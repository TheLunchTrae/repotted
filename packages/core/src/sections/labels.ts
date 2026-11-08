import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { refusal, type Unavailable } from '../endpoints.js';
import { type GitHub, GitHubError, readAllPages, repoPath, type RepoRef } from '../github.js';
import type { FieldChange } from '../match.js';
import { type Label, type LabelEntry, labelKey } from '../schema.js';

const liveLabel = z.object({ name: z.string(), color: z.string(), description: z.string().nullish() });

/** A label as GitHub stores it, with no description as an empty one. */
export interface LiveLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export type LiveLabels = { readonly available: true; readonly labels: readonly LiveLabel[] } | Unavailable;

/** Reads the repository's labels. */
export async function readLabels(github: GitHub, repo: RepoRef): Promise<LiveLabels> {
  const path = `${repoPath(repo)}/labels`;
  try {
    const labels = await readAllPages(path, async (url) => ({
      items: z.array(liveLabel).parse(await github.request('GET', url)),
    }));
    return {
      available: true,
      labels: labels.map((item) => ({ name: item.name, color: item.color, description: item.description ?? '' })),
    };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403) {
      return { available: false, refused: true, reason: refusal(error, 'GET', path, 'labels') };
    }
    throw error;
  }
}

/** A color as GitHub writes it: six lowercase hex digits without `#`. */
function normalColor(color: string): string {
  return color.replace(/^#/u, '').toLowerCase();
}

function isAbsent(entry: LabelEntry): entry is Extract<LabelEntry, { absent: true }> {
  return entry.absent === true;
}

/**
 * The fields of `entry` that `current` does not hold. A name that differs
 * only in case counts, since GitHub keeps the case it is given.
 */
function labelChanges(entry: Label, current: LiveLabel): FieldChange[] {
  const fields: FieldChange[] = [];
  if (entry.name !== current.name) {
    fields.push({ field: 'name', from: current.name, to: entry.name });
  }
  if (entry.color !== undefined && normalColor(entry.color) !== normalColor(current.color)) {
    fields.push({ field: 'color', from: normalColor(current.color), to: normalColor(entry.color) });
  }
  if (entry.description !== undefined && entry.description !== current.description) {
    fields.push({ field: 'description', from: current.description, to: entry.description });
  }
  return fields;
}

/** The write a field takes in GitHub's label body, where a new name goes as `new_name`. */
function bodyOf(fields: readonly FieldChange[]): Record<string, unknown> {
  return Object.fromEntries(fields.map(({ field, to }) => [field === 'name' ? 'new_name' : field, to]));
}

/**
 * Labels pair with the repository's by name, ignoring case as GitHub does.
 * A label the repository lacks takes the first old name in `renamed_from`
 * that it has and renames it, so issues and pull requests keep the label.
 * Where the repository has the label and an old name too, the old one stays:
 * GitHub cannot merge labels, and deleting it would take it off its issues.
 *
 * Deletes come first and renames before other writes, so a name is free
 * before it is reused.
 */
export function planLabels(desired: readonly LabelEntry[], live: LiveLabels, repo: RepoRef): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [`Skipped labels: ${live.reason}`] };
  }
  const path = `${repoPath(repo)}/labels`;
  const labelPath = (name: string): string => `${path}/${encodeURIComponent(name)}`;
  const find = (name: string): LiveLabel | undefined =>
    live.labels.find((item) => labelKey(item.name) === labelKey(name));
  const deletes: Change[] = [];
  const renames: Change[] = [];
  const updates: Change[] = [];
  const creates: Change[] = [];
  const warnings: string[] = [];
  for (const entry of desired) {
    const current = find(entry.name);
    if (isAbsent(entry)) {
      if (current !== undefined) {
        deletes.push({
          section: 'labels',
          action: 'delete',
          target: entry.name,
          entry: { name: entry.name },
          fields: [],
          request: { method: 'DELETE', path: labelPath(current.name) },
        });
      }
      continue;
    }
    const old = (entry.renamed_from ?? []).flatMap((name) => find(name) ?? []);
    if (current !== undefined && old.length > 0) {
      warnings.push(
        `Label "${entry.name}": left ${old.map((item) => `"${item.name}"`).join(' and ')} as ${old.length === 1 ? 'it is' : 'they are'}, since the repository has "${current.name}" too; move issues to it and remove the old label by hand`,
      );
    } else if (old.length > 1) {
      warnings.push(
        `Label "${entry.name}": renames "${old[0]?.name ?? ''}" and leaves ${old
          .slice(1)
          .map((item) => `"${item.name}"`)
          .join(' and ')}, which the repository has too`,
      );
    }
    const source = current ?? old[0];
    if (source === undefined) {
      creates.push({
        section: 'labels',
        action: 'create',
        target: entry.name,
        entry: { name: entry.name },
        fields: [],
        request: {
          method: 'POST',
          path,
          body: {
            name: entry.name,
            ...(entry.color === undefined ? {} : { color: normalColor(entry.color) }),
            ...(entry.description === undefined ? {} : { description: entry.description }),
          },
        },
      });
      continue;
    }
    const fields = labelChanges(entry, source);
    if (fields.length === 0) {
      continue;
    }
    (source === current ? updates : renames).push({
      section: 'labels',
      action: 'update',
      target: entry.name,
      entry: { name: entry.name },
      fields,
      request: { method: 'PATCH', path: labelPath(source.name), body: bodyOf(fields) },
    });
  }
  return { changes: [...deletes, ...renames, ...updates, ...creates], warnings };
}

/** A label as a profile describes it, for capture. */
export function describeLabel(live: LiveLabel): Label {
  return { name: live.name, color: normalColor(live.color), description: live.description };
}
