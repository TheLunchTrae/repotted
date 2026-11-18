import type { EditableProfile } from '@repotted/core';

/** A profile, or a staged apply's file, which resolves over profiles as a profile does. */
export type ResolvedProfile = Pick<EditableProfile, 'chain' | 'profile' | 'drafts' | 'warnings' | 'sources'> &
  Partial<
    Pick<
      EditableProfile,
      | 'kind'
      | 'references'
      | 'owner_source'
      | 'owner_changes'
      | 'problems'
      | 'entryPositions'
      | 'draftEntryPositions'
      | 'rawText'
      | 'unknownFields'
    >
  >;

/**
 * The engine files each key under the name GitHub knows its entry by, so a
 * key that differs only in case still counts as the open file's own.
 */
export function ownUnsets(saved: ResolvedProfile): string[] {
  const files = Object.entries(saved.sources.drafts.unset);
  return (saved.drafts.unset ?? []).filter((key) => {
    const file =
      saved.sources.drafts.unset[key] ?? files.find(([known]) => known.toLowerCase() === key.toLowerCase())?.[1];
    return file === saved.chain[0];
  });
}

export const settingsSections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;
const entrySections = ['autolinks', 'rulesets', 'environments', 'labels'] as const;

export function comparableOwnDraft(saved: ResolvedProfile): unknown {
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
        (section === 'custom_properties' ? [key] : key.split('.')).reduce<unknown>(
          (value, part) => (typeof value === 'object' && value !== null ? Reflect.get(value, part) : undefined),
          saved.drafts[section],
        ),
      ]),
    ),
    entries: entrySections.map((list) => {
      const names = new Set(mine(saved.sources.drafts[list]).map((name) => name.toLowerCase()));
      const key = list === 'autolinks' ? 'key_prefix' : 'name';
      return (saved.drafts[list] ?? []).filter((entry) => names.has(String(Reflect.get(entry, key)).toLowerCase()));
    }),
    unset: ownUnsets(saved),
  };
}
