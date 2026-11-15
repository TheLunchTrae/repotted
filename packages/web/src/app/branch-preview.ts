import { signal } from '@preact/signals';
import {
  type BranchChanges,
  type GitHub,
  listBranches,
  listProfiles,
  readBranchChanges,
  resolveProfile,
} from '@repotted/core';

import { mkdir, readdir, readFile, rm, writeFile } from '../engine/files.js';
import { dirname, join, relative } from '../engine/path.js';
import { isSignedOut } from './account.js';
import { isRecord, kindOf, narrowed, nouns, order, say, settingNames, titles } from './comparison.js';
import { previewFolder } from './kept-files.js';
import type { ProfilesSource } from './profiles.js';

type ResolvedProfile = Awaited<ReturnType<typeof resolveProfile>>;
type Section = (typeof order)[number];

/** One thing a branch changes in a profile: what it is, what the default branch has, and what the branch has. */
export interface PreviewRow {
  /** Whether the branch changes the value, adds it, or removes it. */
  readonly kind: 'changes' | 'adds' | 'removes';
  /** What it is, as the editor names it: a setting's label, or an entry's name. */
  readonly label: string;
  /** Its place in the profile, such as `merge.allow_squash_merge`, or what happens to a whole entry. */
  readonly key: string;
  readonly before: string;
  readonly after: string;
  /** The profile it comes from, by path among the profiles, when that is a profile the profile extends. */
  readonly from: string | undefined;
}

export interface PreviewSection {
  /** A section of a profile, or `profile` for what the profile is: its base and its owner type. */
  readonly section: Section | 'profile';
  readonly title: string;
  readonly rows: readonly PreviewRow[];
}

/**
 * What happens to a profile on the branch:
 * - `added`, `removed`: the branch adds or removes its file.
 * - `changed`: the branch changes its file.
 * - `renamed`: the branch moves its file, and may change it too.
 * - `through-base`: its file is the same, but a profile it extends changes.
 */
export type PreviewStatus = 'added' | 'removed' | 'changed' | 'renamed' | 'through-base';

export interface PreviewedProfile {
  /** Its path among the profiles on the branch, or on the default branch for a removed one. */
  readonly path: string;
  /** Its name and folder, as the list shows them. */
  readonly name: string;
  readonly folder: string;
  readonly status: PreviewStatus;
  /** Its path on the default branch, for a moved profile. */
  readonly previous: string | undefined;
  /** Its file on the branch, as the preview keeps it, which a comparison with a repository uses; undefined for a removed one. */
  readonly file: string | undefined;
  /** Why it doesn't load on the branch, when it doesn't. */
  readonly problem: string | undefined;
  /** Why it doesn't load on the default branch, when it doesn't there but does on the branch. */
  readonly problemBefore: string | undefined;
  /** What applies differently, by section; nothing for a removed profile. */
  readonly sections: readonly PreviewSection[];
  /** Its file's text on each side, when the branch changes the file. */
  readonly text: { readonly before: string; readonly after: string } | undefined;
}

/** A branch read and laid over the profiles. */
export interface Previewed {
  readonly repository: string;
  /** The folder in the repository that holds the profiles; '' for the root. */
  readonly path: string;
  readonly branch: string;
  /** The default branch it is measured against. */
  readonly base: string;
  /** The branch's commit when it was read. */
  readonly commit: string;
  /** How many commits the default branch has that the branch doesn't. */
  readonly behind: number;
  /** Whether GitHub left changed files out, as it does past 300. */
  readonly truncated: boolean;
  /** Whether the profiles here are older than the default branch, so they aren't what it holds now. */
  readonly stale: boolean;
  /**
   * The profiles changed here since the last sync, by path: edited, made, or
   * deleted. The preview starts from the profiles here, so it shows those
   * changes as undone by the branch.
   */
  readonly local: readonly string[];
  /** Whether the branch changes the shared preferences, which the preview doesn't show. */
  readonly preferences: boolean;
  /** Where the preview keeps the profiles as they are on the branch. */
  readonly folder: string;
  /** The profiles the branch changes, by path. */
  readonly profiles: readonly PreviewedProfile[];
  /** How many profiles the branch leaves as they are. */
  readonly unchanged: number;
}

/**
 * Where a preview stands:
 * - `idle`: none is open.
 * - `loading`: the branch is being read.
 * - `failed`: it couldn't be read, and why.
 * - `ready`: what the branch changes.
 */
export type PreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly branch: string }
  | { readonly kind: 'failed'; readonly branch: string; readonly message: string }
  | ({ readonly kind: 'ready' } & Previewed);

/** The branches to pick from, for the profiles' repository. */
export type BranchList =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'listed';
      readonly base: string;
      readonly branches: readonly string[];
      /** Whether GitHub has more branches than one page lists. */
      readonly more: boolean;
    };

/** The part of the profiles a preview reads: their folder, in a turn among syncs and saves. */
export interface PreviewProfiles {
  read<Result>(work: (folder: string, source: ProfilesSource) => Promise<Result>): Promise<Result>;
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

/** Copies every profile under a folder, and nothing hidden, to another. */
async function copyProfiles(from: string, to: string, prefix = ''): Promise<void> {
  await mkdir(join(to, prefix), { recursive: true });
  for (const entry of await readdir(join(from, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyProfiles(from, to, path);
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      await writeFile(join(to, path), await readFile(join(from, path)));
    }
  }
}

/** The commit the folder last synced with, and each profile's blob id then, from its sync record. */
async function syncRecordOf(folder: string): Promise<{ commit: string | undefined; files: Map<string, string> }> {
  try {
    const record: unknown = JSON.parse(await readFile(join(folder, syncRecord), 'utf8'));
    const files = isRecord(record) && isRecord(record['files']) ? record['files'] : {};
    return {
      commit: isRecord(record) && typeof record['commit'] === 'string' ? record['commit'] : undefined,
      files: new Map(
        Object.entries(files).flatMap(([file, id]) => (typeof id === 'string' ? [[file, id] as const] : [])),
      ),
    };
  } catch {
    return { commit: undefined, files: new Map() };
  }
}

/** The id git gives a file's content, which a sync record lists. */
async function blobId(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const whole = new Uint8Array(header.length + content.byteLength);
  whole.set(header);
  whole.set(content, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Every profile under a folder, by its path there, with nothing hidden. */
async function profilePaths(folder: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...(await profilePaths(folder, path)));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      paths.push(path);
    }
  }
  return paths;
}

/** The profiles a folder changed since its last sync, by path, as its record and its files differ. */
async function localChanges(folder: string, synced: ReadonlyMap<string, string>): Promise<string[]> {
  const changed = new Set<string>();
  const here = await profilePaths(folder);
  for (const path of here) {
    if (synced.get(path) !== (await blobId(await readFile(join(folder, path))))) {
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

/** Lays the branch's changes over a copy of the profiles. */
async function layOver(folder: string, changes: BranchChanges): Promise<void> {
  for (const change of changes.files) {
    if (change.status === 'removed' || change.status === 'renamed') {
      await rm(join(folder, change.status === 'removed' ? change.file : change.previous), { force: true });
    }
  }
  for (const change of changes.files) {
    if (change.status !== 'removed') {
      const target = join(folder, change.file);
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
 * Each profile under a folder, by its path there, read and resolved. A
 * problem names files by their path among the profiles, so the same problem
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

/** The key an entry of a list is known by: an autolink's prefix, or the name of anything else. */
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

/**
 * What applies differently from one resolution of a profile to another, by
 * section, as a comparison names it. Each row says which profile it comes
 * from when that is a base the profile extends, since a change there is a
 * change to every profile that extends it.
 */
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
      from: undefined,
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
      from: undefined,
    });
  }
  if (profileRows.length > 0) {
    sections.push({ section: 'profile', title: 'Profile', rows: profileRows });
  }
  for (const section of order) {
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
          from: sourceOf(section, key, removed) ?? sourceOf(section, key.split('.')[0] ?? key, removed),
        });
      }
    } else {
      const list = section;
      const was = entries(list, before);
      const now = entries(list, after);
      const noun = nouns[list] ?? 'entry';
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
            from: sourceOf(list, key, false),
          });
        } else if (to === undefined) {
          rows.push({
            kind: 'removes',
            label: key,
            key: `${noun} removed`,
            before: 'Set',
            after: 'Removed',
            from: sourceOf(list, key, true),
          });
        } else {
          for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])]) {
            for (const change of narrowed(field, from[field], to[field])) {
              rows.push({
                kind: kindOf(change.from, change.to),
                label: key,
                key: change.path,
                before: say(change.from, 'Not set'),
                after: say(change.to, 'Not set'),
                from: sourceOf(list, key, false),
              });
            }
          }
        }
      }
    }
    if (rows.length > 0) {
      sections.push({ section, title: titles[section], rows });
    }
  }
  return sections;
}

/** Each profile the branch changes, as the page shows it, and how many it leaves alone. */
async function compareSides(
  roots: { readonly before: string; readonly after: string },
  changes: BranchChanges,
): Promise<{ profiles: PreviewedProfile[]; unchanged: number }> {
  const [before, after] = await Promise.all([readSide(roots.before), readSide(roots.after)]);
  const moved = new Map(
    changes.files.flatMap((change) => (change.status === 'renamed' ? [[change.file, change.previous] as const] : [])),
  );
  const movedAway = new Set(moved.values());
  const profiles: PreviewedProfile[] = [];
  let unchanged = 0;
  for (const [path, now] of after) {
    const previous = moved.get(path);
    const was = before.get(previous ?? path);
    const sections = now.resolved === undefined ? [] : previewSections(was?.resolved, now.resolved, roots);
    const textChanged = was?.text !== now.text;
    const status: PreviewStatus =
      was === undefined ? 'added' : previous !== undefined ? 'renamed' : textChanged ? 'changed' : 'through-base';
    if (status === 'through-base' && sections.length === 0 && now.problem === was?.problem) {
      unchanged += 1;
      continue;
    }
    profiles.push({
      path,
      name: now.name,
      folder: now.folder,
      status,
      previous,
      file: now.file,
      problem: now.problem,
      problemBefore: now.problem === undefined ? was?.problem : undefined,
      sections,
      text: textChanged ? { before: was?.text ?? '', after: now.text } : undefined,
    });
  }
  for (const [path, was] of before) {
    if (!after.has(path) && !movedAway.has(path)) {
      profiles.push({
        path,
        name: was.name,
        folder: was.folder,
        status: 'removed',
        previous: undefined,
        file: undefined,
        problem: undefined,
        problemBefore: undefined,
        sections: [],
        text: { before: was.text, after: '' },
      });
    }
  }
  profiles.sort((a, b) => a.path.localeCompare(b.path));
  return { profiles, unchanged };
}

/**
 * A preview of a branch of the profiles' repository: each profile the
 * branch changes, laid over the profiles as they are here, and what that
 * changes in what each one applies. It only reads from GitHub. The branch's
 * profiles are kept in files of their own, which the browser doesn't keep
 * between visits, until the preview closes. One preview counts at a time,
 * so a slower read never replaces a later one.
 */
export class BranchPreview {
  readonly state = signal<PreviewState>({ kind: 'idle' });
  readonly branches = signal<BranchList>({ kind: 'idle' });

  readonly #github: GitHub;
  readonly #profiles: PreviewProfiles;
  readonly #onSignedOut: () => void;
  #turn = 0;
  #listing = 0;
  /** How many previews have been made, which names each one's folder. */
  #made = 0;
  /** The folder the current preview keeps its files in. */
  #folder: string | undefined;

  constructor(github: GitHub, profiles: PreviewProfiles, onSignedOut: () => void) {
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

  /** Lists the branches of the repository the profiles are kept in. */
  async listBranches(repository: string): Promise<void> {
    const turn = (this.#listing += 1);
    this.branches.value = { kind: 'loading' };
    try {
      const listed = await listBranches(this.#github, repository);
      if (turn === this.#listing) {
        this.branches.value = { kind: 'listed', ...listed };
      }
    } catch (error) {
      const message = this.#failed(error);
      if (turn === this.#listing) {
        this.branches.value = { kind: 'failed', message };
      }
    }
  }

  /**
   * Opens a preview of `branch`, unless one of it is already open or being
   * read: a page that shows it again, as on the way back from a comparison,
   * reads nothing.
   */
  async open(branch: string): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'idle' && state.kind !== 'failed' && state.branch === branch) {
      return;
    }
    await this.#load(branch);
  }

  /** Reads the open preview's branch again, as it is on GitHub now, against the profiles as they are here now. */
  async refresh(): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'idle') {
      await this.#load(state.branch);
    }
  }

  /** Closes the preview, leaves behind one still being read, and drops the files it kept. */
  async close(): Promise<void> {
    this.#turn += 1;
    this.state.value = { kind: 'idle' };
    await this.#drop();
  }

  async #drop(): Promise<void> {
    const folder = this.#folder;
    this.#folder = undefined;
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async #load(branch: string): Promise<void> {
    const turn = (this.#turn += 1);
    this.state.value = { kind: 'loading', branch };
    this.#made += 1;
    const folder = `${previewFolder}/${this.#made}`;
    const roots = { before: `${folder}/before`, after: `${folder}/after` };
    try {
      // The profiles as they are here, copied in a turn of their own so no sync changes them while they are read.
      const { source, synced, local } = await this.#profiles.read(async (profiles, from) => {
        if (from.kind !== 'repository') {
          throw new Error('A preview of a branch needs profiles kept in a GitHub repository. Choose one in Settings.');
        }
        await copyProfiles(profiles, roots.before);
        await copyProfiles(profiles, roots.after);
        const record = await syncRecordOf(profiles);
        return { source: from, synced: record.commit, local: await localChanges(profiles, record.files) };
      });
      const changes = await readBranchChanges(this.#github, branch, {
        repository: source.repository,
        path: source.path,
      });
      if (turn !== this.#turn) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
      await layOver(roots.after, changes);
      const { profiles, unchanged } = await compareSides(roots, changes);
      await rm(roots.before, { recursive: true, force: true });
      if (turn !== this.#turn) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
      // The folders change hands at once, so nothing can come between the check above and the new state.
      const old = this.#folder;
      this.#folder = folder;
      this.state.value = {
        kind: 'ready',
        repository: source.repository,
        path: changes.path,
        branch,
        base: changes.base,
        commit: changes.headCommit,
        behind: changes.behind,
        truncated: changes.truncated,
        stale: synced !== changes.baseCommit,
        local,
        preferences: changes.others.includes(preferencesFile),
        folder: roots.after,
        profiles,
        unchanged,
      };
      if (old !== undefined) {
        await rm(old, { recursive: true, force: true });
      }
    } catch (error) {
      const message = this.#failed(error);
      if (turn === this.#turn) {
        this.state.value = { kind: 'failed', branch, message };
        await this.#drop();
      }
      await rm(folder, { recursive: true, force: true });
    }
  }
}
