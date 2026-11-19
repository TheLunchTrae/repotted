import type { Apply } from '../apply/apply.js';
import type { BatchApply } from '../apply/batch-apply.js';
import type { Repository } from './repositories.js';
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

/** By name in lower case, the full name of each repository in view. */
function namesInView(inView: readonly Pick<Repository, 'full_name'>[]): ReadonlyMap<string, string> {
  return new Map(inView.map((repository) => [repository.full_name.toLowerCase(), repository.full_name]));
}

/** The repositories in view whose profiles changed since they were last applied, by their full names. */
export function changedInView(
  assignments: RepositoryProfiles,
  inView: readonly Pick<Repository, 'full_name'>[],
): readonly string[] {
  const names = namesInView(inView);
  return assignments.changedRepositories.value.flatMap((key) => names.get(key) ?? []);
}
