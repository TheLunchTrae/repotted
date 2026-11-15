import { sameValue } from '../../app/profile-editor/same-value.js';
import type { SettingField } from '../../app/profile-editor/setting-fields.js';

/** A setting's value as the editor names it in a sentence. */
export function describeValue(field: SettingField, value: unknown): string {
  if (value === undefined) {
    return 'not managed';
  }
  const option = field.options.find((item) => sameValue(item.value, value));
  if (option !== undefined) {
    return option.label;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'none' : value.join(', ');
  }
  return value === null || value === '' ? 'empty' : typeof value === 'string' ? value : JSON.stringify(value);
}
