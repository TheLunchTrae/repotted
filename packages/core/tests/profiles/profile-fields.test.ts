import { expect, test } from 'vitest';
import { parse } from 'yaml';

import { withoutUnknownProfileFields } from '../../src/profiles/profile-fields.js';

test('cleanup removes unknown fields while retaining invalid known values, drafts, and open records', () => {
  const cleaned = withoutUnknownProfileFields(
    `# Keep the header.
unknown: ignored
repository:
  has_wiki: broken # Keep the invalid known value.
  has_wikki: true
actions:
  selected_actions: { verified_allowed: wrong, extra: false }
drafts:
  repository: { has_issues: later, made_up: true }
labels:
  - { name: unfinished, draft: true, color: invalid, extra: true }
rulesets:
  - name: Main
    rules: [{ type: future_rule, parameters: { future_parameter: true }, extra: true }]
    conditions: { future_condition: { extra: true } }
custom_properties: { arbitrary_name: [one, two] }
`.replaceAll('\n', '\r\n'),
  );
  expect(parse(cleaned)).toEqual({
    repository: { has_wiki: 'broken' },
    actions: { selected_actions: { verified_allowed: 'wrong' } },
    drafts: { repository: { has_issues: 'later' } },
    labels: [{ name: 'unfinished', draft: true, color: 'invalid' }],
    rulesets: [
      {
        name: 'Main',
        rules: [{ type: 'future_rule', parameters: { future_parameter: true } }],
        conditions: { future_condition: { extra: true } },
      },
    ],
    custom_properties: { arbitrary_name: ['one', 'two'] },
  });
  expect(cleaned).toContain('# Keep the header.\r\n');
  expect(cleaned).toContain('# Keep the invalid known value.\r\n');
  expect(cleaned.replaceAll('\r\n', '')).not.toContain('\n');
});

test('cleanup retains each use of shared YAML values even when its anchor is removed or pruned', () => {
  const cleaned = withoutUnknownProfileFields(`repository: &shared
  has_wiki: true
  allow_merge_commit: false
merge: *shared
unknown: &settings { has_issues: false }
drafts: { repository: *settings }
`);
  expect(parse(cleaned)).toEqual({
    repository: { has_wiki: true },
    merge: { allow_merge_commit: false },
    drafts: { repository: { has_issues: false } },
  });
});

test('cleanup keeps alias keys and complex or null keys in open records', () => {
  const alias = withoutUnknownProfileFields('unknown: &key has_wiki\nrepository:\n  ? *key\n  : true\n');
  expect(parse(alias)).toEqual({ repository: { has_wiki: true } });
  const text =
    'unknown: true\nhidden: &key one\ncustom_properties: { null: wrong }\nrulesets:\n  - name: Main\n    conditions:\n      ? [one, two]\n      : { future: true }\n      ? [*key, three]\n      : { future: true }\n';
  const before: unknown = parse(text);
  const after: unknown = parse(withoutUnknownProfileFields(text));
  if (typeof before !== 'object' || before === null || typeof after !== 'object' || after === null) {
    throw new Error('Expected profile maps');
  }
  expect(Reflect.get(after, 'custom_properties')).toEqual(Reflect.get(before, 'custom_properties'));
  expect(Reflect.get(after, 'rulesets')).toEqual(Reflect.get(before, 'rulesets'));
});
