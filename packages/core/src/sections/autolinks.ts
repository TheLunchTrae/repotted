import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { readResource, type Unavailable } from '../endpoints.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import type { AutolinkEntry } from '../schema.js';

const liveAutolink = z.object({
  id: z.number().int(),
  key_prefix: z.string(),
  url_template: z.string(),
  is_alphanumeric: z.boolean(),
});

export type LiveAutolink = z.infer<typeof liveAutolink>;

export type LiveAutolinks = { readonly available: true; readonly autolinks: readonly LiveAutolink[] } | Unavailable;

/** Reads the repository's autolinks. GitHub sends them all in one list. */
export async function readAutolinks(github: GitHub, repo: RepoRef): Promise<LiveAutolinks> {
  const read = await readResource(github, repo, '/autolinks', 'autolinks');
  return read.available ? { available: true, autolinks: z.array(liveAutolink).parse(read.value) } : read;
}

function isAbsent(entry: AutolinkEntry): entry is Extract<AutolinkEntry, { absent: true }> {
  return entry.absent === true;
}

/**
 * GitHub cannot edit an autolink, so one that differs is deleted and made
 * again. Deletes come first, so a prefix is free before it is reused.
 */
export function planAutolinks(desired: readonly AutolinkEntry[], live: LiveAutolinks, repo: RepoRef): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [`Skipped autolinks: ${live.reason}`] };
  }
  const path = `${repoPath(repo)}/autolinks`;
  const deletes: Change[] = [];
  const creates: Change[] = [];
  for (const entry of desired) {
    const current = live.autolinks.find((item) => item.key_prefix === entry.key_prefix);
    const remove = (): void => {
      if (current !== undefined) {
        deletes.push({
          section: 'autolinks',
          action: 'delete',
          target: entry.key_prefix,
          fields: [],
          request: { method: 'DELETE', path: `${path}/${current.id}` },
        });
      }
    };
    if (isAbsent(entry)) {
      remove();
      continue;
    }
    // GitHub makes an autolink alphanumeric unless told otherwise.
    const wanted = { ...entry, is_alphanumeric: entry.is_alphanumeric ?? true };
    const fields = fieldChanges(wanted, current);
    if (current !== undefined && fields.length === 0) {
      continue;
    }
    remove();
    creates.push({
      section: 'autolinks',
      action: 'create',
      target: entry.key_prefix,
      fields: current === undefined ? [] : fields,
      request: { method: 'POST', path, body: wanted },
    });
  }
  return { changes: [...deletes, ...creates], warnings: [] };
}

/** An autolink as a profile describes it, for capture. */
export function describeAutolink(autolink: LiveAutolink): AutolinkEntry {
  return {
    key_prefix: autolink.key_prefix,
    url_template: autolink.url_template,
    is_alphanumeric: autolink.is_alphanumeric,
  };
}
