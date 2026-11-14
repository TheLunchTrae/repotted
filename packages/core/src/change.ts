import type { Method } from './github.js';
import type { FieldChange } from './match.js';

export interface Request {
  readonly method: Method;
  readonly path: string;
  readonly body?: unknown;
}

/** The sections in the order a plan applies them. */
export const sections = [
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
] as const;

export type Section = (typeof sections)[number];

/** The sections that are lists of entries, each known by a name. */
export const listSections = ['autolinks', 'rulesets', 'environments', 'labels'] as const satisfies readonly Section[];

export type SettingsSection = Exclude<Section, (typeof listSections)[number]>;

export function isListSection(section: Section): section is (typeof listSections)[number] {
  return (listSections as readonly Section[]).includes(section);
}

/** The entry of a list that a change acts on. */
interface ChangeEntry {
  /**
   * The key its list knows it by, as the profile writes it: a ruleset's,
   * environment's or label's name, or an autolink's key prefix.
   */
  readonly name: string;
  /** For a change to one of an environment's branch policies, that policy. */
  readonly branch_policy?: { readonly name: string; readonly type: 'branch' | 'tag' };
}

interface Write {
  readonly action: 'create' | 'update' | 'delete';
  /** What the change writes, as plan output names it, such as a ruleset's name. */
  readonly target: string;
  readonly fields: readonly FieldChange[];
  readonly request: Request;
}

/**
 * One write that brings part of a repository in line with its profile. A
 * change to a list carries the entry it acts on. GitHub cannot edit an
 * autolink, so a plan remakes one with a delete and a create of the same entry.
 */
export type Change =
  | (Write & { readonly section: (typeof listSections)[number]; readonly entry: ChangeEntry })
  | (Write & { readonly section: SettingsSection; readonly entry?: never });

/**
 * Why a plan or capture leaves something out: GitHub `refused` to show it,
 * as for want of a permission, a role or a payment method on file; the repository does not offer it
 * (`unavailable`); it does not apply with the other settings
 * (`not_applicable`); or, in a capture, a profile cannot hold what GitHub
 * reports (`unloadable`).
 */
export const skipCauses = ['refused', 'unavailable', 'not_applicable', 'unloadable'] as const;

export type SkipCause = (typeof skipCauses)[number];

/**
 * What a plan or capture says beside its changes. A warning with a `cause`
 * left out what `section`, `key` and `field` name, and its `message` says
 * why. One without a cause leaves nothing out: it says what a change does
 * beyond its fields, or names a staged apply's `exclusion` that leaves
 * nothing out, and its `message` is the whole warning.
 */
export interface Warning {
  readonly section?: Section;
  /** A setting's key, or an entry's name. */
  readonly key?: string;
  /** A field of that setting. */
  readonly field?: string;
  readonly cause?: SkipCause;
  /** An exclusion as the staged apply file lists it. */
  readonly exclusion?: string;
  readonly message: string;
}

/** What a section's plan step returns. */
export interface SectionPlan {
  readonly changes: readonly Change[];
  readonly warnings: readonly Warning[];
}
