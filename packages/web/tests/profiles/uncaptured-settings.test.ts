import { captureProfile, parseRepo } from '@repotted/core';
import { expect, test } from 'vitest';

import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { uncapturedSettings } from '../../src/app/profiles/uncaptured-settings.js';

const paymentMethodMissing = answered(
  402,
  'Please ensure your account has a valid payment method on file to access this service.',
);

test('names what a capture of a personal repository could not read by its editor labels, grouped by what would fix it', async () => {
  const github = new FakeGitHub({ repository: { allow_forking: true }, ownerType: 'User' }, 'trae/config')
    .fail('GET /repos/trae/config/code-scanning/ai-scan', answered(403, 'Resource not accessible by integration'))
    .fail('GET /repos/trae/config/actions/cache/retention-limit', paymentMethodMissing)
    .fail('GET /repos/trae/config/actions/cache/storage-limit', paymentMethodMissing);

  const { warnings } = await captureProfile(github, parseRepo('trae/config'));

  expect(warnings).toContainEqual(expect.objectContaining({ key: 'allow_forking', cause: 'unloadable' }));
  expect(uncapturedSettings(warnings, 'user')).toEqual({
    count: 3,
    groups: [
      {
        settings: ['AI Scan on pull requests'],
        reason: "Needs the Repotted App's Code scanning alerts read permission.",
      },
      {
        settings: ['Cache retention, in days', 'Cache size limit, in GB'],
        reason: 'GitHub shows these only with a payment method on file.',
      },
    ],
  });
});

test('names a refused section by its title and a read of several settings by the ones the editor shows first', () => {
  expect(
    uncapturedSettings(
      [
        {
          section: 'rulesets',
          cause: 'refused',
          remedy: { kind: 'permission', permission: 'Metadata read' },
          message: 'GitHub refused to read rulesets',
        },
        {
          section: 'security',
          key: 'security_and_analysis',
          cause: 'refused',
          remedy: { kind: 'admin_role' },
          message: 'GitHub did not report it; it reports it only to repository admins',
        },
        {
          section: 'actions',
          key: 'allowed_actions',
          cause: 'not_applicable',
          message: 'it only applies while Actions is enabled',
        },
        {
          section: 'actions',
          key: 'oidc_customization_sub',
          cause: 'refused',
          remedy: { kind: 'permission', permission: 'Actions read' },
          message: 'GitHub refused to read OIDC',
        },
        {
          section: 'actions',
          key: 'fork_pr_workflows_private_repos',
          cause: 'refused',
          remedy: { kind: 'permission', permission: 'Actions read' },
          message: 'GitHub refused to read fork pull request settings',
        },
      ],
      'organization',
    ),
  ).toEqual({
    count: 7,
    groups: [
      { settings: ['Rulesets'], reason: "Needs the Repotted App's Metadata read permission." },
      {
        settings: ['GitHub Advanced Security', 'GitHub Code Security', 'Secret Protection'],
        reason: 'GitHub shows these only to repository admins.',
      },
      {
        settings: [
          'Use the default subject claim',
          'Use immutable IDs in the subject',
          'Run workflows from fork pull requests',
        ],
        reason: "Needs the Repotted App's Actions read permission.",
      },
    ],
  });
});

test('names only what a profile of its owner type can hold', () => {
  expect(
    uncapturedSettings(
      [
        {
          section: 'security',
          key: 'security_and_analysis',
          cause: 'refused',
          remedy: { kind: 'admin_role' },
          message: 'GitHub did not report it; it reports it only to repository admins',
        },
      ],
      'user',
    ).groups,
  ).toEqual([{ settings: ['Secret Protection'], reason: 'GitHub shows it only to repository admins.' }]);
});
