import type { Method } from './github.js';

// The GitHub App permission each request needs, as GitHub's REST docs list
// them for GitHub App user tokens. Paths are relative to the repository.
const reads: readonly (readonly [RegExp, string])[] = [
  [/^$/u, 'Metadata read'],
  [/^\/topics$/u, 'Metadata read'],
  [/^\/private-vulnerability-reporting$/u, 'Metadata read'],
  [/^\/properties\/values$/u, 'Metadata read'],
  [/^\/rulesets(\/\d+)?$/u, 'Metadata read'],
  [/^\/environments(\/.*)?$/u, 'Actions read'],
  [/^\/actions\/cache\/storage-limit$/u, 'Actions read'],
  [/^\/actions\/oidc\/customization\/sub$/u, 'Actions read'],
  [/^\/code-scanning\/ai-scan$/u, 'Code scanning alerts read'],
  [/^\/pages$/u, 'Pages read'],
  // GitHub asks for write access to read these.
  [/^\/code-quality\/setup$/u, 'Administration write'],
  [/^\/interaction-limits\/pulls\/creation-cap$/u, 'Administration write'],
];

const writes: readonly (readonly [RegExp, string])[] = [
  [/^\/actions\/oidc\/customization\/sub$/u, 'Actions write'],
  [/^\/properties\/values$/u, 'Custom properties write'],
  [/^\/pages$/u, 'Administration write and Pages write'],
];

/**
 * The permission a request to a repository path, as `/repos/{owner}/{repo}/pages`,
 * needs. Everything Repotted reads or writes that the tables leave out needs
 * Administration.
 */
export function requiredPermission(method: Method, path: string): string {
  const relative = path.split('?')[0]?.replace(/^\/repos\/[^/]+\/[^/]+/u, '') ?? '';
  const found = (method === 'GET' ? reads : writes).find(([pattern]) => pattern.test(relative));
  return found?.[1] ?? (method === 'GET' ? 'Administration read' : 'Administration write');
}
