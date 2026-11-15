import type { Change } from '../plan/change.js';
import type { Method } from './client.js';

type AppPermission =
  | 'administration'
  | 'contents'
  | 'metadata'
  | 'actions'
  | 'pages'
  | 'repository_custom_properties'
  | 'security_events'
  | 'issues';

interface Permission {
  readonly name: AppPermission;
  readonly level: 'read' | 'write';
}

const permissionNamesOnGitHubAppSettingsPage: Readonly<Record<AppPermission, string>> = {
  administration: 'Administration',
  contents: 'Contents',
  metadata: 'Metadata',
  actions: 'Actions',
  pages: 'Pages',
  repository_custom_properties: 'Custom properties',
  security_events: 'Code scanning alerts',
  issues: 'Issues',
};

const read = (name: AppPermission): Permission => ({ name, level: 'read' });
const write = (name: AppPermission): Permission => ({ name, level: 'write' });

/** As the Repotted App's registration on GitHub asks for them. */
const permissionsTheRepottedAppAsksFor: readonly Permission[] = [
  write('administration'),
  write('contents'),
  write('actions'),
  write('pages'),
  write('repository_custom_properties'),
  write('issues'),
  read('security_events'),
  read('metadata'),
];

// As GitHub's REST docs list them for GitHub App user tokens. Paths are relative to the repository.
const permissionsNeededToRead: readonly (readonly [RegExp, readonly Permission[]])[] = [
  [/^$/u, [read('metadata')]],
  [/^\/topics$/u, [read('metadata')]],
  [/^\/private-vulnerability-reporting$/u, [read('metadata')]],
  [/^\/properties\/values$/u, [read('metadata')]],
  [/^\/rulesets(\/\d+)?$/u, [read('metadata')]],
  [/^\/environments(\/.*)?$/u, [read('actions')]],
  [/^\/actions\/cache\/storage-limit$/u, [read('actions')]],
  [/^\/actions\/oidc\/customization\/sub$/u, [read('actions')]],
  [/^\/code-scanning\/ai-scan$/u, [read('security_events')]],
  [/^\/pages$/u, [read('pages')]],
  [/^\/labels(\/.*)?$/u, [read('issues')]],
  // GitHub asks for write access to read these.
  [/^\/code-quality\/setup$/u, [write('administration')]],
  [/^\/interaction-limits\/pulls\/creation-cap$/u, [write('administration')]],
];

const permissionsNeededToWrite: readonly (readonly [RegExp, readonly Permission[]])[] = [
  [/^\/actions\/oidc\/customization\/sub$/u, [write('actions')]],
  [/^\/properties\/values$/u, [write('repository_custom_properties')]],
  [/^\/pages$/u, [write('administration'), write('pages')]],
  [/^\/labels(\/.*)?$/u, [write('issues')]],
];

/** Everything Repotted reads or writes that the tables leave out needs Administration. */
function requiredPermissions(method: Method, path: string): readonly Permission[] {
  const relative = path.split('?')[0]?.replace(/^\/repos\/[^/]+\/[^/]+/u, '') ?? '';
  const found = (method === 'GET' ? permissionsNeededToRead : permissionsNeededToWrite).find(([pattern]) =>
    pattern.test(relative),
  );
  return found?.[1] ?? [method === 'GET' ? read('administration') : write('administration')];
}

function describePermissions(permissions: readonly Permission[]): string {
  return permissions
    .map((permission) => `${permissionNamesOnGitHubAppSettingsPage[permission.name]} ${permission.level}`)
    .join(' and ');
}

export function requiredPermission(method: Method, path: string): string {
  return describePermissions(requiredPermissions(method, path));
}

export type Role = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

/**
 * `unknown`: the token cannot read installations, as a `GITHUB_TOKEN` or the
 * GitHub CLI's token.
 */
export type AppAccess =
  | {
      readonly status: 'installed';
      readonly permissions: Readonly<Record<string, string>>;
      readonly settings_url: string | null;
    }
  | { readonly status: 'not_installed' }
  | { readonly status: 'unknown' };

/** A null role is one GitHub did not report. */
export interface Access {
  readonly role: Role | null;
  readonly app: AppAccess;
}

/** `change` is the change's index in the plan's changes. */
export interface Lock {
  readonly change: number;
  readonly reason: string;
}

function grants(granted: string | undefined, level: Permission['level']): boolean {
  return granted === 'write' || granted === 'admin' || (level === 'read' && granted === 'read');
}

function namesOfPermissionsNotGranted(
  granted: Readonly<Record<string, string>>,
  permissions: readonly Permission[],
): readonly string[] {
  const names = permissions
    .filter((permission) => !grants(granted[permission.name], permission.level))
    .map((permission) => permissionNamesOnGitHubAppSettingsPage[permission.name]);
  return [...new Set(names)];
}

export function permissionsInProse(permissions: readonly string[]): string {
  return `${new Intl.ListFormat('en').format(permissions)} ${permissions.length === 1 ? 'permission' : 'permissions'}`;
}

/**
 * GitHub keeps an installation on the permissions its owner accepted, so
 * those the App asks for later stay missing until an owner accepts them.
 */
export function permissionsInstallationHasNotAccepted(granted: Readonly<Record<string, string>>): readonly string[] {
  return namesOfPermissionsNotGranted(granted, permissionsTheRepottedAppAsksFor);
}

/**
 * What reading and writing a path relative to the repository needs that the
 * installation lacks. What the access leaves unknown lacks nothing.
 */
export function permissionsMissingToManage(app: AppAccess, relativePath: string): readonly string[] {
  if (app.status !== 'installed') {
    return [];
  }
  return namesOfPermissionsNotGranted(app.permissions, [
    ...requiredPermissions('GET', relativePath),
    ...requiredPermissions('PUT', relativePath),
  ]);
}

/**
 * What the access leaves unknown locks nothing. Limits of the repository's plan
 * or its owner's policies show only when a write fails.
 */
export function lockChanges(access: Access, changes: readonly Change[]): Lock[] {
  const locks: Lock[] = [];
  for (const [index, change] of changes.entries()) {
    const { app } = access;
    let reason: string | undefined;
    if (app.status === 'not_installed') {
      reason = 'Needs the GitHub App installed on this repository';
    } else if (access.role !== null && access.role !== 'admin') {
      reason = 'Needs admin on this repository';
    } else if (app.status === 'installed') {
      const missing = requiredPermissions(change.request.method, change.request.path).filter(
        (permission) => !grants(app.permissions[permission.name], permission.level),
      );
      reason = missing.length > 0 ? `Needs ${describePermissions(missing)}` : undefined;
    }
    if (reason !== undefined) {
      locks.push({ change: index, reason });
    }
  }
  return locks;
}
