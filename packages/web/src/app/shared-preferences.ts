import { signal } from '@preact/signals';
import { type GitHub, GitHubError, parseRepo } from '@repotted/core';
import * as z from 'zod/mini';

import { join } from '../engine/path.js';
import { isSignedOut } from './account.js';
import type { Preferences } from './preferences.js';
import type { ProfilesSource } from './profiles.js';
import { SerialQueue } from './serial-queue.js';

/**
 * The file beside the profiles in a config repository that holds the
 * preferences that follow the user. It is hidden, so a profile sync and the
 * profile list leave it out.
 */
export const preferencesFile = '.repotted-preferences.json';

/** Makes a preference's next value from its value now; undefined deletes it. */
export type Change = (current: unknown) => unknown;

const message = 'Update Repotted preferences';
const contents = z.object({ sha: z.string(), content: z.string() });
const saved = z.record(z.string(), z.unknown());
// A save that loses to another one, here or elsewhere, reads the file again and tries again this many times.
const tries = 3;

interface Place {
  readonly repository: string;
  /** The file's path in the repository. */
  readonly file: string;
}

interface Pending {
  readonly place: Place;
  readonly key: string;
  readonly change: Change;
}

interface Remote {
  /** The file's blob, or undefined when the repository lacks the file. */
  readonly sha: string | undefined;
  readonly values: Record<string, unknown>;
}

function samePlace(left: Place | undefined, right: Place | undefined): boolean {
  return left?.repository === right?.repository && left?.file === right?.file;
}

function decode(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64.replace(/\s/gu, '')), (char) => char.charCodeAt(0)));
}

function encode(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''));
}

/** The values with keys in order, so the file changes only where a value does. */
function stringify(values: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([left], [right]) => (left < right ? -1 : 1)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** The values with each change made in turn, onto whatever the value is by then. */
function withChanges(values: Record<string, unknown>, changes: readonly Pending[]): Record<string, unknown> {
  let next = values;
  for (const { key, change } of changes) {
    const value = change(next[key]);
    next = Object.fromEntries(Object.entries(next).filter(([other]) => other !== key));
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Preferences that follow the user, such as the repositories and owners the
 * list hides. While profiles are kept in a config repository, they are kept
 * in `preferencesFile` beside them and committed there; otherwise they are
 * kept in this browser. Reading one inside a computed tracks it, so a value
 * that arrives from the repository updates what depends on it.
 *
 * A change made here is kept as the change, not its result, and is made again
 * onto the file as it is when it is saved. So a change to one name in a list
 * keeps the names another browser added since this one read the file, or
 * before it finished reading it.
 */
export class SharedPreferences implements Preferences {
  /** Why the file couldn't be read or saved, until a read or save succeeds. */
  readonly error = signal<string | undefined>(undefined);
  /** Whether the file is being read, so what it holds is not known yet. */
  readonly reading = signal(false);

  readonly #github: GitHub;
  readonly #browser: Preferences;
  readonly #onSignedOut: () => void;
  readonly #queue = new SerialQueue();
  /** Counts each change, so a read in a computed runs again after one. */
  readonly #version = signal(0);
  /** The file they are kept in, or undefined for this browser. */
  #place: Place | undefined;
  /** The file as last read or saved. */
  #base: Record<string, unknown> = {};
  /** The base with the changes not saved yet. */
  #values: Record<string, unknown> = {};
  /** Changes not saved yet, in the order they were made. A change for a file no longer used stays until it is saved there. */
  #pending: readonly Pending[] = [];
  /** The read under way, which a reload waits for rather than starting another. */
  #read: Promise<void> | undefined;

  constructor(github: GitHub, browser: Preferences, onSignedOut: () => void) {
    this.#github = github;
    this.#browser = browser;
    this.#onSignedOut = onSignedOut;
  }

  /** Keeps them where the profiles are, reading the file when that is a repository. */
  use(source: ProfilesSource): Promise<void> {
    const place =
      source.kind === 'repository'
        ? { repository: source.repository, file: join(source.path, preferencesFile) }
        : undefined;
    if (samePlace(place, this.#place)) {
      return this.#read ?? Promise.resolve();
    }
    this.#place = place;
    this.#base = {};
    this.#read = undefined;
    this.reading.value = false;
    this.error.value = undefined;
    this.#changed();
    return this.reload();
  }

  /** Reads the file again, so changes made elsewhere show. A read already under way is the one waited for. */
  reload(): Promise<void> {
    const place = this.#place;
    if (place === undefined) {
      return Promise.resolve();
    }
    if (this.#read !== undefined) {
      return this.#read;
    }
    const reading: Promise<void> = this.#queue
      .run(async () => {
        try {
          const remote = await this.#fetch(place);
          if (samePlace(this.#place, place)) {
            this.#base = remote.values;
            this.error.value = undefined;
            this.#changed();
          }
        } catch (error) {
          this.#failed(place, error, `Couldn't read your preferences from ${place.repository}`);
        }
      })
      .finally(() => {
        if (this.#read === reading) {
          this.#read = undefined;
          this.reading.value = false;
        }
      });
    this.#read = reading;
    this.reading.value = true;
    return reading;
  }

  read(key: string): unknown {
    // Read for its tracking: a computed that reads a preference runs again when one changes.
    void this.#version.value;
    return this.#place === undefined ? this.#browser.read(key) : this.#values[key];
  }

  write(key: string, value: unknown): void {
    this.update(key, () => value);
  }

  /** Changes a preference from its value now, and again from the file's value when it is saved. */
  update(key: string, change: Change): void {
    const place = this.#place;
    if (place === undefined) {
      this.#browser.write(key, change(this.#browser.read(key)));
      this.#version.value += 1;
      return;
    }
    this.#pending = [...this.#pending, { place, key, change }];
    this.#changed();
    // Changes made while one saves wait their turn and go in one commit. A save reports its own failure in error.
    this.#queue.run(() => this.#save(place)).catch(() => undefined);
  }

  #changed(): void {
    const place = this.#place;
    this.#values = withChanges(
      this.#base,
      this.#pending.filter((pending) => samePlace(pending.place, place)),
    );
    this.#version.value += 1;
  }

  /** Commits the changes for this file onto it as it is now, so keys and values changed elsewhere are kept. */
  async #save(place: Place): Promise<void> {
    const changes = this.#pending.filter((pending) => samePlace(pending.place, place));
    if (changes.length === 0) {
      return;
    }
    try {
      let merged: Record<string, unknown> | undefined;
      for (let attempt = 1; merged === undefined; attempt += 1) {
        const remote = await this.#fetch(place);
        const next = withChanges(remote.values, changes);
        try {
          if (stringify(next) !== stringify(remote.values)) {
            await this.#github.request('PUT', this.#path(place), {
              message,
              content: encode(stringify(next)),
              ...(remote.sha === undefined ? {} : { sha: remote.sha }),
            });
          }
          merged = next;
        } catch (error) {
          // GitHub answers 409 when the file changed since it was read, and 422 when it was made meanwhile.
          const lost = error instanceof GitHubError && (error.status === 409 || error.status === 422);
          if (!lost || attempt === tries) {
            throw error;
          }
        }
      }
      this.#pending = this.#pending.filter((pending) => !changes.includes(pending));
      if (samePlace(this.#place, place)) {
        this.#base = merged;
        this.error.value = undefined;
        this.#changed();
      }
    } catch (error) {
      // The changes stay, so the next save tries them again.
      this.#failed(place, error, `Couldn't save your preferences to ${place.repository}`);
    }
  }

  async #fetch(place: Place): Promise<Remote> {
    let answer: unknown;
    try {
      answer = await this.#github.request('GET', this.#path(place));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        return { sha: undefined, values: {} };
      }
      throw error;
    }
    const file = contents.parse(answer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decode(file.content));
    } catch {
      parsed = undefined;
    }
    // A file that isn't an object of preferences is replaced by the next save.
    const values = saved.safeParse(parsed);
    return { sha: file.sha, values: values.success ? values.data : {} };
  }

  #path(place: Place): string {
    const repo = parseRepo(place.repository);
    const file = place.file.split('/').map(encodeURIComponent).join('/');
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${file}`;
  }

  #failed(place: Place, error: unknown, what: string): void {
    if (isSignedOut(error)) {
      this.#onSignedOut();
    } else if (samePlace(this.#place, place)) {
      this.error.value = `${what}: ${messageOf(error)}`;
    }
  }
}
