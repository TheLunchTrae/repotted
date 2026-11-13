import { z } from 'zod';

import { type GitHub, GitHubError } from './github.js';

/** What GitHub has for a pattern that parses. A member that doesn't apply is left out. */
type ActionLookup =
  | {
      /** Nothing to look up: `*` alone, or an owner with a wildcard. */
      readonly status: 'unchecked';
      readonly why: 'everything' | 'wildcard_owner';
    }
  | {
      /** An owner that exists, with a wildcard for its repositories. */
      readonly status: 'owner';
      readonly owner: string;
      readonly owner_type: 'organization' | 'user';
      /** Whether the pattern takes every repository of the owner, as `owner/*` does. */
      readonly all_repositories: boolean;
    }
  | {
      /** A repository that exists, with the ref and path the pattern names, if it names them exactly. */
      readonly status: 'match';
      readonly repository: string;
      readonly archived: boolean;
      readonly ref?: string;
      readonly ref_kind?: 'tag' | 'branch' | 'commit';
      readonly path?: string;
      readonly path_kind?: 'folder' | 'file';
    }
  | { readonly status: 'missing_ref'; readonly repository: string; readonly ref: string }
  | { readonly status: 'missing_path'; readonly repository: string; readonly path: string }
  | {
      /** GitHub answers 404 for what does not exist and for what the token cannot see. */
      readonly status: 'not_found';
      readonly missing: 'owner' | 'repository';
      readonly name: string;
    }
  | { readonly status: 'error'; readonly message: string; readonly rate_limited: boolean };

/**
 * What one allowed action pattern, an entry of
 * `selected_actions.patterns_allowed`, matches on GitHub. Every pattern that
 * parses says whether it `blocks`, which a leading `!` does.
 */
export type ActionPatternCheck = { readonly pattern: string } & (
  | { readonly status: 'invalid'; readonly reason: InvalidReason; readonly message: string }
  | (ActionLookup & { readonly blocks: boolean })
);

type InvalidReason =
  | 'empty'
  | 'space'
  | 'several_refs'
  | 'empty_ref'
  | 'empty_name'
  | 'missing_repository'
  | 'invalid_characters';

/** A pattern's parts. A part with a `*` is a wildcard, and is not looked up. */
interface ParsedPattern {
  readonly blocks: boolean;
  /** Whether it is `*` alone, which takes every action and has no other part. */
  readonly everything: boolean;
  readonly owner: string;
  readonly repository: string;
  readonly path: readonly string[];
  readonly ref: string | undefined;
}

interface Invalid {
  readonly reason: InvalidReason;
  readonly message: string;
}

function invalid(reason: InvalidReason, message: string): Invalid {
  return { reason, message };
}

// Owners take letters, digits and hyphens, and an underscore before the
// short code of an Enterprise Managed User; repositories also take dots.
const ownerCharacter = /[^\w*-]/u;
const repositoryCharacter = /[^\w.*-]/u;
const refCharacter = /[~^:?[\\]/u;
const dotsOnly = /^\.+$/u;

/** The first character `name` may not have, as an invalid pattern's message names it. */
function forbidden(name: string, pattern: RegExp, what: string): Invalid | undefined {
  const found = pattern.exec(name)?.[0];
  if (found !== undefined) {
    return invalid('invalid_characters', `${what} can't have ${found}`);
  }
  // A name of dots would leave the path a lookup asks GitHub for.
  return dotsOnly.test(name) ? invalid('invalid_characters', `${what} can't be only dots`) : undefined;
}

/**
 * What git forbids in the name of a tag or branch. A lookup puts the ref in
 * the path it asks GitHub for, where a part such as `..` would name
 * something else, so a ref git can't have is never asked about.
 */
function refProblem(ref: string): Invalid | undefined {
  const cant = (what: string): Invalid => invalid('invalid_characters', `a tag or branch can't ${what}`);
  // eslint-disable-next-line no-control-regex -- git forbids control characters in a ref
  if (/[\u0000-\u001f\u007f]/u.test(ref)) {
    return cant('have a control character');
  }
  const parts = ref.split('/');
  if (parts.includes('')) {
    return cant('start or end with /, or have //');
  }
  if (ref.includes('..')) {
    return cant('have ..');
  }
  if (parts.some((part) => part.startsWith('.'))) {
    return cant('have a part that starts with a dot');
  }
  if (ref.endsWith('.')) {
    return cant('end with a dot');
  }
  if (parts.some((part) => part.endsWith('.lock'))) {
    return cant('have a part that ends with .lock');
  }
  return forbidden(ref, refCharacter, 'a tag or branch');
}

/** Reads a pattern as GitHub documents them: `OWNER/REPOSITORY[/PATH][@REF]`, with `*` wildcards and a `!` to block. */
function parsePattern(text: string): ParsedPattern | Invalid {
  const blocks = text.startsWith('!');
  const body = blocks ? text.slice(1) : text;
  if (body === '') {
    return invalid('empty', "it's empty");
  }
  if (/\s/u.test(body)) {
    return invalid('space', "a name can't have a space");
  }
  const [name = '', ref, ...moreRefs] = body.split('@');
  if (moreRefs.length > 0) {
    return invalid('several_refs', 'it has more than one @');
  }
  if (ref === '') {
    return invalid('empty_ref', 'nothing follows the @');
  }
  const [owner = '', repository = '', ...path] = name.split('/');
  if (body === '*') {
    return { blocks, everything: true, owner, repository, path, ref };
  }
  if (repository === '' && path.length === 0) {
    return invalid('missing_repository', 'it needs a repository, as owner/repository');
  }
  if (owner === '' || repository === '' || path.includes('')) {
    return invalid('empty_name', 'a name is missing beside a /');
  }
  return (
    forbidden(owner, ownerCharacter, 'an owner') ??
    forbidden(repository, repositoryCharacter, 'a repository') ??
    path.map((part) => forbidden(part, /\\/u, 'a path')).find((problem) => problem !== undefined) ??
    (ref === undefined ? undefined : refProblem(ref)) ?? {
      blocks,
      everything: false,
      owner,
      repository,
      path,
      ref,
    }
  );
}

function wild(part: string): boolean {
  return part.includes('*');
}

function segments(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join('/');
}

type Get = (path: string) => Promise<unknown>;

/** GitHub's answer, or undefined where it answers that there is nothing there, or nothing in an empty repository. */
async function find(get: Get, path: string): Promise<unknown> {
  try {
    return await get(path);
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) {
      return undefined;
    }
    throw error;
  }
}

const account = z.object({ login: z.string(), type: z.string() });
const repositoryFound = z.object({ full_name: z.string(), archived: z.boolean().optional() });

/** A full commit SHA, which a pattern may pin in place of a tag or branch. */
const fullSha = /^[0-9a-f]{40}$/iu;

async function refKind(get: Get, repo: string, ref: string): Promise<'tag' | 'branch' | 'commit' | undefined> {
  if (fullSha.test(ref)) {
    // GitHub answers 422 for a full SHA that names no commit.
    try {
      return (await find(get, `${repo}/commits/${ref}`)) === undefined ? undefined : 'commit';
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        return undefined;
      }
      throw error;
    }
  }
  const name = segments(ref.split('/'));
  if ((await find(get, `${repo}/git/ref/tags/${name}`)) !== undefined) {
    return 'tag';
  }
  return (await find(get, `${repo}/git/ref/heads/${name}`)) === undefined ? undefined : 'branch';
}

async function lookUp(get: Get, parsed: ParsedPattern): Promise<ActionLookup> {
  if (parsed.everything) {
    return { status: 'unchecked', why: 'everything' };
  }
  if (wild(parsed.owner)) {
    return { status: 'unchecked', why: 'wildcard_owner' };
  }
  if (wild(parsed.repository)) {
    const found = await find(get, `/users/${encodeURIComponent(parsed.owner)}`);
    if (found === undefined) {
      return { status: 'not_found', missing: 'owner', name: parsed.owner };
    }
    const owner = account.parse(found);
    return {
      status: 'owner',
      owner: owner.login,
      owner_type: owner.type === 'Organization' ? 'organization' : 'user',
      all_repositories: parsed.repository === '*',
    };
  }
  const repo = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
  const found = await find(get, repo);
  if (found === undefined) {
    return { status: 'not_found', missing: 'repository', name: `${parsed.owner}/${parsed.repository}` };
  }
  // GitHub follows a rename, and takes a name in any case, so its spelling is the one to show.
  const { full_name: repository, archived = false } = repositoryFound.parse(found);
  const ref = parsed.ref === undefined || wild(parsed.ref) ? undefined : parsed.ref;
  const kind = ref === undefined ? undefined : await refKind(get, repo, ref);
  if (ref !== undefined && kind === undefined) {
    return { status: 'missing_ref', repository, ref };
  }
  const named = ref === undefined || kind === undefined ? {} : { ref, ref_kind: kind };
  if (parsed.path.length === 0 || parsed.path.some(wild)) {
    return { status: 'match', repository, archived, ...named };
  }
  // Without an exact ref, the path is looked for on the default branch.
  const query = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
  const contents = await find(get, `${repo}/contents/${segments(parsed.path)}${query}`);
  const path = parsed.path.join('/');
  return contents === undefined
    ? { status: 'missing_path', repository, path }
    : {
        status: 'match',
        repository,
        archived,
        ...named,
        path,
        path_kind: Array.isArray(contents) ? 'folder' : 'file',
      };
}

/** What one run of checks has learned that ends its lookups early. */
interface Run {
  /** GitHub's message once it limits the run. Every lookup after it would get the same answer. */
  limited?: string;
  /** The rejected sign-in that fails the run as a whole, after which nothing more is asked. */
  failed?: GitHubError;
}

async function check(get: Get, run: Run, pattern: string): Promise<ActionPatternCheck> {
  const parsed = parsePattern(pattern);
  if ('reason' in parsed) {
    return { pattern, status: 'invalid', ...parsed };
  }
  const needsGitHub = !parsed.everything && !wild(parsed.owner);
  if (run.limited !== undefined && needsGitHub) {
    return { pattern, blocks: parsed.blocks, status: 'error', message: run.limited, rate_limited: true };
  }
  try {
    return { pattern, blocks: parsed.blocks, ...(await lookUp(get, parsed)) };
  } catch (error) {
    // A sign-in GitHub rejects fails the whole check, like any other command.
    if (!(error instanceof Error) || (error instanceof GitHubError && error.status === 401)) {
      throw error;
    }
    const limited = error instanceof GitHubError && error.rateLimited;
    if (limited) {
      run.limited ??= error.message;
    }
    return { pattern, blocks: parsed.blocks, status: 'error', message: error.message, rate_limited: limited };
  }
}

const lookupsAtOnce = 4;

/**
 * Checks each pattern against GitHub, in the order given: whether it is a
 * pattern at all, and whether the owner, repository, ref and path it names
 * exactly exist. It only reads. Patterns that are the same, or that name the
 * same repository, share their lookups, and at most a few patterns are
 * looked up at once. Once GitHub limits a lookup, the patterns not yet
 * looked up get that error without being asked about, and once it rejects
 * the sign-in, nothing more is asked.
 */
export async function checkActionPatterns(github: GitHub, patterns: readonly string[]): Promise<ActionPatternCheck[]> {
  const answers = new Map<string, Promise<unknown>>();
  const run: Run = {};
  const get: Get = (path) => {
    if (run.failed !== undefined) {
      return Promise.reject(run.failed);
    }
    const known = answers.get(path);
    if (known !== undefined) {
      return known;
    }
    const asked = github.request('GET', path);
    answers.set(path, asked);
    // Noted here, as the answer lands, so a lookup that lands with it asks nothing more.
    asked.catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 401) {
        run.failed ??= error;
      }
    });
    return asked;
  };
  const unique = [...new Set(patterns.map((pattern) => pattern.trim()))];
  const checks = new Map<string, ActionPatternCheck>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let pattern = unique[next]; pattern !== undefined && run.failed === undefined; pattern = unique[next]) {
      next += 1;
      checks.set(pattern, await check(get, run, pattern));
    }
  };
  await Promise.all(Array.from({ length: lookupsAtOnce }, worker));
  return patterns.flatMap((pattern) => checks.get(pattern.trim()) ?? []);
}

function matched(found: Extract<ActionPatternCheck, { status: 'match' }>): string {
  return [
    found.repository,
    ...(found.path === undefined ? [] : [`${found.path_kind ?? 'file'} ${found.path}`]),
    ...(found.ref === undefined || found.ref_kind === undefined
      ? []
      : [`${found.ref_kind} ${found.ref_kind === 'commit' ? found.ref.slice(0, 7) : found.ref}`]),
    ...(found.archived ? ['archived'] : []),
  ].join(', ');
}

/** A check in a line of words, after its pattern, as text output prints it. */
export function describeActionCheck(found: ActionPatternCheck): string {
  const said = ((): string => {
    switch (found.status) {
      case 'invalid':
        return `not a pattern: ${found.message}`;
      case 'unchecked':
        return found.why === 'everything' ? 'matches every action' : "a wildcard owner can't be checked";
      case 'owner':
        return `${found.all_repositories ? 'any repository' : 'some repositories'} from ${found.owner}, ${
          found.owner_type === 'organization' ? 'an organization' : 'a user'
        }`;
      case 'match':
        return matched(found);
      case 'missing_ref':
        return `${found.repository} has no ${fullSha.test(found.ref) ? `commit ${found.ref.slice(0, 7)}` : `tag or branch ${found.ref}`}`;
      case 'missing_path':
        return `${found.repository} has no ${found.path} folder or file`;
      case 'not_found':
        return `no ${found.missing} ${found.name} you can see`;
      case 'error':
        return `could not be checked: ${found.message}`;
    }
  })();
  return `${found.pattern}: ${found.status !== 'invalid' && found.blocks ? 'blocks ' : ''}${said}`;
}

/** A repository a search found, and the action file at its top, if it has one. */
export interface FoundAction {
  /** `owner/name`. */
  readonly repository: string;
  readonly description: string | null;
  readonly stars: number;
  /** `action.yml` or `action.yaml`, or null when the repository's top has neither. */
  readonly action_file: string | null;
}

const searchResults = z.object({
  items: z.array(
    z.object({ full_name: z.string(), description: z.string().nullish(), stargazers_count: z.number().optional() }),
  ),
});

const listing = z.array(z.object({ name: z.string(), type: z.string() }));

async function actionFile(github: GitHub, repository: string): Promise<string | null> {
  try {
    const top = listing.safeParse(await github.request('GET', `/repos/${segments(repository.split('/'))}/contents/`));
    const names = top.success ? top.data.filter((entry) => entry.type === 'file').map((entry) => entry.name) : [];
    return ['action.yml', 'action.yaml'].find((name) => names.includes(name)) ?? null;
  } catch (error) {
    // One repository that can't be listed shows no action file, and the search goes on: an empty one,
    // one the token may not read, or one GitHub fails for. A rate limit or a rejected sign-in ends the search.
    if (error instanceof GitHubError && !error.rateLimited && error.status !== 401) {
      return null;
    }
    throw error;
  }
}

/**
 * Searches GitHub's repositories for `words`, most starred first, and says
 * which of the first ten have an action file at the top. GitHub has no API
 * that searches the Marketplace's actions, so a result may not be an action.
 * It only reads. GitHub allows 30 searches a minute.
 */
export async function findActions(github: GitHub, words: string): Promise<FoundAction[]> {
  const query = encodeURIComponent(`${words} archived:false`);
  const found = searchResults.parse(
    await github.request('GET', `/search/repositories?q=${query}&sort=stars&order=desc&per_page=10`),
  );
  return Promise.all(
    found.items.map(async (item) => ({
      repository: item.full_name,
      description: item.description ?? null,
      stars: item.stargazers_count ?? 0,
      action_file: await actionFile(github, item.full_name),
    })),
  );
}

/** A found repository in a line of words, as text output prints it. */
export function describeFoundAction(found: FoundAction): string {
  const stars = found.stars < 1000 ? String(found.stars) : `${(found.stars / 1000).toFixed(1)}k`;
  const notes = `${stars} stars, ${found.action_file ?? 'no action.yml at the top'}`;
  return `${found.repository} (${notes})${found.description === null ? '' : `: ${found.description}`}`;
}
