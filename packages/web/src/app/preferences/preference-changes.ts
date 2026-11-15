import type { ConfigChange } from '@repotted/core';
import * as z from 'zod/mini';

export const hiddenOwnersKey = 'hidden-repository-owners';
export const hiddenRepositoriesKey = 'hidden-repositories';
export const repositoryFoldersKey = 'repository-folders';

const names = z.array(z.string());
const savedFolders = z.array(z.object({ name: z.string(), repositories: z.array(z.string()) }));

interface SavedFolder {
  readonly name: string;
  readonly repositories: readonly string[];
}

function namesIn(value: unknown): readonly string[] {
  const parsed = names.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function foldersIn(value: unknown): readonly SavedFolder[] {
  const parsed = savedFolders.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function lower(name: string): string {
  return name.toLowerCase();
}

function namesAddedAndRemoved(
  before: readonly string[],
  after: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const beforeNames = new Set(before.map(lower));
  const afterNames = new Set(after.map(lower));
  return {
    added: after.filter((name) => !beforeNames.has(lower(name))),
    removed: before.filter((name) => !afterNames.has(lower(name))),
  };
}

function hiddenChanges(before: unknown, after: unknown, noun: string, nouns: string): ConfigChange[] {
  const { added, removed } = namesAddedAndRemoved(namesIn(before), namesIn(after));
  return [
    ...added.map((name) => ({ action: 'Hide', noun, nouns, name })),
    ...removed.map((name) => ({ action: 'Show', noun, nouns, name })),
  ];
}

function sameRepositories(left: SavedFolder, right: SavedFolder): boolean {
  const leftNames = new Set(left.repositories.map(lower));
  return (
    leftNames.size === new Set(right.repositories.map(lower)).size &&
    right.repositories.every((name) => leftNames.has(lower(name)))
  );
}

function folderOfEachRepository(folders: readonly SavedFolder[]): Map<string, { repository: string; folder: string }> {
  const filed = new Map<string, { repository: string; folder: string }>();
  for (const folder of folders) {
    for (const repository of folder.repositories) {
      if (!filed.has(lower(repository))) {
        filed.set(lower(repository), { repository, folder: folder.name });
      }
    }
  }
  return filed;
}

function folder(action: string, name: string): ConfigChange {
  return { action, noun: 'folder', nouns: 'folders', name };
}

/**
 * A folder gone and one made with the same repositories is a rename, and so is
 * a folder whose name changed only in case. A deleted folder's repositories
 * leave it with the folder, so they get no line of their own.
 */
function folderChanges(beforeValue: unknown, afterValue: unknown): ConfigChange[] {
  const before = foldersIn(beforeValue);
  const after = foldersIn(afterValue);
  const findIn = (folders: readonly SavedFolder[], name: string): SavedFolder | undefined =>
    folders.find((other) => lower(other.name) === lower(name));
  const renamedTo = new Map<string, string>();
  for (const kept of before) {
    const same = findIn(after, kept.name);
    if (same !== undefined && same.name !== kept.name) {
      renamedTo.set(lower(kept.name), same.name);
    }
  }
  const gone = before.filter((kept) => findIn(after, kept.name) === undefined);
  const made = after.filter((kept) => findIn(before, kept.name) === undefined);
  const madeByRename = new Set<SavedFolder>();
  for (const old of gone) {
    const renamed = made.find((candidate) => !madeByRename.has(candidate) && sameRepositories(old, candidate));
    if (renamed !== undefined) {
      madeByRename.add(renamed);
      renamedTo.set(lower(old.name), renamed.name);
    }
  }
  const deleted = gone.filter((old) => !renamedTo.has(lower(old.name)));
  const changes: ConfigChange[] = [
    ...made.filter((created) => !madeByRename.has(created)).map((created) => folder('Create', created.name)),
    ...[...renamedTo].map(([old, renamed]) =>
      folder('Rename', `${before.find((kept) => lower(kept.name) === old)?.name ?? old} to ${renamed}`),
    ),
    ...deleted.map((old) => folder('Delete', old.name)),
  ];
  const deletedNames = new Set(deleted.map((old) => lower(old.name)));
  const filedBefore = folderOfEachRepository(before);
  const filedAfter = folderOfEachRepository(after);
  for (const [key, { repository, folder: folderBefore }] of filedBefore) {
    if (!filedAfter.has(key) && !deletedNames.has(lower(folderBefore))) {
      changes.push({
        action: 'Take',
        noun: 'repository',
        nouns: 'repositories',
        after: `out of folder ${folderBefore}`,
        name: repository,
      });
    }
  }
  for (const [key, { repository, folder: folderAfter }] of filedAfter) {
    const was = filedBefore.get(key)?.folder;
    const wasAfterRename = was === undefined ? undefined : (renamedTo.get(lower(was)) ?? was);
    if (wasAfterRename === undefined || lower(wasAfterRename) !== lower(folderAfter)) {
      changes.push({
        action: 'Move',
        noun: 'repository',
        nouns: 'repositories',
        after: `to folder ${folderAfter}`,
        name: repository,
      });
    }
  }
  return changes;
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
    const described =
      key === hiddenRepositoriesKey
        ? hiddenChanges(before[key], after[key], 'repository', 'repositories')
        : key === hiddenOwnersKey
          ? hiddenChanges(before[key], after[key], 'owner', 'owners')
          : key === repositoryFoldersKey
            ? folderChanges(before[key], after[key])
            : [];
    // Such as a list put in another order, or a key this version doesn't know.
    return described.length > 0
      ? described
      : [{ action: 'Update', noun: 'preference', nouns: 'preferences', name: key }];
  });
}
