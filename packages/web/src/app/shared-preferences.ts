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

interface Remote {
  /** The file's blob, or undefined when the repository lacks the file. */
  readonly sha: string | undefined;
  readonly values: Record<string, unknown>;
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

function withChanges(values: Record<string, unknown>, changes: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const next = Object.entries(values).filter(([key]) => !changes.has(key));
  for (const [key, value] of changes) {
    if (value !== undefined) {
      next.push([key, value]);
    }
  }
  return Object.fromEntries(next);
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
 */
export class SharedPreferences implements Preferences {
  /** Why the file couldn't be read or saved, until a read or save succeeds. */
  readonly error = signal<string | undefined>(undefined);

  readonly #github: GitHub;
  readonly #browser: Preferences;
  readonly #onSignedOut: () => void;
  readonly #queue = new SerialQueue();
  /** Counts each change, so a read in a computed runs again after one. */
  readonly #version = signal(0);
  /** The file they are kept in, or undefined for this browser. */
  #place: Place | undefined;
  #values: Record<string, unknown> = {};
  /** What was written here that the file has yet to get, by key; undefined deletes the key. */
  #pending = new Map<string, unknown>();

  constructor(github: GitHub, browser: Preferences, onSignedOut: () => void) {
    this.#github = github;
    this.#browser = browser;
    this.#onSignedOut = onSignedOut;
  }

  /** Keeps them where the profiles are, reading the file when that is a repository. */
  async use(source: ProfilesSource): Promise<void> {
    const place =
      source.kind === 'repository'
        ? { repository: source.repository, file: join(source.path, preferencesFile) }
        : undefined;
    if (place?.repository === this.#place?.repository && place?.file === this.#place?.file) {
      return;
    }
    this.#place = place;
    this.#values = {};
    this.#pending = new Map();
    this.error.value = undefined;
    this.#version.value += 1;
    if (place === undefined) {
      return;
    }
    await this.#queue.run(async () => {
      try {
        const remote = await this.#read(place);
        if (this.#place === place) {
          this.#values = withChanges(remote.values, this.#pending);
          this.#version.value += 1;
        }
      } catch (error) {
        this.#failed(place, error, `Couldn't read your preferences from ${place.repository}`);
      }
    });
  }

  read(key: string): unknown {
    // Read for its tracking: a computed that reads a preference runs again when one changes.
    void this.#version.value;
    return this.#place === undefined ? this.#browser.read(key) : this.#values[key];
  }

  write(key: string, value: unknown): void {
    const place = this.#place;
    if (place === undefined) {
      this.#browser.write(key, value);
    } else {
      this.#values = withChanges(this.#values, new Map([[key, value]]));
      this.#pending.set(key, value);
      // Writes made while one saves wait their turn and go in one commit.
      // A save reports its own failure in error.
      this.#queue.run(() => this.#save(place)).catch(() => undefined);
    }
    this.#version.value += 1;
  }

  /** Commits what was written here onto the file as it is now, so keys changed elsewhere are kept. */
  async #save(place: Place): Promise<void> {
    if (this.#place !== place || this.#pending.size === 0) {
      return;
    }
    const changes = new Map(this.#pending);
    try {
      let merged: Record<string, unknown> | undefined;
      for (let attempt = 1; merged === undefined; attempt += 1) {
        const remote = await this.#read(place);
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
      if (this.#place !== place) {
        return;
      }
      for (const [key, value] of changes) {
        if (this.#pending.get(key) === value) {
          this.#pending.delete(key);
        }
      }
      this.#values = withChanges(merged, this.#pending);
      this.error.value = undefined;
      this.#version.value += 1;
    } catch (error) {
      this.#failed(place, error, `Couldn't save your preferences to ${place.repository}`);
    }
  }

  async #read(place: Place): Promise<Remote> {
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
    } else if (this.#place === place) {
      this.error.value = `${what}: ${messageOf(error)}`;
    }
  }
}
