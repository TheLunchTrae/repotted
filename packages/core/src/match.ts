import { isDeepStrictEqual } from 'node:util';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether live state satisfies what a profile asks for. Objects match on the
 * keys the profile sets, so defaults GitHub fills in never count as drift.
 * Arrays match when they hold the same number of items and each desired item
 * matches a different live item, in any order.
 */
export function matches(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) {
      return false;
    }
    // A perfect matching found with augmenting paths. A greedy pass is not
    // enough: a loose desired item can take the live item a stricter one needs.
    const candidates = desired.map((item: unknown) =>
      live.flatMap((candidate: unknown, index) => (matches(item, candidate) ? [index] : [])),
    );
    const owner: (number | undefined)[] = live.map(() => undefined);
    const assign = (item: number, seen: Set<number>): boolean => {
      for (const index of candidates[item] ?? []) {
        if (seen.has(index)) {
          continue;
        }
        seen.add(index);
        const current = owner[index];
        if (current === undefined || assign(current, seen)) {
          owner[index] = item;
          return true;
        }
      }
      return false;
    };
    return desired.every((_: unknown, item) => assign(item, new Set()));
  }
  if (isRecord(desired)) {
    return isRecord(live) && Object.entries(desired).every(([key, value]) => matches(value, live[key]));
  }
  return Object.is(desired, live);
}

export interface FieldChange {
  readonly field: string;
  /** Absent when the live repository has no value for the field. */
  readonly from?: unknown;
  readonly to?: unknown;
}

/** The top-level fields of `desired` that `live` does not satisfy. */
export function fieldChanges(
  desired: Record<string, unknown>,
  live: Record<string, unknown> | undefined,
): FieldChange[] {
  return Object.entries(desired)
    .filter(([field, to]) => !matches(to, live?.[field]))
    .map(([field, to]) => ({ field, from: live?.[field], to }));
}

/**
 * Every top-level field of `body` that differs from `current`, for a write
 * that replaces the whole value, so a reviewer sees its whole effect. Fields
 * compare exactly rather than as `matches` does, since the write sends each
 * one as it is.
 */
export function bodyChanges(body: object, current: object | undefined): FieldChange[] {
  const before = new Map<string, unknown>(Object.entries(current ?? {}));
  return Object.entries(body)
    .filter(([field, to]: [string, unknown]) => !isDeepStrictEqual(to, before.get(field)))
    .map(([field, to]: [string, unknown]) => ({ field, from: before.get(field), to }));
}

/**
 * Lays `desired` over `live` for a write that replaces the whole value:
 * objects merge key by key, so keys the profile leaves out keep their live
 * values. In a list, each object takes the first unused live item it
 * `matches`, so an item keeps live keys the profile leaves out, as matching
 * ignores them. Anything else the profile names replaces the live value.
 */
export function overlay(desired: unknown, live: unknown): unknown {
  if (Array.isArray(desired) && Array.isArray(live)) {
    const unused: unknown[] = live.map((item: unknown) => item);
    return desired.map((item: unknown) => {
      const index = isRecord(item) ? unused.findIndex((candidate) => matches(item, candidate)) : -1;
      return index === -1 ? item : overlay(item, unused.splice(index, 1)[0]);
    });
  }
  if (!isRecord(desired) || !isRecord(live)) {
    return desired;
  }
  const merged: Record<string, unknown> = { ...live };
  for (const [key, value] of Object.entries(desired)) {
    merged[key] = overlay(value, live[key]);
  }
  return merged;
}
