import type { Apply } from '../apply/apply.js';
import type { BatchApply } from '../apply/batch-apply.js';
import type { RepositoryProfiles } from './repository-profiles.js';

/** An active write cannot be replaced; callers explain why the review must wait. */
export function reviewAssignedProfiles(
  repositories: readonly string[],
  assignments: RepositoryProfiles,
  folder: string,
  apply: Apply,
  batch: BatchApply,
): { readonly path: '/apply' | '/batch'; readonly work: Promise<void> } | undefined {
  if (apply.state.value.kind === 'applying' || batch.state.value.kind === 'applying' || repositories.length === 0) {
    return undefined;
  }
  const members = repositories.map((repository) => ({
    repository,
    profiles: assignments.profilesOf(repository).map((profilePath) => ({
      file: assignments.fileOf(profilePath),
      name: profilePath.replace(/\.ya?ml$/iu, ''),
      folder,
    })),
  }));
  const [only] = members;
  return members.length === 1 && only !== undefined
    ? { path: '/apply', work: apply.startReview(only.repository, only.profiles) }
    : { path: '/batch', work: batch.startFromProfiles(members) };
}
