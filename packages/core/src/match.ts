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
