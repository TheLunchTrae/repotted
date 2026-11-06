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
    target: z.enum(['branch', 'tag', 'push']).default('branch'),
    enforcement: z.enum(['active', 'evaluate', 'disabled']).default('active'),
    bypass_actors: z.array(bypassActor).default([]),
    conditions: z.record(z.string(), z.unknown()).optional(),
    rules: z.array(rule).default([]),
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

export const profile = z
  .object({
    repository: repositorySettings,
    merge: mergeSettings,
    actions: actionsSettings,
    rulesets: z.array(rulesetEntry),
  })
  .partial()
  .strict()
  .superRefine((value, context) => {
    const names = new Set<string>();
    for (const [index, entry] of (value.rulesets ?? []).entries()) {
      if (names.has(entry.name)) {
        context.addIssue({
          code: 'custom',
          message: `Ruleset "${entry.name}" appears more than once`,
          path: ['rulesets', index, 'name'],
        });
      }
      names.add(entry.name);
    }
  });

/** A profile file, which may extend another profile file. */
export const profileFile = z
  .object({
    extends: z.string().min(1).optional(),
    repository: repositorySettings.optional(),
    merge: mergeSettings.optional(),
    actions: actionsSettings.optional(),
    rulesets: z.array(rulesetEntry).optional(),
  })
  .strict();

export type RepositorySettings = z.infer<typeof repositorySettings>;
export type MergeSettings = z.infer<typeof mergeSettings>;
export type ActionsSettings = z.infer<typeof actionsSettings>;
export type Ruleset = z.infer<typeof ruleset>;
export type RulesetEntry = z.infer<typeof rulesetEntry>;
export type Profile = z.infer<typeof profile>;
export type ProfileFile = z.infer<typeof profileFile>;
