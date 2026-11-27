import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type Document, isMap, isNode, isSeq, parse, parseDocument, stringify, YAMLSeq } from 'yaml';

import { rulesetFromGitHubExport } from '../plan/sections/rulesets.js';
import { declaredReferences, ProfileError } from './profile.js';
import { definitionKind, definitionSections, type DefinitionKind, environmentKey } from './schema.js';

/**
 * An exported profile carries each reusable definition it references under
 * this key, by the reference as the profile writes it, so the file imports
 * where those definitions aren't. No saved profile holds it.
 */
const bundledKey = 'bundled';

type DefinitionSection = (typeof definitionSections)[DefinitionKind];

export interface BundledDefinition {
  /** As the exported profile's `references` writes it. */
  readonly reference: string;
  readonly kind: DefinitionKind;
  readonly section: DefinitionSection;
  /** The definition's file name without its extension, which names it in its library. */
  readonly name: string;
  readonly text: string;
}

export interface ProfileImport {
  /** Undefined for a profile. */
  readonly kind: DefinitionKind | undefined;
  /** The file as imported, without the definitions it carries. */
  readonly text: string;
  readonly bundled: readonly BundledDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineEndingsOf(source: string, text: string): string {
  return source.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text;
}

function written(document: Document, source: string): string {
  return lineEndingsOf(source, document.toString({ lineWidth: 0, indent: /^( +)\S/mu.exec(source)?.[1]?.length ?? 2 }));
}

/**
 * The profile's saved file with each definition its own `references` name
 * carried under `bundled`. A definition exports as its file is, since it
 * holds nothing it needs from elsewhere.
 */
export async function exportProfile(file: string): Promise<string> {
  const text = await readFile(file, 'utf8');
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new ProfileError(`${file} is not valid YAML`, { cause: document.errors[0] });
  }
  const references = declaredReferences(text);
  if (references.length === 0) {
    return text;
  }
  if (document.has(bundledKey)) {
    throw new ProfileError(`${file} already has a ${bundledKey} key`);
  }
  const bundled: Record<string, unknown> = {};
  for (const reference of references) {
    const target = path.resolve(path.dirname(file), reference);
    let definition: string;
    try {
      definition = await readFile(target, 'utf8');
    } catch (error) {
      throw new ProfileError(`Cannot read reusable definition ${reference}`, { cause: error });
    }
    bundled[reference] = parse(definition) as unknown;
  }
  document.set(bundledKey, document.createNode(bundled));
  return written(document, text);
}

function referencedSections(value: Record<string, unknown>): Map<string, DefinitionSection> {
  const found = new Map<string, DefinitionSection>();
  const references = value['references'];
  if (!isRecord(references)) {
    return found;
  }
  for (const section of Object.values(definitionSections)) {
    const listed = references[section];
    for (const reference of Array.isArray(listed) ? listed : []) {
      if (typeof reference === 'string') {
        found.set(reference, section);
      }
    }
  }
  return found;
}

/**
 * Reads an imported file as a profile or a definition, taking out the
 * definitions an exported profile carries. Each must be one the profile
 * references, of the kind its reference is for. The rest of the file is
 * checked where it is saved, as any profile is.
 */
export function readProfileImport(text: string): ProfileImport {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new ProfileError('The file is not valid YAML', { cause: document.errors[0] });
  }
  const value: unknown = document.toJS();
  if (value !== null && value !== undefined && !isRecord(value)) {
    throw new ProfileError('The file is not a profile or a reusable definition');
  }
  // No profile or definition has these at its top level; a ruleset GitHub exported has them all.
  if (isRecord(value) && typeof value['name'] === 'string' && 'enforcement' in value && 'target' in value) {
    let ruleset: unknown;
    try {
      ruleset = rulesetFromGitHubExport(value);
    } catch (error) {
      throw new ProfileError('The file is not a ruleset as GitHub exports it', { cause: error });
    }
    return {
      kind: 'ruleset',
      text: stringify({ kind: 'ruleset', rulesets: [ruleset] }, { lineWidth: 0 }),
      bundled: [],
    };
  }
  const kindRead = definitionKind.safeParse(value?.['kind']);
  const kind = value?.['kind'] === undefined ? undefined : kindRead.data;
  if (value?.['kind'] !== undefined && kind === undefined) {
    throw new ProfileError(`The file's kind must be one of ${definitionKind.options.join(', ')}`);
  }
  const carried = value?.[bundledKey];
  if (carried === undefined) {
    return { kind, text, bundled: [] };
  }
  if (kind !== undefined) {
    throw new ProfileError(`A reusable definition cannot carry others under ${bundledKey}`);
  }
  if (!isRecord(carried)) {
    throw new ProfileError(`${bundledKey} must map each reference to its definition`);
  }
  const sections = referencedSections(value ?? {});
  const bundled: BundledDefinition[] = [];
  for (const [reference, definition] of Object.entries(carried)) {
    const section = sections.get(reference);
    if (section === undefined) {
      throw new ProfileError(`${bundledKey} holds ${reference}, which the profile doesn't reference`);
    }
    const definitionKindRead = isRecord(definition) ? definitionKind.safeParse(definition['kind']).data : undefined;
    if (definitionKindRead === undefined || definitionSections[definitionKindRead] !== section) {
      throw new ProfileError(`${reference} is not a reusable ${section} definition`);
    }
    bundled.push({
      reference,
      kind: definitionKindRead,
      section,
      name: path.basename(reference).replace(/\.ya?ml$/iu, ''),
      text: lineEndingsOf(text, stringify(definition, { lineWidth: 0 })),
    });
  }
  document.delete(bundledKey);
  return { kind, text: written(document, text), bundled };
}

function valueOf(item: unknown): unknown {
  return isNode(item) ? (item.toJSON() as unknown) : item;
}

function entryKey(section: DefinitionSection, entry: unknown): string | undefined {
  if (!isRecord(entry) || typeof entry['name'] !== 'string') {
    return undefined;
  }
  const name = section === 'environments' ? environmentKey(entry['name']) : entry['name'];
  // A draft and an applying entry of one name stand side by side, so they replace only their own kind.
  return `${entry['draft'] === true ? 'draft' : 'entry'}:${name}`;
}

/**
 * The imported profile with its carried definitions written into it, so it
 * resolves as it did with the references: referenced entries keep their
 * places, an inline entry of the same name replaces one in place, and the
 * rest of the inline entries follow.
 */
export function withBundledInside(imported: ProfileImport): string {
  if (imported.bundled.length === 0) {
    return imported.text;
  }
  const document = parseDocument(imported.text);
  const inside = new Set(imported.bundled.map((item) => item.reference));
  for (const section of Object.values(definitionSections)) {
    const definitions = imported.bundled.filter((item) => item.section === section);
    if (definitions.length === 0) {
      continue;
    }
    const referenced = definitions.flatMap((item) => {
      const value: unknown = parse(item.text);
      const entries = isRecord(value) ? value[section] : undefined;
      return Array.isArray(entries) ? (entries as unknown[]) : [];
    });
    const existing = document.get(section, true);
    const inlineItems = isSeq(existing) ? [...existing.items] : [];
    const inlineKeys = inlineItems.map((item) => entryKey(section, valueOf(item)));
    const used = new Set<number>();
    const items: unknown[] = [];
    for (const entry of referenced) {
      const key = entryKey(section, entry);
      const replacement = inlineKeys.findIndex((other, index) => !used.has(index) && other === key);
      if (replacement === -1) {
        items.push(document.createNode(entry));
      } else {
        used.add(replacement);
        items.push(inlineItems[replacement]);
      }
    }
    items.push(...inlineItems.filter((_, index) => !used.has(index)));
    const list = new YAMLSeq();
    list.items = items;
    document.set(section, list);
    // The profile's own entries and drafts of a name outrank the definition's unset of it, so that unset is left out.
    const replacedInline = new Set(
      inlineKeys.flatMap((key) => (key === undefined ? [] : [key.replace(/^draft:/u, 'entry:')])),
    );
    const unsetKey = (key: string): string | undefined =>
      key.startsWith(`${section}/`) ? entryKey(section, { name: key.slice(section.length + 1) }) : undefined;
    const ownUnset = valueOf(document.getIn(['drafts', 'unset']));
    const known = new Set(
      (Array.isArray(ownUnset) ? (ownUnset as unknown[]) : []).flatMap((key) =>
        typeof key === 'string' ? [unsetKey(key) ?? key] : [],
      ),
    );
    for (const item of definitions) {
      const value: unknown = parse(item.text);
      const drafts = isRecord(value) ? value['drafts'] : undefined;
      const keys = isRecord(drafts) ? drafts['unset'] : undefined;
      for (const key of Array.isArray(keys) ? keys : []) {
        const comparable = typeof key === 'string' ? (unsetKey(key) ?? key) : undefined;
        if (comparable !== undefined && !known.has(comparable) && !replacedInline.has(comparable)) {
          known.add(comparable);
          document.addIn(['drafts', 'unset'], key);
        }
      }
    }
  }
  // A definition's owner type applies to the profile that references it, so one written in keeps it.
  const owners = new Set(
    imported.bundled.flatMap((item) => {
      const value: unknown = parse(item.text);
      return isRecord(value) && typeof value['owner_type'] === 'string' ? [value['owner_type']] : [];
    }),
  );
  const ownOwner: unknown = document.get('owner_type');
  const [owner] = owners;
  if (owners.size > 1 || (owner !== undefined && ownOwner !== undefined && ownOwner !== owner)) {
    throw new ProfileError("The profile's reusable definitions are for different owner types");
  }
  if (owner !== undefined && ownOwner === undefined) {
    document.set('owner_type', owner);
  }
  const references = document.get('references', true);
  if (isMap(references)) {
    for (const pair of [...references.items]) {
      const listed = pair.value;
      if (isSeq(listed)) {
        listed.items = listed.items.filter((item) => {
          const reference = valueOf(item);
          return typeof reference !== 'string' || !inside.has(reference);
        });
        if (listed.items.length === 0) {
          references.delete(pair.key);
        }
      }
    }
    if (references.items.length === 0) {
      document.delete('references');
    }
  }
  return written(document, imported.text);
}

export interface OneTimeSettings {
  /** What a one-time apply sets, as a profile writes it, with no drafts, references, or kind. */
  readonly settings: Record<string, unknown>;
  /** Whether the file held drafts, which a one-time apply leaves out as every apply does. */
  readonly leftOutDrafts: boolean;
}

/**
 * The settings an imported file sets, for a one-time apply that saves
 * nothing: carried definitions written in, drafts left out. References the
 * file carries no definition for are refused, since a one-time apply has no
 * profiles folder to find them in. The settings are checked where the apply
 * is staged.
 */
export function oneTimeSettings(imported: ProfileImport): OneTimeSettings {
  const value: unknown = parse(withBundledInside(imported));
  const read: Record<string, unknown> = isRecord(value) ? value : {};
  const references = read['references'];
  if (references !== undefined) {
    const named = isRecord(references)
      ? Object.values(references).flatMap((listed) => (Array.isArray(listed) ? (listed as unknown[]) : []))
      : [];
    throw new ProfileError(
      `The file references ${named.length === 0 ? 'reusable definitions' : named.join(', ')} without carrying ${named.length === 1 ? 'it' : 'them'}. Export the profile from Repotted to carry its definitions.`,
    );
  }
  const lists = new Set(['autolinks', 'actions_policies', 'rulesets', 'environments', 'labels']);
  const settings: Record<string, unknown> = {};
  let leftOutDrafts = false;
  for (const [key, entry] of Object.entries(read)) {
    if (key === 'drafts') {
      leftOutDrafts = true;
    } else if (lists.has(key) && Array.isArray(entry)) {
      const kept = entry.filter((item: unknown) => !isRecord(item) || item['draft'] !== true);
      leftOutDrafts ||= kept.length < entry.length;
      if (kept.length > 0) {
        settings[key] = kept;
      }
    } else if (key !== 'kind') {
      settings[key] = entry;
    }
  }
  if (Object.keys(settings).every((key) => key === 'owner_type')) {
    throw new ProfileError(
      leftOutDrafts ? 'The file holds only drafts, which an apply leaves out.' : 'The file sets nothing to apply.',
    );
  }
  return { settings, leftOutDrafts };
}
