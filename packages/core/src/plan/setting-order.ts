import { settingCondition } from '../profiles/setting-dependencies.js';
import { type Change, isListSection } from './change.js';

/** Keep adapter order except where a planned setting needs another planned write first. */
export function orderSettingChanges(changes: readonly Change[]): Change[] {
  const prerequisites = new Map<Change, Set<Change>>(changes.map((change) => [change, new Set()]));
  for (const change of changes) {
    if (isListSection(change.section)) {
      continue;
    }
    const disablesSetup = change.fields.some(
      (field) =>
        (field.field === 'code_scanning_default_setup.state' || field.field === 'code_quality_setup.state') &&
        field.to === 'not-configured',
    );
    for (const field of change.fields) {
      let key = field.field;
      const seen = new Set<string>();
      while (!seen.has(key)) {
        seen.add(key);
        const condition = settingCondition(change.section, key);
        if (condition === undefined) {
          break;
        }
        key = condition.otherSettingKeyInSameSection;
        for (const other of changes) {
          if (
            other !== change &&
            other.section === change.section &&
            other.fields.some((candidate) => candidate.field === key || key.startsWith(`${candidate.field}.`))
          ) {
            prerequisites.get(change)?.add(other);
          }
        }
      }
      if (
        change.section === 'security' &&
        (field.field.startsWith('code_scanning_default_setup.') || field.field.startsWith('code_quality_setup.')) &&
        !disablesSetup
      ) {
        for (const other of changes) {
          if (
            other.section === 'actions' &&
            other.fields.some((candidate) => candidate.field === 'enabled' && candidate.to === true)
          ) {
            prerequisites.get(change)?.add(other);
          }
        }
      }
    }
  }
  const ordered: Change[] = [];
  const visiting = new Set<Change>();
  const visited = new Set<Change>();
  const visit = (change: Change): void => {
    if (visited.has(change)) {
      return;
    }
    if (visiting.has(change)) {
      throw new Error('The plan has conflicting setting prerequisites');
    }
    visiting.add(change);
    for (const prerequisite of prerequisites.get(change) ?? []) {
      visit(prerequisite);
    }
    visiting.delete(change);
    visited.add(change);
    ordered.push(change);
  };
  for (const change of changes) {
    visit(change);
  }
  return ordered;
}
