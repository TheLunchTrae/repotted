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
  /** What was typed for it, while that can't be a value, and why. */
  readonly invalid: { readonly text: string; readonly problem: string } | undefined;
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

function sameValue(left: unknown, right: unknown): boolean {
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
  /** Why the unsaved changes can't be saved as they stand, or why the last save failed. */
  readonly problem = signal<string | undefined>(undefined);
  readonly saving = signal(false);

  readonly #saved = signal<ResolvedProfile | undefined>(undefined);
  /** The profile as a save would leave it, while there are unsaved changes the engine accepts. */
  readonly #preview = signal<ResolvedProfile | undefined>(undefined);
  readonly #edits = signal<ReadonlyMap<string, SettingEdit>>(new Map());
  readonly #invalid = signal<ReadonlyMap<string, { readonly text: string; readonly problem: string }>>(new Map());
  /** The changes a save under way is writing, which the file has as soon as it ends. */
  #writing: ReadonlyMap<string, SettingEdit> = new Map();
  /** Counts previews, so a slow one never replaces a later one's result. */
  #previews = 0;

  constructor(file: string) {
    this.file = file;
  }

  /** Whether any change, typed or chosen, isn't saved. */
  readonly dirty = computed(() => this.#edits.value.size > 0 || this.#invalid.value.size > 0);

  readonly canSave = computed(
    () =>
      this.#edits.value.size > 0 &&
      this.#invalid.value.size === 0 &&
      this.problem.value === undefined &&
      !this.saving.value,
  );

  /** Whether the profile has been read. */
  readonly loaded = computed(() => this.#saved.value !== undefined);

  /** Each tab's groups and settings, as they stand with the unsaved changes. */
  readonly sections = computed(() =>
    settingSections.map((section) => ({
      section,
      groups: section.groups.map((group): GroupRows => ({ group, rows: this.#rows(group) })),
    })),
  );

  /** Reads the profile as it is saved, and lays the unsaved changes over it again. */
  async load(): Promise<void> {
    try {
      this.#saved.value = await resolveProfile(this.file);
      this.loadError.value = undefined;
    } catch (error) {
      this.#saved.value = undefined;
      this.loadError.value = reasonOf(error, this.file);
      return;
    }
    await this.#previewEdits();
  }

  /** Sets a setting in this profile, or with undefined stops setting it here, so a base profile's value applies. */
  async set(field: SettingField, value: unknown): Promise<void> {
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
      for (const other of this.#fields(field.section)) {
        if (other !== field && (field.alone || other.alone) && this.#current(other, edits) !== undefined) {
          change(other, undefined);
        }
      }
    }
    this.#forget(field);
    this.#edits.value = edits;
    await this.#previewEdits();
  }

  /**
   * Takes what was typed for a number, text, or list setting. Text that
   * can't be a value stays as typed, with why, and holds the save back.
   */
  async type(field: SettingField, text: string): Promise<void> {
    const parsed = parse(field, text);
    if ('problem' in parsed) {
      const invalid = new Map(this.#invalid.value);
      invalid.set(keyOf(field.path), { text, problem: parsed.problem });
      this.#invalid.value = invalid;
      return;
    }
    await this.set(field, parsed.value);
  }

  /** Puts a setting back as it is saved. */
  async reset(field: SettingField): Promise<void> {
    const edits = new Map(this.#edits.value);
    edits.delete(keyOf(field.path));
    this.#forget(field);
    this.#edits.value = edits;
    await this.#previewEdits();
  }

  /** Puts the whole profile back as it is saved. */
  async resetAll(): Promise<void> {
    this.#edits.value = new Map();
    this.#invalid.value = new Map();
    await this.#previewEdits();
  }

  /**
   * Writes the unsaved changes to the file through `write`, which gives the
   * save its turn among syncs. Only the settings changed are written, so
   * what the file gained meanwhile stays. A save that fails keeps the
   * changes, with why.
   */
  async save(write: (work: () => Promise<void>) => Promise<void>): Promise<void> {
    if (!this.canSave.value) {
      return;
    }
    this.saving.value = true;
    const edits = [...this.#edits.value.values()];
    this.#writing = this.#edits.value;
    try {
      await write(async () => {
        this.#saved.value = await editProfile(this.file, edits);
      });
      // Changes made while the save ran stay unsaved.
      const left = new Map(this.#edits.value);
      for (const edit of edits) {
        if (left.get(keyOf(edit.path)) === edit) {
          left.delete(keyOf(edit.path));
        }
      }
      this.#edits.value = left;
    } catch (error) {
      this.problem.value = reasonOf(error, this.file);
      return;
    } finally {
      this.#writing = new Map();
      this.saving.value = false;
    }
    await this.#previewEdits();
  }

  #fields(section: string): readonly SettingField[] {
    return settingSections
      .flatMap((item) => item.groups.flatMap((group) => group.fields))
      .filter((item) => item.section === section);
  }

  #forget(field: SettingField): void {
    if (this.#invalid.value.has(keyOf(field.path))) {
      const invalid = new Map(this.#invalid.value);
      invalid.delete(keyOf(field.path));
      this.#invalid.value = invalid;
    }
  }

  /** What the open file itself sets for a setting, as saved; undefined when a base sets it or nothing does. */
  #own(field: SettingField): unknown {
    const saved = this.#saved.value;
    const source = saved?.sources[sectionOf(field)][field.key];
    return saved !== undefined && source === saved.chain[0] ? getIn(saved.profile, field.path) : undefined;
  }

  /** What applies for a setting given these edits, before any preview of them. */
  #current(field: SettingField, edits: ReadonlyMap<string, { readonly value: unknown }>): unknown {
    const edit = edits.get(keyOf(field.path));
    return edit === undefined ? getIn((this.#preview.value ?? this.#saved.value)?.profile, field.path) : edit.value;
  }

  async #previewEdits(): Promise<void> {
    const turn = (this.#previews += 1);
    const edits = [...this.#edits.value.values()];
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
    const value = (field: SettingField): unknown => {
      const edit = edits.get(keyOf(field.path));
      // An edit the engine refused still shows as chosen, beside why. One that stops
      // setting the value here shows what then applies, such as a base profile's.
      return edit?.value === undefined ? getIn(shown.profile, field.path) : edit.value;
    };
    const holds = (field: SettingField): boolean => {
      const condition = field.dependsOn;
      if (condition === undefined) {
        return false;
      }
      const other = getIn(shown.profile, [field.section, ...condition.key.split('.')]);
      return other !== undefined && condition.values.some((item) => sameValue(item, other));
    };
    const section = this.#fields(group.fields[0]?.section ?? '');
    return group.fields
      .filter((field) => !(field.dependsOn?.hides === true && holds(field)))
      .map((field) => {
        const source = shown.sources[sectionOf(field)][field.key];
        return {
          field,
          value: value(field),
          source: source === undefined ? undefined : source === shown.chain[0] ? 'here' : basename(source),
          unsaved: edits.has(keyOf(field.path)),
          off: field.dependsOn?.hides === false && holds(field),
          invalid: this.#invalid.value.get(keyOf(field.path)),
          hiddenNamed: section.filter(
            (other) =>
              other.dependsOn?.hides === true &&
              other.dependsOn.key === field.key &&
              holds(other) &&
              value(other) !== undefined,
          ).length,
        };
      });
  }
}
