import { z } from 'zod';

import { environmentKey, labelKey } from '../profiles/schema.js';
import type { Change, Section, Warning } from './change.js';

export const authoritativeSections = ['autolinks', 'actions_policies', 'rulesets', 'environments', 'labels'] as const;
export type AuthoritativeSection = (typeof authoritativeSections)[number];
export const authoritativeSchema = z
  .array(z.enum(authoritativeSections))
  .refine(
    (sections) => new Set(sections).size === sections.length,
    'Each authoritative section can be named only once',
  );

export interface Ownership {
  readonly authoritative?: readonly AuthoritativeSection[];
  readonly exclude?: readonly string[];
}

export function owns(ownership: Ownership, section: Section): boolean {
  return (
    ownership.authoritative?.some((name) => name === section) === true && ownership.exclude?.includes(section) !== true
  );
}

function key(section: Section, name: string): string {
  return section === 'environments' ? environmentKey(name) : section === 'labels' ? labelKey(name) : name;
}

export function excludedEntry(ownership: Ownership, section: Section, name: string): boolean {
  return (
    ownership.exclude?.some((excluded) => {
      const prefix = `${section}/`;
      return excluded.startsWith(prefix) && key(section, excluded.slice(prefix.length)) === key(section, name);
    }) === true
  );
}

export function pruneEntries<Entry>(
  desired: readonly Entry[],
  liveNames: readonly string[],
  nameOf: (entry: Entry) => string,
  absent: (name: string) => Entry,
  section: Section,
  ownership: Ownership,
  aliases: readonly string[] = [],
): readonly Entry[] {
  if (!owns(ownership, section)) {
    return desired;
  }
  if (new Set(liveNames.map((name) => key(section, name))).size !== liveNames.length) {
    throw new Error(`Cannot fully own ${section}: live entries have duplicate names, so their targets are ambiguous`);
  }
  const wanted = new Set([...desired.map(nameOf), ...aliases].map((name) => key(section, name)));
  return [
    ...desired,
    ...liveNames
      .filter((name) => !wanted.has(key(section, name)) && !excludedEntry(ownership, section, name))
      .map(absent),
  ].filter((entry) => !excludedEntry(ownership, section, nameOf(entry)));
}

export function ownershipWarnings(changes: readonly Change[], warnings: Warning[], ownership: Ownership): void {
  const blocked = warnings.find(
    (warning) =>
      warning.section !== undefined &&
      owns(ownership, warning.section) &&
      (warning.cause === 'refused' || warning.cause === 'unavailable' || warning.cause === 'unloadable'),
  );
  if (blocked !== undefined) {
    throw new Error(
      `Cannot fully own ${blocked.section}: ${blocked.message}. Nothing was planned. Restore complete read access or turn ownership off.`,
    );
  }
  if (owns(ownership, 'rulesets')) {
    warnings.push({
      section: 'rulesets',
      message:
        'Full ownership controls repository rulesets only. Inherited organization rulesets remain outside repository control.',
    });
  }
  for (const change of changes) {
    if (change.action !== 'delete' || !owns(ownership, change.section)) {
      continue;
    }
    if (change.section === 'environments' && change.entry.branch_policy === undefined) {
      warnings.push({
        section: 'environments',
        key: change.entry.name,
        message: `Deleting environment "${change.entry.name}" also deletes its secrets and variables.`,
      });
    }
    if (change.section === 'labels') {
      warnings.push({
        section: 'labels',
        key: change.entry.name,
        message: `Deleting label "${change.entry.name}" removes it from issues and pull requests.`,
      });
    }
  }
}
