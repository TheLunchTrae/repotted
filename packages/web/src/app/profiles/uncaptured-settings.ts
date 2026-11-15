import { type OwnerType, partOwnerTypeCannotHold, type Plan } from '@repotted/core';

import { sectionTitles } from '../apply/comparison.js';
import { type SettingField, settingSections } from '../profile-editor/setting-fields.js';

type Warning = Plan['warnings'][number];

/** Settings a capture couldn't read for the same reason, by the names the profile editor gives them. */
export interface UncapturedSettingsGroup {
  readonly settings: readonly string[];
  readonly reason: string;
}

export interface UncapturedSettings {
  readonly count: number;
  readonly groups: readonly UncapturedSettingsGroup[];
  /** Set when a group needs a permission the Repotted App's installation hasn't been given. */
  readonly needsAppPermission: boolean;
  /** Where an owner accepts those permissions, once it's been looked up. */
  readonly installationSettingsUrl: string | null;
}

const editorFields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ownerTypeCanHold(field: SettingField, ownerType: OwnerType | undefined): boolean {
  return partOwnerTypeCannotHold(field.path, ownerType) === undefined;
}

/**
 * A read that covers several editor settings is named by the ones that
 * depend on none of the others.
 */
function settingNamesOf({ section, key, field }: Warning, ownerType: OwnerType | undefined): readonly string[] {
  if (section === undefined) {
    return [];
  }
  if (key === undefined) {
    return [sectionTitles[section]];
  }
  const path = [section, key, field].filter((part) => part !== undefined);
  const underPath = editorFields.filter((editorField) => path.every((part, index) => editorField.path[index] === part));
  if (underPath.length === 0) {
    return [capitalized((field ?? key).replaceAll('_', ' '))];
  }
  const covered = underPath.filter((editorField) => ownerTypeCanHold(editorField, ownerType));
  const exact = covered.find((editorField) => editorField.path.length === path.length);
  if (exact !== undefined) {
    return [exact.label];
  }
  const coveredKeys = new Set(covered.map((editorField) => editorField.key));
  return covered
    .filter((editorField) => !coveredKeys.has(editorField.dependsOn?.otherSettingKeyInSameSection ?? ''))
    .map((editorField) => editorField.label);
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
export function uncapturedSettings(warnings: readonly Warning[], ownerType: OwnerType | undefined): UncapturedSettings {
  const refused = warnings.filter((warning) => warning.cause === 'refused');
  const byRemedy = new Map<string, { first: Warning; settings: string[] }>();
  for (const warning of refused) {
    const remedyKey = warning.remedy === undefined ? `message:${warning.message}` : JSON.stringify(warning.remedy);
    const group = byRemedy.get(remedyKey) ?? { first: warning, settings: [] };
    for (const name of settingNamesOf(warning, ownerType)) {
      if (!group.settings.includes(name)) {
        group.settings.push(name);
      }
    }
    byRemedy.set(remedyKey, group);
  }
  const groups = [...byRemedy.values()]
    .filter(({ settings }) => settings.length > 0)
    .map(({ first, settings }) => ({ settings, reason: reasonOf(first, settings.length) }));
  const needsAppPermission = [...byRemedy.values()].some(
    ({ first, settings }) => settings.length > 0 && first.remedy?.kind === 'permission',
  );
  return {
    count: groups.reduce((total, group) => total + group.settings.length, 0),
    groups,
    needsAppPermission,
    installationSettingsUrl: null,
  };
}
