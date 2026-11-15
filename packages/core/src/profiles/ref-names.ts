// GitHub takes a branch name by Git's own rules for a ref name, the ones
// `git check-ref-format --branch` checks. An environment's deployment pattern
// is matched with fnmatch, so it may also hold `*`, `?` and `[`.

function refNameProblem(name: string, noun: 'branch name' | 'pattern'): string | undefined {
  const wildcardsAllowed = noun === 'pattern';
  if (/\s/u.test(name)) {
    return `A ${noun} can't have spaces.`;
  }
  // eslint-disable-next-line no-control-regex -- Git refuses control characters in a ref name
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    return `A ${noun} can't have control characters.`;
  }
  if (name.includes('..')) {
    return `A ${noun} can't have two dots in a row.`;
  }
  if (name.includes('@{') || name === '@') {
    return `A ${noun} can't be @ or have @{ in it.`;
  }
  const refused = wildcardsAllowed ? /[~^:\\]/u : /[~^:?*[\\]/u;
  if (refused.test(name)) {
    return wildcardsAllowed ? `A ${noun} can't have ~ ^ : or \\.` : `A ${noun} can't have ~ ^ : ? * [ or \\.`;
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return `A ${noun} can't start or end with /, or have two in a row.`;
  }
  const parts = name.split('/');
  if (parts.some((part) => part.startsWith('.'))) {
    return `No part of a ${noun} between slashes can start with a dot.`;
  }
  if (parts.some((part) => part.endsWith('.lock'))) {
    return `No part of a ${noun} between slashes can end with .lock.`;
  }
  if (name.endsWith('.')) {
    return `A ${noun} can't end with a dot.`;
  }
  return undefined;
}

/** Undefined for an empty name, which a field's own rule answers. */
export function branchNameProblem(name: string): string | undefined {
  return name === '' ? undefined : refNameProblem(name, 'branch name');
}

/** For an environment's deployment branch or tag pattern. */
export function branchPatternProblem(pattern: string): string | undefined {
  return pattern === '' ? "A pattern can't be empty." : refNameProblem(pattern, 'pattern');
}
