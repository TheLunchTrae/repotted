import type { AuthoritativeSection } from '@repotted/core';
import * as z from 'zod/mini';

/** The sections the web app offers to own. It has no autolink editor, so it leaves autolinks to the CLI. */
export const ownableSections = [
  'actions_policies',
  'rulesets',
  'environments',
  'labels',
] as const satisfies readonly AuthoritativeSection[];
export type OwnableSection = (typeof ownableSections)[number];

/**
 * By repository, in lower case, the profiles it uses in the order they apply,
 * each by its path in the profiles folder, and the version of each last applied.
 */
export const repositoryProfilesKey = 'repository-profiles';

export interface AppliedVersion {
  readonly profile: string;
  readonly version: string;
}

export interface Assignment {
  readonly profiles: readonly string[];
  readonly authoritative?: readonly OwnableSection[] | undefined;
  readonly appliedAuthoritative?: readonly OwnableSection[] | undefined;
  /** In the order they were applied. Undefined until one of them is. */
  readonly applied?: readonly AppliedVersion[] | undefined;
}

/** A saved section the app doesn't offer is dropped, so it can't make every saved assignment unreadable. */
const ownedSections = z.pipe(
  z.array(z.string()),
  z.transform((sections) => ownableSections.filter((section) => sections.includes(section))),
);

const savedAssignments = z.record(
  z.string(),
  z.object({
    profiles: z.array(z.string()),
    authoritative: z.optional(ownedSections),
    appliedAuthoritative: z.optional(ownedSections),
    applied: z.optional(z.array(z.object({ profile: z.string(), version: z.string() }))),
  }),
);

export function assignmentsIn(value: unknown): Readonly<Record<string, Assignment>> {
  const parsed = savedAssignments.safeParse(value);
  return parsed.success ? parsed.data : {};
}
