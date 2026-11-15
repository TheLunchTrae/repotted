import { expect, test } from 'vitest';

import type { AppAccess } from '../../src/github/permissions.js';
import { permissionsMissingForProfilePart } from '../../src/plan/part-permissions.js';

function installedWith(permissions: Record<string, string>): AppAccess {
  return { status: 'installed', permissions, settings_url: 'https://github.com/settings/installations/1' };
}

const everyPermission = {
  administration: 'write',
  contents: 'write',
  actions: 'write',
  pages: 'write',
  repository_custom_properties: 'write',
  issues: 'write',
  security_events: 'read',
  metadata: 'read',
};

test('a part lacks what reading or writing it needs that the installation was not given', () => {
  const { pages: _pages, actions: _actions, ...withoutPagesOrActions } = everyPermission;
  const app = installedWith({ ...withoutPagesOrActions, issues: 'read', security_events: 'none' });

  expect(permissionsMissingForProfilePart(app, 'pages')).toEqual(['Pages']);
  expect(permissionsMissingForProfilePart(app, 'actions', 'oidc_customization_sub')).toEqual(['Actions']);
  expect(permissionsMissingForProfilePart(app, 'actions', 'max_cache_size_gb')).toEqual(['Actions']);
  expect(permissionsMissingForProfilePart(app, 'actions', 'access_level')).toEqual([]);
  expect(permissionsMissingForProfilePart(app, 'security', 'code_scanning_ai_scan')).toEqual(['Code scanning alerts']);
  expect(permissionsMissingForProfilePart(app, 'environments')).toEqual(['Actions']);
  expect(permissionsMissingForProfilePart(app, 'labels')).toEqual(['Issues']);
  expect(permissionsMissingForProfilePart(app, 'repository', 'has_wiki')).toEqual([]);
});

test('a part lacks nothing when the installation is all there, or not known', () => {
  expect(permissionsMissingForProfilePart(installedWith(everyPermission), 'pages')).toEqual([]);
  expect(permissionsMissingForProfilePart({ status: 'unknown' }, 'pages')).toEqual([]);
  expect(permissionsMissingForProfilePart({ status: 'not_installed' }, 'labels')).toEqual([]);
});
