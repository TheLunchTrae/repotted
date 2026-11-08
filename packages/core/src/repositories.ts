import { z } from 'zod';

import { type GitHub, GitHubError, repoPath, type RepoRef } from './github.js';
import type { Access, AppAccess, Role } from './permissions.js';

/** A repository the signed-in account can manage settings on. */
export interface Repository {
  /** `owner/name`. */
  readonly full_name: string;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface RepositoryList {
  /**
   * `installations`: the repositories a GitHub App user token reaches, through
   * the App's installations. `admin`: the repositories any other token can
   * administer.
   */
  readonly source: 'installations' | 'admin';
  readonly repositories: readonly Repository[];
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

const pageSize = 100;

async function readPages<Item>(
  path: string,
  fetchPage: (url: string) => Promise<{ items: Item[]; total?: number }>,
): Promise<Item[]> {
  const items: Item[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    const { items: pageItems, total } = await fetchPage(`${path}${separator}per_page=${pageSize}&page=${page}`);
    items.push(...pageItems);
    if (pageItems.length < pageSize || (total !== undefined && items.length >= total)) {
      return items;
    }
  }
}

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
  return readPages(`/user/installations/${id}/repositories`, async (url) => {
    const page = installationRepositoryPage.parse(await github.request('GET', url));
    return { items: page.repositories, total: page.total_count };
  });
}

async function installationRepositories(
  github: GitHub,
  installations: readonly { id: number }[],
): Promise<Repository[]> {
  const found = new Map<string, Repository>();
  for (const installation of installations) {
    const repositories = await installationRepositoryList(github, installation.id);
    // An installation lists the repositories the user can read; only those
    // they administer can have their settings changed.
    for (const entry of repositories.filter(administered)) {
      found.set(entry.full_name, describe(entry));
    }
  }
  return [...found.values()];
}

async function adminRepositories(github: GitHub): Promise<Repository[]> {
  const repositories = await readPages(
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name',
    async (url) => ({ items: z.array(repository).parse(await github.request('GET', url)) }),
  );
  return repositories.filter(administered).map(describe);
}

/**
 * The App installations the token reaches, or undefined when GitHub refuses
 * the list, which it does to any token but a GitHub App user token.
 */
async function listInstallations(github: GitHub): Promise<z.infer<typeof installation>[] | undefined> {
  try {
    return await readPages('/user/installations', async (url) => {
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
 * Lists the repositories Repotted can manage with this token, by name: those
 * the account administers. A GitHub App user token reaches them through the
 * App's installations. GitHub refuses the installation list to any other
 * token with a 403, so it gets every repository the account administers,
 * which the token itself may not be allowed to change.
 */
export async function listRepositories(github: GitHub): Promise<RepositoryList> {
  const installations = await listInstallations(github);
  if (installations === undefined) {
    return { source: 'admin', repositories: (await adminRepositories(github)).sort(byName) };
  }
  return {
    source: 'installations',
    repositories: (await installationRepositories(github, installations)).sort(byName),
  };
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

/** `fullName` is the repository's name as GitHub has it now, after any rename or transfer. */
async function readAppAccess(github: GitHub, fullName: string): Promise<AppAccess> {
  const installations = await listInstallations(github);
  if (installations === undefined) {
    return { status: 'unknown' };
  }
  // An account installs an App once, so the installation on the owner is the only one that can cover the repository.
  const owner = fullName.split('/')[0] ?? fullName;
  const owned = installations.find((item) => sameName(item.account?.login, owner));
  const covers =
    owned !== undefined &&
    (owned.repository_selection === 'all' ||
      (await installationRepositoryList(github, owned.id)).some((entry) => sameName(entry.full_name, fullName)));
  if (owned === undefined || !covers) {
    return { status: 'not_installed' };
  }
  return { status: 'installed', permissions: owned.permissions ?? {}, settings_url: owned.html_url ?? null };
}

/**
 * What the signed-in account and its GitHub App may change on `repo`: the
 * account's role there, and the permissions granted to the App's
 * installation on it. It only reads.
 */
export async function readAccess(github: GitHub, repo: RepoRef): Promise<Access> {
  const found = viewer.parse(await github.request('GET', repoPath(repo)));
  return {
    role: readRole(found.permissions),
    app: await readAppAccess(github, found.full_name ?? `${repo.owner}/${repo.name}`),
  };
}

const user = z.object({ login: z.string(), name: z.string().nullish() });

/** The account a token signs in as. */
export async function currentUser(github: GitHub): Promise<{ login: string; name: string | null }> {
  const parsed = user.parse(await github.request('GET', '/user'));
  return { login: parsed.login, name: parsed.name ?? null };
}
