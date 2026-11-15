// What the ruleset, environment, and label forms write. Each function takes
// an entry and answers the entry with one thing changed, leaving every key
// it doesn't name as it was, so what a form doesn't show stays as the
// profile's file has it. `saved` is the entry as the file has it, when it
// has one: a change back to what is saved gives the saved shape again, so an
// entry typed in and put back is no change.

import { entryValueProblems } from '@repotted/core';

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

function sameText(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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

export function refNames(entry: Entry, side: 'include' | 'exclude'): readonly string[] {
  const conditions = isEntry(entry['conditions']) ? entry['conditions'] : {};
  const refName = isEntry(conditions['ref_name']) ? conditions['ref_name'] : {};
  return items(refName[side]).map(String);
}

/** GitHub takes the two sides together, so both are written, and with neither the condition goes. */
export function withRefNames(
  entry: Entry,
  side: 'include' | 'exclude',
  names: readonly string[],
  saved?: Entry,
): Entry {
  const next = { include: refNames(entry, 'include'), exclude: refNames(entry, 'exclude'), [side]: names };
  const conditions = isEntry(entry['conditions']) ? entry['conditions'] : {};
  if (
    saved !== undefined &&
    sameText(next.include, refNames(saved, 'include')) &&
    sameText(next.exclude, refNames(saved, 'exclude'))
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
    : undefined;
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

function lowercaseFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * Why GitHub would refuse one of the environment's branch or tag patterns, by
 * the engine's own rule for a deployment pattern, with the pattern first.
 */
export function branchPolicyProblem(entry: Entry, type: 'branch' | 'tag'): string | undefined {
  const policies = entries(entry['branch_policies']);
  const found = entryValueProblems('environments', entry).find(({ path: [listName, index, key] }) => {
    const policy = typeof index === 'number' ? policies[index] : undefined;
    return listName === 'branch_policies' && key === 'name' && (policy?.['type'] ?? 'branch') === type;
  });
  if (found === undefined) {
    return undefined;
  }
  const [, index] = found.path;
  const name = typeof index === 'number' ? policies[index]?.['name'] : undefined;
  return typeof name === 'string' && name !== '' ? `${name}: ${lowercaseFirst(found.message)}` : found.message;
}

/** A string answer is why the text isn't a whole number from 0 up to `most`; an empty text leaves it to each repository. */
export function parseWholeNumberUpTo(
  typed: string,
  most: number,
  what: string,
): { readonly value: number | undefined } | string {
  const digits = typed.trim();
  if (digits === '') {
    return { value: undefined };
  }
  return /^\d+$/u.test(digits) && Number(digits) <= most
    ? { value: Number(digits) }
    : `${what} is a whole number, from 0 to ${most}.`;
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
