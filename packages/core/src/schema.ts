import { z } from 'zod';

// Field names are the GitHub REST API's own, so a profile maps onto requests
// without translation and the REST docs describe every key.

/** Settings on the repository itself, read and written at `/repos/{owner}/{repo}`. */
export const repositoryFields = {
  has_issues: z.boolean(),
  has_projects: z.boolean(),
  has_wiki: z.boolean(),
  has_discussions: z.boolean(),
  allow_auto_merge: z.boolean(),
  allow_update_branch: z.boolean(),
  delete_branch_on_merge: z.boolean(),
  web_commit_signoff_required: z.boolean(),
};

/** Merge methods and their commit messages, on the same endpoint. */
export const mergeFields = {
  allow_merge_commit: z.boolean(),
  allow_squash_merge: z.boolean(),
  allow_rebase_merge: z.boolean(),
  merge_commit_title: z.enum(['PR_TITLE', 'MERGE_MESSAGE']),
  merge_commit_message: z.enum(['PR_BODY', 'PR_TITLE', 'BLANK']),
  squash_merge_commit_title: z.enum(['PR_TITLE', 'COMMIT_OR_PR_TITLE']),
  squash_merge_commit_message: z.enum(['PR_BODY', 'COMMIT_MESSAGES', 'BLANK']),
};

// GitHub takes only the title and message pairs that its settings page
// offers, and rejects any other pair with a 422.
export const commitPairs = [
  {
    title: 'merge_commit_title',
    message: 'merge_commit_message',
    allowed: ['MERGE_MESSAGE PR_TITLE', 'PR_TITLE BLANK', 'PR_TITLE PR_BODY'],
  },
  {
    title: 'squash_merge_commit_title',
    message: 'squash_merge_commit_message',
    allowed: ['COMMIT_OR_PR_TITLE COMMIT_MESSAGES', 'PR_TITLE BLANK', 'PR_TITLE COMMIT_MESSAGES', 'PR_TITLE PR_BODY'],
  },
] as const;

/**
 * What GitHub would reject in these merge settings: a title and message pair
 * it does not offer, or every merge method turned off. A setting left out is
 * not checked, so a profile alone and a profile laid over live settings both
 * pass through here.
 */
export function mergeSettingsProblems(merge: MergeSettings): string[] {
  const problems: string[] = [];
  for (const pair of commitPairs) {
    const title = merge[pair.title];
    const message = merge[pair.message];
    if (
      title !== undefined &&
      message !== undefined &&
      !(pair.allowed as readonly string[]).includes(`${title} ${message}`)
    ) {
      problems.push(
        `GitHub does not allow ${pair.title}: ${title} with ${pair.message}: ${message}. Allowed pairs: ${pair.allowed.map((entry) => entry.replace(' ', ' with ')).join(', ')}`,
      );
    }
  }
  if (merge.allow_merge_commit === false && merge.allow_squash_merge === false && merge.allow_rebase_merge === false) {
    problems.push('Every merge method is off; GitHub needs at least one');
  }
  return problems;
}

export const repositorySettings = z.object(repositoryFields).partial().strict();

export const mergeSettings = z.object(mergeFields).partial().strict();

export const selectedActions = z
  .object({
    github_owned_allowed: z.boolean(),
    verified_allowed: z.boolean(),
    patterns_allowed: z.array(z.string()),
  })
  .partial()
  .strict();

export const actionsSettings = z
  .object({
    enabled: z.boolean(),
    allowed_actions: z.enum(['all', 'local_only', 'selected']),
    selected_actions: selectedActions,
    sha_pinning_required: z.boolean(),
    default_workflow_permissions: z.enum(['read', 'write']),
    can_approve_pull_request_reviews: z.boolean(),
  })
  .partial()
  .strict();

export const bypassActor = z
  .object({
    actor_id: z.number().int().nullable(),
    actor_type: z.string(),
    bypass_mode: z.enum(['always', 'pull_request', 'exempt']),
  })
  .strict();

export const rule = z
  .object({
    type: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ruleset = z
  .object({
    name: z.string().min(1),
    target: z.enum(['branch', 'tag', 'push']).optional(),
    enforcement: z.enum(['active', 'evaluate', 'disabled']).optional(),
    bypass_actors: z.array(bypassActor).optional(),
    conditions: z.record(z.string(), z.unknown()).optional(),
    rules: z.array(rule).optional(),
  })
  .strict();

/** A ruleset the profile removes by name. */
const absentRuleset = z
  .object({
    name: z.string().min(1),
    absent: z.literal(true),
  })
  .strict();

export const rulesetEntry = z.union([absentRuleset, ruleset]);

export const environmentReviewer = z
  .object({
    type: z.enum(['User', 'Team']),
    id: z.number().int(),
  })
  .strict();

export const deploymentBranchPolicy = z
  .object({
    protected_branches: z.boolean(),
    custom_branch_policies: z.boolean(),
  })
  .strict()
  .refine((value) => value.protected_branches !== value.custom_branch_policies, {
    message: 'Set exactly one of protected_branches and custom_branch_policies to true',
  });

/** A branch or tag name pattern that may deploy to an environment. */
export const branchPolicy = z
  .object({
    name: z.string().min(1),
    type: z.enum(['branch', 'tag']).optional(),
  })
  .strict();

export const environment = z
  .object({
    name: z.string().min(1),
    wait_timer: z.number().int().min(0).max(43_200).optional(),
    prevent_self_review: z.boolean().optional(),
    reviewers: z.array(environmentReviewer).max(6).optional(),
    deployment_branch_policy: deploymentBranchPolicy.nullable().optional(),
    branch_policies: z.array(branchPolicy).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Name patterns only apply, and GitHub only accepts them, under custom policies.
    if (value.branch_policies !== undefined && value.deployment_branch_policy?.custom_branch_policies !== true) {
      context.addIssue({
        code: 'custom',
        message: 'branch_policies needs deployment_branch_policy with custom_branch_policies: true',
        path: ['branch_policies'],
      });
    }
    // GitHub keeps prevent_self_review on its required-reviewers rule, which needs a reviewer.
    if (value.prevent_self_review === true && value.reviewers?.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'prevent_self_review needs at least one reviewer',
        path: ['prevent_self_review'],
      });
    }
  });

/** An environment the profile removes by name. */
const absentEnvironment = z
  .object({
    name: z.string().min(1),
    absent: z.literal(true),
  })
  .strict();

export const environmentEntry = z.union([absentEnvironment, environment]);

function addDuplicateNameIssues(
  entries: readonly { name: string }[],
  kind: string,
  path: string,
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (names.has(entry.name)) {
      context.addIssue({
        code: 'custom',
        message: `${kind} "${entry.name}" appears more than once`,
        path: [path, index, 'name'],
      });
    }
    names.add(entry.name);
  }
}

export const profile = z
  .object({
    repository: repositorySettings,
    merge: mergeSettings,
    actions: actionsSettings,
    rulesets: z.array(rulesetEntry),
    environments: z.array(environmentEntry),
  })
  .partial()
  .strict()
  .superRefine((value, context) => {
    for (const message of mergeSettingsProblems(value.merge ?? {})) {
      context.addIssue({ code: 'custom', message, path: ['merge'] });
    }
    addDuplicateNameIssues(value.rulesets ?? [], 'Ruleset', 'rulesets', context);
    addDuplicateNameIssues(value.environments ?? [], 'Environment', 'environments', context);
  });

/** A profile file, which may extend another profile file. */
export const profileFile = z
  .object({
    extends: z.string().min(1).optional(),
    repository: repositorySettings.optional(),
    merge: mergeSettings.optional(),
    actions: actionsSettings.optional(),
    rulesets: z.array(rulesetEntry).optional(),
    environments: z.array(environmentEntry).optional(),
  })
  .strict();

export type RepositorySettings = z.infer<typeof repositorySettings>;
export type MergeSettings = z.infer<typeof mergeSettings>;
export type ActionsSettings = z.infer<typeof actionsSettings>;
export type Ruleset = z.infer<typeof ruleset>;
export type RulesetEntry = z.infer<typeof rulesetEntry>;
export type Environment = z.infer<typeof environment>;
export type EnvironmentEntry = z.infer<typeof environmentEntry>;
export type Profile = z.infer<typeof profile>;
export type ProfileFile = z.infer<typeof profileFile>;
