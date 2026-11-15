import { z } from 'zod';

import { type GitHub, GitHubError, readAllPages, repoPath, type RepoRef } from './client.js';
import { type Access, type AppAccess, permissionsInstallationHasNotAccepted, type Role } from './permissions.js';

export interface Repository {
  readonly full_name: string;
  readonly private: boolean;
  readonly archived: boolean;
}

/** `settings_url` is where an owner accepts them. */
export interface InstallationMissingPermissions {
  readonly owner: string;
  readonly permissions: readonly string[];
  readonly settings_url: string | null;
}

/** `missing_permissions` names only installations that hold a listed repository. */
export interface RepositoryList {
  readonly source: 'installations' | 'admin';
  readonly repositories: readonly Repository[];
  readonly missing_permissions: readonly InstallationMissingPermissions[];
}

const repository = z.object({
  full_name: z.string(),
  private: z.boolean(),
  archived: z.boolean().optional(),
  permissions: z.object({ admin: z.boolean() }).partial().optional(),
});

const installation = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string() }).partial().nullish(),
  repository_selection: z.enum(['all', 'selected']).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  html_url: z.string().optional(),
});

const installationPage = z.object({
  total_count: z.number().int(),
  installations: z.array(installation),
});

const installationRepositoryPage = z.object({
  total_count: z.number().int(),
  repositories: z.array(repository),
});

function describe(entry: z.infer<typeof repository>): Repository {
  return { full_name: entry.full_name, private: entry.private, archived: entry.archived ?? false };
}

function administered(entry: z.infer<typeof repository>): boolean {
  return entry.permissions?.admin === true;
}

function byName(left: Repository, right: Repository): number {
  return left.full_name.localeCompare(right.full_name);
}

async function installationRepositoryList(github: GitHub, id: number): Promise<z.infer<typeof repository>[]> {
  return readAllPages(`/user/installations/${id}/repositories`, async (url) => {
    const page = installationRepositoryPage.parse(await github.request('GET', url));
    return { items: page.repositories, total: page.total_count };
  });
}

async function installationRepositories(
  github: GitHub,
  installations: readonly z.infer<typeof installation>[],
): Promise<Omit<RepositoryList, 'source'>> {
  const found = new Map<string, Repository>();
  const missing: InstallationMissingPermissions[] = [];
  for (const installed of installations) {
    // An installation lists every repository the user can read.
    const repositories = (await installationRepositoryList(github, installed.id)).filter(administered);
    for (const entry of repositories) {
      found.set(entry.full_name, describe(entry));
    }
    const permissions =
      installed.permissions === undefined ? [] : permissionsInstallationHasNotAccepted(installed.permissions);
    const owner = installed.account?.login;
    if (repositories.length > 0 && permissions.length > 0 && owner !== undefined) {
      missing.push({ owner, permissions, settings_url: installed.html_url ?? null });
    }
  }
  return {
    repositories: [...found.values()].sort(byName),
    missing_permissions: missing.sort((left, right) => left.owner.localeCompare(right.owner)),
  };
}

async function adminRepositories(github: GitHub): Promise<Repository[]> {
  const repositories = await readAllPages(
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name',
    async (url) => ({ items: z.array(repository).parse(await github.request('GET', url)) }),
  );
  return repositories.filter(administered).map(describe);
}

/** Undefined when GitHub refuses the list, which it does to any token but a GitHub App user token. */
async function listInstallations(github: GitHub): Promise<z.infer<typeof installation>[] | undefined> {
  try {
    return await readAllPages('/user/installations', async (url) => {
      const page = installationPage.parse(await github.request('GET', url));
      return { items: page.installations, total: page.total_count };
    });
  } catch (error) {
    // A rate limit is a 403 too, and must not read as a token without installations.
    if (error instanceof GitHubError && error.status === 403 && !error.rateLimited) {
      return undefined;
    }
    throw error;
  }
}

/**
 * A token that is not a GitHub App user token gets every repository the
 * account administers, which the token itself may not be allowed to change.
 */
export async function listRepositories(github: GitHub): Promise<RepositoryList> {
  const installations = await listInstallations(github);
  if (installations === undefined) {
    return { source: 'admin', repositories: (await adminRepositories(github)).sort(byName), missing_permissions: [] };
  }
  return { source: 'installations', ...(await installationRepositories(github, installations)) };
}

const viewer = z.object({
  full_name: z.string().optional(),
  permissions: z
    .object({ admin: z.boolean(), maintain: z.boolean(), push: z.boolean(), triage: z.boolean(), pull: z.boolean() })
    .partial()
    .optional(),
});

function sameName(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function readRole(flags: z.infer<typeof viewer>['permissions']): Role | null {
  const order = [
    ['admin', 'admin'],
    ['maintain', 'maintain'],
    ['push', 'write'],
    ['triage', 'triage'],
    ['pull', 'read'],
  ] as const;
  return order.find(([flag]) => flags?.[flag] === true)?.[1] ?? null;
}

async function readAppAccess(github: GitHub, fullNameOnGitHubNow: string): Promise<AppAccess> {
  const installations = await listInstallations(github);
  if (installations === undefined) {
    return { status: 'unknown' };
  }
  // An account installs an App once, so the installation on the owner is the only one that can cover the repository.
  const owner = fullNameOnGitHubNow.split('/')[0] ?? fullNameOnGitHubNow;
  const owned = installations.find((item) => sameName(item.account?.login, owner));
  const covers =
    owned !== undefined &&
    (owned.repository_selection === 'all' ||
      (await installationRepositoryList(github, owned.id)).some((entry) =>
        sameName(entry.full_name, fullNameOnGitHubNow),
      ));
  if (owned === undefined || !covers) {
    return { status: 'not_installed' };
  }
  if (owned.permissions === undefined) {
    return { status: 'unknown' };
  }
  return { status: 'installed', permissions: owned.permissions, settings_url: owned.html_url ?? null };
}

export async function readInstallationSettingsUrl(github: GitHub, owner: string): Promise<string | null> {
  const installations = await listInstallations(github);
  return installations?.find((item) => sameName(item.account?.login, owner))?.html_url ?? null;
}

export async function readAccess(github: GitHub, repo: RepoRef): Promise<Access> {
  const found = viewer.parse(await github.request('GET', repoPath(repo)));
  return {
    role: readRole(found.permissions),
    app: await readAppAccess(github, found.full_name ?? `${repo.owner}/${repo.name}`),
  };
}

const user = z.object({ login: z.string(), name: z.string().nullish() });

export async function currentUser(github: GitHub): Promise<{ login: string; name: string | null }> {
  const parsed = user.parse(await github.request('GET', '/user'));
  return { login: parsed.login, name: parsed.name ?? null };
}
