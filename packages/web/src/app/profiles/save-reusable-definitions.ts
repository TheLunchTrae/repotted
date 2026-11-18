import {
  editProfile,
  parseProfile,
  previewProfileChanges,
  stringifyDefinition,
  type ProfileEdit,
} from '@repotted/core';

import { mkdir, readdir, rm, writeFile } from '../../engine/files.js';
import { dirname, join, relative } from '../../engine/path.js';
import { definitionTypes } from './definition-types.js';
import { profileNameProblem } from './profile-name.js';

export type ReusableSection = 'actions' | 'rulesets' | 'environments';

export interface ReusableDefinition {
  readonly section: ReusableSection;
  readonly name: string;
  readonly targetName?: string;
}

/** Called in the profiles' write turn; failed profile writes remove every definition made in that turn. */
export async function saveReusableDefinitions(
  folder: string,
  file: string,
  edits: readonly ProfileEdit[],
  definitions: readonly ReusableDefinition[],
): ReturnType<typeof editProfile> {
  const after = await previewProfileChanges(file, edits);
  if (after.kind !== undefined) {
    throw new Error('Create reusable definitions from a profile, rather than another definition.');
  }
  const references = { ...after.references };
  const files: { file: string; text: string }[] = [];
  const actions = definitions.some((definition) => definition.section === 'actions');
  const writes: ProfileEdit[] = edits.filter((edit) =>
    'list' in edit
      ? !definitions.some((definition) => definition.section === edit.list && definition.targetName === edit.name)
      : !(actions && (edit.path[0] === 'actions' || (edit.path[0] === 'drafts' && edit.path[1] === 'actions'))) &&
        edit.path[0] !== 'references',
  );
  if (actions) {
    writes.push({ path: ['actions'], value: undefined }, { path: ['drafts', 'actions'], value: undefined });
  }
  for (const definition of definitions) {
    const problem = profileNameProblem(definition.name, 'reusable definition');
    if (problem !== undefined) {
      throw new Error(problem);
    }
    const library = definitionTypes.find((item) => item.section === definition.section);
    if (library === undefined) {
      throw new Error(`Cannot save a reusable definition for ${definition.section}.`);
    }
    const destination = join(folder, 'definitions', library.kind);
    const path = join(destination, `${definition.name.trim()}.yaml`);
    const existing = await readdir(destination, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    if (
      existing.some(
        (item) => item.name.replace(/\.ya?ml$/iu, '').toLowerCase() === definition.name.trim().toLowerCase(),
      ) ||
      files.some((item) => item.file.toLowerCase() === path.toLowerCase())
    ) {
      throw new Error(`${definition.name.trim()} is already in ${relative(folder, destination)}.`);
    }
    const value =
      definition.section === 'actions'
        ? after.profile.actions
        : after.profile[definition.section]?.find((entry) => entry.name === definition.targetName);
    if (value === undefined || Object.keys(value).length === 0) {
      throw new Error(`Choose settings for the reusable ${library.label.toLowerCase()} before saving.`);
    }
    const text = stringifyDefinition({
      kind: library.kind,
      ...(after.profile.owner_type === undefined ? {} : { owner_type: after.profile.owner_type }),
      [definition.section]: definition.section === 'actions' ? value : [value],
    });
    await parseProfile(text, destination);
    files.push({ file: path, text });
    const reference = relative(dirname(file), path);
    if (definition.section === 'actions') {
      references.actions = reference;
    } else {
      references[definition.section] = [...(references[definition.section] ?? []), reference];
    }
  }
  writes.push({ path: ['references'], value: references });
  const created: string[] = [];
  try {
    for (const item of files) {
      await mkdir(dirname(item.file), { recursive: true });
      await writeFile(item.file, item.text, { flag: 'wx' });
      created.push(item.file);
    }
    return await editProfile(file, writes);
  } catch (error) {
    for (const path of created.reverse()) {
      await rm(path);
    }
    throw error;
  }
}
