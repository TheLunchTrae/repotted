import { signal } from '@preact/signals';
import {
  type BranchChanges,
  type GitHub,
  listBranches,
  listProfiles,
  readBranchChanges,
  resolveProfile,
} from '@repotted/core';

import { mkdir, readdir, readFile, rm, writeFile } from '../../engine/files.js';
import { dirname, join, relative } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import {
  isRecord,
  kindOf,
  narrowed,
  entryNounByList,
  sectionsInShownOrder,
  valueInFewWords,
  settingNames,
  sectionTitles,
} from '../apply/comparison.js';
import { branchPreviewFolder } from '../storage/kept-files.js';
import type { ProfilesSource } from './profiles.js';

type ResolvedProfile = Awaited<ReturnType<typeof resolveProfile>>;
type Section = (typeof sectionsInShownOrder)[number];

export interface PreviewRow {
  readonly kind: 'changes' | 'adds' | 'removes';
  readonly label: string;
  /** Its place in the profile, such as `merge.allow_squash_merge`, or what happens to a whole entry. */
  readonly key: string;
  readonly before: string;
  readonly after: string;
  readonly fromExtendedProfile: string | undefined;
}

export interface PreviewSection {
  /** A section of a profile, or `profile` for what the profile is: its base and its owner type. */
  readonly section: Section | 'profile';
  readonly title: string;
  readonly rows: readonly PreviewRow[];
}

/** `through-base`: its file is the same, but a profile it extends changes. */
export type PreviewStatus = 'added' | 'removed' | 'changed' | 'renamed' | 'through-base';

export interface PreviewedProfile {
  /** On the default branch for a removed profile. */
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly status: PreviewStatus;
  readonly movedFromPath: string | undefined;
  readonly fileOnBranch: string | undefined;
  readonly problemOnBranch: string | undefined;
  readonly problemFixedByBranch: string | undefined;
  readonly sections: readonly PreviewSection[];
  readonly changedFileText: { readonly before: string; readonly after: string } | undefined;
}

export interface PreviewedBranch {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly branchCommit: string;
  readonly commitsBehindDefaultBranch: number;
  readonly changedFilesTruncated: boolean;
  readonly localProfilesOlderThanDefaultBranch: boolean;
  readonly profilesChangedSinceLastSync: readonly string[];
  readonly changesSharedPreferences: boolean;
  readonly branchProfilesFolder: string;
  readonly changedProfiles: readonly PreviewedProfile[];
  readonly unchangedProfileCount: number;
}

export type PreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly branch: string }
  | { readonly kind: 'failed'; readonly branch: string; readonly message: string }
  | ({ readonly kind: 'ready' } & PreviewedBranch);

export type BranchList =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'listed';
      readonly defaultBranch: string;
      readonly branches: readonly string[];
      readonly moreBranchesThanListed: boolean;
    };

export interface ProfilesFolderReader {
  readFolderWithoutSyncing<Result>(work: (folder: string, source: ProfilesSource) => Promise<Result>): Promise<Result>;
}

const syncRecord = '.repotted-sync.json';
const preferencesFile = '.repotted-preferences.json';
const entryLists = ['autolinks', 'rulesets', 'environments', 'labels'] as const;
type EntryList = (typeof entryLists)[number];

function isEntryList(section: Section): section is EntryList {
  return entryLists.some((list) => list === section);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyVisibleProfiles(from: string, to: string, prefix = ''): Promise<void> {
  await mkdir(join(to, prefix), { recursive: true });
  for (const entry of await readdir(join(from, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyVisibleProfiles(from, to, path);
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      await writeFile(join(to, path), await readFile(join(from, path)));
    }
  }
}

async function lastSyncedCommitAndBlobIds(
  folder: string,
): Promise<{ commit: string | undefined; blobIdByProfilePath: Map<string, string> }> {
  try {
    const record: unknown = JSON.parse(await readFile(join(folder, syncRecord), 'utf8'));
    const files = isRecord(record) && isRecord(record['files']) ? record['files'] : {};
    return {
      commit: isRecord(record) && typeof record['commit'] === 'string' ? record['commit'] : undefined,
      blobIdByProfilePath: new Map(
        Object.entries(files).flatMap(([file, id]) => (typeof id === 'string' ? [[file, id] as const] : [])),
      ),
    };
  } catch {
    return { commit: undefined, blobIdByProfilePath: new Map() };
  }
}

async function gitBlobId(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const whole = new Uint8Array(header.length + content.byteLength);
  whole.set(header);
  whole.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function visibleProfilePaths(folder: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...(await visibleProfilePaths(folder, path)));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      paths.push(path);
    }
  }
  return paths;
}

async function profilePathsChangedSinceLastSync(
  folder: string,
  synced: ReadonlyMap<string, string>,
): Promise<string[]> {
  const changed = new Set<string>();
  const here = await visibleProfilePaths(folder);
  for (const path of here) {
    if (synced.get(path) !== (await gitBlobId(await readFile(join(folder, path))))) {
      changed.add(path);
    }
  }
  for (const path of synced.keys()) {
    if (!here.includes(path)) {
      changed.add(path);
    }
  }
  return [...changed].sort();
}

async function layBranchChangesOver(folder: string, changes: BranchChanges): Promise<void> {
  for (const change of changes.changedProfiles) {
    if (change.status === 'removed' || change.status === 'renamed') {
      await rm(join(folder, change.status === 'removed' ? change.profilePath : change.previousProfilePath), {
        force: true,
      });
    }
  }
  for (const change of changes.changedProfiles) {
    if (change.status !== 'removed') {
      const target = join(folder, change.profilePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.content);
    }
  }
}

interface Side {
  readonly name: string;
  readonly folder: string;
  readonly file: string;
  readonly text: string;
  readonly resolved: ResolvedProfile | undefined;
  readonly problem: string | undefined;
}

/**
 * A problem names files by their path among the profiles, so the same problem
 * reads the same on both sides. A profile that extends a file outside the
 * folder doesn't load: a branch could otherwise point one at the browser's
 * other profiles.
 */
async function readSide(root: string): Promise<Map<string, Side>> {
  const sides = new Map<string, Side>();
  const inside = `${root}/`;
  for (const listing of await listProfiles(root)) {
    const path = relative(root, listing.file);
    const text = await readFile(listing.file, 'utf8').catch(() => '');
    let resolved: ResolvedProfile | undefined;
    let problem = listing.problem ?? undefined;
    if (problem === undefined) {
      try {
        const read = await resolveProfile(listing.file);
        const outside = read.chain.find((file) => !file.startsWith(inside));
        if (outside === undefined) {
          resolved = read;
        } else {
          problem = 'It extends a profile outside the profiles folder.';
        }
      } catch (error) {
        problem = messageOf(error);
      }
    }
    sides.set(path, {
      name: listing.name,
      folder: listing.folder,
      file: listing.file,
      text,
      resolved,
      problem: problem?.replaceAll(inside, ''),
    });
  }
  return sides;
}

function settingKey(path: string): string {
  return path.slice(path.indexOf('.') + 1);
}

function entryKey(list: EntryList, entry: unknown): string | undefined {
  const key = isRecord(entry) ? entry[list === 'autolinks' ? 'key_prefix' : 'name'] : undefined;
  return typeof key === 'string' ? key : undefined;
}

function entries(
  list: EntryList,
  profile: ResolvedProfile | undefined,
): Map<string, Readonly<Record<string, unknown>>> {
  const items: unknown = profile?.profile[list];
  return new Map(
    (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
      const key = entryKey(list, item);
      return key === undefined || !isRecord(item) ? [] : [[key, item] as const];
    }),
  );
}

export function previewSections(
  before: ResolvedProfile | undefined,
  after: ResolvedProfile | undefined,
  root: { readonly before: string; readonly after: string },
): PreviewSection[] {
  const fromBase = (side: ResolvedProfile | undefined, file: string | undefined, folder: string): string | undefined =>
    side === undefined || file === undefined || file === side.chain[0] ? undefined : relative(folder, file);
  const sourceOf = (section: Section, key: string, removed: boolean): string | undefined => {
    const side = removed ? before : after;
    const files: Readonly<Record<string, string>> | undefined = side?.sources[section];
    return fromBase(side, files?.[key], removed ? root.before : root.after);
  };
  const sections: PreviewSection[] = [];
  const profileRows: PreviewRow[] = [];
  const base = (side: ResolvedProfile | undefined, folder: string): string | undefined =>
    side?.chain[1] === undefined ? undefined : relative(folder, side.chain[1]);
  const baseBefore = base(before, root.before);
  const baseAfter = base(after, root.after);
  if (baseBefore !== baseAfter) {
    profileRows.push({
      kind: kindOf(baseBefore, baseAfter),
      label: 'Extends',
      key: 'extends',
      before: baseBefore ?? 'None',
      after: baseAfter ?? 'None',
      fromExtendedProfile: undefined,
    });
  }
  const ownerBefore = before?.profile.owner_type;
  const ownerAfter = after?.profile.owner_type;
  if (ownerBefore !== ownerAfter) {
    const owner = (type: string | undefined): string =>
      type === 'user' ? 'Personal accounts' : type === 'organization' ? 'Organizations' : 'Any owner';
    profileRows.push({
      kind: kindOf(ownerBefore, ownerAfter),
      label: 'For',
      key: 'owner_type',
      before: owner(ownerBefore),
      after: owner(ownerAfter),
      fromExtendedProfile: undefined,
    });
  }
  if (profileRows.length > 0) {
    sections.push({ section: 'profile', title: 'Profile', rows: profileRows });
  }
  for (const section of sectionsInShownOrder) {
    const rows: PreviewRow[] = [];
    if (!isEntryList(section)) {
      const from: unknown = before?.profile[section];
      const to: unknown = after?.profile[section];
      for (const change of narrowed(section, isRecord(from) ? from : {}, isRecord(to) ? to : {})) {
        const { label, named } = settingNames(change.path);
        const removed = change.to === undefined;
        // A setting inside a group, such as `selected_actions.verified_allowed`, goes by its path in the section.
        const key = settingKey(change.path).replace(/\[.*$/u, '');
        rows.push({
          kind: kindOf(change.from, change.to),
          label,
          key: change.path,
          before: named(change.from),
          after: named(change.to),
          fromExtendedProfile: sourceOf(section, key, removed) ?? sourceOf(section, key.split('.')[0] ?? key, removed),
        });
      }
    } else {
      const list = section;
      const was = entries(list, before);
      const now = entries(list, after);
      const noun = entryNounByList[list] ?? 'entry';
      for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
        const from = was.get(key);
        const to = now.get(key);
        if (from === undefined) {
          rows.push({
            kind: 'adds',
            label: key,
            key: `new ${noun}`,
            before: 'Not set',
            after: 'Added',
            fromExtendedProfile: sourceOf(list, key, false),
          });
        } else if (to === undefined) {
          rows.push({
            kind: 'removes',
            label: key,
            key: `${noun} removed`,
            before: 'Set',
            after: 'Removed',
            fromExtendedProfile: sourceOf(list, key, true),
          });
        } else {
          for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])]) {
            for (const change of narrowed(field, from[field], to[field])) {
              rows.push({
                kind: kindOf(change.from, change.to),
                label: key,
                key: change.path,
                before: valueInFewWords(change.from, 'Not set'),
                after: valueInFewWords(change.to, 'Not set'),
                fromExtendedProfile: sourceOf(list, key, false),
              });
            }
          }
        }
      }
    }
    if (rows.length > 0) {
      sections.push({ section, title: sectionTitles[section], rows });
    }
  }
  return sections;
}

async function compareSides(
  roots: { readonly before: string; readonly after: string },
  changes: BranchChanges,
): Promise<{ changedProfiles: PreviewedProfile[]; unchangedProfileCount: number }> {
  const [before, after] = await Promise.all([readSide(roots.before), readSide(roots.after)]);
  const moved = new Map(
    changes.changedProfiles.flatMap((change) =>
      change.status === 'renamed' ? [[change.profilePath, change.previousProfilePath] as const] : [],
    ),
  );
  const movedAway = new Set(moved.values());
  const changedProfiles: PreviewedProfile[] = [];
  let unchangedProfileCount = 0;
  for (const [path, now] of after) {
    const previous = moved.get(path);
    const was = before.get(previous ?? path);
    const sections = now.resolved === undefined ? [] : previewSections(was?.resolved, now.resolved, roots);
    const textChanged = was?.text !== now.text;
    const status: PreviewStatus =
      was === undefined ? 'added' : previous !== undefined ? 'renamed' : textChanged ? 'changed' : 'through-base';
    if (status === 'through-base' && sections.length === 0 && now.problem === was?.problem) {
      unchangedProfileCount += 1;
      continue;
    }
    changedProfiles.push({
      path,
      name: now.name,
      folder: now.folder,
      status,
      movedFromPath: previous,
      fileOnBranch: now.file,
      problemOnBranch: now.problem,
      problemFixedByBranch: now.problem === undefined ? was?.problem : undefined,
      sections,
      changedFileText: textChanged ? { before: was?.text ?? '', after: now.text } : undefined,
    });
  }
  for (const [path, was] of before) {
    if (!after.has(path) && !movedAway.has(path)) {
      changedProfiles.push({
        path,
        name: was.name,
        folder: was.folder,
        status: 'removed',
        movedFromPath: undefined,
        fileOnBranch: undefined,
        problemOnBranch: undefined,
        problemFixedByBranch: undefined,
        sections: [],
        changedFileText: { before: was.text, after: '' },
      });
    }
  }
  changedProfiles.sort((a, b) => a.path.localeCompare(b.path));
  return { changedProfiles, unchangedProfileCount };
}

// Only reads from GitHub.
export class BranchPreview {
  readonly state = signal<PreviewState>({ kind: 'idle' });
  readonly branches = signal<BranchList>({ kind: 'idle' });

  readonly #github: GitHub;
  readonly #profiles: ProfilesFolderReader;
  readonly #onSignedOut: () => void;
  #latestLoadTurn = 0;
  #latestListingTurn = 0;
  #previewsMade = 0;
  #currentPreviewFolder: string | undefined;

  constructor(github: GitHub, profiles: ProfilesFolderReader, onSignedOut: () => void) {
    this.#github = github;
    this.#profiles = profiles;
    this.#onSignedOut = onSignedOut;
  }

  #failed(error: unknown): string {
    if (isSignedOut(error)) {
      this.#onSignedOut();
    }
    return messageOf(error);
  }

  async listBranches(repository: string): Promise<void> {
    const turn = (this.#latestListingTurn += 1);
    this.branches.value = { kind: 'loading' };
    try {
      const listed = await listBranches(this.#github, repository);
      if (turn === this.#latestListingTurn) {
        this.branches.value = { kind: 'listed', ...listed };
      }
    } catch (error) {
      const message = this.#failed(error);
      if (turn === this.#latestListingTurn) {
        this.branches.value = { kind: 'failed', message };
      }
    }
  }

  /** A page that shows the same branch again, as on the way back from a comparison, reads nothing. */
  async open(branch: string): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'idle' && state.kind !== 'failed' && state.branch === branch) {
      return;
    }
    await this.#load(branch);
  }

  async refresh(): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'idle') {
      await this.#load(state.branch);
    }
  }

  async close(): Promise<void> {
    this.#latestLoadTurn += 1;
    this.state.value = { kind: 'idle' };
    await this.#removeCurrentPreviewFolder();
  }

  async #removeCurrentPreviewFolder(): Promise<void> {
    const folder = this.#currentPreviewFolder;
    this.#currentPreviewFolder = undefined;
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async #load(branch: string): Promise<void> {
    const turn = (this.#latestLoadTurn += 1);
    this.state.value = { kind: 'loading', branch };
    this.#previewsMade += 1;
    const folder = `${branchPreviewFolder}/${this.#previewsMade}`;
    const roots = { before: `${folder}/before`, after: `${folder}/after` };
    try {
      const { source, lastSyncedCommit, profilesChangedSinceLastSync } = await this.#profiles.readFolderWithoutSyncing(
        async (profiles, from) => {
          if (from.kind !== 'repository') {
            throw new Error(
              'A preview of a branch needs profiles kept in a GitHub repository. Choose one in Settings.',
            );
          }
          await copyVisibleProfiles(profiles, roots.before);
          await copyVisibleProfiles(profiles, roots.after);
          const record = await lastSyncedCommitAndBlobIds(profiles);
          return {
            source: from,
            lastSyncedCommit: record.commit,
            profilesChangedSinceLastSync: await profilePathsChangedSinceLastSync(profiles, record.blobIdByProfilePath),
          };
        },
      );
      const changes = await readBranchChanges(this.#github, branch, {
        repository: source.repository,
        path: source.path,
      });
      if (turn !== this.#latestLoadTurn) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
      await layBranchChangesOver(roots.after, changes);
      const { changedProfiles, unchangedProfileCount } = await compareSides(roots, changes);
      await rm(roots.before, { recursive: true, force: true });
      if (turn !== this.#latestLoadTurn) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
      // The folders change hands at once, so nothing can come between the check above and the new state.
      const old = this.#currentPreviewFolder;
      this.#currentPreviewFolder = folder;
      this.state.value = {
        kind: 'ready',
        repository: source.repository,
        path: changes.path,
        branch,
        defaultBranch: changes.defaultBranch,
        branchCommit: changes.branchCommit,
        commitsBehindDefaultBranch: changes.commitsBehindDefaultBranch,
        changedFilesTruncated: changes.changedFilesTruncated,
        localProfilesOlderThanDefaultBranch: lastSyncedCommit !== changes.defaultBranchCommit,
        profilesChangedSinceLastSync,
        changesSharedPreferences: changes.otherChangedFiles.includes(preferencesFile),
        branchProfilesFolder: roots.after,
        changedProfiles,
        unchangedProfileCount,
      };
      if (old !== undefined) {
        await rm(old, { recursive: true, force: true });
      }
    } catch (error) {
      const message = this.#failed(error);
      if (turn === this.#latestLoadTurn) {
        this.state.value = { kind: 'failed', branch, message };
        await this.#removeCurrentPreviewFolder();
      }
      await rm(folder, { recursive: true, force: true });
    }
  }
}
