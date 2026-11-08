import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import type { Unavailable } from '../endpoints.js';
import { type GitHub, GitHubError, readAllPages, repoPath, type RepoRef } from '../github.js';
import { bodyChanges, matches } from '../match.js';
import { type Environment, type EnvironmentEntry, environmentKey } from '../schema.js';

type Reviewer = NonNullable<Environment['reviewers']>[number];

/** The settings an environment write sends, as GitHub reports them. */
interface EnvironmentSettings {
  readonly wait_timer: number;
  readonly prevent_self_review: boolean;
  readonly reviewers: Reviewer[];
  readonly deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
}

interface BranchPolicy {
  readonly id: number;
  readonly name: string;
  readonly type: 'branch' | 'tag';
}

export interface LiveEnvironment {
  readonly name: string;
  readonly settings: EnvironmentSettings;
  /** Read only under custom branch policies, where they apply. */
  readonly branchPolicies: readonly BranchPolicy[];
}

export type LiveEnvironments =
  | { readonly available: true; readonly environments: readonly LiveEnvironment[] }
  | Unavailable;

// GitHub reports the settings as protection rules, and leaves a rule out
// while it holds its default.
const protectionRule = z.object({
  type: z.string(),
  wait_timer: z.number().int().optional(),
  prevent_self_review: z.boolean().optional(),
  reviewers: z
    .array(z.object({ type: z.enum(['User', 'Team']), reviewer: z.object({ id: z.number().int() }) }))
    .optional(),
});

const environmentList = z.object({
  total_count: z.number().int(),
  environments: z.array(
    z.object({
      name: z.string(),
      protection_rules: z.array(protectionRule).nullish(),
      deployment_branch_policy: z
        .object({ protected_branches: z.boolean(), custom_branch_policies: z.boolean() })
        .nullish(),
    }),
  ),
});

const policyList = z.object({
  total_count: z.number().int(),
  branch_policies: z.array(
    z.object({ id: z.number().int(), name: z.string(), type: z.enum(['branch', 'tag']).optional() }),
  ),
});

function environmentPath(repo: RepoRef, name: string): string {
  return `${repoPath(repo)}/environments/${encodeURIComponent(name)}`;
}

function settingsFrom(listed: z.infer<typeof environmentList>['environments'][number]): EnvironmentSettings {
  const rules = listed.protection_rules ?? [];
  const reviewers = rules.find((rule) => rule.type === 'required_reviewers');
  return {
    wait_timer: rules.find((rule) => rule.type === 'wait_timer')?.wait_timer ?? 0,
    prevent_self_review: reviewers?.prevent_self_review ?? false,
    reviewers: (reviewers?.reviewers ?? []).map((entry) => ({ type: entry.type, id: entry.reviewer.id })),
    deployment_branch_policy: listed.deployment_branch_policy ?? null,
  };
}

async function readAll(github: GitHub, repo: RepoRef): Promise<LiveEnvironment[]> {
  const listed = await readAllPages(`${repoPath(repo)}/environments`, async (url) => {
    const page = environmentList.parse(await github.request('GET', url));
    return { total: page.total_count, items: page.environments };
  });
  const environments: LiveEnvironment[] = [];
  for (const entry of listed) {
    const settings = settingsFrom(entry);
    const branchPolicies =
      settings.deployment_branch_policy?.custom_branch_policies === true
        ? await readAllPages(`${environmentPath(repo, entry.name)}/deployment-branch-policies`, async (url) => {
            const page = policyList.parse(await github.request('GET', url));
            return {
              total: page.total_count,
              items: page.branch_policies.map((policy) => ({ ...policy, type: policy.type ?? 'branch' })),
            };
          })
        : [];
    environments.push({ name: entry.name, settings, branchPolicies });
  }
  return environments;
}

/** Reads the repository's environments with the branch and tag patterns that may deploy to each. */
export async function readEnvironments(github: GitHub, repo: RepoRef): Promise<LiveEnvironments> {
  try {
    return { available: true, environments: await readAll(github, repo) };
  } catch (error) {
    // A GitHub App without the Actions read permission gets a 403 listing
    // environments or their deployment patterns.
    if (error instanceof GitHubError && error.status === 403) {
      return {
        available: false,
        cause: 'refused',
        reason: `GitHub refused to read environments (${error.message}); reading them needs the Actions read permission`,
      };
    }
    throw error;
  }
}

/** An environment as a profile describes it, for capture. */
export function describeEnvironment(live: LiveEnvironment): Environment {
  return {
    name: live.name,
    ...live.settings,
    ...(live.settings.deployment_branch_policy?.custom_branch_policies === true
      ? { branch_policies: live.branchPolicies.map((policy) => ({ name: policy.name, type: policy.type })) }
      : {}),
  };
}

function isAbsent(entry: EnvironmentEntry): entry is Extract<EnvironmentEntry, { absent: true }> {
  return entry.absent === true;
}

/**
 * The settings to write. The endpoint replaces every setting, so each one the
 * profile leaves out is sent with its live value, or its default for a new
 * environment.
 */
function writeSettings(entry: Environment, current: EnvironmentSettings | undefined): EnvironmentSettings {
  const reviewers = entry.reviewers ?? current?.reviewers ?? [];
  return {
    wait_timer: entry.wait_timer ?? current?.wait_timer ?? 0,
    // Removing every reviewer removes the rule that holds prevent_self_review.
    prevent_self_review:
      entry.prevent_self_review ?? (reviewers.length === 0 ? false : current?.prevent_self_review) ?? false,
    reviewers,
    deployment_branch_policy:
      entry.deployment_branch_policy === undefined
        ? (current?.deployment_branch_policy ?? null)
        : entry.deployment_branch_policy,
  };
}

function desiredSettings(entry: Environment): Omit<Environment, 'name' | 'branch_policies'> {
  const { name: _name, branch_policies: _policies, ...settings } = entry;
  return settings;
}

/** Environment settings that GitHub would not keep once the profile is laid over the live ones. */
export class EnvironmentSettingsError extends Error {
  constructor(name: string) {
    super(`Environment "${name}" sets prevent_self_review but would have no reviewers; add reviewers to the profile`);
    this.name = 'EnvironmentSettingsError';
  }
}

/**
 * Environment writes come first, so custom branch policies are on before
 * their name patterns are added. Patterns the profile drops are deleted
 * before new ones are added, so no branch or tag outside both lists can
 * deploy in between. Environments the profile removes go last.
 */
export function planEnvironments(
  desired: readonly EnvironmentEntry[],
  live: LiveEnvironments,
  repo: RepoRef,
): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [{ section: 'environments', cause: live.cause, message: live.reason }] };
  }
  const byName = new Map(live.environments.map((entry) => [environmentKey(entry.name), entry]));
  const writes: Change[] = [];
  const policyDeletes: Change[] = [];
  const policyCreates: Change[] = [];
  const deletes: Change[] = [];

  for (const entry of desired) {
    const current = byName.get(environmentKey(entry.name));
    // GitHub matches names without case, so requests use the name it holds.
    const name = current?.name ?? entry.name;
    const path = environmentPath(repo, name);
    if (isAbsent(entry)) {
      if (current !== undefined) {
        deletes.push({
          section: 'environments',
          action: 'delete',
          target: name,
          entry: { name: entry.name },
          fields: [],
          request: { method: 'DELETE', path },
        });
      }
      continue;
    }
    const body = writeSettings(entry, current?.settings);
    if (body.prevent_self_review && body.reviewers.length === 0) {
      throw new EnvironmentSettingsError(name);
    }
    if (current === undefined || !matches(desiredSettings(entry), current.settings)) {
      writes.push({
        section: 'environments',
        action: current === undefined ? 'create' : 'update',
        target: name,
        entry: { name: entry.name },
        fields: bodyChanges(body, current?.settings),
        request: { method: 'PUT', path, body },
      });
    }
    if (entry.branch_policies === undefined) {
      continue;
    }
    const unused = [...(current?.branchPolicies ?? [])];
    for (const policy of entry.branch_policies) {
      const type = policy.type ?? 'branch';
      const index = unused.findIndex((candidate) => candidate.name === policy.name && candidate.type === type);
      if (index === -1) {
        policyCreates.push({
          section: 'environments',
          action: 'create',
          target: `${name}: ${type} ${policy.name}`,
          entry: { name: entry.name, branch_policy: { name: policy.name, type } },
          fields: [
            { field: 'name', to: policy.name },
            { field: 'type', to: type },
          ],
          request: { method: 'POST', path: `${path}/deployment-branch-policies`, body: { name: policy.name, type } },
        });
      } else {
        unused.splice(index, 1);
      }
    }
    for (const policy of unused) {
      policyDeletes.push({
        section: 'environments',
        action: 'delete',
        target: `${name}: ${policy.type} ${policy.name}`,
        entry: { name: entry.name, branch_policy: { name: policy.name, type: policy.type } },
        fields: [],
        request: { method: 'DELETE', path: `${path}/deployment-branch-policies/${policy.id}` },
      });
    }
  }

  return { changes: [...writes, ...policyDeletes, ...policyCreates, ...deletes], warnings: [] };
}
