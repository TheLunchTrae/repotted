import type { Change, SectionPlan } from '../change.js';
import { type Endpoint, type EndpointValue, planEndpoint, readEndpoints } from '../endpoints.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges, matches } from '../match.js';
import {
  commitPairs,
  mergeFields,
  type MergeSettings,
  mergeSettingsProblems,
  type Profile,
  repositoryEndpointFields,
  repositoryFields,
  type RepositorySettings,
} from '../schema.js';

/** Repository settings at endpoints of their own; `topics` comes with the repository instead. */
export const repositoryEndpoints: readonly Endpoint[] = [
  {
    kind: 'toggle',
    key: 'immutable_releases',
    path: '/immutable-releases',
    target: 'release immutability',
    reads: 'enabled',
    // GitHub answers 404 while immutable releases are off.
    missingIsOff: true,
  },
  {
    kind: 'object',
    key: 'pull_request_creation_cap',
    path: '/interaction-limits/pulls/creation-cap',
    target: 'pull request creation cap',
    method: 'PATCH',
    schema: repositoryEndpointFields.pull_request_creation_cap,
    carries: ['enabled'],
  },
];

export interface LiveRepository {
  /** The repository's own settings and its topics. */
  readonly repository: Record<string, unknown>;
  readonly merge: MergeSettings;
  /** The repository's `security_and_analysis`, which GitHub reports only to admins. */
  readonly securityAndAnalysis: Record<string, unknown> | undefined;
  /** The endpoint settings read, by key. */
  readonly endpoints: ReadonlyMap<string, EndpointValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

/**
 * Reads the repository and the endpoint settings in `endpointKeys`. Values
 * stay as GitHub sends them, such as `internal` visibility, so they differ
 * from any a profile can set; only an empty description or homepage, which
 * GitHub sends as null, reads as the empty string a profile writes.
 */
export async function readRepository(
  github: GitHub,
  repo: RepoRef,
  endpointKeys: readonly string[] = repositoryEndpoints.map((endpoint) => endpoint.key),
): Promise<LiveRepository> {
  const data = await github.request('GET', repoPath(repo));
  const record = isRecord(data) ? data : {};
  const repository = pick(record, [...Object.keys(repositoryFields), 'topics']);
  for (const key of ['description', 'homepage']) {
    if (record[key] === null) {
      repository[key] = '';
    }
  }
  const security = record['security_and_analysis'];
  return {
    repository,
    merge: pick(record, Object.keys(mergeFields)),
    securityAndAnalysis: isRecord(security) ? security : undefined,
    endpoints: await readEndpoints(
      github,
      repo,
      repositoryEndpoints.filter((endpoint) => endpointKeys.includes(endpoint.key)),
    ),
  };
}

function settingsChange(
  section: 'repository' | 'merge',
  target: string,
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  repo: RepoRef,
): Change[] {
  const fields = fieldChanges(desired, live);
  if (fields.length === 0) {
    return [];
  }
  const body: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field.field, field.to]));
  // GitHub takes a commit message setting only with its title setting, so a
  // write of either carries both, using the live value for the other.
  for (const { title, message } of commitPairs) {
    if (title in body || message in body) {
      for (const key of [title, message]) {
        const value = body[key] ?? desired[key] ?? live[key];
        if (value !== undefined) {
          body[key] = value;
        }
      }
    }
  }
  return [
    {
      section,
      action: 'update',
      target,
      fields,
      request: {
        method: 'PATCH',
        path: repoPath(repo),
        body,
      },
    },
  ];
}

/** Merge settings that GitHub would reject once the profile is laid over the live ones. */
export class MergeSettingsError extends Error {
  constructor(problems: readonly string[]) {
    super(`The merge settings would be invalid on the repository:\n${problems.map((line) => `  ${line}`).join('\n')}`);
    this.name = 'MergeSettingsError';
  }
}

// What a change of visibility does beyond the setting, from GitHub's docs.
const visibilityWarnings: Readonly<Record<string, string>> = {
  public: 'Changing visibility to public shows the repository, its history and its issues to everyone',
  private:
    'Changing visibility to private detaches public forks and drops stars and watchers from people without access',
};

/** The settings the repository's own PATCH writes, without topics and endpoint settings. */
function ownSettings(settings: RepositorySettings): Record<string, unknown> {
  const elsewhere = new Set(['topics', ...repositoryEndpoints.map((endpoint) => endpoint.key)]);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !elsewhere.has(key)));
}

export function planRepository(
  desired: Pick<Profile, 'repository' | 'merge'>,
  live: LiveRepository,
  repo: RepoRef,
): SectionPlan {
  if (desired.merge !== undefined) {
    // A commit message pair the profile leaves out is never sent, so the
    // live pair is checked only beside a profile that names half of it.
    const named = desired.merge;
    const unsent = commitPairs
      .filter(({ title, message }) => named[title] === undefined && named[message] === undefined)
      .flatMap(({ title, message }) => [title, message]);
    const merged = { ...live.merge, ...named };
    const problems = mergeSettingsProblems(
      Object.fromEntries(Object.entries(merged).filter(([key]) => !unsent.some((pairKey) => pairKey === key))),
    );
    if (problems.length > 0) {
      throw new MergeSettingsError(problems);
    }
  }
  const changes: Change[] = [];
  const warnings: string[] = [];
  if (desired.repository !== undefined) {
    const own = settingsChange(
      'repository',
      'repository settings',
      ownSettings(desired.repository),
      live.repository,
      repo,
    );
    changes.push(...own);
    const visibility = own[0]?.fields.find((field) => field.field === 'visibility');
    const warning = visibility === undefined ? undefined : visibilityWarnings[String(visibility.to)];
    if (warning !== undefined) {
      warnings.push(warning);
    }
    const { topics } = desired.repository;
    const liveTopics = live.repository['topics'] ?? [];
    if (topics !== undefined && !matches(topics, liveTopics)) {
      changes.push({
        section: 'repository',
        action: 'update',
        target: 'topics',
        fields: [{ field: 'topics', from: liveTopics, to: topics }],
        request: { method: 'PUT', path: `${repoPath(repo)}/topics`, body: { names: topics } },
      });
    }
    for (const endpoint of repositoryEndpoints) {
      const value: unknown = Reflect.get(desired.repository, endpoint.key);
      const current = live.endpoints.get(endpoint.key);
      if (value !== undefined && current !== undefined) {
        const plan = planEndpoint('repository', endpoint, value, current, repo);
        changes.push(...plan.changes);
        warnings.push(...plan.warnings);
      }
    }
  }
  if (desired.merge !== undefined) {
    changes.push(...settingsChange('merge', 'merge methods', desired.merge, live.merge, repo));
  }
  return { changes, warnings };
}
