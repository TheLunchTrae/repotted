import { computed, signal } from '@preact/signals';
import {
  createPlan,
  describeSkipped,
  describeWarning,
  type GitHub,
  lockChanges,
  OwnerMismatchError,
  parseRepo,
  type Plan,
  readAccess,
  resolveProfile,
  skippedDrafts,
} from '@repotted/core';

import { dirname } from '../engine/path.js';
import { isSignedOut } from './account.js';
import { settingSections } from './setting-fields.js';
import { searchWords } from './setting-search.js';

type Change = Plan['changes'][number];

/** One difference: something the profile names, what GitHub has of it now, and what the profile wants. */
export interface CompareRow {
  /** Whether the profile changes what GitHub has, adds what it lacks, or removes what it has. */
  readonly kind: 'changes' | 'adds' | 'removes';
  /** What it is, as the editor names it: a setting's label, or an entry's name. */
  readonly label: string;
  /** Its place in the profile, such as `merge.allow_squash_merge`, or what happens to a whole entry. */
  readonly key: string;
  readonly now: string;
  readonly wanted: string;
  /** Why Repotted can't make the change, such as "Needs Actions write"; undefined when it can. */
  readonly lock: string | undefined;
  /** In an apply, what leaves the row's change out of it, such as `repository.has_wiki` or `rulesets/Main`. */
  readonly leaveOut?: string | undefined;
  /**
   * In an apply, whether the row comes from one of the apply's one-off
   * edits, which is changed or undone on the edits and not left out.
   */
  readonly oneOff?: boolean;
}

/** What leaves one change of an apply's plan out, or one field of it, as the engine's staged plan lists it. */
export interface RowExclusion {
  readonly change: number;
  readonly field: string | null;
  readonly key: string;
  /** Whether the apply's own one-off edits set what the key names. */
  readonly edited: boolean;
}

export interface CompareSection {
  readonly section: Change['section'];
  readonly title: string;
  readonly rows: readonly CompareRow[];
}

/**
 * Something the profile sets that the plan changes nothing of. GitHub
 * nearly always has it as the profile sets it; the exception is a setting
 * the engine leaves out without a word because it can't apply with the
 * options chosen, such as a runner for a code scanning setup that is not
 * configured. So a row says there is no change, not what GitHub holds.
 */
export interface MatchRow {
  readonly label: string;
  /** Its place in the profile for a setting, or what kind of entry it is. */
  readonly key: string;
  /** The value the profile sets; nothing for an entry, which is unchanged whole. */
  readonly value: string | undefined;
}

/** What one section of the profile sets that needs no change. */
export interface MatchSection {
  readonly section: Change['section'];
  readonly title: string;
  readonly rows: readonly MatchRow[];
}

/** One section of a comparison as shown: its differences, then what matches. */
export interface ShownSection extends CompareSection {
  readonly matches: readonly MatchRow[];
}

/** A comparison that was made: what the profile would change on the repository, and what it left out. */
export interface Compared {
  readonly repository: string;
  /** The profile's file, and its name as the list has it. */
  readonly file: string;
  readonly profile: string;
  readonly sections: readonly CompareSection[];
  /** What the profile sets that needs no change, by section. */
  readonly matching: readonly MatchSection[];
  /**
   * Where the Repotted App's access to the repository is reviewed on GitHub:
   * its installation's settings, `install` when it isn't installed there,
   * or undefined when GitHub wouldn't say.
   */
  readonly appAccess: { readonly settings: string } | 'install' | undefined;
  /** The profile's drafts, which a comparison leaves out, each in a few words. */
  readonly skipped: readonly string[];
  /** What the comparison couldn't read or says beside its differences. */
  readonly warnings: readonly string[];
}

/** The profile a comparison is made with. */
export interface ComparedProfile {
  readonly file: string;
  /** Its name as the list has it. */
  readonly name: string;
  /** The folder the profiles are kept in, which paths in a message are given from; the profile's own when left out. */
  readonly folder?: string;
}

export type ComparisonState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'comparing'; readonly repository: string; readonly file: string; readonly profile: string }
  | {
      readonly kind: 'failed';
      readonly repository: string;
      readonly file: string;
      readonly profile: string;
      readonly message: string;
      /** Whether the profile is for the other kind of owner, which a copy of another type gets past. */
      readonly mismatch: boolean;
    }
  | ({ readonly kind: 'compared' } & Compared);

const titles: Readonly<Record<Change['section'], string>> = {
  repository: 'Repository',
  merge: 'Merge',
  security: 'Security',
  actions: 'Actions',
  custom_properties: 'Custom properties',
  pages: 'Pages',
  autolinks: 'Autolinks',
  rulesets: 'Rulesets',
  environments: 'Environments',
  labels: 'Labels',
};

/** The sections in the order a comparison shows them. */
const order: readonly Change['section'][] = [
  'repository',
  'merge',
  'security',
  'actions',
  'custom_properties',
  'pages',
  'autolinks',
  'rulesets',
  'environments',
  'labels',
];

const nouns: Readonly<Record<string, string>> = {
  autolinks: 'autolink',
  rulesets: 'ruleset',
  environments: 'environment',
  labels: 'label',
};

const fields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value in a few words, as a row shows it. */
function say(value: unknown, missing: string): string {
  if (value === undefined) {
    return missing;
  }
  if (typeof value === 'boolean') {
    return value ? 'On' : 'Off';
  }
  if (value === null || value === '') {
    return 'Empty';
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'None'
      : value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  }
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function kindOf(from: unknown, to: unknown): CompareRow['kind'] {
  return from === undefined ? 'adds' : to === undefined ? 'removes' : 'changes';
}

/** A setting's label and its values by their choice labels, as the editor has them, when it has the setting. */
function settingNames(path: string): { label: string; named: (value: unknown) => string } {
  const field = fields.find((item) => item.path.join('.') === path);
  return {
    label: field?.label ?? path.slice(path.indexOf('.') + 1),
    named: (value) =>
      field?.options.find((option) => JSON.stringify(option.value) === JSON.stringify(value))?.label ??
      say(value, 'Not set'),
  };
}

function settingRow(path: string, from: unknown, to: unknown, lock: string | undefined): CompareRow {
  const { label, named } = settingNames(path);
  return { kind: kindOf(from, to), label, key: path, now: named(from), wanted: named(to), lock };
}

/** What an item of a list is known by, so the same item is compared with itself wherever it sits. */
function identityOf(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (item['actor_type'] !== undefined) {
    return `${say(item['actor_type'], '')} ${say(item['actor_id'] ?? undefined, 'any')}`.trim();
  }
  if (item['type'] !== undefined && item['id'] !== undefined) {
    return `${say(item['type'], '')} ${say(item['id'], '')}`;
  }
  const known = item['type'] ?? item['context'] ?? item['name'];
  return typeof known === 'string' ? known : undefined;
}

/**
 * What differs between two values of an entry's field, narrowed to where
 * they differ: a key of an object, or an item of a list by what it is known
 * by, so a rule with one changed number is that number and not two whole
 * lists of rules.
 */
function narrowed(path: string, from: unknown, to: unknown): { path: string; from: unknown; to: unknown }[] {
  if (JSON.stringify(from) === JSON.stringify(to)) {
    return [];
  }
  if (isRecord(from) && isRecord(to)) {
    return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap((key) =>
      narrowed(`${path}.${key}`, from[key], to[key]),
    );
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const before = new Map(from.map((item: unknown) => [identityOf(item), item]));
    const after = new Map(to.map((item: unknown) => [identityOf(item), item]));
    // Items with nothing to know them by, or two known by the same, are compared as the whole list.
    if (!before.has(undefined) && !after.has(undefined) && before.size === from.length && after.size === to.length) {
      return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) =>
        narrowed(`${path}[${key ?? ''}]`, before.get(key), after.get(key)),
      );
    }
  }
  return [{ path, from, to }];
}

/** The rows of one change: a row a field for a setting or a changed entry, and one row for what is made or removed whole. */
function rowsOf(change: Change, lock: string | undefined): CompareRow[] {
  if (change.entry !== undefined) {
    const policy = change.entry.branch_policy;
    const noun = policy === undefined ? (nouns[change.section] ?? 'entry') : `${policy.type} policy`;
    const name = policy === undefined ? change.entry.name : `${change.entry.name}: ${policy.name}`;
    if (change.action === 'create') {
      return [{ kind: 'adds', label: name, key: `new ${noun}`, now: 'Not on GitHub', wanted: 'Created', lock }];
    }
    if (change.action === 'delete') {
      return [{ kind: 'removes', label: name, key: `${noun} removed`, now: 'On GitHub', wanted: 'Removed', lock }];
    }
    return change.fields
      .flatMap((field) => narrowed(field.field, field.from, field.to))
      .map((field) => ({
        kind: kindOf(field.from, field.to),
        label: name,
        key: field.path,
        now: say(field.from, 'Not set'),
        wanted: say(field.to, 'Not set'),
        lock,
      }));
  }
  // A settings section GitHub makes or deletes whole, as it does a Pages site, says so before its settings.
  const whole: CompareRow[] =
    change.action === 'update'
      ? []
      : [
          {
            kind: change.action === 'create' ? 'adds' : 'removes',
            label: change.section === 'pages' ? 'GitHub Pages site' : change.target,
            key: change.section,
            now: change.action === 'create' ? 'Not on GitHub' : 'On GitHub',
            wanted: change.action === 'create' ? 'Created' : 'Deleted',
            lock,
          },
        ];
  return [
    ...whole,
    ...change.fields.flatMap((field) => {
      const path = `${change.section}.${field.field}`;
      // A group of settings, such as the selected actions, is a row for each setting in it that differs.
      const grouped = fields.some((item) => item.path.join('.').startsWith(`${path}.`));
      if (grouped && (isRecord(field.to) || isRecord(field.from))) {
        const from = isRecord(field.from) ? field.from : {};
        const to = isRecord(field.to) ? field.to : {};
        return Object.keys(to)
          .filter((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
          .map((key) => settingRow(`${path}.${key}`, from[key], to[key], lock));
      }
      return [settingRow(path, field.from, field.to, lock)];
    }),
  ];
}

/** A plan as the sections of a comparison, in the order the plan applies them. */
export function compareSections(
  plan: Plan,
  locks: ReadonlyMap<number, string>,
  exclusions: readonly RowExclusion[] = [],
): CompareSection[] {
  const sections: CompareSection[] = [];
  /** A row with what leaves it out: its field's key for a setting, and its change's for anything made, removed, or listed. */
  const leavable = (index: number, row: CompareRow): CompareRow => {
    const of = exclusions.filter((exclusion) => exclusion.change === index);
    const field = of.find(
      (exclusion) => exclusion.field !== null && (row.key === exclusion.key || row.key.startsWith(`${exclusion.key}.`)),
    );
    const found = field ?? of.find((exclusion) => exclusion.field === null);
    if (found === undefined) {
      return row;
    }
    // The engine refuses to exclude what the apply itself edits, so such a row is undone on the edits instead.
    return found.edited ? { ...row, oneOff: true } : { ...row, leaveOut: found.key };
  };
  // GitHub can't edit an autolink, so a plan remakes one with a delete and a create, which is one change to it here.
  const autolinks = (action: Change['action']): Map<string, number> =>
    new Map(
      plan.changes.flatMap((change, index) =>
        change.section === 'autolinks' && change.action === action ? [[change.entry.name, index] as const] : [],
      ),
    );
  const deleted = autolinks('delete');
  const created = autolinks('create');
  for (const [index, change] of plan.changes.entries()) {
    const remade = change.section === 'autolinks' && deleted.has(change.entry.name) && created.has(change.entry.name);
    if (remade && change.action === 'delete') {
      continue;
    }
    const rows = (
      remade
        ? rowsOf(
            { ...change, action: 'update' },
            locks.get(index) ?? locks.get(deleted.get(change.entry.name) ?? index),
          )
        : rowsOf(change, locks.get(index))
    ).map((row) => leavable(index, row));
    const last = sections.at(-1);
    if (last?.section === change.section) {
      sections[sections.length - 1] = { ...last, rows: [...last.rows, ...rows] };
    } else {
      sections.push({ section: change.section, title: titles[change.section], rows });
    }
  }
  return sections.filter((section) => section.rows.length > 0);
}

/** A settings section's values by path, with a group opened where the editor shows its parts as settings of their own. */
function flat(path: string, values: Readonly<Record<string, unknown>>): [string, unknown][] {
  return Object.entries(values).flatMap(([key, value]): [string, unknown][] => {
    const at = `${path}.${key}`;
    const opens =
      isRecord(value) &&
      !fields.some((field) => field.path.join('.') === at) &&
      fields.some((field) => field.path.join('.').startsWith(`${at}.`));
    return opens ? flat(at, value) : [[at, value]];
  });
}

/**
 * What the plan's profile sets that the plan changes nothing of. It leaves
 * out what the plan didn't read or said it skipped: a section or setting a
 * warning left out, and the settings of a section that is made or deleted
 * whole.
 */
export function matchSections(plan: Plan): MatchSection[] {
  const desired: unknown = plan.desired;
  const wanted = isRecord(desired) ? desired : {};
  const skips = plan.warnings.filter((warning) => warning.cause !== undefined);
  const differing = compareSections(plan, new Map());
  return order.flatMap((section): MatchSection[] => {
    const title = titles[section];
    const values = wanted[section];
    const changes = plan.changes.filter((change) => change.section === section);
    if (skips.some((warning) => warning.section === section && warning.key === undefined)) {
      return [];
    }
    let rows: MatchRow[] = [];
    if (Array.isArray(values)) {
      const touched = new Set(changes.map((change) => change.entry?.name));
      rows = values.flatMap((entry: unknown): MatchRow[] => {
        const known = isRecord(entry) ? (entry['name'] ?? entry['key_prefix']) : undefined;
        return typeof known !== 'string' || touched.has(known) || (isRecord(entry) && entry['absent'] === true)
          ? []
          : [{ label: known, key: nouns[section] ?? 'entry', value: undefined }];
      });
    } else if (isRecord(values) && !changes.some((change) => change.action !== 'update')) {
      const differs = (differing.find((item) => item.section === section)?.rows ?? []).map((row) => row.key);
      rows = flat(section, values).flatMap(([path, value]): MatchRow[] => {
        const rest = path.slice(section.length + 1);
        const [top = ''] = rest.split('.');
        const skipped = skips.some(
          (warning) =>
            warning.section === section &&
            (warning.field === undefined ? warning.key === top : `${warning.key ?? ''}.${warning.field}` === rest),
        );
        if (skipped || differs.includes(path)) {
          return [];
        }
        const { label, named } = settingNames(path);
        return [{ label, key: path, value: named(value) }];
      });
    }
    return rows.length === 0 ? [] : [{ section, title, rows }];
  });
}

function normalize(text: string): string {
  return ` ${text.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ')} `;
}

/**
 * A repository compared with a profile: what the profile would change
 * there. Comparing only reads from GitHub. One comparison counts at a time,
 * so a slower one never replaces a later one's result.
 */
export class Comparison {
  readonly state = signal<ComparisonState>({ kind: 'idle' });
  /** What is typed in the comparison's search. */
  readonly search = signal('');
  /** Whether only the differences Repotted can't make show. */
  readonly onlyLocked = signal(false);
  /** Whether only what differs shows, with what matches folded away; on at first. */
  readonly onlyDifferences = signal(true);

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  #turn = 0;
  #last: { readonly repository: string; readonly profile: ComparedProfile } | undefined;

  constructor(github: GitHub, onSignedOut: () => void) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
  }

  /** How many differences there are, how many of them Repotted can't make, and how much matches. */
  readonly counts = computed(() => {
    const state = this.state.value;
    const rows = state.kind === 'compared' ? state.sections.flatMap((section) => section.rows) : [];
    return {
      differences: rows.length,
      locked: rows.filter((row) => row.lock !== undefined).length,
      matches: state.kind === 'compared' ? state.matching.reduce((sum, section) => sum + section.rows.length, 0) : 0,
    };
  });

  /**
   * The sections with the rows the search and the filters leave: the
   * differences, and what matches unless only differences, or only those
   * Repotted can't make, show.
   */
  readonly shown = computed((): ShownSection[] => {
    const state = this.state.value;
    if (state.kind !== 'compared') {
      return [];
    }
    const words = searchWords(this.search.value);
    const locked = this.onlyLocked.value;
    const matching = this.onlyDifferences.value || locked ? [] : state.matching;
    const found = (title: string, row: { label: string; key: string }): boolean => {
      const text = normalize(`${title} ${row.label} ${row.key}`);
      return words.every((word) => text.includes(word));
    };
    return order
      .map((section): ShownSection => {
        const title = titles[section];
        return {
          section,
          title,
          rows: (state.sections.find((item) => item.section === section)?.rows ?? []).filter(
            (row) => (!locked || row.lock !== undefined) && found(title, row),
          ),
          matches: (matching.find((item) => item.section === section)?.rows ?? []).filter((row) => found(title, row)),
        };
      })
      .filter((section) => section.rows.length > 0 || section.matches.length > 0);
  });

  /** Compares a repository with a profile as it is saved, by the profile's file and its name in the list. */
  async compare(repository: string, profile: ComparedProfile): Promise<void> {
    const turn = (this.#turn += 1);
    this.#last = { repository, profile };
    this.search.value = '';
    this.onlyLocked.value = false;
    this.state.value = { kind: 'comparing', repository, file: profile.file, profile: profile.name };
    try {
      const repo = parseRepo(repository);
      const resolved = await resolveProfile(profile.file);
      const [plan, access] = await Promise.all([
        createPlan(this.#github, repo, resolved.profile, skippedDrafts(resolved.drafts)),
        readAccess(this.#github, repo),
      ]);
      if (turn !== this.#turn) {
        return;
      }
      const locks = new Map(lockChanges(access, plan.changes).map((lock) => [lock.change, lock.reason]));
      this.state.value = {
        kind: 'compared',
        repository,
        file: profile.file,
        profile: profile.name,
        sections: compareSections(plan, locks),
        matching: matchSections(plan),
        appAccess:
          access.app.status === 'not_installed'
            ? 'install'
            : access.app.status === 'installed' && access.app.settings_url !== null
              ? { settings: access.app.settings_url }
              : undefined,
        skipped: plan.skipped.map(describeSkipped),
        warnings: plan.warnings.map(describeWarning),
      };
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      if (turn === this.#turn) {
        this.state.value = {
          kind: 'failed',
          repository,
          file: profile.file,
          profile: profile.name,
          // The profile goes by its name, and a base profile by its path among the profiles, not by where the browser keeps them.
          message: (error instanceof Error ? error.message : String(error))
            .replaceAll(profile.file, profile.name)
            .replaceAll(`${profile.folder ?? dirname(profile.file)}/`, ''),
          mismatch: error instanceof OwnerMismatchError,
        };
      }
    }
  }

  /** Compares the same two again: the profile as it is saved now, and GitHub as it is now. */
  async again(): Promise<void> {
    if (this.#last !== undefined) {
      await this.compare(this.#last.repository, this.#last.profile);
    }
  }

  /** Puts the comparison away, and leaves behind one still being made. */
  close(): void {
    this.#turn += 1;
    this.state.value = { kind: 'idle' };
  }
}
