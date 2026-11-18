import { signal } from '@preact/signals';
import { configCommitMessage, type GitHub, GitHubError } from '@repotted/core';
import * as z from 'zod/mini';

import { join } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import type { ProfilesSource } from '../profiles/profiles.js';
import { readRepositoryFile, writeRepositoryFile } from '../storage/repository-files.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { preferenceChanges } from './preference-changes.js';
import type { Preferences } from './preferences.js';

/** Hidden, so a profile sync and the profile list leave it out. */
export const preferencesFile = '.repotted-preferences.json';

/** Returning undefined deletes the preference. */
export type Change = (current: unknown) => unknown;

const saved = z.record(z.string(), z.unknown());
// A save that loses to another one, here or elsewhere, reads the file again and tries again.
const maximumSaveAttempts = 3;

interface Place {
  readonly repository: string;
  readonly file: string;
}

interface Pending {
  readonly place: Place;
  readonly key: string;
  readonly change: Change;
}

interface Remote {
  /** Undefined when the repository lacks the file. */
  readonly sha: string | undefined;
  readonly values: Record<string, unknown>;
}

function samePlace(left: Place | undefined, right: Place | undefined): boolean {
  return left?.repository === right?.repository && left?.file === right?.file;
}

/** The values with keys in order, so the file changes only where a value does. */
function stringify(values: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([left], [right]) => (left < right ? -1 : 1)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

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
 * While profiles are kept in a config repository, the preferences are
 * committed to `preferencesFile` beside them; otherwise they are kept in
 * this browser. Reading one inside a computed tracks it, so a value that
 * arrives from the repository updates what depends on it.
 *
 * A change made here is kept as the change, not its result, and is made again
 * onto the file as it is when it is saved. So a change to one name in a list
 * keeps the names another browser added since this one read the file, or
 * before it finished reading it.
 */
export class SharedPreferences implements Preferences {
  readonly error = signal<string | undefined>(undefined);

  readonly #github: GitHub;
  readonly #browser: Preferences;
  readonly #onSignedOut: () => void;
  readonly #onSaved: ((keys: readonly string[], destination: 'browser' | 'repository') => void) | undefined;
  readonly #queue = new SerialQueue();
  /** Counts each change, so a read in a computed runs again after one. */
  readonly #version = signal(0);
  /** Undefined while the preferences are kept in this browser. */
  #place: Place | undefined;
  #fileAsLastReadOrSaved: Record<string, unknown> = {};
  #fileWithPendingChanges: Record<string, unknown> = {};
  /** In the order they were made. A change for a file no longer used stays until it is saved there. */
  #pending: readonly Pending[] = [];
  #readUnderWay: Promise<void> | undefined;

  constructor(
    github: GitHub,
    browser: Preferences,
    onSignedOut: () => void,
    onSaved?: (keys: readonly string[], destination: 'browser' | 'repository') => void,
  ) {
    this.#onSaved = onSaved;
    this.#github = github;
    this.#browser = browser;
    this.#onSignedOut = onSignedOut;
  }

  use(source: ProfilesSource): Promise<void> {
    const place =
      source.kind === 'repository'
        ? { repository: source.repository, file: join(source.path, preferencesFile) }
        : undefined;
    if (samePlace(place, this.#place)) {
      return this.#readUnderWay ?? Promise.resolve();
    }
    this.#place = place;
    this.#fileAsLastReadOrSaved = {};
    this.#readUnderWay = undefined;
    this.error.value = undefined;
    this.#changed();
    return this.reload();
  }

  reload(): Promise<void> {
    const place = this.#place;
    if (place === undefined) {
      return Promise.resolve();
    }
    if (this.#readUnderWay !== undefined) {
      return this.#readUnderWay;
    }
    const reading: Promise<void> = this.#queue
      .run(async () => {
        try {
          const remote = await this.#fetch(place);
          if (samePlace(this.#place, place)) {
            this.#fileAsLastReadOrSaved = remote.values;
            this.#changed();
            if (this.#pending.some((pending) => samePlace(pending.place, place))) {
              // Changes a save failed to commit try again, and keep showing why until they are saved.
              this.#queue.run(() => this.#save(place)).catch(() => undefined);
            } else {
              this.error.value = undefined;
            }
          }
        } catch (error) {
          this.#failed(place, error, `Couldn't read your preferences from ${place.repository}`);
        }
      })
      .finally(() => {
        if (this.#readUnderWay === reading) {
          this.#readUnderWay = undefined;
        }
      });
    this.#readUnderWay = reading;
    return reading;
  }

  read(key: string): unknown {
    // Read for its tracking: a computed that reads a preference runs again when one changes.
    void this.#version.value;
    return this.#place === undefined ? this.#browser.read(key) : this.#fileWithPendingChanges[key];
  }

  write(key: string, value: unknown): void {
    this.update(key, () => value);
  }

  update(key: string, change: Change): void {
    const place = this.#place;
    if (place === undefined) {
      const value = change(this.#browser.read(key));
      this.#browser.write(key, value);
      if (this.#onSaved !== undefined && JSON.stringify(this.#browser.read(key)) === JSON.stringify(value)) {
        this.#onSaved([key], 'browser');
      }
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
    this.#fileWithPendingChanges = withChanges(
      this.#fileAsLastReadOrSaved,
      this.#pending.filter((pending) => samePlace(pending.place, place)),
    );
    this.#version.value += 1;
  }

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
            await writeRepositoryFile(this.#github, place.repository, place.file, {
              text: stringify(next),
              sha: remote.sha,
              message: configCommitMessage(preferenceChanges(remote.values, next)),
            });
          }
          merged = next;
        } catch (error) {
          // GitHub answers 409 when the file changed since it was read, and 422 when it was made meanwhile.
          const lost = error instanceof GitHubError && (error.status === 409 || error.status === 422);
          if (!lost || attempt === maximumSaveAttempts) {
            throw error;
          }
        }
      }
      this.#pending = this.#pending.filter((pending) => !changes.includes(pending));
      if (samePlace(this.#place, place)) {
        this.#fileAsLastReadOrSaved = merged;
        this.error.value = undefined;
        this.#changed();
        this.#onSaved?.([...new Set(changes.map((change) => change.key))], 'repository');
      }
    } catch (error) {
      // The changes stay, so the next save tries them again.
      this.#failed(place, error, `Couldn't save your preferences to ${place.repository}`);
    }
  }

  async #fetch(place: Place): Promise<Remote> {
    const file = await readRepositoryFile(this.#github, place.repository, place.file);
    if (file === undefined) {
      return { sha: undefined, values: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      parsed = undefined;
    }
    // A file that isn't an object of preferences is replaced by the next save.
    const values = saved.safeParse(parsed);
    return { sha: file.sha, values: values.success ? values.data : {} };
  }

  #failed(place: Place, error: unknown, what: string): void {
    if (isSignedOut(error)) {
      this.#onSignedOut();
    } else if (samePlace(this.#place, place)) {
      this.error.value = `${what}: ${messageOf(error)}`;
    }
  }
}
