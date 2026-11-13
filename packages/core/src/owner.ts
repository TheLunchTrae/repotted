/**
 * What owns the repositories a profile is for, as GitHub's `owner.type`
 * says: a personal account or an organization. A profile without one is for
 * any owner.
 */
export const ownerTypes = ['user', 'organization'] as const;

export type OwnerType = (typeof ownerTypes)[number];

/**
 * Who has a setting or one of its values: only personal accounts, only
 * organizations, or only organizations on GitHub Enterprise Cloud.
 */
export type OwnerNeed = 'user' | 'organization' | 'enterprise';

/** A setting, or one value of it, that only some owners have. */
interface SettingRule {
  /** The section and key, as `['pages', 'public']`, or a whole section, as `['custom_properties']`. */
  readonly path: readonly string[];
  /** The one value that needs the owner; any value when left out. */
  readonly value?: string;
  readonly needs: OwnerNeed;
}

/**
 * The settings, and values of settings, that GitHub has only for some
 * owners. [Settings coverage](../../../docs/developer/settings-coverage.md#owners)
 * gives GitHub's docs for each.
 */
export const settingRules: readonly SettingRule[] = [
  { path: ['repository', 'allow_forking'], needs: 'organization' },
  { path: ['actions', 'access_level'], value: 'user', needs: 'user' },
  { path: ['actions', 'access_level'], value: 'organization', needs: 'organization' },
  { path: ['actions', 'fork_pr_workflows_private_repos'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'advanced_security'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'code_security'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_ai_detection'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_non_provider_patterns'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_delegated_alert_dismissal'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_delegated_bypass'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_delegated_bypass_options'], needs: 'organization' },
  { path: ['security', 'security_and_analysis', 'secret_scanning_validity_checks'], needs: 'enterprise' },
  { path: ['security', 'code_quality_setup'], needs: 'organization' },
  { path: ['custom_properties'], needs: 'organization' },
  { path: ['pages', 'public'], needs: 'enterprise' },
];

/** Ruleset targets only organizations have. */
const organizationTargets: ReadonlySet<string> = new Set(['push']);

/** Ruleset rules only organizations have. */
const organizationRules: ReadonlySet<string> = new Set(['merge_queue', 'code_quality']);

/** Bypass actors only organizations have. */
const organizationActors: ReadonlySet<string> = new Set([
  'OrganizationAdmin',
  'Team',
  'EnterpriseOwner',
  'EnterpriseRole',
]);

/** Environment reviewers only organizations have. */
const organizationReviewers: ReadonlySet<string> = new Set(['Team']);

/** Whether an owner of `type` has what `needs` asks for. A profile for any owner has everything. */
export function ownerHas(type: OwnerType | undefined, needs: OwnerNeed): boolean {
  return type === undefined || (needs === 'user' ? type === 'user' : type === 'organization');
}

/** How an owner type reads in a message. */
export function describeOwnerType(type: OwnerType): string {
  return type === 'user' ? 'personal accounts' : 'organizations';
}

function describeNeed(needs: OwnerNeed): string {
  return {
    user: 'only personal accounts have',
    organization: 'only organizations have',
    enterprise: 'only organizations on GitHub Enterprise Cloud have',
  }[needs];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root);
}

/**
 * One part of a profile that its owner type doesn't have. `path` is where it
 * is, and `edit` is what an owner type change does to it: unset a setting,
 * drop an entry, or write the entry without what it can't have.
 */
export interface OwnerConflict {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly edit:
    | { readonly path: readonly string[]; readonly value: undefined }
    | {
        readonly list: 'rulesets' | 'environments';
        readonly name: string;
        /** Whether the entry is a draft. */
        readonly draft?: true;
        readonly entry: Readonly<Record<string, unknown>> | undefined;
      };
}

/** Whether draft rulesets and environments are checked too. */
interface ConflictOptions {
  readonly drafts?: boolean;
}

/** Whether to check an entry, and what to call it in a message. */
function checkedEntry(
  entry: unknown,
  kind: 'Ruleset' | 'Environment',
  { drafts = false }: ConflictOptions,
): { entry: Readonly<Record<string, unknown>>; name: string; where: string; draft?: true } | undefined {
  // An entry that removes holds nothing to conflict.
  if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['absent'] === true) {
    return undefined;
  }
  const name = entry['name'];
  if (entry['draft'] !== true) {
    return { entry, name, where: `${kind} "${name}"` };
  }
  return drafts ? { entry, name, where: `Draft ${kind.toLowerCase()} "${name}"`, draft: true } : undefined;
}

function settingConflicts(settings: unknown, type: OwnerType, at: readonly string[] = []): OwnerConflict[] {
  return settingRules.flatMap((rule) => {
    const value = valueAt(settings, rule.path);
    if (value === undefined || (rule.value !== undefined && value !== rule.value) || ownerHas(type, rule.needs)) {
      return [];
    }
    const name = rule.path.join('.');
    const message = `${rule.value === undefined ? name : `${name}: ${rule.value}`} is something ${describeNeed(rule.needs)}, and this profile is for ${describeOwnerType(type)}`;
    // A whole section goes setting by setting, as an edit names one setting.
    const paths =
      rule.path.length === 1 && isRecord(value) ? Object.keys(value).map((key) => [...rule.path, key]) : [rule.path];
    return paths.map((path) => ({
      path: [...at, ...path],
      message,
      edit: { path: [...at, ...path], value: undefined },
    }));
  });
}

/** Writes `list` into `entry` without what `bad` picks, and leaves it out once nothing is left. */
function keepList(
  entry: Record<string, unknown>,
  key: string,
  list: readonly unknown[],
  bad: (item: unknown) => boolean,
): void {
  if (!list.some(bad)) {
    return;
  }
  const kept = list.filter((item) => !bad(item));
  if (kept.length > 0) {
    entry[key] = kept;
  } else {
    Reflect.deleteProperty(entry, key);
  }
}

function rulesetConflicts(
  rulesets: readonly unknown[] | undefined,
  type: OwnerType,
  options: ConflictOptions,
): OwnerConflict[] {
  if (type !== 'user') {
    return [];
  }
  return (rulesets ?? []).flatMap((item, index): OwnerConflict[] => {
    const checked = checkedEntry(item, 'Ruleset', options);
    if (checked === undefined) {
      return [];
    }
    const { entry, name, where } = checked;
    const draft = checked.draft === undefined ? {} : { draft: checked.draft };
    if (typeof entry['target'] === 'string' && organizationTargets.has(entry['target'])) {
      return [
        {
          path: ['rulesets', index, 'target'],
          message: `${where} is a push ruleset, which only organizations have`,
          edit: { list: 'rulesets', name, ...draft, entry: undefined },
        },
      ];
    }
    const rules = Array.isArray(entry['rules']) ? entry['rules'] : [];
    const actors = Array.isArray(entry['bypass_actors']) ? entry['bypass_actors'] : [];
    const badRule = (rule: unknown): boolean =>
      isRecord(rule) && typeof rule['type'] === 'string' && organizationRules.has(rule['type']);
    const badActor = (actor: unknown): boolean =>
      isRecord(actor) && typeof actor['actor_type'] === 'string' && organizationActors.has(actor['actor_type']);
    if (!rules.some(badRule) && !actors.some(badActor)) {
      return [];
    }
    // A list left empty goes, so the ruleset doesn't manage it.
    const kept: Record<string, unknown> = { ...entry };
    keepList(kept, 'rules', rules, badRule);
    keepList(kept, 'bypass_actors', actors, badActor);
    const edit = { list: 'rulesets' as const, name, ...draft, entry: kept };
    return [
      ...rules.flatMap((rule, at) =>
        badRule(rule)
          ? [
              {
                path: ['rulesets', index, 'rules', at],
                message: `${where} has a ${String(valueAt(rule, ['type']))} rule, which only organizations have`,
                edit,
              },
            ]
          : [],
      ),
      ...actors.flatMap((actor, at) =>
        badActor(actor)
          ? [
              {
                path: ['rulesets', index, 'bypass_actors', at],
                message: `${where} lets ${String(valueAt(actor, ['actor_type']))} bypass it, which only organizations have`,
                edit,
              },
            ]
          : [],
      ),
    ];
  });
}

function environmentConflicts(
  environments: readonly unknown[] | undefined,
  type: OwnerType,
  options: ConflictOptions,
): OwnerConflict[] {
  if (type !== 'user') {
    return [];
  }
  return (environments ?? []).flatMap((item, index): OwnerConflict[] => {
    const checked = checkedEntry(item, 'Environment', options);
    if (checked === undefined) {
      return [];
    }
    const { entry, name, where } = checked;
    const draft = checked.draft === undefined ? {} : { draft: checked.draft };
    const reviewers: readonly unknown[] = Array.isArray(entry['reviewers']) ? entry['reviewers'] : [];
    const bad = (reviewer: unknown): boolean =>
      isRecord(reviewer) && typeof reviewer['type'] === 'string' && organizationReviewers.has(reviewer['type']);
    const kept: Record<string, unknown> = { ...entry };
    keepList(kept, 'reviewers', reviewers, bad);
    // Self review is a setting of the reviewers, so it goes with them.
    if (!('reviewers' in kept)) {
      delete kept['prevent_self_review'];
    }
    const edit = { list: 'environments' as const, name, ...draft, entry: kept };
    return reviewers.flatMap((reviewer, at) =>
      bad(reviewer)
        ? [
            {
              path: ['environments', index, 'reviewers', at],
              message: `${where} has a team as a reviewer, which only organizations have`,
              edit,
            },
          ]
        : [],
    );
  });
}

/**
 * The parts of a profile that owners of `type` don't have. A profile for any
 * owner has none. Draft rulesets and environments count only with `drafts`,
 * since a draft may be unfinished.
 */
export function ownerConflicts(
  value: object,
  type: OwnerType | undefined,
  options: ConflictOptions = {},
): OwnerConflict[] {
  if (type === undefined) {
    return [];
  }
  const list = (key: string): readonly unknown[] | undefined => {
    const found: unknown = Reflect.get(value, key);
    return Array.isArray(found) ? found : undefined;
  };
  return [
    ...settingConflicts(value, type),
    ...rulesetConflicts(list('rulesets'), type, options),
    ...environmentConflicts(list('environments'), type, options),
  ];
}

/** The draft settings that owners of `type` don't have, under `drafts`. */
export function draftOwnerConflicts(drafts: object | undefined, type: OwnerType | undefined): OwnerConflict[] {
  return type === undefined || drafts === undefined ? [] : settingConflicts(drafts, type, ['drafts']);
}

/** Removes the value at `path`, and each object that leaves empty. */
function removeAt(root: object, path: readonly string[]): void {
  const [key, ...rest] = path;
  if (key === undefined) {
    return;
  }
  const child: unknown = Reflect.get(root, key);
  if (rest.length > 0) {
    if (!isRecord(child)) {
      return;
    }
    removeAt(child, rest);
    if (Object.keys(child).length > 0) {
      return;
    }
  }
  Reflect.deleteProperty(root, key);
}

/**
 * `value` without the parts owners of `type` don't have: each such setting
 * removed, a push ruleset dropped, and a ruleset or environment written
 * without what only organizations have. `dropped` says what went.
 */
export function withoutOwnerConflicts<Value extends object>(
  value: Value,
  type: OwnerType | undefined,
): { value: Value; dropped: OwnerConflict[] } {
  const dropped = ownerConflicts(value, type);
  const kept = structuredClone(value);
  for (const { edit } of dropped) {
    if ('list' in edit) {
      const entries: unknown = Reflect.get(kept, edit.list);
      const index = Array.isArray(entries)
        ? entries.findIndex((entry) => isRecord(entry) && entry['name'] === edit.name)
        : -1;
      if (Array.isArray(entries) && index !== -1) {
        if (edit.entry === undefined) {
          entries.splice(index, 1);
        } else {
          entries.splice(index, 1, edit.entry);
        }
      }
      continue;
    }
    removeAt(kept, edit.path);
  }
  return { value: kept, dropped };
}
