import type { Plan } from '@repotted/core';

import { entryNounByList, sectionTitles, settingNames } from '../apply/comparison.js';
import { settingSections } from '../profile-editor/setting-fields.js';

type Warning = Plan['warnings'][number];

/** Settings a capture couldn't read for the same reason, by the names the profile editor gives them. */
export interface UncapturedSettingsGroup {
  readonly settings: readonly string[];
  readonly reason: string;
}

export interface UncapturedSettings {
  readonly count: number;
  readonly groups: readonly UncapturedSettingsGroup[];
}

const settingPaths = settingSections.flatMap((section) =>
  section.groups.flatMap((group) => group.fields.map((field) => field.path.join('.'))),
);

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function settingNameOf({ section, key, field }: Warning): string {
  if (section === undefined) {
    return '';
  }
  if (key === undefined) {
    return sectionTitles[section];
  }
  const entryNoun = entryNounByList[section];
  if (entryNoun !== undefined) {
    return `${capitalized(entryNoun)} "${key}"`;
  }
  const path = [section, key, field].filter((part) => part !== undefined).join('.');
  if (settingPaths.includes(path)) {
    return settingNames(path).label;
  }
  const settingsUnder = settingPaths.filter((settingPath) => settingPath.startsWith(`${path}.`));
  const [onlySettingUnder] = settingsUnder;
  if (settingsUnder.length === 1 && onlySettingUnder !== undefined) {
    return settingNames(onlySettingUnder).label;
  }
  return capitalized((field ?? key).replaceAll('_', ' '));
}

function reasonOf(warning: Warning, settingCount: number): string {
  const these = settingCount === 1 ? 'it' : 'these';
  switch (warning.remedy?.kind) {
    case 'permission':
      return `Needs the Repotted App's ${warning.remedy.permission} permission.`;
    case 'admin_role':
      return `GitHub shows ${these} only to repository admins.`;
    case 'payment_method':
      return `GitHub shows ${these} only with a payment method on file.`;
    case undefined:
      return `${capitalized(warning.message)}.`;
  }
}

/**
 * What a capture couldn't read and a person can do something about: what
 * GitHub refused to show. What a profile of its owner type can never hold,
 * or the repository doesn't offer, is left out without a word.
 */
export function uncapturedSettings(warnings: readonly Warning[]): UncapturedSettings {
  const refused = warnings.filter((warning) => warning.cause === 'refused');
  const byRemedy = new Map<string, { first: Warning; settings: string[] }>();
  for (const warning of refused) {
    const remedyKey = warning.remedy === undefined ? `message:${warning.message}` : JSON.stringify(warning.remedy);
    const group = byRemedy.get(remedyKey) ?? { first: warning, settings: [] };
    const name = settingNameOf(warning);
    if (!group.settings.includes(name)) {
      group.settings.push(name);
    }
    byRemedy.set(remedyKey, group);
  }
  const groups = [...byRemedy.values()].map(({ first, settings }) => ({
    settings,
    reason: reasonOf(first, settings.length),
  }));
  return { count: groups.reduce((total, group) => total + group.settings.length, 0), groups };
}
