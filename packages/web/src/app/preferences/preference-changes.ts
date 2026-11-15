import type { ConfigChange } from '@repotted/core';
import * as z from 'zod/mini';

export const hiddenOwnersKey = 'hidden-repository-owners';
export const hiddenRepositoriesKey = 'hidden-repositories';
export const repositoryFoldersKey = 'repository-folders';

/** Its repositories are by `owner/name`, in the order they were put in. */
export interface Folder {
  readonly name: string;
  readonly repositories: readonly string[];
}

const names = z.array(z.string());
const savedFolders = z.array(z.object({ name: z.string(), repositories: z.array(z.string()) }));

/** GitHub names are case-insensitive, and so are folder names. */
export function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function byFolderName(left: Folder, right: Folder): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

export function namesIn(value: unknown): readonly string[] {
  const parsed = names.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** A file edited by hand may name a folder twice or a repository in two folders: the first of each counts. */
export function foldersIn(value: unknown): readonly Folder[] {
  const parsed = savedFolders.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const folders: Folder[] = [];
  const filed: string[] = [];
  for (const folder of parsed.data) {
    if (folders.some((earlier) => sameName(earlier.name, folder.name))) {
      continue;
    }
    const repositories = folder.repositories.filter(
      (name, index) =>
        !filed.some((other) => sameName(other, name)) &&
        folder.repositories.findIndex((other) => sameName(other, name)) === index,
    );
    filed.push(...repositories);
    folders.push({ name: folder.name, repositories });
  }
  return folders.toSorted(byFolderName);
}

function hiddenChanges(before: unknown, after: unknown, noun: string, nouns: string): ConfigChange[] {
  const hiddenBefore = namesIn(before);
  const hiddenAfter = namesIn(after);
  const isIn = (list: readonly string[], name: string): boolean => list.some((other) => sameName(other, name));
  return [
    ...hiddenAfter.filter((name) => !isIn(hiddenBefore, name)).map((name) => ({ action: 'Hide', noun, nouns, name })),
    ...hiddenBefore.filter((name) => !isIn(hiddenAfter, name)).map((name) => ({ action: 'Show', noun, nouns, name })),
  ];
}

function sharedRepositoryCount(left: Folder, right: Folder): number {
  return left.repositories.filter((name) => right.repositories.some((other) => sameName(other, name))).length;
}

function folderChange(action: string, name: string): ConfigChange {
  return { action, noun: 'folder', nouns: 'folders', name };
}

function repositoryChange(action: string, nounQualifier: string, name: string): ConfigChange {
  return { action, noun: 'repository', nouns: 'repositories', nounQualifier, name };
}

/**
 * Pairs each folder gone with the folder made that shares the most
 * repositories with it, as a rename; a lone folder gone and a lone folder
 * made are a rename too. Changes saved together, such as a rename and a move
 * into the folder, are one commit, so the repositories need not match.
 */
function folderRenames(gone: readonly Folder[], made: readonly Folder[]): Map<Folder, Folder> {
  const renamedTo = new Map<Folder, Folder>();
  const taken = new Set<Folder>();
  for (const folderGone of gone) {
    let best: { folder: Folder; shared: number } | undefined;
    for (const folderMade of made) {
      const shared = sharedRepositoryCount(folderGone, folderMade);
      if (!taken.has(folderMade) && shared > 0 && (best === undefined || shared > best.shared)) {
        best = { folder: folderMade, shared };
      }
    }
    if (best !== undefined) {
      renamedTo.set(folderGone, best.folder);
      taken.add(best.folder);
    }
  }
  const [loneGone] = gone;
  const [loneMade] = made;
  if (gone.length === 1 && made.length === 1 && loneGone !== undefined && loneMade !== undefined) {
    renamedTo.set(loneGone, loneMade);
  }
  return renamedTo;
}

function folderOfEachRepository(folders: readonly Folder[]): Map<string, { repository: string; folder: string }> {
  const filed = new Map<string, { repository: string; folder: string }>();
  for (const folder of folders) {
    for (const repository of folder.repositories) {
      filed.set(repository.toLowerCase(), { repository, folder: folder.name });
    }
  }
  return filed;
}

/**
 * A folder whose name changed only in case is renamed too. A deleted
 * folder's repositories leave it with the folder, so they get no line of
 * their own.
 */
function folderChanges(beforeValue: unknown, afterValue: unknown): ConfigChange[] {
  const before = foldersIn(beforeValue);
  const after = foldersIn(afterValue);
  const findIn = (folders: readonly Folder[], name: string): Folder | undefined =>
    folders.find((other) => sameName(other.name, name));
  const gone = before.filter((folderBefore) => findIn(after, folderBefore.name) === undefined);
  const made = after.filter((folderAfter) => findIn(before, folderAfter.name) === undefined);
  const renamedTo = folderRenames(gone, made);
  const newNameByOldName = new Map<string, string>();
  for (const folderBefore of before) {
    const folderAfter = renamedTo.get(folderBefore) ?? findIn(after, folderBefore.name);
    if (folderAfter !== undefined && folderAfter.name !== folderBefore.name) {
      newNameByOldName.set(folderBefore.name.toLowerCase(), folderAfter.name);
    }
  }
  const madeByRename = new Set(renamedTo.values());
  const deleted = gone.filter((folderGone) => !renamedTo.has(folderGone));
  const changes: ConfigChange[] = [
    ...made
      .filter((folderMade) => !madeByRename.has(folderMade))
      .map((folderMade) => folderChange('Create', folderMade.name)),
    ...before.flatMap((folderBefore) => {
      const newName = newNameByOldName.get(folderBefore.name.toLowerCase());
      return newName === undefined ? [] : [folderChange('Rename', `${folderBefore.name} to ${newName}`)];
    }),
    ...deleted.map((folderGone) => folderChange('Delete', folderGone.name)),
  ];
  const currentName = (name: string): string => newNameByOldName.get(name.toLowerCase()) ?? name;
  const filedBefore = folderOfEachRepository(before);
  const filedAfter = folderOfEachRepository(after);
  for (const [key, { repository, folder: folderBefore }] of filedBefore) {
    const folderWasDeleted = deleted.some((folderGone) => sameName(folderGone.name, folderBefore));
    if (!filedAfter.has(key) && !folderWasDeleted) {
      changes.push(repositoryChange('Take', `out of folder ${currentName(folderBefore)}`, repository));
    }
  }
  for (const [key, { repository, folder: folderAfter }] of filedAfter) {
    const folderBefore = filedBefore.get(key)?.folder;
    if (folderBefore === undefined || !sameName(currentName(folderBefore), folderAfter)) {
      changes.push(repositoryChange('Move', `to folder ${folderAfter}`, repository));
    }
  }
  return changes;
}

const preferenceLabels: Readonly<Record<string, string>> = {
  [hiddenRepositoriesKey]: 'hidden repositories',
  [hiddenOwnersKey]: 'hidden owners',
  [repositoryFoldersKey]: 'folders',
};

function changesOf(key: string, before: unknown, after: unknown): ConfigChange[] {
  if (key === hiddenRepositoriesKey) {
    return hiddenChanges(before, after, 'repository', 'repositories');
  }
  if (key === hiddenOwnersKey) {
    return hiddenChanges(before, after, 'owner', 'owners');
  }
  if (key === repositoryFoldersKey) {
    return folderChanges(before, after);
  }
  return [];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** What saving `after` over `before` changes, for the commit's message. */
export function preferenceChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): ConfigChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return keys.flatMap((key): ConfigChange[] => {
    if (sameValue(before[key], after[key])) {
      return [];
    }
    const described = changesOf(key, before[key], after[key]);
    // Such as a list put in another order, or a key this version doesn't know.
    return described.length > 0
      ? described
      : [{ action: 'Update', noun: 'preference', nouns: 'preferences', name: preferenceLabels[key] ?? key }];
  });
}
