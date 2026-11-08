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
] as const;

export type Section = (typeof sections)[number];

/** One write that brings part of a repository in line with its profile. */
export interface Change {
  readonly section: Section;
  readonly action: 'create' | 'update' | 'delete';
  /** What the change writes, such as a ruleset's name. */
  readonly target: string;
  readonly fields: readonly FieldChange[];
  readonly request: Request;
}

/** What a section's plan step returns. */
export interface SectionPlan {
  readonly changes: readonly Change[];
  readonly warnings: readonly string[];
}
