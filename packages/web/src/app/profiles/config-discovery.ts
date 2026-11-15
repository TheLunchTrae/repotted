import { signal } from '@preact/signals';
import type { GitHub } from '@repotted/core';

import { isSignedOut } from '../account/account.js';
import type { Repository } from '../repositories/repositories.js';
import { configTopic, type MarkedFolder, readMarkedFolder } from './config-marker.js';
import type { Profiles } from './profiles.js';

export interface FoundRepository {
  readonly repository: string;
  /** Undefined when its marker names no folder this browser can use, so the user names one. */
  readonly folder: MarkedFolder;
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
    let found: FoundRepository[];
    let browserProfiles: number;
    try {
      found = await Promise.all(
        marked.map(async (entry) => ({
          repository: entry.full_name,
          folder: await readMarkedFolder(this.#github, entry.full_name),
        })),
      );
      browserProfiles = await this.#profiles.readFolderWithoutSyncing(() =>
        Promise.resolve(this.#profiles.listings.value.length),
      );
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      // Without its markers no repository can be offered rightly, and the user can still choose one in Settings.
      this.state.value = { status: 'done' };
      return;
    }
    const [only] = found;
    if (found.length === 1 && only?.folder !== undefined && browserProfiles === 0) {
      await this.#useFound(only.repository, only.folder);
      return;
    }
    this.state.value = { status: 'asking', found, browserProfiles, busy: false, error: undefined };
  }

  /** The user's pick from what was found. */
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

  dismiss(): void {
    this.state.value = { status: 'done' };
  }

  /** A repository chosen before repositories were marked gets its mark when the list shows it has none. */
  async #markChosen(repositories: readonly Repository[]): Promise<void> {
    const source = this.#profiles.source.value;
    if (source.kind !== 'repository') {
      return;
    }
    const listed = repositories.find((entry) => entry.full_name.toLowerCase() === source.repository.toLowerCase());
    if (listed !== undefined && !listed.archived && !listed.topics.includes(configTopic)) {
      await this.#profiles.markRepository();
    }
  }

  async #useFound(repository: string, folder: string): Promise<void> {
    const error = await this.#profiles.connect(repository, folder, false, { unlessChosen: true });
    if (error !== undefined) {
      this.state.value = { status: 'asking', found: [{ repository, folder }], browserProfiles: 0, busy: false, error };
      return;
    }
    const source = this.#profiles.source.value;
    const usedFound = source.kind === 'repository' && source.repository.toLowerCase() === repository.toLowerCase();
    // The user may have chosen in Settings while the markers were read; their choice stands, with nothing to tell.
    this.state.value = usedFound ? { status: 'found', repository: source.repository } : { status: 'done' };
  }
}
