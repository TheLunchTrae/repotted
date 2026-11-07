import { z } from 'zod';

import { type GitHub, GitHubError } from './github.js';

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

const installationPage = z.object({
  total_count: z.number().int(),
  installations: z.array(z.object({ id: z.number().int() })),
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

function byName(left: Repository, right: Repository): number {
  return left.full_name.localeCompare(right.full_name);
}

async function installationRepositories(
  github: GitHub,
  installations: readonly { id: number }[],
): Promise<Repository[]> {
  const found = new Map<string, Repository>();
  for (const installation of installations) {
    const repositories = await readPages(`/user/installations/${installation.id}/repositories`, async (url) => {
      const page = installationRepositoryPage.parse(await github.request('GET', url));
      return { items: page.repositories, total: page.total_count };
    });
    for (const entry of repositories) {
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
  return repositories.filter((entry) => entry.permissions?.admin === true).map(describe);
}

/**
 * Lists the repositories Repotted can manage with this token, by name. A
 * GitHub App user token reaches the repositories the App is installed on;
 * GitHub refuses the installation list to any other token, which then gets
 * the repositories it administers.
 */
export async function listRepositories(github: GitHub): Promise<RepositoryList> {
  let installations: { id: number }[];
  try {
    installations = await readPages('/user/installations', async (url) => {
      const page = installationPage.parse(await github.request('GET', url));
      return { items: page.installations, total: page.total_count };
    });
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
      return { source: 'admin', repositories: (await adminRepositories(github)).sort(byName) };
    }
    throw error;
  }
  return {
    source: 'installations',
    repositories: (await installationRepositories(github, installations)).sort(byName),
  };
}

const user = z.object({ login: z.string(), name: z.string().nullish() });

/** The account a token signs in as. */
export async function currentUser(github: GitHub): Promise<{ login: string; name: string | null }> {
  const parsed = user.parse(await github.request('GET', '/user'));
  return { login: parsed.login, name: parsed.name ?? null };
}
