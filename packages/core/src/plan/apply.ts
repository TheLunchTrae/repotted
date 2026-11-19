import { type GitHub, parseRepo } from '../github/client.js';
import { parseProfile, resolveProfile } from '../profiles/profile.js';
import { isDeepEqual } from '../shared/equal.js';
import { planStagedApply } from '../staging/staged.js';
import type { Change } from './change.js';
import { createPlan, type Plan, skippedDrafts } from './plan.js';

export class StalePlanError extends Error {
  readonly current: Plan;

  constructor(current: Plan) {
    super(`${current.repository} changed since this plan was made. Run plan again and review the new changes.`);
    this.name = 'StalePlanError';
    this.current = current;
  }
}

export class ApplyError extends Error {
  readonly applied: readonly Change[];
  readonly failed: Change;

  constructor(applied: readonly Change[], failed: Change, cause: unknown) {
    super(`Failed to ${failed.action} ${failed.target} after ${applied.length} of the plan's changes`, { cause });
    this.name = 'ApplyError';
    this.applied = applied;
    this.failed = failed;
  }
}

function jsonValue(value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return copy;
}

async function replan(github: GitHub, reviewed: Plan): Promise<Plan> {
  const source = reviewed.source;
  if (source !== undefined && 'staged' in source) {
    return (
      await planStagedApply(github, source.staged, (staged) => {
        if (staged.repository.toLowerCase() !== reviewed.repository.toLowerCase()) {
          throw new Error('The staged apply now targets a different repository; review a fresh plan');
        }
      })
    ).plan;
  }
  const resolveSource =
    source === undefined
      ? undefined
      : () => ('profile' in source ? resolveProfile(source.profile) : parseProfile(source.text, source.directory));
  const resolved = await resolveSource?.();
  const current = await createPlan(
    github,
    parseRepo(reviewed.repository),
    resolved?.profile ?? reviewed.desired,
    resolved === undefined ? reviewed.skipped : skippedDrafts(resolved.drafts),
    reviewed,
  );
  const latest = await resolveSource?.();
  if (resolved !== undefined && !isDeepEqual(resolved.profile, latest?.profile)) {
    throw new Error('The source configuration changed while GitHub was being read. Review a fresh plan.');
  }
  return current;
}

async function writeChanges(github: GitHub, changes: readonly Change[], beforeWrite?: () => void): Promise<Change[]> {
  beforeWrite?.();
  const applied: Change[] = [];
  for (const change of changes) {
    try {
      await github.request(change.request.method, change.request.path, change.request.body);
    } catch (error) {
      throw new ApplyError(applied, change, error);
    }
    applied.push(change);
  }
  return applied;
}

function hasReviewedOwnership(current: Plan, reviewed: Plan): boolean {
  return (
    isDeepEqual(current.authoritative ?? [], reviewed.authoritative ?? []) &&
    isDeepEqual(current.exclude ?? [], reviewed.exclude ?? [])
  );
}

/**
 * Applies a reviewed plan. The repository is planned again first, and the
 * plan only runs when that yields exactly the reviewed changes.
 */
export async function applyPlan(github: GitHub, reviewed: Plan, beforeWrite?: () => void): Promise<readonly Change[]> {
  const current = await replan(github, reviewed);
  if (
    !isDeepEqual(jsonValue(current.changes), jsonValue(reviewed.changes)) ||
    !hasReviewedOwnership(current, reviewed)
  ) {
    throw new StalePlanError(current);
  }
  return writeChanges(github, current.changes, beforeWrite);
}

/**
 * Finishes an apply of a reviewed plan that was cut off after it began, so
 * some of its changes may be written already. The repository is planned
 * again, and what is left only runs when every change of the new plan is one
 * the reviewed plan lists, whole.
 */
export async function resumeApply(
  github: GitHub,
  reviewed: Plan,
  beforeWrite?: () => void,
): Promise<readonly Change[]> {
  const current = await replan(github, reviewed);
  const reviewedChanges = reviewed.changes.map(jsonValue);
  const isReviewed = (change: Change): boolean => {
    const left = jsonValue(change);
    return reviewedChanges.some((listed) => isDeepEqual(listed, left));
  };
  if (!current.changes.every(isReviewed) || !hasReviewedOwnership(current, reviewed)) {
    throw new StalePlanError(current);
  }
  return writeChanges(github, current.changes, beforeWrite);
}
