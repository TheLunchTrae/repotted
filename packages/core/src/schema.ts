import { z } from 'zod';

// Field names are the GitHub REST API's own, so a profile maps onto requests
// without translation and the REST docs describe every key.

/** Settings on the repository itself, read and written at `/repos/{owner}/{repo}`. */
export const repositoryFields = {
  description: z.string(),
  homepage: z.string(),
  visibility: z.enum(['public', 'private']),
  default_branch: z.string().min(1),
  is_template: z.boolean(),
  allow_forking: z.boolean(),
  has_issues: z.boolean(),
  has_projects: z.boolean(),
  has_wiki: z.boolean(),
  has_discussions: z.boolean(),
  has_pull_requests: z.boolean(),
  pull_request_creation_policy: z.enum(['all', 'collaborators_only']),
  allow_auto_merge: z.boolean(),
  allow_update_branch: z.boolean(),
  delete_branch_on_merge: z.boolean(),
  web_commit_signoff_required: z.boolean(),
};

/**
 * Repository settings that name one repository rather than describe a
 * setup, so a capture leaves them out and a captured profile does not carry
 * them to other repositories.
 */
export const identifyingRepositoryFields: ReadonlySet<string> = new Set([
  'description',
  'homepage',
  'visibility',
  'topics',
]);

/** A topic as GitHub accepts it: lowercase letters, digits and hyphens, at most 50 characters. */
const topic = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,49}$/u, 'A topic is lowercase letters, digits and hyphens, at most 50 characters');

/**
 * Repository settings that GitHub keeps at endpoints of their own. Each is
 * named for its path, as `immutable_releases` is for
 * `/repos/{owner}/{repo}/immutable-releases`, and an object holds that
 * endpoint's own fields.
 */
export const repositoryEndpointFields = {
  topics: z.array(topic).max(20),
  immutable_releases: z.boolean(),
  pull_request_creation_cap: z
    .object({
      enabled: z.boolean(),
      max_open_pull_requests: z.number().int().min(1),
      include_drafts: z.boolean(),
    })
    .partial()
    .strict(),
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

export const repositorySettings = z
  .object({ ...repositoryFields, ...repositoryEndpointFields })
  .partial()
  .strict();

export const mergeSettings = z.object(mergeFields).partial().strict();

export const selectedActions = z
  .object({
    github_owned_allowed: z.boolean(),
    verified_allowed: z.boolean(),
    patterns_allowed: z.array(z.string()),
  })
  .partial()
  .strict();

/**
 * Actions settings at endpoints of their own under `actions/`. An endpoint
 * with one field goes by that field's name; one with several goes by its
 * path, as `fork_pr_workflows_private_repos` does, and holds its fields.
 */
export const actionsEndpointFields = {
  access_level: z.enum(['none', 'user', 'organization']),
  approval_policy: z.enum([
    'first_time_contributors_new_to_github',
    'first_time_contributors',
    'all_external_contributors',
  ]),
  artifact_and_log_retention: z
    .object({ days: z.number().int().min(1) })
    .partial()
    .strict(),
  fork_pr_workflows_private_repos: z
    .object({
      run_workflows_from_fork_pull_requests: z.boolean(),
      send_write_tokens_to_workflows: z.boolean(),
      send_secrets_and_variables: z.boolean(),
      require_approval_for_fork_pr_workflows: z.boolean(),
    })
    .partial()
    .strict(),
  max_cache_retention_days: z.number().int().min(1),
  max_cache_size_gb: z.number().int().min(1),
  oidc_customization_sub: z
    .object({
      use_default: z.boolean(),
      include_claim_keys: z.array(z.string().regex(/^\w+$/u, 'A claim key is letters, digits and underscores')),
      use_immutable_subject: z.boolean(),
    })
    .partial()
    .strict(),
};

export const actionsSettings = z
  .object({
    enabled: z.boolean(),
    allowed_actions: z.enum(['all', 'local_only', 'selected']),
    selected_actions: selectedActions,
    sha_pinning_required: z.boolean(),
    default_workflow_permissions: z.enum(['read', 'write']),
    can_approve_pull_request_reviews: z.boolean(),
    ...actionsEndpointFields,
  })
  .partial()
  .strict();

const status = z.object({ status: z.enum(['enabled', 'disabled']) }).strict();

/**
 * The `security_and_analysis` object that `/repos/{owner}/{repo}` reads and
 * writes. GitHub reports `dependabot_security_updates` there too, but sets it
 * only through `automated_security_fixes`.
 */
export const securityAndAnalysis = z
  .object({
    advanced_security: status,
    code_security: status,
    secret_scanning: status,
    secret_scanning_push_protection: status,
    secret_scanning_ai_detection: status,
    secret_scanning_non_provider_patterns: status,
    secret_scanning_delegated_alert_dismissal: status,
    secret_scanning_delegated_bypass: status,
    // GitHub Enterprise Cloud only.
    secret_scanning_validity_checks: status,
    secret_scanning_delegated_bypass_options: z
      .object({
        reviewers: z.array(
          z
            .object({
              reviewer_id: z.number().int(),
              reviewer_type: z.enum(['TEAM', 'ROLE']),
              mode: z.enum(['ALWAYS', 'EXEMPT']).optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .partial()
  .strict();

const runnerSetup = {
  runner_type: z.enum(['standard', 'labeled']),
  runner_label: z.string().min(1).nullable(),
};

/**
 * Security and code quality settings, named for their endpoints' paths
 * under the repository, except `security_and_analysis`, which is a field of
 * the repository itself.
 */
export const securityFields = {
  security_and_analysis: securityAndAnalysis,
  vulnerability_alerts: z.boolean(),
  automated_security_fixes: z.boolean(),
  private_vulnerability_reporting: z.boolean(),
  code_scanning_default_setup: z
    .object({
      state: z.enum(['configured', 'not-configured']),
      ...runnerSetup,
      // As GitHub takes them, which a capture leaves out.
      languages: z.array(
        z.enum(['actions', 'c-cpp', 'csharp', 'go', 'java-kotlin', 'javascript-typescript', 'python', 'ruby', 'swift']),
      ),
      query_suite: z.enum(['default', 'extended']),
      threat_model: z.enum(['remote', 'remote_and_local']),
    })
    .partial()
    .strict(),
  code_scanning_ai_scan: z
    .object({ pr_scan: z.enum(['enabled', 'disabled']) })
    .partial()
    .strict(),
  code_quality_setup: z
    .object({
      state: z.enum(['configured', 'not-configured']),
      ...runnerSetup,
      languages: z.array(z.enum(['csharp', 'go', 'java-kotlin', 'javascript-typescript', 'python', 'ruby'])),
      ai_findings_option: z.enum(['disabled', 'on_push']),
    })
    .partial()
    .strict(),
  dependabot_runner_settings: z
    .object({
      runner_type: z.enum(['standard', 'labeled']),
      runner_labels: z.array(z.string().min(1)).max(1),
      // GitHub reports no group as an empty one.
      runner_group: z.string(),
    })
    .partial()
    .strict(),
};

export const securitySettings = z
  .object(securityFields)
  .partial()
  .strict()
  .superRefine((value, context) => {
    // GitHub opens security update pull requests only for the alerts it raises.
    if (value.automated_security_fixes === true && value.vulnerability_alerts === false) {
      context.addIssue({
        code: 'custom',
        message: 'automated_security_fixes needs vulnerability_alerts',
        path: ['automated_security_fixes'],
      });
    }
  });

/** Custom property values by property name; null clears a value. */
export const customProperties = z.record(z.string().min(1), z.union([z.string(), z.array(z.string()), z.null()]));

/**
 * `absent: true` marks an entry that removes, and `draft: true` a draft in a
 * profile file. Every other branch leaves the key out, so entry unions pick
 * their branch by it, and an error names the field that fails rather than the
 * whole entry.
 */
const unmarked = z.undefined().optional();

/** The message for a marking key that holds anything but `true`. */
function marked(key: 'absent' | 'draft'): { error: z.core.$ZodErrorMap } {
  return { error: (issue) => (issue.code === 'invalid_union' ? `${key} is true or left out` : undefined) };
}

export const autolink = z
  .object({
    key_prefix: z.string().min(1),
    url_template: z.string().includes('<num>', { message: 'url_template needs <num>' }),
    is_alphanumeric: z.boolean().optional(),
  })
  .strict();

/** An autolink the profile removes by its prefix. */
const absentAutolink = z
  .object({
    key_prefix: z.string().min(1),
    absent: z.literal(true),
    draft: unmarked,
  })
  .strict();

export const autolinkEntry = z.discriminatedUnion(
  'absent',
  [absentAutolink, autolink.extend({ absent: unmarked, draft: unmarked })],
  marked('absent'),
);

export const pagesSite = z
  .object({
    build_type: z.enum(['legacy', 'workflow']),
    source: z
      .object({
        branch: z.string().min(1),
        path: z.enum(['/', '/docs']),
      })
      .partial()
      .strict(),
    cname: z.string().nullable(),
    https_enforced: z.boolean(),
    // Whether anyone may see the site, rather than only people with read
    // access to the repository. GitHub Enterprise Cloud only.
    public: z.boolean(),
  })
  .partial()
  .strict();

/** A GitHub Pages site the profile turns off. */
const absentPages = z.object({ absent: z.literal(true) }).strict();

export const pagesEntry = z.discriminatedUnion(
  'absent',
  [absentPages, pagesSite.extend({ absent: unmarked })],
  marked('absent'),
);

export const bypassActor = z
  .object({
    actor_id: z.number().int().nullable(),
    actor_type: z.string(),
    bypass_mode: z.enum(['always', 'pull_request', 'exempt']),
  })
  .strict();

const patternParameters = z
  .looseObject({ operator: z.enum(['starts_with', 'ends_with', 'contains', 'regex']) })
  .partial();

/**
 * The parameter values GitHub's REST description allows for known rule types.
 * Each parameter is optional, since a rule keeps the live parameters the
 * profile leaves out. Other parameters, and other rule types, stay open.
 */
const ruleParameters: ReadonlyMap<string, z.ZodType> = new Map(
  Object.entries({
    pull_request: z
      .looseObject({
        allowed_merge_methods: z
          .array(z.enum(['merge', 'squash', 'rebase']))
          .min(1, { message: 'allowed_merge_methods needs at least one merge method' }),
        required_approving_review_count: z.number().int().min(0).max(10),
      })
      .partial(),
    merge_queue: z
      .looseObject({
        check_response_timeout_minutes: z.number().int().min(1).max(360),
        grouping_strategy: z.enum(['ALLGREEN', 'HEADGREEN']),
        max_entries_to_build: z.number().int().min(0).max(100),
        max_entries_to_merge: z.number().int().min(0).max(100),
        merge_method: z.enum(['MERGE', 'SQUASH', 'REBASE']),
        min_entries_to_merge: z.number().int().min(0).max(100),
        min_entries_to_merge_wait_minutes: z.number().int().min(0).max(360),
      })
      .partial(),
    commit_message_pattern: patternParameters,
    commit_author_email_pattern: patternParameters,
    committer_email_pattern: patternParameters,
    branch_name_pattern: patternParameters,
    tag_name_pattern: patternParameters,
    code_quality: z.looseObject({ severity: z.enum(['errors', 'warnings', 'notes', 'all']) }).partial(),
    max_file_path_length: z.looseObject({ max_file_path_length: z.number().int().min(1).max(32_767) }).partial(),
    max_file_size: z.looseObject({ max_file_size: z.number().int().min(1).max(100) }).partial(),
  }),
);

export const rule = z
  .object({
    type: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const result = ruleParameters.get(value.type)?.safeParse(value.parameters ?? {});
    for (const issue of result?.error?.issues ?? []) {
      context.addIssue({ code: 'custom', message: issue.message, path: ['parameters', ...issue.path] });
    }
  });

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
    draft: unmarked,
  })
  .strict();

export const rulesetEntry = z.discriminatedUnion(
  'absent',
  [absentRuleset, ruleset.extend({ absent: unmarked, draft: unmarked })],
  marked('absent'),
);

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
    const patterns = new Set<string>();
    for (const [index, policy] of (value.branch_policies ?? []).entries()) {
      const key = `${policy.type ?? 'branch'} ${policy.name}`;
      if (patterns.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `Pattern "${key}" appears more than once`,
          path: ['branch_policies', index, 'name'],
        });
      }
      patterns.add(key);
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
    draft: unmarked,
  })
  .strict();

export const environmentEntry = z.discriminatedUnion(
  'absent',
  [absentEnvironment, environment.extend({ absent: unmarked, draft: unmarked })],
  marked('absent'),
);

/** GitHub treats environment names as case-insensitive, so entries pair by this key. */
export function environmentKey(name: string): string {
  return name.toLowerCase();
}

function addDuplicateNameIssues(
  entries: readonly { name: string }[],
  kind: string,
  path: string,
  context: z.RefinementCtx,
  key: (name: string) => string = (name) => name,
): void {
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (names.has(key(entry.name))) {
      context.addIssue({
        code: 'custom',
        message: `${kind} "${entry.name}" appears more than once`,
        path: [path, index, 'name'],
      });
    }
    names.add(key(entry.name));
  }
}

export const profile = z
  .object({
    repository: repositorySettings,
    merge: mergeSettings,
    actions: actionsSettings,
    security: securitySettings,
    custom_properties: customProperties,
    pages: pagesEntry,
    autolinks: z.array(autolinkEntry),
    rulesets: z.array(rulesetEntry),
    environments: z.array(environmentEntry),
  })
  .partial()
  .strict()
  .superRefine((value, context) => {
    for (const message of mergeSettingsProblems(value.merge ?? {})) {
      context.addIssue({ code: 'custom', message, path: ['merge'] });
    }
    addDuplicateNameIssues(
      (value.autolinks ?? []).map((entry) => ({ name: entry.key_prefix })),
      'Autolink',
      'autolinks',
      context,
    );
    addDuplicateNameIssues(value.rulesets ?? [], 'Ruleset', 'rulesets', context);
    addDuplicateNameIssues(value.environments ?? [], 'Environment', 'environments', context, environmentKey);
  });

/**
 * A ruleset or environment saved as a draft. Only its name has to be valid:
 * the rest may be unfinished, and plan and apply leave it out.
 */
export const draftEntry = z.looseObject({
  name: z.string().min(1),
  draft: z.literal(true),
});

/** An autolink saved as a draft, known by its prefix as an autolink is. */
export const draftAutolink = z.looseObject({
  key_prefix: z.string().min(1),
  draft: z.literal(true),
});

// A dot joins a group to its key in a draft's path, as
// `selected_actions.verified_allowed`, so no name may hold one.
const draftValues = z.record(z.string(), z.unknown()).superRefine((values, context) => {
  for (const [key, value] of Object.entries(values)) {
    const inner = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
    const paths = [[key], ...inner.map((name) => [key, name])].filter((path) => path.at(-1)?.includes('.') === true);
    for (const path of paths) {
      context.addIssue({ code: 'custom', message: 'A draft setting name cannot contain a dot', path });
    }
  }
});

/**
 * Draft settings by section, one for each section that holds settings. Any
 * key and value is kept, since a draft may be unfinished; what would stop it
 * from applying is a warning.
 */
export const draftSettings = z
  .object({
    repository: draftValues,
    merge: draftValues,
    actions: draftValues,
    security: draftValues,
    custom_properties: draftValues,
    pages: draftValues,
  })
  .partial()
  .strict();

/** A profile file, which may extend another profile file. */
export const profileFile = z
  .object({
    extends: z.string().min(1).optional(),
    repository: repositorySettings.optional(),
    merge: mergeSettings.optional(),
    actions: actionsSettings.optional(),
    security: securitySettings.optional(),
    custom_properties: customProperties.optional(),
    pages: pagesEntry.optional(),
    autolinks: z.array(z.discriminatedUnion('draft', [draftAutolink, autolinkEntry], marked('draft'))).optional(),
    rulesets: z.array(z.discriminatedUnion('draft', [draftEntry, rulesetEntry], marked('draft'))).optional(),
    environments: z.array(z.discriminatedUnion('draft', [draftEntry, environmentEntry], marked('draft'))).optional(),
    drafts: draftSettings.optional(),
  })
  .strict();

/**
 * The JSON Schema of a profile file, for editors and other tools that read
 * profiles. It holds each key and the values it takes, but not the checks
 * that span keys, such as merge commit pairs and repeated names, which only
 * Repotted makes. It is Draft 7, which editors' YAML support reads.
 */
export function profileFileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(profileFile, {
    target: 'draft-07',
    io: 'input',
    // `undefined` is `unmarked`: an entry branch that leaves a marking key out.
    unrepresentable: ({ zodSchema }) => (zodSchema._zod.def.type === 'undefined' ? { not: {} } : 'throw'),
  });
}

export type RepositorySettings = z.infer<typeof repositorySettings>;
export type MergeSettings = z.infer<typeof mergeSettings>;
export type ActionsSettings = z.infer<typeof actionsSettings>;
export type SecuritySettings = z.infer<typeof securitySettings>;
export type CustomProperties = z.infer<typeof customProperties>;
export type AutolinkEntry = z.infer<typeof autolinkEntry>;
export type PagesEntry = z.infer<typeof pagesEntry>;
export type Ruleset = z.infer<typeof ruleset>;
export type RulesetEntry = z.infer<typeof rulesetEntry>;
export type Environment = z.infer<typeof environment>;
export type EnvironmentEntry = z.infer<typeof environmentEntry>;
export type Profile = z.infer<typeof profile>;
export type ProfileFile = z.infer<typeof profileFile>;
export type DraftEntry = z.infer<typeof draftEntry>;
export type DraftAutolink = z.infer<typeof draftAutolink>;
