import { computed, signal } from '@preact/signals';
import { editProfile, type ProfileEdit, previewProfile, resolveProfile, settingPath } from '@repotted/core';

import { basename } from '../engine/path.js';
import { EntryEdits, type EntryList, type EntryRow, type SaveMode } from './entry-edits.js';
import type { Entry } from './entry-forms.js';
import { ownDraft, ownUnsets, settingsSections as draftSections } from './own-drafts.js';
import { sameValue } from './same-value.js';
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
  /** Whether the value shown is this profile's draft of it, which doesn't apply until a save finishes the draft. */
  readonly inDraft: boolean;
  /** What applies now, from this profile or a base profile, whatever the draft and the unsaved changes say. */
  readonly applied: unknown;
  /** Whether GitHub greys it out for the value of the setting it follows. */
  readonly off: boolean;
  /** What is being typed for it, as typed, until the box is left. */
  readonly text: string | undefined;
  /** Why what was typed can't be a value, which holds the save back. */
  readonly invalid: string | undefined;
  /** How many settings under it GitHub hides for its value while a profile still names them. */
  readonly hiddenNamed: number;
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

/** This profile's own draft of a setting: a value, or that finishing the draft stops setting it here. */
type SettingDraft = { readonly value: unknown } | 'unset';

const entryKeys = /^(?:rulesets|environments|labels)\//u;

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

const allFields: readonly SettingField[] = settingSections.flatMap((section) =>
  section.groups.flatMap((group) => group.fields),
);

/** Every setting of one section, in the editor's order. */
function fieldsOf(section: string): readonly SettingField[] {
  return allFields.filter((item) => item.section === section);
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
  /** The rulesets, environments, and labels, with the changes to them that aren't saved. */
  readonly #entryEdits = new EntryEdits();
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
    () => this.loaded.value && (this.#edits.value.size > 0 || this.#entryEdits.count.value > 0 || this.#refused.value),
  );

  /**
   * How many changes this profile's own draft holds, of those the editor
   * saves and discards: settings, rulesets, environments, and labels. A
   * save that applies finishes them all.
   */
  readonly draftCount = computed(() => {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return 0;
    }
    const settings = allFields.filter((field) => this.#draft(field) !== undefined).map((field) => keyOf(field.path));
    const others = this.#ownUnsets.value.filter((key) => !key.includes('/') && !settings.includes(key));
    return settings.length + this.#otherDrafts().length + others.length + this.#entryEdits.draftCount.value;
  });

  /** What stops each draft from applying as it stands, as the profile was last read or saved. */
  readonly warnings = computed(() => this.#saved.value?.warnings ?? []);

  /** Whether Save can run: it applies the unsaved changes and the draft together, so it needs one of them. */
  readonly canSave = computed(
    () =>
      this.loaded.value &&
      (this.#changed.value || this.draftCount.value > 0) &&
      !this.#refused.value &&
      !this.#entryEdits.held.value &&
      this.problem.value === undefined &&
      !this.saving.value,
  );

  /**
   * Why the unsaved changes can't be kept as a draft, when nothing typed is
   * in the way: a draft may be unfinished, so only an entry's name and a
   * value a draft can't hold stop it.
   */
  readonly draftProblem = computed(() => {
    if (this.#entryEdits.draftHeld.value) {
      return 'Give each new or renamed ruleset, environment, and label a name no other has, to keep them as a draft.';
    }
    const empty = allFields.find((field) => {
      const edit = this.#edits.value.get(keyOf(field.path));
      return edit?.value === null && this.#applied(field) !== null;
    });
    return empty === undefined
      ? undefined
      : `${empty.label}: an empty value can't be kept in a draft. Save it, or reset it.`;
  });

  /** Whether Save as draft can run: it keeps the unsaved changes without applying them. */
  readonly canSaveAsDraft = computed(
    () =>
      this.loaded.value &&
      this.#changed.value &&
      !this.#refused.value &&
      this.draftProblem.value === undefined &&
      !this.saving.value,
  );

  /** Whether the draft can be discarded: that writes at once, so it waits until nothing unsaved would go with it. */
  readonly canDiscardDraft = computed(() => this.draftCount.value > 0 && !this.dirty.value && !this.saving.value);

  /** Each tab's groups and settings, as they stand with the unsaved changes. */
  readonly sections = computed(() =>
    settingSections.map((section) => ({
      section,
      groups: section.groups.map((group): GroupRows => ({ group, rows: this.#rows(group) })),
    })),
  );

  /** The rulesets, environments, and labels, by list, as they stand with the unsaved changes. */
  readonly entries = this.#entryEdits.rows;

  readonly #changed = computed(() => this.#edits.value.size > 0 || this.#entryEdits.count.value > 0);

  readonly #ownUnsets = computed(() => (this.#saved.value === undefined ? [] : ownUnsets(this.#saved.value)));

  /** Whether something typed can't be a value. */
  readonly #refused = computed(() => [...this.#typed.value.values()].some((typed) => typed.problem !== undefined));

  /** Reads the profile as it is saved, and lays the unsaved changes over it again. */
  async load(): Promise<void> {
    try {
      this.#saved.value = await resolveProfile(this.file);
      this.#entryEdits.setSaved(this.#saved.value);
      this.loadError.value = undefined;
    } catch (error) {
      this.#saved.value = undefined;
      this.#entryEdits.setSaved(undefined);
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
    const key = this.#entryEdits.add(list, entry);
    await this.#entriesChanged();
    return key;
  }

  /** Replaces an entry with what its form made of it. */
  async changeEntry(row: EntryRow, entry: Entry): Promise<void> {
    this.#entryEdits.change(row, entry);
    await this.#entriesChanged();
  }

  /** Has the profile remove the entry from each repository, or manage it again with what it had. */
  async setAbsent(row: EntryRow, absent: boolean): Promise<void> {
    this.#entryEdits.setAbsent(row, absent);
    await this.#entriesChanged();
  }

  /** Stops this profile from managing an entry it names itself, or lets go of one that is new. */
  async takeOut(row: EntryRow): Promise<void> {
    this.#entryEdits.takeOut(row);
    await this.#entriesChanged();
  }

  /** Puts back an entry that an unsaved change, or the draft, takes out of the profile. */
  async putBack(row: EntryRow): Promise<void> {
    this.#entryEdits.putBack(row);
    await this.#entriesChanged();
  }

  /** Puts an entry back as it is saved. */
  async resetEntry(row: EntryRow): Promise<void> {
    this.#entryEdits.reset(row);
    await this.#entriesChanged();
  }

  /** Keeps a change to an entry that changed elsewhere since, over that change. */
  async keepEntry(row: EntryRow): Promise<void> {
    this.#entryEdits.keepMine(row);
    await this.#entriesChanged();
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
    this.#entryEdits.resetAll();
    this.#typed.value = new Map();
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  /**
   * Writes the unsaved changes to the file through `write`, which gives the
   * save its turn among syncs. Saving so they apply finishes the profile's
   * draft with them; saving as a draft keeps them in it and leaves what
   * applies as it is. Only what differs is written, so what the file gained
   * meanwhile stays. A save that fails keeps the changes, with why, and can
   * be tried again.
   */
  async save(write: (work: () => Promise<void>) => Promise<void>, mode: SaveMode = 'applies'): Promise<void> {
    if (!(mode === 'applies' ? this.canSave.value : this.canSaveAsDraft.value)) {
      return;
    }
    await this.#write(write, this.#edits.value, (writing) => {
      if (this.#entryEdits.writesOverChange()) {
        throw new Error(
          'A ruleset, environment, or label changed elsewhere since you changed it. Open it to keep yours or reset it.',
        );
      }
      if (mode === 'applies' ? this.#entryEdits.held.value : this.#entryEdits.draftHeld.value) {
        throw new Error("A ruleset, environment, or label can't be saved as it stands. Open it to see why.");
      }
      const entries = this.#entryEdits.saving(mode);
      return [...this.#settingWrites(writing, mode, entries.unsets), ...entries.writes];
    });
  }

  /**
   * Takes this profile's own draft out of its file, so only what applies
   * stays. It keeps what the editor doesn't show, such as a draft autolink.
   */
  async discardDraft(write: (work: () => Promise<void>) => Promise<void>): Promise<void> {
    if (!this.canDiscardDraft.value) {
      return;
    }
    await this.#write(write, new Map(), () => [
      ...allFields.flatMap((field) => {
        const draft = this.#draft(field);
        return draft === undefined || draft === 'unset' ? [] : [{ path: ['drafts', ...field.path], value: undefined }];
      }),
      ...this.#otherDrafts().map(({ path }) => ({ path: ['drafts', ...path], value: undefined })),
      ...this.#unsetWrite(this.#ownUnsets.value.filter((key) => key.startsWith('autolinks/'))),
      ...this.#entryEdits.discards(),
    ]);
  }

  /** Writes what `edits` gives, once the file is read again in the write's turn, and settles the changes it wrote. */
  async #write(
    write: (work: () => Promise<void>) => Promise<void>,
    writing: ReadonlyMap<string, SettingEdit>,
    edits: (writing: ReadonlyMap<string, SettingEdit>) => readonly ProfileEdit[],
  ): Promise<void> {
    this.saving.value = true;
    this.saveError.value = undefined;
    this.#writing = writing;
    this.#entryEdits.begin();
    let wrote = false;
    const shown = this.#saved.value === undefined ? undefined : ownDraft(this.#saved.value);
    try {
      await write(async () => {
        // The file may have changed since it was read, as by the sync before this turn. An entry is
        // written whole, so one that changed under its change is not written over.
        const current = await resolveProfile(this.file);
        this.#saved.value = current;
        this.#entryEdits.setSaved(current);
        // Every save finishes, adds to, or discards the whole draft, so it acts only on the draft that was shown.
        if (!sameValue(shown, ownDraft(current))) {
          throw new Error("The profile's draft changed elsewhere. Look at it as it is now, then save again.");
        }
        this.#saved.value = await editProfile(this.file, edits(writing));
        this.#entryEdits.setSaved(this.#saved.value);
        wrote = true;
      });
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
      const kept = new Map(writing);
      for (const [key, edit] of this.#edits.value) {
        kept.set(key, edit);
      }
      this.#edits.value = kept;
      this.saveError.value = reasonOf(error, this.file);
    } finally {
      this.#entryEdits.saved(wrote);
      this.#writing = new Map();
      this.saving.value = false;
    }
    await this.#previewEdits();
  }

  /** This profile's own draft of a setting, as saved. */
  #draft(field: SettingField): SettingDraft | undefined {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return undefined;
    }
    if (saved.sources.drafts[sectionOf(field)][field.key] === saved.chain[0]) {
      const value = getIn(saved.drafts, field.path);
      return value === undefined ? undefined : { value };
    }
    // Only a setting this file sets can stop being set in it.
    return this.#applied(field) !== undefined && this.#ownUnsets.value.includes(keyOf(field.path))
      ? 'unset'
      : undefined;
  }

  /** What the file gives a setting as last saved, which its row starts from: the draft's value, or what the file applies. */
  #start(field: SettingField): unknown {
    const draft = this.#draft(field);
    return draft === undefined ? this.#applied(field) : draft === 'unset' ? undefined : draft.value;
  }

  /**
   * This profile's own draft settings the editor has no row for and still
   * finishes and discards: a custom property, and any setting the tabs
   * leave to the profile's file. A draft of a key no section has is not one.
   */
  #otherDrafts(): SettingEdit[] {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return [];
    }
    const rows = new Set(allFields.map((field) => keyOf(field.path)));
    return draftSections.flatMap((section) =>
      Object.entries(saved.sources.drafts[section])
        .filter(([, file]) => file === saved.chain[0])
        .map(([key]) => [section, ...key.split('.')])
        .filter((path) => !rows.has(keyOf(path)) && settingPath(path) === 'setting')
        .map((path) => ({ path, value: getIn(saved.drafts, path) })),
    );
  }

  /** The edit that makes the file's `drafts.unset` hold `keys`, or none when it already does. */
  #unsetWrite(keys: readonly string[]): SettingEdit[] {
    return sameValue(keys, this.#ownUnsets.value)
      ? []
      : [{ path: ['drafts', 'unset'], value: keys.length === 0 ? undefined : keys }];
  }

  /**
   * What a save writes for the settings: each one that has a change or a
   * draft as it ends. Saving so they apply writes what differs from what
   * applies and takes the draft out. Saving as a draft writes what differs
   * under `drafts`, lists what stops being set in `drafts.unset` with
   * `entryUnsets`, and leaves what applies as it is.
   */
  #settingWrites(
    edits: ReadonlyMap<string, SettingEdit>,
    mode: SaveMode,
    entryUnsets: readonly string[],
  ): SettingEdit[] {
    const writes: SettingEdit[] = [];
    const unsets: string[] = [];
    const rows = new Set(allFields.map((field) => keyOf(field.path)));
    for (const field of allFields) {
      const key = keyOf(field.path);
      const edit = edits.get(key);
      const draft = this.#draft(field);
      if (edit === undefined && draft === undefined) {
        continue;
      }
      const applied = this.#applied(field);
      const final = edit === undefined ? this.#start(field) : edit.value;
      const differs = !sameValue(final, applied);
      const drafted = draft !== undefined && draft !== 'unset';
      if (mode === 'applies') {
        if (differs) {
          writes.push({ path: field.path, value: final });
        }
        if (drafted) {
          writes.push({ path: ['drafts', ...field.path], value: undefined });
        }
      } else if (final !== undefined && differs) {
        if (!drafted || !sameValue(draft.value, final)) {
          writes.push({ path: ['drafts', ...field.path], value: final });
        }
      } else {
        if (drafted) {
          writes.push({ path: ['drafts', ...field.path], value: undefined });
        }
        if (differs) {
          unsets.push(key);
        }
      }
    }
    // A key no row stands for: an autolink's stays either way, and a custom property's until the draft is finished.
    const others = this.#ownUnsets.value.filter((key) => !entryKeys.test(key) && !rows.has(key));
    if (mode === 'applies') {
      for (const draft of this.#otherDrafts()) {
        writes.push(draft, { path: ['drafts', ...draft.path], value: undefined });
      }
      for (const key of others.filter((other) => !other.includes('/'))) {
        writes.push({ path: key.split('.'), value: undefined });
      }
      return [...writes, ...this.#unsetWrite(others.filter((key) => key.includes('/')))];
    }
    return [...writes, ...this.#unsetWrite([...others, ...unsets, ...entryUnsets])];
  }

  async #change(field: SettingField, value: unknown): Promise<void> {
    const edits = new Map(this.#edits.value);
    const change = (target: SettingField, next: unknown): void => {
      const key = keyOf(target.path);
      // A change back to what the file has, or will have once a save under way ends, is no change.
      const writing = this.#writing.get(key);
      if (sameValue(next, writing === undefined ? this.#start(target) : writing.value)) {
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

  /** What the open file itself sets for a setting so it applies, as saved; undefined when a base sets it or nothing does. */
  #applied(field: SettingField): unknown {
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
    const final = edit === undefined ? this.#start(field) : edit.value;
    // A null is a value, which clears the setting on GitHub; only no value here falls through.
    return final === undefined ? getIn((this.#preview.value ?? this.#saved.value)?.profile, field.path) : final;
  }

  async #entriesChanged(): Promise<void> {
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  async #previewEdits(): Promise<void> {
    const turn = (this.#previews += 1);
    // An entry that can't be saved as it stands, such as one with no name, is held back before the engine sees it.
    const edits =
      this.#saved.value === undefined
        ? []
        : [...this.#settingWrites(this.#edits.value, 'applies', []), ...this.#entryEdits.writes()];
    if (edits.length === 0) {
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
          inDraft: !edits.has(key) && this.#draft(field) !== undefined,
          applied: getIn(this.#saved.value?.profile, field.path),
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
