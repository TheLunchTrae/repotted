import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import type { ActionsSettings } from '../schema.js';

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
  const warnings: string[] = [];

  const enabled = desired.enabled ?? live.enabled ?? true;
  const allowed = desired.allowed_actions ?? live.allowed_actions;
  for (const key of ['allowed_actions', 'sha_pinning_required'] as const) {
    if (!enabled && desired[key] !== undefined) {
      warnings.push(`Skipped ${key}: it only applies while Actions is enabled`);
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
      warnings.push(
        'Skipped selected_actions: it only applies while Actions is enabled with allowed_actions: selected',
      );
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
