import type { Change } from './change.js';
import type { Method } from './github.js';

/** A GitHub App permission, by the key GitHub gives it in an installation's `permissions`. */
type AppPermission =
  | 'administration'
  | 'metadata'
  | 'actions'
  | 'pages'
  | 'repository_custom_properties'
  | 'security_events'
  | 'issues';

/** One App permission at the level a request needs. */
interface Permission {
  readonly name: AppPermission;
  readonly level: 'read' | 'write';
}

// The names GitHub's App settings page gives the permissions.
const labels: Readonly<Record<AppPermission, string>> = {
  administration: 'Administration',
  metadata: 'Metadata',
  actions: 'Actions',
  pages: 'Pages',
  repository_custom_properties: 'Custom properties',
  security_events: 'Code scanning alerts',
  issues: 'Issues',
};

const read = (name: AppPermission): Permission => ({ name, level: 'read' });
const write = (name: AppPermission): Permission => ({ name, level: 'write' });

// The GitHub App permission each request needs, as GitHub's REST docs list
// them for GitHub App user tokens. Paths are relative to the repository.
const reads: readonly (readonly [RegExp, readonly Permission[]])[] = [
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

const writes: readonly (readonly [RegExp, readonly Permission[]])[] = [
  [/^\/actions\/oidc\/customization\/sub$/u, [write('actions')]],
  [/^\/properties\/values$/u, [write('repository_custom_properties')]],
  [/^\/pages$/u, [write('administration'), write('pages')]],
  [/^\/labels(\/.*)?$/u, [write('issues')]],
];

/**
 * The permissions a request to a repository path, as `/repos/{owner}/{repo}/pages`,
 * needs. Everything Repotted reads or writes that the tables leave out needs
 * Administration.
 */
function requiredPermissions(method: Method, path: string): readonly Permission[] {
  const relative = path.split('?')[0]?.replace(/^\/repos\/[^/]+\/[^/]+/u, '') ?? '';
  const found = (method === 'GET' ? reads : writes).find(([pattern]) => pattern.test(relative));
  return found?.[1] ?? [method === 'GET' ? read('administration') : write('administration')];
}

/** Permissions as GitHub's settings page names them, as in "Administration write and Pages write". */
function describePermissions(permissions: readonly Permission[]): string {
  return permissions.map((permission) => `${labels[permission.name]} ${permission.level}`).join(' and ');
}

/** The permission a request needs, in words. */
export function requiredPermission(method: Method, path: string): string {
  return describePermissions(requiredPermissions(method, path));
}

/** The signed-in account's role on a repository, the highest of GitHub's `permissions` flags. */
export type Role = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

/**
 * What the GitHub App may do on the repository. `unknown` when the token
 * cannot read installations, as a `GITHUB_TOKEN` or the GitHub CLI's token,
 * so nothing is known about the App.
 */
export type AppAccess =
  | {
      readonly status: 'installed';
      /** The permissions granted to the App's installation, by GitHub's key, as `{ pages: 'write' }`. */
      readonly permissions: Readonly<Record<string, string>>;
      /** The installation's settings page on GitHub, where its owner reviews what the App may do. */
      readonly settings_url: string | null;
    }
  | { readonly status: 'not_installed' }
  | { readonly status: 'unknown' };

/** What the signed-in account and its App may change on one repository. A null role is one GitHub did not report. */
export interface Access {
  readonly role: Role | null;
  readonly app: AppAccess;
}

/** A change Repotted cannot make, by its index in the plan's changes, and why, in a few words. */
export interface Lock {
  readonly change: number;
  readonly reason: string;
}

function grants(granted: string | undefined, level: Permission['level']): boolean {
  return granted === 'write' || granted === 'admin' || (level === 'read' && granted === 'read');
}

/**
 * The changes that `access` does not allow, each with its reason. Repotted
 * lists only repositories the account administers, and treats every write
 * as needing admin. What the access leaves unknown locks nothing; limits of
 * the repository's plan or its owner's policies show only when a write fails.
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
