import { computed, signal } from '@preact/signals';
import { editProfile, previewProfile, resolveProfile } from '@repotted/core';

import { basename } from '../engine/path.js';
import { type SettingField, type SettingGroup, settingSections } from './setting-fields.js';

type ResolvedProfile = Awaited<ReturnType<typeof resolveProfile>>;

/** One setting to write, or with an undefined value to stop naming, in the open profile's file. */
interface SettingEdit {
  readonly path: readonly string[];
  readonly value: unknown;
}

/** One setting as the editor draws it. */
export interface SettingRow {
  readonly field: SettingField;
  /** What applies with the unsaved changes: this profile's value, a base profile's, or undefined when none sets it. */
  readonly value: unknown;
  /** The profile that sets the value: 'here' for the open one, a base profile's file name, or undefined. */
  readonly source: string | undefined;
  /** Whether it has a change that isn't saved. */
  readonly unsaved: boolean;
  /** Whether GitHub greys it out for the value of the setting it follows. */
  readonly off: boolean;
  /** What is being typed for it, as typed, until the box is left. */
  readonly text: string | undefined;
  /** Why what was typed can't be a value, which holds the save back. */
  readonly invalid: string | undefined;
  /** How many settings under it GitHub hides for its value while a profile still names them. */
  readonly hiddenNamed: number;
}

export const entryLists = ['rulesets', 'environments', 'labels'] as const;
export type EntryList = (typeof entryLists)[number];
export type Entry = Readonly<Record<string, unknown>>;

/** One ruleset, environment, or label as the editor draws it. */
export interface EntryRow {
  readonly list: EntryList;
  /** What the editor knows the entry by while it is open, whatever its name becomes. */
  readonly key: string;
  /** The entry as it stands with the unsaved changes, or undefined when they take it out of this profile. */
  readonly entry: Entry | undefined;
  /** Its name as saved, or undefined for one that is new. */
  readonly savedName: string | undefined;
  /** The profile that sets it: 'here', a base profile's file name, or undefined for one that is new. */
  readonly source: string | undefined;
  readonly unsaved: boolean;
  /** Why it can't be saved as it stands, such as a name another entry has. */
  readonly problem: string | undefined;
}

/** A change to one entry: the entry to write under the name the file knows it by, or undefined to stop naming it. */
interface EntryChange {
  readonly list: EntryList;
  readonly name: string | undefined;
  readonly entry: Entry | undefined;
}

const entryNouns: Readonly<Record<EntryList, string>> = {
  rulesets: 'a ruleset',
  environments: 'an environment',
  labels: 'a label',
};

function nameOf(entry: Entry | undefined): string {
  return typeof entry?.['name'] === 'string' ? entry['name'].trim() : '';
}

export interface GroupRows {
  readonly group: SettingGroup;
  readonly rows: readonly SettingRow[];
}

function getIn(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined),
    value,
  );
}

/** Whether two setting values are the same, as plain data. */
export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The engine's reason without its marks, and with the file by its name, since the editor shows it beside that profile. */
function reasonOf(error: unknown, file: string): string {
  return messageOf(error)
    .replaceAll(file, basename(file))
    .replaceAll('✖ ', '')
    .replaceAll(/\s*→ at /gu, ', at ');
}

function keyOf(path: readonly string[]): string {
  return path.join('.');
}

type SourceSection = keyof ResolvedProfile['sources'];

function sectionOf(field: SettingField): Exclude<SourceSection, 'drafts'> {
  // Every field's section is one of the profile's settings sections.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- setting-fields.ts names only sections the engine has, which its test holds to the schema
  return field.section as Exclude<SourceSection, 'drafts'>;
}

/** What typed text is as a setting's value, or why it can't be one. */
function parse(field: SettingField, text: string): { readonly value: unknown } | { readonly problem: string } {
  const trimmed = text.trim();
  if (field.kind === 'list') {
    return {
      value: text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    };
  }
  if (field.kind === 'number') {
    return /^[1-9]\d*$/u.test(trimmed) ? { value: Number(trimmed) } : { problem: 'Type a whole number, 1 or more.' };
  }
  if (trimmed === '') {
    if (field.emptyIsNull) {
      return { value: null };
    }
    return field.allowsEmpty
      ? { value: '' }
      : { problem: `${field.label} can't be empty. Remove it to stop setting it.` };
  }
  return { value: trimmed };
}

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What GitHub would refuse in an entry that the profile's schema lets through. */
function fieldProblem(list: EntryList, entry: Entry): string | undefined {
  if (list !== 'rulesets' || !Array.isArray(entry['rules'])) {
    return undefined;
  }
  const checks = entry['rules'].filter(isEntry).find((rule) => rule['type'] === 'required_status_checks');
  const named = isEntry(checks?.['parameters']) ? checks['parameters']['required_status_checks'] : undefined;
  return checks !== undefined && (!Array.isArray(named) || named.length === 0)
    ? 'Name at least one status check that must pass.'
    : undefined;
}

/** Every setting of one section, in the editor's order. */
function fieldsOf(section: string): readonly SettingField[] {
  return settingSections
    .flatMap((item) => item.groups.flatMap((group) => group.fields))
    .filter((item) => item.section === section);
}

/**
 * The open profile's settings and the changes to them that aren't saved.
 * Every change is previewed through the engine as it is made, so the editor
 * shows what a save would give, base profiles included, and a change the
 * engine refuses says why before anything is written.
 */
export class ProfileEditor {
  readonly file: string;
  /** Why the profile can't be read. */
  readonly loadError = signal<string | undefined>(undefined);
  /** Why the unsaved changes can't be saved as they stand. */
  readonly problem = signal<string | undefined>(undefined);
  /** Why the last save failed, until the next save or change. */
  readonly saveError = signal<string | undefined>(undefined);
  readonly saving = signal(false);

  readonly #saved = signal<ResolvedProfile | undefined>(undefined);
  /** The profile as a save would leave it, while there are unsaved changes the engine accepts. */
  readonly #preview = signal<ResolvedProfile | undefined>(undefined);
  readonly #edits = signal<ReadonlyMap<string, SettingEdit>>(new Map());
  /** What is being typed in each box, with why it can't be a value when it can't. */
  readonly #typed = signal<ReadonlyMap<string, { readonly text: string; readonly problem: string | undefined }>>(
    new Map(),
  );
  readonly #entryEdits = signal<ReadonlyMap<string, EntryChange>>(new Map());
  /** Numbers the new entries, so each has a key before it has a name. */
  #newEntries = 0;
  /** The changes a save under way is writing, which the file has as soon as it ends. */
  #writing: ReadonlyMap<string, SettingEdit> = new Map();
  /** Counts previews, so a slow one never replaces a later one's result. */
  #previews = 0;

  constructor(file: string) {
    this.file = file;
  }

  /** Whether the profile has been read. */
  readonly loaded = computed(() => this.#saved.value !== undefined);

  /**
   * Whether any change, typed or chosen, isn't saved. A profile that can't be
   * read counts for nothing, since it offers no way to save or reset; its
   * changes come back if it reads again.
   */
  readonly dirty = computed(
    () => this.loaded.value && (this.#edits.value.size > 0 || this.#entryEdits.value.size > 0 || this.#refused.value),
  );

  readonly canSave = computed(
    () =>
      this.loaded.value &&
      (this.#edits.value.size > 0 || this.#entryEdits.value.size > 0) &&
      !this.#refused.value &&
      !this.#entryProblems.value &&
      this.problem.value === undefined &&
      !this.saving.value,
  );

  /** Each tab's groups and settings, as they stand with the unsaved changes. */
  readonly sections = computed(() =>
    settingSections.map((section) => ({
      section,
      groups: section.groups.map((group): GroupRows => ({ group, rows: this.#rows(group) })),
    })),
  );

  /** The rulesets, environments, and labels, by list, as they stand with the unsaved changes. */
  readonly entries = computed<Readonly<Record<EntryList, readonly EntryRow[]>>>(() => ({
    rulesets: this.#entryRows('rulesets'),
    environments: this.#entryRows('environments'),
    labels: this.#entryRows('labels'),
  }));

  readonly #entryProblems = computed(() =>
    entryLists.some((list) => this.entries.value[list].some((row) => row.problem !== undefined)),
  );

  /** Whether something typed can't be a value. */
  readonly #refused = computed(() => [...this.#typed.value.values()].some((typed) => typed.problem !== undefined));

  /** Reads the profile as it is saved, and lays the unsaved changes over it again. */
  async load(): Promise<void> {
    try {
      this.#saved.value = await resolveProfile(this.file);
      this.loadError.value = undefined;
    } catch (error) {
      this.#saved.value = undefined;
      this.#preview.value = undefined;
      this.loadError.value = reasonOf(error, this.file);
      return;
    }
    await this.#previewEdits();
  }

  /** Sets a setting in this profile, or with undefined stops setting it here, so a base profile's value applies. */
  async set(field: SettingField, value: unknown): Promise<void> {
    this.#forget(field);
    await this.#change(field, value);
  }

  /**
   * Takes what is being typed for a number, text, or list setting, as each
   * key is pressed. The box keeps the text as typed until `settle`. Text
   * that can't be a value says why and holds the save back.
   */
  async type(field: SettingField, text: string): Promise<void> {
    const parsed = parse(field, text);
    const typed = new Map(this.#typed.value);
    typed.set(keyOf(field.path), { text, problem: 'problem' in parsed ? parsed.problem : undefined });
    this.#typed.value = typed;
    if ('value' in parsed) {
      await this.#change(field, parsed.value);
    }
  }

  /** The box was left: what was typed shows as its value from now on, unless it can't be one. */
  settle(field: SettingField): void {
    if (this.#typed.value.get(keyOf(field.path))?.problem === undefined) {
      this.#forget(field);
    }
  }

  /** Starts a ruleset, environment, or label, and answers the key the editor knows it by. */
  async addEntry(list: EntryList, entry: Entry): Promise<string> {
    this.#newEntries += 1;
    const key = `${list}/+${this.#newEntries}`;
    await this.#changeEntry(key, { list, name: undefined, entry });
    return key;
  }

  /**
   * Replaces an entry with what the editor made of it. The whole entry is
   * written, so what the editor doesn't show stays as the caller left it in
   * `entry`. An entry changed back to what is saved is no change.
   */
  async changeEntry(row: EntryRow, entry: Entry): Promise<void> {
    const saved = this.#savedEntry(row.list, row.savedName);
    await this.#changeEntry(
      row.key,
      saved !== undefined && sameValue(saved, entry) ? undefined : { list: row.list, name: row.savedName, entry },
    );
  }

  /** Stops this profile from managing an entry it names itself, or lets go of one that is new. */
  async takeOut(row: EntryRow): Promise<void> {
    await this.#changeEntry(
      row.key,
      row.savedName === undefined ? undefined : { list: row.list, name: row.savedName, entry: undefined },
    );
  }

  /** Puts an entry back as it is saved. */
  async resetEntry(row: EntryRow): Promise<void> {
    await this.#changeEntry(row.key, undefined);
  }

  /** Puts a setting back as it is saved. */
  async reset(field: SettingField): Promise<void> {
    const edits = new Map(this.#edits.value);
    edits.delete(keyOf(field.path));
    this.#forget(field);
    this.#edits.value = edits;
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  /** Puts the whole profile back as it is saved. */
  async resetAll(): Promise<void> {
    this.#edits.value = new Map();
    this.#entryEdits.value = new Map();
    this.#typed.value = new Map();
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  /**
   * Writes the unsaved changes to the file through `write`, which gives the
   * save its turn among syncs. Only the settings changed are written, so
   * what the file gained meanwhile stays. A save that fails keeps the
   * changes, with why, and can be tried again.
   */
  async save(write: (work: () => Promise<void>) => Promise<void>): Promise<void> {
    if (!this.canSave.value) {
      return;
    }
    this.saving.value = true;
    this.saveError.value = undefined;
    const writing = this.#edits.value;
    const entries = this.#entryEdits.value;
    this.#writing = writing;
    try {
      await write(async () => {
        this.#saved.value = await editProfile(this.file, [...writing.values(), ...this.#entryWrites(entries)]);
      });
      // An entry changed again while the save ran stays unsaved, under the name the file has for it then.
      const entriesLeft = new Map<string, EntryChange>();
      for (const [key, change] of this.#entryEdits.value) {
        const written = entries.get(key);
        if (written === undefined) {
          entriesLeft.set(key, change);
        } else if (written !== change) {
          // The file has the entry under the name the save gave it, which is where its row is from now on.
          const name = written.entry === undefined ? change.name : nameOf(written.entry);
          entriesLeft.set(name === undefined ? key : `${change.list}/${name}`, { ...change, name });
        }
      }
      this.#entryEdits.value = entriesLeft;
      // Changes made while the save ran stay unsaved.
      const left = new Map(this.#edits.value);
      for (const [key, edit] of writing) {
        if (left.get(key) === edit) {
          left.delete(key);
        }
      }
      this.#edits.value = left;
    } catch (error) {
      // A setting changed back, while the save ran, to what the save was writing lost its
      // edit as no change. The save wrote nothing, so that edit stands again.
      const edits = new Map(writing);
      for (const [key, edit] of this.#edits.value) {
        edits.set(key, edit);
      }
      this.#edits.value = edits;
      this.saveError.value = reasonOf(error, this.file);
    } finally {
      this.#writing = new Map();
      this.saving.value = false;
    }
    await this.#previewEdits();
  }

  async #change(field: SettingField, value: unknown): Promise<void> {
    const edits = new Map(this.#edits.value);
    const change = (target: SettingField, next: unknown): void => {
      const key = keyOf(target.path);
      // A change back to what the file has, or will have once a save under way ends, is no change.
      const writing = this.#writing.get(key);
      if (sameValue(next, writing === undefined ? this.#own(target) : writing.value)) {
        edits.delete(key);
      } else {
        edits.set(key, { path: target.path, value: next });
      }
    };
    change(field, value);
    if (value !== undefined) {
      // A setting that stands alone and the rest of its section take each other out.
      for (const other of fieldsOf(field.section)) {
        if (other !== field && (field.alone || other.alone) && this.#valueOf(other, edits) !== undefined) {
          change(other, undefined);
        }
      }
    }
    this.#edits.value = edits;
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  #forget(field: SettingField): void {
    if (this.#typed.value.has(keyOf(field.path))) {
      const typed = new Map(this.#typed.value);
      typed.delete(keyOf(field.path));
      this.#typed.value = typed;
    }
  }

  /** What the open file itself sets for a setting, as saved; undefined when a base sets it or nothing does. */
  #own(field: SettingField): unknown {
    const saved = this.#saved.value;
    const source = saved?.sources[sectionOf(field)][field.key];
    return saved !== undefined && source === saved.chain[0] ? getIn(saved.profile, field.path) : undefined;
  }

  /**
   * What applies for a setting with these edits: the edit's value, or for a
   * setting with no edit, or one an edit stops setting here, what the
   * previewed profile has, which is the saved one while a preview is refused.
   */
  #valueOf(field: SettingField, edits: ReadonlyMap<string, SettingEdit>): unknown {
    const edit = edits.get(keyOf(field.path));
    // A null is a value, which clears the setting on GitHub; only an edit with no value falls through.
    return edit?.value === undefined
      ? getIn((this.#preview.value ?? this.#saved.value)?.profile, field.path)
      : edit.value;
  }

  async #changeEntry(key: string, change: EntryChange | undefined): Promise<void> {
    const edits = new Map(this.#entryEdits.value);
    if (change === undefined) {
      edits.delete(key);
    } else {
      edits.set(key, change);
    }
    this.#entryEdits.value = edits;
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  #savedEntries(list: EntryList): readonly Entry[] {
    const entries: unknown = this.#saved.value?.profile[list];
    return Array.isArray(entries) ? entries.filter(isEntry) : [];
  }

  #savedEntry(list: EntryList, name: string | undefined): Entry | undefined {
    return this.#savedEntries(list).find((entry) => entry['name'] === name);
  }

  /** The entry changes as the engine takes them: by the name the file has, or the new entry's own. */
  #entryWrites(
    changes: ReadonlyMap<string, EntryChange>,
  ): { list: EntryList; name: string; entry: Entry | undefined }[] {
    return [...changes.values()].map((change) => ({
      list: change.list,
      name: change.name ?? nameOf(change.entry),
      entry: change.entry === undefined ? undefined : { ...change.entry, name: nameOf(change.entry) },
    }));
  }

  #entryRows(list: EntryList): EntryRow[] {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return [];
    }
    const edits = this.#entryEdits.value;
    const rows = this.#savedEntries(list).map((entry) => {
      const name = nameOf(entry);
      const key = `${list}/${name}`;
      const edit = edits.get(key);
      const source = Object.entries(saved.sources[list]).find(
        ([known]) => known.toLowerCase() === name.toLowerCase(),
      )?.[1];
      return {
        list,
        key,
        entry: edit === undefined ? entry : edit.entry,
        savedName: name,
        source: source === undefined || source === saved.chain[0] ? 'here' : basename(source),
        unsaved: edit !== undefined,
      };
    });
    const added = [...edits]
      .filter(([, change]) => change.list === list && change.name === undefined)
      .map(([key, change]) => ({
        list,
        key,
        entry: change.entry,
        savedName: undefined,
        source: undefined,
        unsaved: true,
      }));
    const all = [...rows, ...added];
    return all.map((row) => {
      const name = nameOf(row.entry).toLowerCase();
      const taken = all.some(
        (other) => other !== row && other.entry !== undefined && nameOf(other.entry).toLowerCase() === name,
      );
      return {
        ...row,
        problem:
          row.entry === undefined
            ? undefined
            : name === ''
              ? 'Give it a name.'
              : taken
                ? `The profile already has ${entryNouns[list]} named ${nameOf(row.entry)}.`
                : fieldProblem(list, row.entry),
      };
    });
  }

  async #previewEdits(): Promise<void> {
    const turn = (this.#previews += 1);
    // An entry with no name, or another's, is held back before the engine sees it.
    const edits = this.#entryProblems.value
      ? [...this.#edits.value.values()]
      : [...this.#edits.value.values(), ...this.#entryWrites(this.#entryEdits.value)];
    if (edits.length === 0 || this.#saved.value === undefined) {
      this.#preview.value = undefined;
      this.problem.value = undefined;
      return;
    }
    try {
      const { after } = await previewProfile(this.file, edits);
      if (turn === this.#previews) {
        this.#preview.value = after;
        this.problem.value = undefined;
      }
    } catch (error) {
      if (turn === this.#previews) {
        // No profile to show but the saved one, with each edit laid over its own setting.
        this.#preview.value = undefined;
        this.problem.value = reasonOf(error, this.file);
      }
    }
  }

  #rows(group: SettingGroup): SettingRow[] {
    const shown = this.#preview.value ?? this.#saved.value;
    if (shown === undefined) {
      return [];
    }
    const edits = this.#edits.value;
    const section = fieldsOf(group.fields[0]?.section ?? '');
    const holds = (field: SettingField): boolean => {
      const condition = field.dependsOn;
      const other = section.find((item) => item.key === condition?.key);
      if (condition === undefined || other === undefined) {
        return false;
      }
      const value = this.#valueOf(other, edits);
      return value !== undefined && condition.values.some((item) => sameValue(item, value));
    };
    return group.fields
      .filter((field) => !(field.dependsOn?.hides === true && holds(field)))
      .map((field) => {
        const key = keyOf(field.path);
        const source = shown.sources[sectionOf(field)][field.key];
        const typed = this.#typed.value.get(key);
        return {
          field,
          value: this.#valueOf(field, edits),
          source: source === undefined ? undefined : source === shown.chain[0] ? 'here' : basename(source),
          unsaved: edits.has(key),
          off: field.dependsOn?.hides === false && holds(field),
          text: typed?.text,
          invalid: typed?.problem,
          hiddenNamed: section.filter(
            (other) =>
              other.dependsOn?.hides === true &&
              other.dependsOn.key === field.key &&
              holds(other) &&
              this.#valueOf(other, edits) !== undefined,
          ).length,
        };
      });
  }
}
