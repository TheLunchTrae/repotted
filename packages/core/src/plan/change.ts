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

export const listSections = ['autolinks', 'rulesets', 'environments', 'labels'] as const satisfies readonly Section[];

export type SettingsSection = Exclude<Section, (typeof listSections)[number]>;

export function isListSection(section: Section): section is (typeof listSections)[number] {
  return (listSections as readonly Section[]).includes(section);
}

interface ChangeEntry {
  /** An autolink's key prefix; any other entry's name. */
  readonly name: string;
  readonly branch_policy?: { readonly name: string; readonly type: 'branch' | 'tag' };
}

interface Write {
  readonly action: 'create' | 'update' | 'delete';
  readonly target: string;
  readonly fields: readonly FieldChange[];
  readonly request: Request;
}

export type Change =
  | (Write & { readonly section: (typeof listSections)[number]; readonly entry: ChangeEntry })
  | (Write & { readonly section: SettingsSection; readonly entry?: never });

/**
 * `refused`: GitHub would not show it, as for want of a permission, a role or a
 * payment method on file. `unloadable`: a capture met something GitHub reports
 * that a profile cannot hold.
 */
export const skipCauses = ['refused', 'unavailable', 'not_applicable', 'unloadable'] as const;

export type SkipCause = (typeof skipCauses)[number];

/** A warning without a `cause` leaves nothing out of the plan or capture. */
export interface Warning {
  readonly section?: Section;
  readonly key?: string;
  readonly field?: string;
  readonly cause?: SkipCause;
  readonly exclusion?: string;
  readonly message: string;
}

export interface SectionPlan {
  readonly changes: readonly Change[];
  readonly warnings: readonly Warning[];
}
