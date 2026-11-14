import type { resolveProfile } from '@repotted/core';

/** A file as an editor reads it: a profile, or anything else that resolves over profiles as one does, as an apply's file. */
export type ResolvedProfile = Pick<
  Awaited<ReturnType<typeof resolveProfile>>,
  'chain' | 'profile' | 'drafts' | 'warnings' | 'sources'
> &
  Partial<Pick<Awaited<ReturnType<typeof resolveProfile>>, 'owner_source' | 'owner_changes'>>;

/**
 * The keys of `drafts.unset` that the open file itself lists, as written
 * there. The engine files each key under the name GitHub knows its entry by,
 * so a key that differs only in case is found by that.
 */
export function ownUnsets(saved: ResolvedProfile): string[] {
  const files = Object.entries(saved.sources.drafts.unset);
  return (saved.drafts.unset ?? []).filter((key) => {
    const file =
      saved.sources.drafts.unset[key] ?? files.find(([known]) => known.toLowerCase() === key.toLowerCase())?.[1];
    return file === saved.chain[0];
  });
}

/** The sections of a profile that hold settings. */
export const settingsSections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;
const lists = ['autolinks', 'rulesets', 'environments', 'labels'] as const;

/**
 * Everything the open file's own draft holds, in a form two reads of the
 * file can be compared by: its draft settings, its draft entries, and its
 * keys of `drafts.unset`.
 */
export function ownDraft(saved: ResolvedProfile): unknown {
  const own = saved.chain[0];
  const mine = (files: Readonly<Record<string, string>>): string[] =>
    Object.entries(files)
      .filter(([, file]) => file === own)
      .map(([key]) => key);
  return {
    // A setting in a group goes by `<group>.<key>`, so a base profile's draft of another key in the group stays out.
    settings: settingsSections.map((section) =>
      mine(saved.sources.drafts[section]).map((key) => [
        key,
        key
          .split('.')
          .reduce<unknown>(
            (value, part) => (typeof value === 'object' && value !== null ? Reflect.get(value, part) : undefined),
            saved.drafts[section],
          ),
      ]),
    ),
    entries: lists.map((list) => {
      const names = new Set(mine(saved.sources.drafts[list]).map((name) => name.toLowerCase()));
      const key = list === 'autolinks' ? 'key_prefix' : 'name';
      return (saved.drafts[list] ?? []).filter((entry) => names.has(String(Reflect.get(entry, key)).toLowerCase()));
    }),
    unset: ownUnsets(saved),
  };
}
