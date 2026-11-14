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
