import { z } from 'zod';

import type { Change, SectionPlan, Warning } from '../change.js';
import type { Endpoint } from '../endpoints.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import { actionsEndpointFields, type ActionsSettings } from '../schema.js';

/** Actions settings at endpoints of their own, which apply after the policy. */
export const actionsEndpoints: readonly Endpoint[] = [
  {
    kind: 'field',
    key: 'access_level',
    path: '/actions/permissions/access',
    target: 'access from other repositories',
    method: 'PUT',
  },
  {
    kind: 'field',
    key: 'approval_policy',
    path: '/actions/permissions/fork-pr-contributor-approval',
    target: 'approval for fork pull request workflows',
    method: 'PUT',
  },
  {
    kind: 'object',
    key: 'fork_pr_workflows_private_repos',
    path: '/actions/permissions/fork-pr-workflows-private-repos',
    target: 'fork pull request workflows in private repositories',
    method: 'PUT',
    schema: actionsEndpointFields.fork_pr_workflows_private_repos,
  },
  {
    kind: 'object',
    key: 'artifact_and_log_retention',
    path: '/actions/permissions/artifact-and-log-retention',
    target: 'artifact and log retention',
    method: 'PUT',
    schema: actionsEndpointFields.artifact_and_log_retention,
  },
  {
    kind: 'field',
    key: 'max_cache_retention_days',
    path: '/actions/cache/retention-limit',
    target: 'cache retention',
    method: 'PUT',
  },
  {
    kind: 'field',
    key: 'max_cache_size_gb',
    path: '/actions/cache/storage-limit',
    target: 'cache storage',
    method: 'PUT',
  },
  {
    kind: 'object',
    key: 'oidc_customization_sub',
    path: '/actions/oidc/customization/sub',
    target: 'OIDC subject claim',
    method: 'PUT',
    schema: actionsEndpointFields.oidc_customization_sub,
    // GitHub uses the claim keys only in place of the default subject.
    adjust: (desired) => {
      if (desired['include_claim_keys'] === undefined) {
        return { desired };
      }
      if (desired['use_default'] === true) {
        const { include_claim_keys: _keys, ...rest } = desired;
        return {
          desired: rest,
          dropped: { fields: ['include_claim_keys'], reason: 'GitHub ignores claim keys while use_default is true' },
        };
      }
      return { desired: { ...desired, use_default: false } };
    },
  },
];

const livePermissions = z.object({
  enabled: z.boolean(),
  allowed_actions: z.enum(['all', 'local_only', 'selected']).optional(),
  sha_pinning_required: z.boolean().optional(),
});

const liveSelected = z.object({
  github_owned_allowed: z.boolean().optional(),
  verified_allowed: z.boolean().optional(),
  patterns_allowed: z.array(z.string()).optional(),
});

const liveWorkflow = z.object({
  default_workflow_permissions: z.enum(['read', 'write']),
  can_approve_pull_request_reviews: z.boolean(),
});

export async function readActions(github: GitHub, repo: RepoRef): Promise<ActionsSettings> {
  const base = `${repoPath(repo)}/actions/permissions`;
  const permissions = livePermissions.parse(await github.request('GET', base));
  const workflow = liveWorkflow.parse(await github.request('GET', `${base}/workflow`));
  // GitHub only serves the selected-actions list while the policy is `selected`.
  const selected =
    permissions.allowed_actions === 'selected'
      ? liveSelected.parse(await github.request('GET', `${base}/selected-actions`))
      : undefined;
  return {
    ...permissions,
    ...(selected === undefined ? {} : { selected_actions: selected }),
    ...workflow,
  };
}

function only<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Plans the three Actions endpoints in the order they must run: the policy,
 * then its selected-actions list, then workflow token permissions. Each write
 * is a PUT, so its body carries live values for the keys the profile omits.
 */
export function planActions(desired: ActionsSettings, live: ActionsSettings, repo: RepoRef): SectionPlan {
  const base = `${repoPath(repo)}/actions/permissions`;
  const changes: Change[] = [];
  const warnings: Warning[] = [];

  const enabled = desired.enabled ?? live.enabled ?? true;
  const allowed = desired.allowed_actions ?? live.allowed_actions;
  for (const key of ['allowed_actions', 'sha_pinning_required'] as const) {
    if (!enabled && desired[key] !== undefined) {
      warnings.push({
        section: 'actions',
        key,
        cause: 'not_applicable',
        message: 'it only applies while Actions is enabled',
      });
    }
  }
  const shaPinning = desired.sha_pinning_required ?? live.sha_pinning_required;
  const policy = only(desired, enabled ? ['enabled', 'allowed_actions', 'sha_pinning_required'] : ['enabled']);
  const policyFields = fieldChanges(policy, live);
  if (policyFields.length > 0) {
    changes.push({
      section: 'actions',
      action: 'update',
      target: 'Actions policy',
      fields: policyFields,
      request: {
        method: 'PUT',
        path: base,
        body: {
          enabled,
          ...(enabled && allowed !== undefined ? { allowed_actions: allowed } : {}),
          ...(enabled && shaPinning !== undefined ? { sha_pinning_required: shaPinning } : {}),
        },
      },
    });
  }

  if (desired.selected_actions !== undefined) {
    if (!enabled || allowed !== 'selected') {
      warnings.push({
        section: 'actions',
        key: 'selected_actions',
        cause: 'not_applicable',
        message: 'it only applies while Actions is enabled with allowed_actions: selected',
      });
    } else {
      const fields = fieldChanges(desired.selected_actions, live.selected_actions);
      if (fields.length > 0) {
        changes.push({
          section: 'actions',
          action: 'update',
          target: 'selected actions',
          fields: fields.map((field) => ({ ...field, field: `selected_actions.${field.field}` })),
          request: {
            method: 'PUT',
            path: `${base}/selected-actions`,
            body: { ...live.selected_actions, ...desired.selected_actions },
          },
        });
      }
    }
  }

  const workflowKeys = ['default_workflow_permissions', 'can_approve_pull_request_reviews'] as const;
  const workflowFields = fieldChanges(only(desired, workflowKeys), live);
  if (workflowFields.length > 0) {
    changes.push({
      section: 'actions',
      action: 'update',
      target: 'workflow permissions',
      fields: workflowFields,
      request: {
        method: 'PUT',
        path: `${base}/workflow`,
        body: { ...only(live, workflowKeys), ...only(desired, workflowKeys) },
      },
    });
  }

  return { changes, warnings };
}
