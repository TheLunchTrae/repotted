import type { resolveProfile } from '@repotted/core';

type ResolvedProfile = Awaited<ReturnType<typeof resolveProfile>>;

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

const sections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;
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
    settings: sections.map((section) => {
      const keys = new Set(mine(saved.sources.drafts[section]).map((key) => key.split('.')[0]));
      return Object.entries(saved.drafts[section] ?? {}).filter(([key]) => keys.has(key));
    }),
    entries: lists.map((list) => {
      const names = new Set(mine(saved.sources.drafts[list]).map((name) => name.toLowerCase()));
      const key = list === 'autolinks' ? 'key_prefix' : 'name';
      return (saved.drafts[list] ?? []).filter((entry) => names.has(String(Reflect.get(entry, key)).toLowerCase()));
    }),
    unset: ownUnsets(saved),
  };
}
