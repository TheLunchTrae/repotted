// What the ruleset, environment, and label forms write. Each function takes
// an entry and answers the entry with one thing changed, leaving every key
// it doesn't name as it was, so what a form doesn't show stays as the
// profile's file has it. `saved` is the entry as the file has it, when it
// has one: a change back to what is saved gives the saved shape again, so an
// entry typed in and put back is no change.

export type Entry = Readonly<Record<string, unknown>>;

export function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function entries(value: unknown): readonly Entry[] {
  return items(value).filter(isEntry);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

export function uniqueTrimmedNonBlankLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    ),
  ];
}

/** Undefined leaves the key out, so each repository keeps its own. */
export function withKey(entry: Entry, key: string, value: unknown): Entry {
  const { [key]: _old, ...rest } = entry;
  return value === undefined ? rest : { ...rest, [key]: value };
}

export function refNames(entry: Entry, side: RefSide): readonly string[] {
  const conditions = isEntry(entry['conditions']) ? entry['conditions'] : {};
  const refName = isEntry(conditions['ref_name']) ? conditions['ref_name'] : {};
  return items(refName[side]).map(String);
}

/**
 * GitHub takes the two sides together, so both are written, and with neither
 * the condition goes. GitHub matches the names in any order, so the same
 * names as saved give the saved shape back.
 */
export function withRefNames(entry: Entry, side: RefSide, names: readonly string[], saved?: Entry): Entry {
  const next = { include: refNames(entry, 'include'), exclude: refNames(entry, 'exclude'), [side]: names };
  const conditions = isEntry(entry['conditions']) ? entry['conditions'] : {};
  if (
    saved !== undefined &&
    sameMembers(next.include, refNames(saved, 'include')) &&
    sameMembers(next.exclude, refNames(saved, 'exclude'))
  ) {
    const savedConditions = isEntry(saved['conditions']) ? saved['conditions'] : {};
    const { ref_name: _old, ...others } = conditions;
    const restored = 'ref_name' in savedConditions ? { ...others, ref_name: savedConditions['ref_name'] } : others;
    return withKey(entry, 'conditions', Object.keys(restored).length > 0 ? restored : undefined);
  }
  const { ref_name: _old, ...others } = conditions;
  const merged = next.include.length + next.exclude.length > 0 ? { ...others, ref_name: next } : others;
  return withKey(entry, 'conditions', Object.keys(merged).length > 0 ? merged : undefined);
}

export type RefSide = 'include' | 'exclude';

/** GitHub's ruleset targets other than a ref pattern: each repository's default branch, and every branch or tag. */
export const defaultBranchTarget = '~DEFAULT_BRANCH';
export const allRefsTarget = '~ALL';

function isNamedRefTarget(name: string): boolean {
  return name === defaultBranchTarget || name === allRefsTarget;
}

/** Undefined when the profile leaves the target to each repository. */
export function rulesetTarget(entry: Entry): 'branch' | 'tag' | 'push' | undefined {
  const target = entry['target'];
  return target === 'branch' || target === 'tag' || target === 'push' ? target : undefined;
}

export function refPatterns(entry: Entry, side: RefSide): readonly string[] {
  return refNames(entry, side).filter((name) => !isNamedRefTarget(name));
}

/** Selecting adds the target at the end, so the names the file has keep their order. */
export function withNamedRefTarget(
  entry: Entry,
  side: RefSide,
  target: string,
  selected: boolean,
  saved?: Entry,
): Entry {
  const others = refNames(entry, side).filter((name) => name !== target);
  return withRefNames(entry, side, selected ? [...others, target] : others, saved);
}

/** A named target typed among the patterns is selected. */
export function withRefPatterns(entry: Entry, side: RefSide, typed: readonly string[], saved?: Entry): Entry {
  const named = refNames(entry, side).filter(isNamedRefTarget);
  const typedNamed = typed.filter((name) => isNamedRefTarget(name) && !named.includes(name));
  const patterns = typed.filter((name) => !isNamedRefTarget(name));
  return withRefNames(entry, side, [...named, ...typedNamed, ...patterns], saved);
}

const refPrefixes = { branch: 'refs/heads/', tag: 'refs/tags/' } as const;

/** What git refuses in a ref name, leaving out what fnmatch patterns use. */
const sequencesRefNamesRefuse = ['..', '//', '\\', ':', '^', '~', '@{'] as const;

/**
 * Why GitHub would refuse a ref pattern or match nothing with it. A ruleset
 * whose target is left to each repository may hold branch or tag patterns.
 */
export function refPatternProblem(pattern: string, target: 'branch' | 'tag' | undefined): string | undefined {
  if (pattern.startsWith('~')) {
    return `${pattern} isn't a target GitHub knows.`;
  }
  const prefix =
    target === undefined
      ? Object.values(refPrefixes).find((candidate) => pattern.startsWith(candidate))
      : refPrefixes[target];
  if (prefix === undefined || !pattern.startsWith(prefix)) {
    return target === 'tag'
      ? 'Start each tag pattern with refs/tags/, as in refs/tags/v*.'
      : target === 'branch'
        ? 'Start each branch pattern with refs/heads/, as in refs/heads/release/*.'
        : 'Start each pattern with refs/heads/ for branches or refs/tags/ for tags.';
  }
  const kind = prefix === refPrefixes.tag ? 'tag' : 'branch';
  const name = pattern.slice(prefix.length);
  if (name === '') {
    return `${pattern} needs a ${kind} name or pattern after it.`;
  }
  if (/[\s\p{Cc}]/u.test(name)) {
    return `${pattern}: a ${kind} name can't have spaces.`;
  }
  const refused = sequencesRefNamesRefuse.find((sequence) => name.includes(sequence));
  if (refused !== undefined) {
    return `${pattern}: a ${kind} name can't have ${refused}.`;
  }
  const ending = ['/', '.lock', '.'].find((end) => name.endsWith(end));
  if (ending !== undefined) {
    return `${pattern}: a ${kind} name can't end with ${ending}.`;
  }
  return name.split('/').some((part) => part.startsWith('.'))
    ? `${pattern}: no part of a ${kind} name can start with a dot.`
    : undefined;
}

/** A push ruleset's patterns are refused whole, by `namedRefTargetsProblem`. */
export function refPatternsProblem(entry: Entry, side: RefSide): string | undefined {
  const target = rulesetTarget(entry);
  if (target === 'push') {
    return undefined;
  }
  return refPatterns(entry, side)
    .map((pattern) => refPatternProblem(pattern, target))
    .find((problem) => problem !== undefined);
}

export function namedRefTargetsProblem(entry: Entry, side: RefSide): string | undefined {
  const target = rulesetTarget(entry);
  const names = refNames(entry, side);
  if (target === 'push' && names.length > 0) {
    return 'A push ruleset has no branch or tag targets. Deselect them.';
  }
  return target === 'tag' && names.includes(defaultBranchTarget)
    ? "A tag ruleset can't target the default branch. Deselect it."
    : undefined;
}

/** The first reason, of both sides, why GitHub would refuse the ruleset's targets or match nothing with them. */
export function refTargetsProblem(entry: Entry): string | undefined {
  return (['include', 'exclude'] as const)
    .map((side) => namedRefTargetsProblem(entry, side) ?? refPatternsProblem(entry, side))
    .find((problem) => problem !== undefined);
}

export function ruleOf(entry: Entry | undefined, type: string): Entry | undefined {
  return entries(entry?.['rules']).find((rule) => rule['type'] === type);
}

/**
 * A rule turned on comes back as the file has it, with its parameters. A
 * profile that sets no rules leaves each repository's alone, while one that
 * sets some removes every other on apply: so when the last rule goes and the
 * file set none, `rules` goes too.
 */
export function withRule(entry: Entry, type: string, on: boolean, saved?: Entry): Entry {
  const rules = entries(entry['rules']);
  if (on) {
    return ruleOf(entry, type) === undefined
      ? withKey(entry, 'rules', [...rules, ruleOf(saved, type) ?? { type }])
      : entry;
  }
  const left = rules.filter((rule) => rule['type'] !== type);
  return withKey(entry, 'rules', left.length === 0 && saved?.['rules'] === undefined ? undefined : left);
}

export function withRuleParameter(entry: Entry, type: string, key: string, value: unknown): Entry {
  return withKey(
    entry,
    'rules',
    entries(entry['rules']).map((rule) => {
      if (rule['type'] !== type) {
        return rule;
      }
      const parameters = withKey(isEntry(rule['parameters']) ? rule['parameters'] : {}, key, value);
      return withKey(rule, 'parameters', Object.keys(parameters).length > 0 ? parameters : undefined);
    }),
  );
}

export function statusChecks(entry: Entry): readonly string[] {
  const parameters = ruleOf(entry, 'required_status_checks')?.['parameters'];
  return entries(isEntry(parameters) ? parameters['required_status_checks'] : undefined).map((check) =>
    String(check['context']),
  );
}

/** A check the ruleset already names keeps what else the file says of it. */
export function withStatusChecks(entry: Entry, contexts: readonly string[]): Entry {
  const parameters = ruleOf(entry, 'required_status_checks')?.['parameters'];
  const kept = entries(isEntry(parameters) ? parameters['required_status_checks'] : undefined);
  return withRuleParameter(
    entry,
    'required_status_checks',
    'required_status_checks',
    contexts.map((context) => kept.find((check) => check['context'] === context) ?? { context }),
  );
}

/** What GitHub would refuse in a ruleset that the profile's schema lets through. */
export function rulesetProblem(entry: Entry): string | undefined {
  const checks = ruleOf(entry, 'required_status_checks');
  return checks !== undefined && statusChecks(entry).length === 0
    ? 'Name at least one status check that must pass.'
    : refTargetsProblem(entry);
}

export type DeploymentBranches = 'any' | 'protected' | 'chosen';

export function deploymentBranches(entry: Entry): DeploymentBranches | undefined {
  const policy = entry['deployment_branch_policy'];
  if (policy === null) {
    return 'any';
  }
  if (!isEntry(policy)) {
    return undefined;
  }
  return policy['custom_branch_policies'] === true ? 'chosen' : 'protected';
}

/**
 * The patterns belong to chosen branches and tags: they go with any other
 * choice, and come back as the file has them when it is chosen again.
 */
export function withDeploymentBranches(entry: Entry, choice: DeploymentBranches | undefined, saved?: Entry): Entry {
  const policy =
    choice === undefined
      ? undefined
      : choice === 'any'
        ? null
        : { protected_branches: choice === 'protected', custom_branch_policies: choice === 'chosen' };
  const next = withKey(entry, 'deployment_branch_policy', policy);
  if (choice !== 'chosen') {
    return withKey(next, 'branch_policies', undefined);
  }
  return entry['branch_policies'] === undefined ? withKey(next, 'branch_policies', saved?.['branch_policies']) : next;
}

/** A pattern with no type is a branch's. */
export function branchPolicies(entry: Entry, type: 'branch' | 'tag'): readonly string[] {
  return entries(entry['branch_policies'])
    .filter((policy) => (policy['type'] ?? 'branch') === type)
    .map((policy) => String(policy['name']));
}

/** A pattern the environment already has stays as the file writes it. */
export function withBranchPolicies(entry: Entry, type: 'branch' | 'tag', names: readonly string[]): Entry {
  const all = entries(entry['branch_policies']);
  const isType = (policy: Entry): boolean => (policy['type'] ?? 'branch') === type;
  const set = names.map(
    (name) =>
      all.find((policy) => isType(policy) && policy['name'] === name) ?? (type === 'tag' ? { name, type } : { name }),
  );
  const others = all.filter((policy) => !isType(policy));
  // Branches first, as GitHub lists them.
  return withKey(entry, 'branch_policies', type === 'branch' ? [...set, ...others] : [...others, ...set]);
}

export function hexColor(entry: Entry): string | undefined {
  const color = typeof entry['color'] === 'string' ? entry['color'].replace(/^#/u, '').toLowerCase() : '';
  return /^[0-9a-f]{6}$/u.test(color) ? color : undefined;
}

export function labelProblem(entry: Entry, others: readonly string[]): string | undefined {
  const name = typeof entry['name'] === 'string' ? entry['name'].trim().toLowerCase() : '';
  const olds = items(entry['renamed_from']).map(String);
  const lowered = olds.map((old) => old.toLowerCase());
  if (lowered.includes(name)) {
    return "Renamed from lists the label's own name.";
  }
  if (new Set(lowered).size !== lowered.length) {
    return 'Each old name can be listed once.';
  }
  const long = olds.find((old) => old.length > 50);
  if (long !== undefined) {
    return 'An old name can be at most 50 characters.';
  }
  const taken = olds.find((old) => others.includes(old.toLowerCase()));
  return taken === undefined ? undefined : `The profile has a label named ${taken}, so it can't be an old name.`;
}
