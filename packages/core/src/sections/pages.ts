import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { type EndpointValue, readResource } from '../endpoints.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import type { PagesEntry } from '../schema.js';

const liveSite = z.object({
  build_type: z.enum(['legacy', 'workflow']).nullish(),
  source: z.object({ branch: z.string(), path: z.enum(['/', '/docs']) }).nullish(),
  cname: z.string().nullish(),
  https_enforced: z.boolean().nullish(),
  public: z.boolean().nullish(),
});

/** The settings of a Pages site that a profile can set, as GitHub reports them. */
interface LiveSite {
  readonly build_type?: 'legacy' | 'workflow';
  readonly source?: { branch: string; path: '/' | '/docs' };
  readonly cname: string | null;
  readonly https_enforced?: boolean;
  readonly public?: boolean;
}

/** The repository's Pages site, or null when it has none. */
export type LivePages =
  | { readonly available: true; readonly site: LiveSite | null }
  | Extract<EndpointValue, { available: false }>;

export async function readPages(github: GitHub, repo: RepoRef): Promise<LivePages> {
  const read = await readResource(github, repo, '/pages', 'GitHub Pages', null);
  if (!read.available) {
    return read;
  }
  if (read.value === null) {
    return { available: true, site: null };
  }
  const {
    build_type: buildType,
    source,
    cname,
    https_enforced: httpsEnforced,
    public: isPublic,
  } = liveSite.parse(read.value);
  return {
    available: true,
    site: {
      ...(buildType === 'legacy' || buildType === 'workflow' ? { build_type: buildType } : {}),
      ...(source === null || source === undefined ? {} : { source }),
      cname: cname ?? null,
      ...(typeof httpsEnforced === 'boolean' ? { https_enforced: httpsEnforced } : {}),
      ...(typeof isPublic === 'boolean' ? { public: isPublic } : {}),
    },
  };
}

function isAbsent(entry: PagesEntry): entry is Extract<PagesEntry, { absent: true }> {
  return 'absent' in entry;
}

/**
 * Plans the Pages site: creates it when the profile describes one the
 * repository lacks, then sets what creating it cannot, and deletes it for
 * `absent: true`.
 */
export function planPages(desired: PagesEntry, live: LivePages, repo: RepoRef): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [`Skipped pages: ${live.reason}`] };
  }
  const path = `${repoPath(repo)}/pages`;
  const target = 'GitHub Pages site';
  const { site } = live;
  if (isAbsent(desired)) {
    return {
      changes:
        site === null
          ? []
          : [{ section: 'pages', action: 'delete', target, fields: [], request: { method: 'DELETE', path } }],
      warnings: [],
    };
  }
  const changes: Change[] = [];
  const { cname, https_enforced: httpsEnforced, public: isPublic, ...created } = desired;
  if (site === null) {
    changes.push({
      section: 'pages',
      action: 'create',
      target,
      fields: [],
      request: { method: 'POST', path, body: created },
    });
    const later = {
      ...(cname === undefined ? {} : { cname }),
      ...(httpsEnforced === undefined ? {} : { https_enforced: httpsEnforced }),
      ...(isPublic === undefined ? {} : { public: isPublic }),
    };
    if (Object.keys(later).length > 0) {
      changes.push({
        section: 'pages',
        action: 'update',
        target,
        fields: Object.entries(later).map(([field, to]) => ({ field, to })),
        request: { method: 'PUT', path, body: later },
      });
    }
    return { changes, warnings: [] };
  }
  const fields = fieldChanges(desired, { ...site });
  if (fields.length > 0) {
    const body: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field.field, field.to]));
    // The source is written whole, so it keeps the live part the profile leaves out.
    if (desired.source !== undefined) {
      body['source'] = { ...site.source, ...desired.source };
    }
    changes.push({ section: 'pages', action: 'update', target, fields, request: { method: 'PUT', path, body } });
  }
  return { changes, warnings: [] };
}

/**
 * A site as a profile describes it, for capture. A site built by a workflow
 * has no source to keep, the custom domain belongs to one repository, and
 * who may see the site follows the repository's visibility.
 */
export function describePages(site: LiveSite): PagesEntry {
  return {
    ...(site.build_type === undefined ? {} : { build_type: site.build_type }),
    ...(site.source === undefined || site.build_type === 'workflow' ? {} : { source: site.source }),
    ...(site.https_enforced === undefined ? {} : { https_enforced: site.https_enforced }),
  };
}
