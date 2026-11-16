import { z } from 'zod';

import { type GitHub, GitHubError } from './client.js';

export interface FoundGitHubApp {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
}

const app = z.object({ id: z.number().int(), slug: z.string(), name: z.string() });

/** Takes an app's slug, or its address on github.com, and answers the slug, or undefined when it can't be one. */
export function gitHubAppSlug(typed: string): string | undefined {
  const trimmed = typed.trim();
  const slug = /^(?:https?:\/\/)?(?:www\.)?github\.com\/apps\/([^/?#]+)\/?(?:[?#].*)?$/iu.exec(trimmed)?.[1] ?? trimmed;
  return /^[a-z0-9][a-z0-9-]*$/iu.test(slug) ? slug.toLowerCase() : undefined;
}

/** GitHub answers for any public app, and for a private one only to its owner. Undefined when it answers that there is none. */
export async function findGitHubApp(github: GitHub, slug: string): Promise<FoundGitHubApp | undefined> {
  try {
    const found = app.parse(await github.request('GET', `/apps/${encodeURIComponent(slug)}`));
    return { id: found.id, slug: found.slug, name: found.name };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404 && error.receivedResponse) {
      return undefined;
    }
    throw error;
  }
}
