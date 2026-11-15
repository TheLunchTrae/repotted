import * as z from 'zod/mini';

import type { Repository } from './repositories.js';

export const sortOrders = ['name-ascending', 'name-descending', 'pushed-newest', 'pushed-oldest'] as const;
export type SortOrder = (typeof sortOrders)[number];

export const sortOrderLabels: Readonly<Record<SortOrder, string>> = {
  'name-ascending': 'Name, A to Z',
  'name-descending': 'Name, Z to A',
  'pushed-newest': 'Last pushed, newest first',
  'pushed-oldest': 'Last pushed, oldest first',
};

export const visibilityFilters = ['any', 'public', 'private'] as const;
export type VisibilityFilter = (typeof visibilityFilters)[number];
export const archivedFilters = ['any', 'not-archived', 'archived'] as const;
export type ArchivedFilter = (typeof archivedFilters)[number];

export interface ListFilters {
  readonly visibility: VisibilityFilter;
  readonly archived: ArchivedFilter;
  /** A repository passes with any one of them. */
  readonly topics: readonly string[];
}

export const noFilters: ListFilters = { visibility: 'any', archived: 'any', topics: [] };

export type FilterChip =
  | { readonly kind: 'visibility'; readonly label: string }
  | { readonly kind: 'archived'; readonly label: string }
  | { readonly kind: 'topic'; readonly topic: string; readonly label: string };

const savedSortOrder = z.enum(sortOrders);
const savedFilters = z.object({
  visibility: z.catch(z.enum(visibilityFilters), 'any'),
  archived: z.catch(z.enum(archivedFilters), 'any'),
  topics: z.catch(z.array(z.string()), []),
});

export function sortOrderIn(value: unknown): SortOrder {
  const parsed = savedSortOrder.safeParse(value);
  return parsed.success ? parsed.data : 'name-ascending';
}

export function filtersIn(value: unknown): ListFilters {
  const parsed = savedFilters.safeParse(value);
  return parsed.success ? { ...parsed.data, topics: [...new Set(parsed.data.topics)] } : noFilters;
}

export function filterCount(filters: ListFilters): number {
  return Number(filters.visibility !== 'any') + Number(filters.archived !== 'any') + filters.topics.length;
}

export function filtersToSave(filters: ListFilters): ListFilters | undefined {
  return filterCount(filters) === 0 ? undefined : filters;
}

export type FilterPart = 'visibility' | 'archived' | 'topics';

/** `ignoring` leaves one part out, so a menu can count what each of its choices would show. */
export function passesFilters(repository: Repository, filters: ListFilters, ignoring?: FilterPart): boolean {
  if (ignoring !== 'visibility' && filters.visibility !== 'any') {
    if (repository.private !== (filters.visibility === 'private')) {
      return false;
    }
  }
  if (ignoring !== 'archived' && filters.archived !== 'any') {
    if (repository.archived !== (filters.archived === 'archived')) {
      return false;
    }
  }
  if (ignoring !== 'topics' && filters.topics.length > 0) {
    return filters.topics.some((topic) => repository.topics.includes(topic));
  }
  return true;
}

export const visibilityLabels: Readonly<Record<VisibilityFilter, string>> = {
  any: 'Any',
  public: 'Public',
  private: 'Private',
};

export const archivedLabels: Readonly<Record<ArchivedFilter, string>> = {
  any: 'Any',
  'not-archived': 'Not archived',
  archived: 'Archived',
};

export function filterChips(filters: ListFilters): readonly FilterChip[] {
  return [
    ...(filters.visibility === 'any'
      ? []
      : [{ kind: 'visibility', label: visibilityLabels[filters.visibility] } as const]),
    ...(filters.archived === 'any' ? [] : [{ kind: 'archived', label: archivedLabels[filters.archived] } as const]),
    ...filters.topics.map((topic) => ({ kind: 'topic', topic, label: `Topic ${topic}` }) as const),
  ];
}

function byFullName(left: Repository, right: Repository): number {
  return left.full_name.localeCompare(right.full_name, undefined, { sensitivity: 'base' });
}

/** A repository GitHub gives no push time for goes last either way. */
function byPush(newestFirst: boolean): (left: Repository, right: Repository) => number {
  return (left, right) => {
    if (left.pushed_at === right.pushed_at) {
      return byFullName(left, right);
    }
    if (left.pushed_at === null) {
      return 1;
    }
    if (right.pushed_at === null) {
      return -1;
    }
    const difference = Date.parse(left.pushed_at) - Date.parse(right.pushed_at);
    if (difference === 0) {
      return byFullName(left, right);
    }
    return newestFirst ? -difference : difference;
  };
}

export function sorted(repositories: readonly Repository[], order: SortOrder): readonly Repository[] {
  switch (order) {
    case 'name-ascending':
      return repositories.toSorted(byFullName);
    case 'name-descending':
      return repositories.toSorted((left, right) => byFullName(right, left));
    case 'pushed-newest':
      return repositories.toSorted(byPush(true));
    case 'pushed-oldest':
      return repositories.toSorted(byPush(false));
  }
}

const units = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
] as const;

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function pushedLabel(pushedAt: string | null, now: number): string {
  if (pushedAt === null) {
    return 'No push time';
  }
  const elapsed = now - Date.parse(pushedAt);
  const unit = units.find(([, length]) => elapsed >= length);
  if (unit === undefined) {
    return 'Pushed just now';
  }
  const [name, length] = unit;
  return `Pushed ${relativeTime.format(-Math.floor(elapsed / length), name)}`;
}
