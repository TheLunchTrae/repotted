import {
  type BundledDefinition,
  declaredExtends,
  declaredReferences,
  type ProfileImport,
  withBundledInside,
  withExtends,
  withRewrittenReferences,
} from '@repotted/core';
import { parse } from 'yaml';

import { mkdir, readdir, readFile, rm, writeFile } from '../../engine/files.js';
import { dirname, join, relative, resolve } from '../../engine/path.js';
import { sameValue } from '../profile-editor/same-value.js';
import { profileNameProblem } from './profile-name.js';

/** Whether an exported profile's definitions are saved to their libraries or written into the profile. */
export type BundledChoice = 'reusable' | 'inside';

export interface ImportedDefinition {
  readonly bundled: BundledDefinition;
  /** The name it is saved under in its library. */
  readonly name: string;
  /** Where it goes in the profiles folder. */
  readonly file: string;
  /**
   * `new` is written on save; `same` is a definition of that name already
   * there with the same settings, which the profile uses instead; `taken` is
   * one with other settings, so the import needs another name.
   */
  readonly state: 'new' | 'same' | 'taken';
}

/**
 * An import laid out under the staging folder as it will be in the profiles
 * folder, so its editor resolves it as saved. Nothing is in the profiles
 * folder until `saveStagedImport`.
 */
export interface StagedImport {
  readonly folder: string;
  readonly staging: string;
  /** The staged profile or definition, which the editor opens. */
  readonly file: string;
  /** Where the file goes on save. */
  readonly destination: string;
  readonly definitions: readonly ImportedDefinition[];
}

function under(folder: string, target: string): boolean {
  return target === folder || target.startsWith(`${folder}/`);
}

/**
 * Rewrites the file's `extends` and `references`, written from `from`, so
 * they name the same files written from `to`, after `move` maps each.
 */
function reRooted(text: string, from: string, to: string, move: (target: string) => string): string {
  const rewrite = (named: string): string => relative(to, move(resolve(from, named)));
  const references = declaredReferences(text).length === 0 ? text : withRewrittenReferences(text, rewrite);
  const base = declaredExtends(references);
  return base === undefined ? references : withExtends(references, rewrite(base));
}

async function namesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
}

async function placed(folder: string, bundled: BundledDefinition, name: string): Promise<ImportedDefinition> {
  const library = join(folder, 'definitions', bundled.kind);
  const existing = (await namesIn(library)).find(
    (item) => item.replace(/\.ya?ml$/iu, '').toLowerCase() === name.trim().toLowerCase(),
  );
  if (existing === undefined) {
    return { bundled, name: name.trim(), file: join(library, `${name.trim()}.yaml`), state: 'new' };
  }
  const file = join(library, existing);
  const same = sameValue(parse(await readFile(file, 'utf8')), parse(bundled.text));
  return { bundled, name: name.trim(), file, state: same ? 'same' : 'taken' };
}

/**
 * Lays the import out under `staging`, which it empties first. `names`
 * renames definitions by their reference, for those whose name is taken.
 * References and `extends` the import carries no file for keep naming the
 * files they name from `destination`.
 */
export async function stageProfileImport(options: {
  readonly folder: string;
  readonly staging: string;
  readonly destination: string;
  readonly imported: ProfileImport;
  readonly choice: BundledChoice;
  readonly names?: Readonly<Record<string, string>>;
}): Promise<StagedImport> {
  const { folder, staging, destination, imported, choice } = options;
  if (!under(folder, destination)) {
    throw new Error('Import into the profiles folder.');
  }
  const definitions: ImportedDefinition[] = [];
  if (choice === 'reusable') {
    for (const bundled of imported.bundled) {
      const name = options.names?.[bundled.reference] ?? bundled.name;
      const problem = profileNameProblem(name, 'reusable definition');
      if (problem !== undefined) {
        throw new Error(problem);
      }
      const definition = await placed(folder, bundled, name);
      if (definitions.some((other) => other.file.toLowerCase() === definition.file.toLowerCase())) {
        throw new Error(`Two definitions would be saved as ${relative(folder, definition.file)}.`);
      }
      definitions.push(definition);
    }
  }
  const text = choice === 'inside' ? withBundledInside(imported) : imported.text;
  const stagedFile = join(staging, relative(folder, destination));
  const carried = new Map(
    definitions.map((item) => [resolve(dirname(destination), item.bundled.reference), item] as const),
  );
  // A carried definition goes to its library, or to the one already there; staged new ones sit where they go.
  const staged = reRooted(text, dirname(destination), dirname(stagedFile), (target) => {
    const definition = carried.get(target);
    if (definition === undefined) {
      return target;
    }
    return definition.state === 'new' ? join(staging, relative(folder, definition.file)) : definition.file;
  });
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(stagedFile), { recursive: true });
  await writeFile(stagedFile, staged);
  for (const definition of definitions.filter((item) => item.state === 'new')) {
    const file = join(staging, relative(folder, definition.file));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, definition.bundled.text);
  }
  return { folder, staging, file: stagedFile, destination, definitions };
}

/**
 * Writes the staged import, as its editor last saved it, into the profiles
 * folder: new definitions first, then the file, with references to staged
 * files pointed at where they now are. Nothing it writes is replaced, and a
 * failed write takes back what it wrote. The staging folder goes once all
 * of it is written.
 */
export async function saveStagedImport(staged: StagedImport): Promise<void> {
  const taken = staged.definitions.filter((item) => item.state === 'taken');
  if (taken.length > 0) {
    throw new Error(
      `Rename ${taken.map((item) => item.name).join(', ')}: a different definition of that name is already there.`,
    );
  }
  const fromStaging = (target: string): string =>
    under(staged.staging, target) ? join(staged.folder, relative(staged.staging, target)) : target;
  const text = reRooted(
    await readFile(staged.file, 'utf8'),
    dirname(staged.file),
    dirname(staged.destination),
    fromStaging,
  );
  const writes = staged.definitions
    .filter((item) => item.state === 'new')
    .map((item) => ({ from: join(staged.staging, relative(staged.folder, item.file)), to: item.file }));
  const created: string[] = [];
  let writing = staged.destination;
  try {
    for (const write of writes) {
      writing = write.to;
      await mkdir(dirname(write.to), { recursive: true });
      await writeFile(write.to, await readFile(write.from, 'utf8'), { flag: 'wx' });
      created.push(write.to);
    }
    writing = staged.destination;
    await mkdir(dirname(staged.destination), { recursive: true });
    await writeFile(staged.destination, text, { flag: 'wx' });
  } catch (error) {
    for (const file of created.toReversed()) {
      await rm(file, { force: true });
    }
    const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
    throw exists ? new Error(`${relative(staged.folder, writing)} is already there.`) : error;
  }
  await rm(staged.staging, { recursive: true, force: true });
}
