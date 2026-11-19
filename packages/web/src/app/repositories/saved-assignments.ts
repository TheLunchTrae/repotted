import { type AuthoritativeSection, authoritativeSections } from '@repotted/core';
import * as z from 'zod/mini';

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
  readonly authoritative?: readonly AuthoritativeSection[] | undefined;
  readonly appliedAuthoritative?: readonly AuthoritativeSection[] | undefined;
  /** In the order they were applied. Undefined until one of them is. */
  readonly applied?: readonly AppliedVersion[] | undefined;
}

const savedAssignments = z.record(
  z.string(),
  z.object({
    profiles: z.array(z.string()),
    authoritative: z.optional(z.array(z.enum(authoritativeSections))),
    appliedAuthoritative: z.optional(z.array(z.enum(authoritativeSections))),
    applied: z.optional(z.array(z.object({ profile: z.string(), version: z.string() }))),
  }),
);

export function assignmentsIn(value: unknown): Readonly<Record<string, Assignment>> {
  const parsed = savedAssignments.safeParse(value);
  return parsed.success ? parsed.data : {};
}
