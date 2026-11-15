import { signal } from '@preact/signals';
import type { GitHub } from '@repotted/core';

import { isSignedOut } from '../account/account.js';
import type { Repository } from '../repositories/repositories.js';
import { configTopic, hasMarker, readMarkedFolder } from './config-marker.js';
import type { Profiles } from './profiles.js';

export interface FoundRepository {
  readonly repository: string;
  /** Undefined when its marker can't be read or names no folder this browser can use, so the user names one. */
  readonly folder: string | undefined;
}

export type DiscoveryState =
  | { readonly status: 'waiting' }
  | { readonly status: 'looking' }
  | {
      readonly status: 'asking';
      readonly found: readonly FoundRepository[];
      /** The profiles kept in this browser now, which the user may add to the repository. */
      readonly browserProfiles: number;
      readonly busy: boolean;
      readonly error: string | undefined;
    }
  | { readonly status: 'found'; readonly repository: string }
  | { readonly status: 'done' };

/**
 * Finds where a browser with no choice of where profiles are kept should
 * keep them, by the topic on the user's repositories. It looks once a
 * visit, when the repository list first loads.
 */
export class ConfigDiscovery {
  readonly state = signal<DiscoveryState>({ status: 'waiting' });

  readonly #github: GitHub;
  readonly #profiles: Profiles;
  readonly #onSignedOut: () => void;

  constructor(github: GitHub, profiles: Profiles, onSignedOut: () => void) {
    this.#github = github;
    this.#profiles = profiles;
    this.#onSignedOut = onSignedOut;
  }

  async look(repositories: readonly Repository[]): Promise<void> {
    if (this.state.value.status !== 'waiting') {
      return;
    }
    this.state.value = { status: 'looking' };
    if (this.#profiles.chosen.value) {
      await this.#markChosen(repositories);
      this.state.value = { status: 'done' };
      return;
    }
    const marked = repositories.filter((entry) => !entry.archived && entry.topics.includes(configTopic));
    if (marked.length === 0) {
      this.state.value = { status: 'done' };
      return;
    }
    const reads = await Promise.all(marked.map((entry) => this.#readFound(entry.full_name)));
    if (reads.some((read) => read === 'signed out')) {
      this.#onSignedOut();
      this.state.value = { status: 'done' };
      return;
    }
    const found = reads.filter((read): read is FoundRepository => read !== 'signed out');
    const browserProfiles = await this.#browserProfiles();
    const [only] = found;
    if (found.length === 1 && only?.folder !== undefined && browserProfiles === 0) {
      await this.#useFound(only.repository, only.folder);
      return;
    }
    this.state.value = { status: 'asking', found, browserProfiles, busy: false, error: undefined };
  }

  async use(repository: string, folder: string, addBrowserProfiles: boolean): Promise<void> {
    const asking = this.state.value;
    if (asking.status !== 'asking' || asking.busy) {
      return;
    }
    this.state.value = { ...asking, busy: true, error: undefined };
    const error = await this.#profiles.connect(repository, folder, addBrowserProfiles);
    this.state.value = error === undefined ? { status: 'done' } : { ...asking, busy: false, error };
  }

  /** Saves the browser as the choice, so later visits don't ask again. */
  async keepInBrowser(): Promise<void> {
    const asking = this.state.value;
    if (asking.status !== 'asking' || asking.busy) {
      return;
    }
    this.state.value = { ...asking, busy: true, error: undefined };
    await this.#profiles.keepInBrowser();
    const error = this.#profiles.connectError.value;
    this.state.value = error === undefined ? { status: 'done' } : { ...asking, busy: false, error };
  }

  /** Hides the notice for this visit; the next one looks again. */
  dismiss(): void {
    this.state.value = { status: 'done' };
  }

  /** A marker that can't be read, as without the Contents permission, leaves the folder for the user to name. */
  async #readFound(repository: string): Promise<FoundRepository | 'signed out'> {
    try {
      return { repository, folder: await readMarkedFolder(this.#github, repository) };
    } catch (error) {
      return isSignedOut(error) ? 'signed out' : { repository, folder: undefined };
    }
  }

  #browserProfiles(): Promise<number> {
    return this.#profiles.readFolderWithoutSyncing(() => Promise.resolve(this.#profiles.listings.value.length));
  }

  /**
   * A repository chosen before repositories were marked has no marker. One
   * that has a marker but not the topic had it taken off, by a move in
   * another browser or by hand, so it stays as it is.
   */
  async #markChosen(repositories: readonly Repository[]): Promise<void> {
    const source = this.#profiles.source.value;
    if (source.kind !== 'repository') {
      return;
    }
    const listed = repositories.find((entry) => entry.full_name.toLowerCase() === source.repository.toLowerCase());
    if (listed === undefined || listed.archived || listed.topics.includes(configTopic)) {
      return;
    }
    try {
      if (!(await hasMarker(this.#github, listed.full_name))) {
        await this.#profiles.markRepository();
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
    }
  }

  async #useFound(repository: string, folder: string): Promise<void> {
    const error = await this.#profiles.connect(repository, folder, false, { onlyIntoEmptyUnchosenBrowser: true });
    if (error !== undefined) {
      this.state.value = { status: 'asking', found: [{ repository, folder }], browserProfiles: 0, busy: false, error };
      return;
    }
    const source = this.#profiles.source.value;
    if (source.kind === 'repository' && source.repository.toLowerCase() === repository.toLowerCase()) {
      this.state.value = { status: 'found', repository: source.repository };
    } else if (this.#profiles.chosen.value) {
      // Chosen in Settings while the marker was read; that choice stands, with nothing to tell.
      this.state.value = { status: 'done' };
    } else {
      // A profile made here meanwhile is the user's to keep or add, so they are asked.
      this.state.value = {
        status: 'asking',
        found: [{ repository, folder }],
        browserProfiles: await this.#browserProfiles(),
        busy: false,
        error: undefined,
      };
    }
  }
}
