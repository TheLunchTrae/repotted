/**
 * One change a commit to a config repository makes, as the line
 * `${action} ${noun}${after}: ${name}`, such as `Create profile: web/base`
 * or `Move repository to folder Work: octo/app`.
 */
export interface ConfigChange {
  readonly action: string;
  readonly noun: string;
  readonly nouns: string;
  /** Follows the noun, such as `to folder Work`. */
  readonly after?: string;
  readonly name: string;
}

export interface ProfileFileChange {
  /** By its path in the profiles folder. */
  readonly file: string;
  readonly kind: 'create' | 'update' | 'delete';
  /** The git blob id of what it holds after the change, or before it for a delete; it pairs a delete with a create as a rename. */
  readonly contentId?: string | undefined;
}

export const longestCommitSubject = 72;
export const mostCommitBodyLines = 50;

const fallbackSubject = 'Update Repotted files';

interface ChangeGroup {
  readonly kind: ConfigChange;
  readonly names: string[];
}

function groupKey(change: ConfigChange): string {
  return JSON.stringify([change.action, change.noun, change.nouns, change.after ?? '']);
}

function groupsOf(changes: readonly ConfigChange[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const key = groupKey(change);
    const group = groups.get(key) ?? { kind: change, names: [] };
    if (!group.names.includes(change.name)) {
      group.names.push(change.name);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function afterNoun(kind: ConfigChange): string {
  return kind.after === undefined ? '' : ` ${kind.after}`;
}

function namedClause(group: ChangeGroup, shownNames: readonly string[]): string {
  const { kind, names } = group;
  const omitted = names.length - shownNames.length;
  const noun = names.length === 1 ? kind.noun : kind.nouns;
  return `${kind.action} ${noun}${afterNoun(kind)}: ${shownNames.join(', ')}${omitted > 0 ? ` and ${omitted} more` : ''}`;
}

function countedClause(group: ChangeGroup): string {
  const { kind, names } = group;
  return `${kind.action} ${names.length} ${names.length === 1 ? kind.noun : kind.nouns}${afterNoun(kind)}`;
}

/** Names as many as fit, and at least one. */
function namedClauseWithin(group: ChangeGroup, limit: number): string | undefined {
  for (let shown = group.names.length; shown >= 1; shown -= 1) {
    const clause = namedClause(group, group.names.slice(0, shown));
    if (clause.length <= limit) {
      return clause;
    }
  }
  return undefined;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinedClauses(clauses: readonly string[]): string {
  return clauses.map((clause, index) => (index === 0 ? clause : lowerFirst(clause))).join('; ');
}

function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function countedClausesWithin(groups: readonly ChangeGroup[], limit: number): string {
  const subjectNaming = (shown: number): string => {
    const rest = groups.slice(shown).reduce((total, group) => total + group.names.length, 0);
    return `${joinedClauses(groups.slice(0, shown).map(countedClause))} and ${rest} more ${rest === 1 ? 'change' : 'changes'}`;
  };
  let shown = groups.length - 1;
  while (shown > 1 && subjectNaming(shown).length > limit) {
    shown -= 1;
  }
  return clipped(subjectNaming(shown), limit);
}

/** Every change on its own line, when the subject leaves some out. */
function bodyLines(groups: readonly ChangeGroup[]): string[] {
  const lines = groups.flatMap((group) =>
    group.names.map((name) => `- ${namedClause({ ...group, names: [name] }, [name])}`),
  );
  if (lines.length <= mostCommitBodyLines) {
    return lines;
  }
  const shown = mostCommitBodyLines - 1;
  return [...lines.slice(0, shown), `- and ${lines.length - shown} more`];
}

/**
 * A subject of at most `longestCommitSubject` characters that names what
 * changed, and, when it can't name all of it, a body that lists each change.
 * Changes of one kind share a clause, as in `Hide repositories: a, b`.
 */
export function configCommitMessage(changes: readonly ConfigChange[]): string {
  const groups = groupsOf(changes);
  const [first] = groups;
  if (first === undefined) {
    return fallbackSubject;
  }
  const everyName = joinedClauses(groups.map((group) => namedClause(group, group.names)));
  if (everyName.length <= longestCommitSubject) {
    return everyName;
  }
  let subject: string;
  if (groups.length === 1) {
    const fallback = first.names.length === 1 ? namedClause(first, first.names) : countedClause(first);
    subject = namedClauseWithin(first, longestCommitSubject) ?? clipped(fallback, longestCommitSubject);
  } else {
    const everyCount = joinedClauses(groups.map(countedClause));
    subject =
      everyCount.length <= longestCommitSubject ? everyCount : countedClausesWithin(groups, longestCommitSubject);
  }
  return `${subject}\n\n${bodyLines(groups).join('\n')}`;
}

/** Its path in the profiles folder without `.yaml`. */
export function profileDisplayName(file: string): string {
  return file.replace(/\.ya?ml$/iu, '');
}

function folderOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

function profileChange(action: string, name: string): ConfigChange {
  return { action, noun: 'profile', nouns: 'profiles', name };
}

/**
 * A delete and a create of the same content are one rename, or a move when
 * the profile changes folder.
 */
export function profileFileChanges(changes: readonly ProfileFileChange[]): ConfigChange[] {
  const created = changes.filter((change) => change.kind === 'create');
  const pairedCreates = new Set<ProfileFileChange>();
  const renamedTo = new Map<ProfileFileChange, ProfileFileChange>();
  for (const deleted of changes.filter((change) => change.kind === 'delete')) {
    const match = created.find(
      (change) =>
        !pairedCreates.has(change) && change.contentId !== undefined && change.contentId === deleted.contentId,
    );
    if (match !== undefined) {
      pairedCreates.add(match);
      renamedTo.set(deleted, match);
    }
  }
  const described: ConfigChange[] = [];
  for (const change of changes) {
    if (pairedCreates.has(change)) {
      continue;
    }
    const name = profileDisplayName(change.file);
    const newFile = renamedTo.get(change);
    if (newFile !== undefined) {
      const action = folderOf(change.file) === folderOf(newFile.file) ? 'Rename' : 'Move';
      described.push(profileChange(action, `${name} to ${profileDisplayName(newFile.file)}`));
    } else {
      described.push(
        profileChange(change.kind === 'create' ? 'Create' : change.kind === 'update' ? 'Update' : 'Delete', name),
      );
    }
  }
  return described;
}
