// Names no file can have on Windows, where a config repository's profiles may also be used.
const windowsNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export function profileNameProblem(name: string, noun = 'profile'): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return `Give the ${noun} a name.`;
  }
  if (/^\.|[/\\:*?"<>|\p{Cc}]|[. ]$/u.test(trimmed)) {
    return 'A name cannot start with a dot, end with a dot or a space, or hold / \\ : * ? " < > |.';
  }
  if (/\.ya?ml$/iu.test(trimmed)) {
    return 'Leave out the file ending; Repotted adds .yaml.';
  }
  if (windowsNames.test(trimmed.split('.')[0] ?? trimmed)) {
    return `Windows keeps the name ${trimmed} for itself, so it cannot be a file there.`;
  }
  return undefined;
}
