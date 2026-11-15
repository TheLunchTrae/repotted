import { computed, signal } from '@preact/signals';
import {
  type AppAccess,
  changeOwnerType,
  editProfile,
  type OwnerNeed,
  ownerHas,
  type OwnerType,
  permissionsMissingForProfilePart,
  type ProfileEdit,
  previewProfile,
  resolveProfile,
  settingPath,
  settingRules,
  stringifyProfile,
} from '@repotted/core';

import { basename } from '../../engine/path.js';
import type { ActionPatternChecks } from './action-pattern-checks.js';
import type { ActionSearch } from './action-search.js';
import type { GitHubAppLookup } from './bypass-actors.js';
import { EntryEdits, type EntryList, type EntryRow, type SaveMode } from './entry-edits.js';
import type { Entry } from './entry-forms.js';
import { type DiffFold, type DiffLine, diffLines, foldUnchanged } from './line-diff.js';
import {
  comparableOwnDraft,
  ownUnsets,
  type ResolvedProfile,
  settingsSections as draftSections,
} from './own-drafts.js';
import { sameValue } from './same-value.js';
import {
  type SettingField,
  type SettingGroup,
  type SettingOption,
  type SettingSection,
  settingSections,
} from './setting-fields.js';
import { matchesSearch, parentOf, searchWords } from './setting-search.js';

/**
 * How an editor reads, previews, and writes its file. A profile's editor
 * uses the engine's profile functions; an apply's uses those of its staged
 * apply, whose one-off edits can't be drafts.
 */
export interface EditorStore {
  readonly canHoldDrafts: boolean;
  readonly resolve: (file: string) => Promise<ResolvedProfile>;
  readonly preview: (
    file: string,
    edits: readonly ProfileEdit[],
  ) => Promise<{ readonly before: ResolvedProfile; readonly after: ResolvedProfile }>;
  readonly edit: (file: string, edits: readonly ProfileEdit[]) => Promise<ResolvedProfile>;
}

const profileStore: EditorStore = {
  canHoldDrafts: true,
  resolve: resolveProfile,
  preview: previewProfile,
  edit: editProfile,
};

/** An undefined value stops naming the setting in the open profile's file. */
interface SettingEdit {
  readonly path: readonly string[];
  readonly value: unknown;
}

export interface SettingWithValue {
  readonly field: SettingField;
  readonly value: unknown;
}

interface TurnedOffOnGitHub extends SettingWithValue {
  readonly hidden: boolean;
}

export interface SettingRow {
  readonly field: SettingField;
  readonly optionsForProfileOwnerType: readonly SettingOption[];
  /** Who alone has the setting, where the profile's type doesn't already say: organizations, or those on GitHub Enterprise Cloud. */
  readonly ownerTag: 'Organizations' | 'Enterprise Cloud' | undefined;
  /** With the unsaved changes: this profile's value, a base profile's, or undefined when none sets it. */
  readonly value: unknown;
  /** 'here' for the open profile, a base profile's file name, or undefined. */
  readonly source: string | undefined;
  readonly unsaved: boolean;
  readonly savedDraftHasSetting: boolean;
  readonly valueShownIsFromDraft: boolean;
  /** What applies now, from this profile or a base profile, whatever the draft and the unsaved changes say. */
  readonly applied: unknown;
  /** The highest setting whose value greys this one out on GitHub, and that value. */
  readonly greyedOutOnGitHubWhile: SettingWithValue | undefined;
  readonly textBeingTyped: string | undefined;
  readonly typedTextProblem: string | undefined;
  /** How many settings under it GitHub hides for its value while a profile still names them. */
  readonly hiddenNamed: number;
  /** What the repository's installation of the Repotted App lacks to change the setting, which turns it off. */
  readonly missingPermissions: readonly string[];
  readonly missingPermissionsItsGroupAndSectionDoNotName: readonly string[];
}

export interface GroupRows {
  readonly group: SettingGroup;
  readonly rows: readonly SettingRow[];
  /** What every setting in the group lacks, less what its section names. */
  readonly missingPermissions: readonly string[];
}

export interface SectionRows {
  readonly section: SettingSection;
  readonly groups: readonly GroupRows[];
  readonly missingPermissionsEverySettingShares: readonly string[];
}

function permissionsEveryRowLacks(rows: readonly SettingRow[]): readonly string[] {
  return (rows[0]?.missingPermissions ?? []).filter((permission) =>
    rows.every((row) => row.missingPermissions.includes(permission)),
  );
}

function without(permissions: readonly string[], named: readonly string[]): readonly string[] {
  return permissions.filter((permission) => !named.includes(permission));
}

/** What a save that applies would change: the profile that applies now against the one that would, as a diff of YAML. */
export interface SavePreview {
  readonly lines: readonly (DiffLine | DiffFold)[];
  readonly changedLineCount: number;
  readonly draftChangeCount: number;
  readonly unsavedChangeCount: number;
}

export type SettingFilter = 'managed' | 'unsaved' | 'drafts';

export interface FoundGroup extends GroupRows {
  readonly tab: string;
}

interface Finding {
  readonly query: string;
  readonly filters: ReadonlySet<SettingFilter>;
  /** The paths of the settings that fit, and with them those they sit under. */
  readonly fits: ReadonlySet<string>;
  readonly shown: ReadonlySet<string>;
}

const nothingFound: Finding = { query: '', filters: new Set(), fits: new Set(), shown: new Set() };

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

function yamlLines(resolved: ResolvedProfile): string[] {
  const text = stringifyProfile(resolved.profile).trimEnd();
  return text === '' || text === '{}' ? [] : text.split('\n');
}

/** This profile's own draft of a setting: a value, or that finishing the draft stops setting it here. */
type SettingDraft = { readonly value: unknown } | 'unset';

const patternsPath = 'actions.selected_actions.patterns_allowed';

const entryKeys = /^(?:rulesets|environments|labels)\//u;

function keyOf(path: readonly string[]): string {
  return path.join('.');
}

type SourceSection = keyof ResolvedProfile['sources'];

function sectionOf(field: SettingField): Exclude<SourceSection, 'drafts'> {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- setting-fields.ts names only sections the engine has, which its test holds to the schema
  return field.section as Exclude<SourceSection, 'drafts'>;
}

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

function fieldsOf(section: string): readonly SettingField[] {
  return allFields.filter((item) => item.section === section);
}

/** Who alone has a setting, or one value of it; undefined when every owner does. A rule's path stands for all under it. */
function needOf(path: readonly string[], value?: unknown): OwnerNeed | undefined {
  return settingRules.find(
    (rule) =>
      rule.path.every((part, index) => path[index] === part) &&
      (value === undefined ? rule.value === undefined : rule.value === value),
  )?.needs;
}

function fits(type: OwnerType | undefined, need: OwnerNeed | undefined): boolean {
  return need === undefined || ownerHas(type, need);
}

export type OwnerChoice = OwnerType | 'any';

/** `path` is as `owner_changes` names it; the answer is as the editor names it. */
function describeOwnerChange(path: string): string {
  const draft = path.startsWith('drafts.');
  const target = draft ? path.slice('drafts.'.length) : path;
  const drafted = (name: string): string => (draft ? `${name} (draft)` : name);
  if (target.startsWith('rulesets/')) {
    return drafted(`Ruleset ${target.slice('rulesets/'.length)}`);
  }
  if (target.startsWith('environments/')) {
    return drafted(`Environment ${target.slice('environments/'.length)}`);
  }
  const field = allFields.find((item) => keyOf(item.path) === target || keyOf(item.path).startsWith(`${target}.`));
  if (field !== undefined) {
    return drafted(field.label);
  }
  return drafted(
    target.startsWith('custom_properties.') ? `Custom property ${target.slice('custom_properties.'.length)}` : target,
  );
}

/**
 * Every change is previewed through the engine as it is made, so the editor
 * shows what a save would give, base profiles included, and a change the
 * engine refuses says why before anything is written.
 */
export class ProfileEditor {
  readonly file: string;
  readonly loadError = signal<string | undefined>(undefined);
  readonly unsavedChangesProblem = signal<string | undefined>(undefined);
  readonly saveError = signal<string | undefined>(undefined);
  readonly saving = signal(false);

  readonly #saved = signal<ResolvedProfile | undefined>(undefined);
  /** Undefined unless there are unsaved changes the engine accepts. */
  readonly #profileAsSaveWouldLeaveIt = signal<ResolvedProfile | undefined>(undefined);
  readonly #edits = signal<ReadonlyMap<string, SettingEdit>>(new Map());
  readonly #typed = signal<ReadonlyMap<string, { readonly text: string; readonly problem: string | undefined }>>(
    new Map(),
  );
  readonly #entryEdits = new EntryEdits();
  #settingEditsSaveIsWriting: ReadonlyMap<string, SettingEdit> = new Map();
  #latestPreviewNumber = 0;
  /** Counts what a preview of a save can go out of date by, so one made before then is never shown. */
  #opens = 0;

  readonly patterns: ActionPatternChecks | undefined;
  readonly actionSearch: ActionSearch | undefined;

  readonly appLookup: GitHubAppLookup | undefined;

  readonly canHoldDrafts: boolean;
  readonly #store: EditorStore;

  constructor(
    file: string,
    github?: {
      readonly patterns: ActionPatternChecks;
      readonly search: ActionSearch;
      readonly appLookup: GitHubAppLookup;
    },
    store: EditorStore = profileStore,
  ) {
    this.file = file;
    this.#store = store;
    this.canHoldDrafts = store.canHoldDrafts;
    this.patterns = github?.patterns;
    this.actionSearch = github?.search;
    this.appLookup = github?.appLookup;
  }

  readonly loaded = computed(() => this.#saved.value !== undefined);

  /**
   * A profile that can't be read counts for nothing, since it offers no way
   * to save or reset; its changes come back if it reads again.
   */
  readonly dirty = computed(
    () =>
      this.loaded.value &&
      (this.#edits.value.size > 0 || this.#entryEdits.count.value > 0 || this.#someTypedTextCannotBeAValue.value),
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

  /** From the profile's own file or a base profile's; undefined for any owner. */
  readonly ownerType = computed(() => this.#saved.value?.profile.owner_type);

  /**
   * The base profile that gives the profile its owner type, when its own
   * file doesn't. A chain has one type, so only that profile can change it.
   */
  readonly ownerTypeFrom = computed(() => {
    const saved = this.#saved.value;
    // A base's type holds whether or not the open file repeats it, so the file's own line changes nothing.
    const source = this.#baseProfileSettingOwnerType.value ?? saved?.owner_source ?? undefined;
    return source === undefined || source === saved?.chain[0] ? undefined : basename(source);
  });

  readonly settingsHiddenForOwnerTypeCount = computed(() => {
    const type = this.ownerType.value;
    return allFields.filter((field) => !fits(type, needOf(field.path))).length;
  });

  /** The change writes at once, so it waits until nothing is unsaved. */
  readonly canChangeOwnerType = computed(() => this.loaded.value && !this.dirty.value && !this.saving.value);

  readonly preview = signal<SavePreview | undefined>(undefined);

  readonly savedDraftWarnings = computed(() => this.#saved.value?.warnings ?? []);

  /** Save applies the unsaved changes and the draft together, so it needs one of them. */
  readonly canSave = computed(
    () =>
      this.loaded.value &&
      (this.#changed.value || this.draftCount.value > 0) &&
      !this.#someTypedTextCannotBeAValue.value &&
      !this.#entryEdits.someEntryCannotBeSavedToApply.value &&
      this.unsavedChangesProblem.value === undefined &&
      !this.saving.value,
  );

  /**
   * Why the unsaved changes can't be kept as a draft, when nothing typed is
   * in the way: a draft may be unfinished, so only an entry's name and a
   * value a draft can't hold stop it.
   */
  readonly draftProblem = computed(() => {
    if (!this.canHoldDrafts) {
      return undefined;
    }
    if (this.#entryEdits.someChangedEntryCannotBeDraft.value) {
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

  readonly canSaveAsDraft = computed(
    () =>
      this.canHoldDrafts &&
      this.loaded.value &&
      this.#changed.value &&
      !this.#someTypedTextCannotBeAValue.value &&
      this.draftProblem.value === undefined &&
      !this.saving.value,
  );

  /** Discarding writes at once, so it waits until nothing unsaved would go with it. */
  readonly canDiscardDraft = computed(() => this.draftCount.value > 0 && !this.dirty.value && !this.saving.value);

  /**
   * Set for an apply's editor from the repository's installation, so what it
   * lacks is turned off. A profile's editor is for any repository, so it has none.
   */
  readonly #installation = signal<AppAccess | undefined>(undefined);

  readonly installationSettingsUrl = computed(() => {
    const installation = this.#installation.value;
    return installation?.status === 'installed' ? installation.settings_url : null;
  });

  readonly sections = computed((): SectionRows[] =>
    settingSections.map((section) => {
      const groups = section.groups.map((group) => ({ group, rows: this.#rows(group) }));
      const sectionLacks = permissionsEveryRowLacks(groups.flatMap(({ rows }) => rows));
      return {
        section,
        missingPermissionsEverySettingShares: sectionLacks,
        groups: groups.map(({ group, rows }): GroupRows => {
          const groupLacks = without(permissionsEveryRowLacks(rows), sectionLacks);
          return {
            group,
            missingPermissions: groupLacks,
            rows: rows.map((row) => ({
              ...row,
              missingPermissionsItsGroupAndSectionDoNotName: without(row.missingPermissions, [
                ...sectionLacks,
                ...groupLacks,
              ]),
            })),
          };
        }),
      };
    }),
  );

  /** What the installation lacks to change a list's entries, which turns the list off. */
  readonly entryListMissingPermissions = computed((): Readonly<Record<EntryList, readonly string[]>> => {
    const installation = this.#installation.value;
    const lacks = (list: EntryList): readonly string[] =>
      installation === undefined ? [] : permissionsMissingForProfilePart(installation, list);
    return { rulesets: lacks('rulesets'), environments: lacks('environments'), labels: lacks('labels') };
  });

  useInstallation(installation: AppAccess): void {
    this.#installation.value = installation;
  }

  readonly query = computed(() => this.#finding.value.query);

  readonly filters = computed(() => this.#finding.value.filters);

  readonly filtering = computed(
    () => searchWords(this.#finding.value.query).length > 0 || this.#finding.value.filters.size > 0,
  );

  /** A setting shown only for what sits under it is not counted. */
  readonly foundCount = computed(() => {
    const { fits } = this.#finding.value;
    return this.found.value.reduce(
      (count, group) => count + group.rows.filter((row) => fits.has(keyOf(row.field.path))).length,
      0,
    );
  });

  readonly foundSummary = computed(() => {
    const count = this.foundCount.value;
    const { query, filters } = this.#finding.value;
    if (count > 0) {
      return count === 1 ? '1 setting found.' : `${count} settings found.`;
    }
    if (searchWords(query).length > 0) {
      return `No settings match “${query.trim()}”.`;
    }
    const entries = Object.values(this.entries.value).flat();
    if (filters.has('unsaved') && entries.some((row) => row.unsaved)) {
      return 'No settings match these filters. Unsaved changes to rulesets, environments, and labels are on their own tabs.';
    }
    if (filters.has('drafts') && entries.some((row) => row.inDraft !== undefined)) {
      return 'No settings match these filters. Drafts of rulesets, environments, and labels are on their own tabs.';
    }
    return 'No settings match these filters.';
  });

  /**
   * What is found changes when the search or a filter does, or the profile
   * is read again, and not as a row is edited, so a row doesn't vanish under
   * the hand. A found setting that an edit hides, as GitHub does for the
   * value of the one above it, leaves that one in place to change back.
   */
  readonly found = computed((): FoundGroup[] => {
    const { shown } = this.#finding.value;
    // Found settings are shown without their section's heading, so a group says what the section lacks.
    return this.sections.value.flatMap(({ section, groups, missingPermissionsEverySettingShares }) =>
      groups
        .map(({ group, rows, missingPermissions: groupLacks }) => ({
          group,
          rows: rows.filter((row) => shown.has(keyOf(row.field.path))),
          missingPermissions: [...missingPermissionsEverySettingShares, ...groupLacks],
        }))
        .filter(({ rows }) => rows.length > 0)
        .map((found) => ({ tab: section.name, ...found })),
    );
  });

  readonly entries = this.#entryEdits.rows;

  readonly #changed = computed(() => this.#edits.value.size > 0 || this.#entryEdits.count.value > 0);

  readonly #ownUnsets = computed(() => (this.#saved.value === undefined ? [] : ownUnsets(this.#saved.value)));

  readonly #finding = signal<Finding>(nothingFound);

  readonly #baseProfileSettingOwnerType = signal<string | undefined>(undefined);

  readonly #someTypedTextCannotBeAValue = computed(() =>
    [...this.#typed.value.values()].some((typed) => typed.problem !== undefined),
  );

  /** Lays the unsaved changes over the profile as it is saved now. */
  async load(): Promise<void> {
    try {
      this.#saved.value = await this.#store.resolve(this.file);
      this.#entryEdits.setSaved(this.#saved.value);
      await this.#readBaseOwner();
      this.loadError.value = undefined;
    } catch (error) {
      this.#saved.value = undefined;
      this.#entryEdits.setSaved(undefined);
      this.#profileAsSaveWouldLeaveIt.value = undefined;
      this.closePreview();
      this.patterns?.follow(undefined);
      this.loadError.value = reasonOf(error, this.file);
      return;
    }
    await this.#previewEdits();
    this.#findAgain();
  }

  /** An undefined value stops setting it here, so a base profile's value applies. */
  async set(field: SettingField, value: unknown): Promise<void> {
    this.#forget(field);
    await this.#change(field, value);
  }

  /**
   * The box keeps the text as typed until `settle`. Text that can't be a
   * value says why and holds the save back.
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

  /** Undefined while the list doesn't show. */
  readonly #patternLines = computed(() => {
    const row = this.sections.value
      .flatMap((section) => section.groups.flatMap((group) => group.rows))
      .find((item) => keyOf(item.field.path) === patternsPath);
    return row === undefined
      ? undefined
      : (row.textBeingTyped?.split('\n') ?? (Array.isArray(row.value) ? row.value.map(String) : []));
  });

  /** As `owner/name@*` on a line, in any case. */
  allowsRepository(repository: string): boolean {
    const pattern = `${repository}@*`.toLowerCase();
    return (this.#patternLines.value ?? []).some((line) => line.trim().toLowerCase() === pattern);
  }

  async allowRepository(repository: string): Promise<void> {
    const field = allFields.find((item) => keyOf(item.path) === patternsPath);
    // A list that doesn't show, as with every action allowed, is not added to: its lines aren't the box's to read.
    if (field === undefined || this.#patternLines.value === undefined || this.allowsRepository(repository)) {
      return;
    }
    const lines = this.#patternLines.value.map((line) => line.trim()).filter((line) => line !== '');
    await this.set(field, [...lines, `${repository}@*`]);
  }

  /** The box was left: what was typed shows as its value from now on, unless it can't be one. */
  settle(field: SettingField): void {
    if (this.#typed.value.get(keyOf(field.path))?.problem === undefined) {
      this.#forget(field);
    }
  }

  /** Offered when Save is, since it shows what Save would do: the draft and the unsaved changes together. */
  async openPreview(): Promise<void> {
    if (!this.canSave.value) {
      return;
    }
    const unsaved = this.#edits.value.size + this.#entryEdits.count.value;
    const drafted = this.draftCount.value;
    const turn = (this.#opens += 1);
    try {
      const { before, after } = await this.#store.preview(this.file, [
        ...this.#settingWrites(this.#edits.value, 'applies', []),
        ...this.#entryEdits.writes(),
      ]);
      // A change, a save, or a fresh read since Preview was pressed leaves this one behind.
      if (turn !== this.#opens) {
        return;
      }
      const lines = diffLines(yamlLines(before), yamlLines(after));
      this.preview.value = {
        lines: foldUnchanged(lines),
        changedLineCount: lines.filter((line) => line.kind !== 'same').length,
        draftChangeCount: drafted,
        unsavedChangeCount: unsaved,
      };
    } catch (error) {
      if (turn === this.#opens) {
        this.saveError.value = reasonOf(error, this.file);
      }
    }
  }

  /** Leaves behind a preview that is still being made. */
  closePreview(): void {
    this.#opens += 1;
    this.preview.value = undefined;
  }

  search(query: string): void {
    this.#find(query, this.#finding.value.filters);
  }

  filter(filter: SettingFilter, on: boolean): void {
    const filters = new Set(this.#finding.value.filters);
    if (on) {
      filters.add(filter);
    } else {
      filters.delete(filter);
    }
    this.#find(this.#finding.value.query, filters);
  }

  clearFilters(): void {
    this.#finding.value = nothingFound;
  }

  /** Finds again over the profile as it was just read or written, so what a save or a discard settled leaves the filters. */
  #findAgain(): void {
    if (!this.filtering.value) {
      return;
    }
    // A setting with a change that isn't saved stays where it shows, whatever the fresh read finds.
    const kept = [...this.#finding.value.shown].filter((key) => this.#edits.value.has(key));
    this.#find(this.#finding.value.query, this.#finding.value.filters);
    this.#finding.value = { ...this.#finding.value, shown: new Set([...this.#finding.value.shown, ...kept]) };
  }

  #find(query: string, filters: ReadonlySet<SettingFilter>): void {
    const words = searchWords(query);
    const rows = this.sections.value.flatMap((section) => section.groups.flatMap((group) => group.rows));
    const fits = rows.filter(
      (row) =>
        matchesSearch(row.field, words) &&
        (!filters.has('managed') || row.value !== undefined) &&
        (!filters.has('unsaved') || row.unsaved || row.typedTextProblem !== undefined) &&
        (!filters.has('drafts') || row.savedDraftHasSetting),
    );
    // A setting shows under the one it belongs to, and the one whose value decides whether it shows.
    const above = fits.flatMap(({ field }) => [
      parentOf(field),
      fieldsOf(field.section).find((other) => other.key === field.dependsOn?.otherSettingKeyInSameSection),
    ]);
    const paths = (fields: readonly (SettingField | undefined)[]): Set<string> =>
      new Set(fields.flatMap((field) => (field === undefined ? [] : [keyOf(field.path)])));
    const found = paths(fits.map((row) => row.field));
    this.#finding.value = { query, filters, fits: found, shown: new Set([...found, ...paths(above)]) };
  }

  async addEntry(list: EntryList, entry: Entry): Promise<string> {
    const key = this.#entryEdits.add(list, entry);
    await this.#entriesChanged();
    return key;
  }

  async changeEntry(row: EntryRow, entry: Entry): Promise<void> {
    this.#entryEdits.change(row, entry);
    await this.#entriesChanged();
  }

  async setAbsent(row: EntryRow, absent: boolean): Promise<void> {
    this.#entryEdits.setAbsent(row, absent);
    await this.#entriesChanged();
  }

  async takeOut(row: EntryRow): Promise<void> {
    this.#entryEdits.takeOut(row);
    await this.#entriesChanged();
  }

  async putBack(row: EntryRow): Promise<void> {
    this.#entryEdits.putBack(row);
    await this.#entriesChanged();
  }

  async resetEntry(row: EntryRow): Promise<void> {
    this.#entryEdits.reset(row);
    await this.#entriesChanged();
  }

  async keepEntry(row: EntryRow): Promise<void> {
    this.#entryEdits.keepMine(row);
    await this.#entriesChanged();
  }

  async reset(field: SettingField): Promise<void> {
    const edits = new Map(this.#edits.value);
    edits.delete(keyOf(field.path));
    this.#forget(field);
    this.#edits.value = edits;
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

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
    await this.#write(write, this.#edits.value, async (writing) => {
      if (this.#entryEdits.writesOverChange()) {
        throw new Error(
          'A ruleset, environment, or label changed elsewhere since you changed it. Open it to keep yours or reset it.',
        );
      }
      if (
        mode === 'applies'
          ? this.#entryEdits.someEntryCannotBeSavedToApply.value
          : this.#entryEdits.someChangedEntryCannotBeDraft.value
      ) {
        throw new Error("A ruleset, environment, or label can't be saved as it stands. Open it to see why.");
      }
      const entries = this.#entryEdits.saving(mode);
      return this.#store.edit(this.file, [...this.#settingWrites(writing, mode, entries.unsets), ...entries.writes]);
    });
  }

  /** What the profile's file would stop managing as a profile for `type`, as the editor names each. */
  ownerLeaving(type: OwnerChoice): string[] {
    return type === 'any' ? [] : (this.#saved.value?.owner_changes?.[type] ?? []).map(describeOwnerChange);
  }

  /**
   * What the new type doesn't have is left not managed, as `ownerLeaving`
   * lists, so the change stops when the file would now leave something else.
   */
  async changeOwnerType(write: (work: () => Promise<void>) => Promise<void>, type: OwnerChoice): Promise<void> {
    if (
      !this.canChangeOwnerType.value ||
      this.ownerTypeFrom.value !== undefined ||
      type === (this.ownerType.value ?? 'any')
    ) {
      return;
    }
    const shown = this.ownerLeaving(type);
    await this.#write(write, new Map(), async () => {
      if (!sameValue(shown, this.ownerLeaving(type))) {
        throw new Error(
          `${basename(this.file)} changed since it was shown. Check what the change leaves not managed, then change the type.`,
        );
      }
      return changeOwnerType(this.file, type === 'any' ? undefined : type);
    });
    // A change made while this one waited, to a setting the new type doesn't have, has no row to show or reset it.
    const owner = this.ownerType.value;
    const kept = new Map([...this.#edits.value].filter(([, edit]) => fits(owner, needOf(edit.path))));
    if (kept.size !== this.#edits.value.size) {
      this.#edits.value = kept;
      await this.#previewEdits();
    }
  }

  async #readBaseOwner(): Promise<void> {
    const base = this.#saved.value?.chain[1];
    // A base that can't be read fails the open profile's own read, so this one only ever follows a read that worked.
    this.#baseProfileSettingOwnerType.value =
      base === undefined ? undefined : ((await resolveProfile(base).catch(() => undefined))?.owner_source ?? undefined);
  }

  /** Keeps what the editor doesn't show, such as a draft autolink. */
  async discardDraft(write: (work: () => Promise<void>) => Promise<void>): Promise<void> {
    if (!this.canDiscardDraft.value) {
      return;
    }
    await this.#write(write, new Map(), async () => {
      const edits: ProfileEdit[] = [
        ...allFields.flatMap((field) => {
          const draft = this.#draft(field);
          return draft === undefined || draft === 'unset'
            ? []
            : [{ path: ['drafts', ...field.path], value: undefined }];
        }),
        ...this.#otherDrafts().map(({ path }) => ({ path: ['drafts', ...path], value: undefined })),
        ...this.#unsetWrite(this.#ownUnsets.value.filter((key) => key.startsWith('autolinks/'))),
        ...this.#entryEdits.discards(),
      ];
      return this.#store.edit(this.file, edits);
    });
  }

  /** Writes with `act`, once the file is read again in the write's turn, and settles the changes it wrote. */
  async #write(
    write: (work: () => Promise<void>) => Promise<void>,
    writing: ReadonlyMap<string, SettingEdit>,
    act: (writing: ReadonlyMap<string, SettingEdit>) => Promise<ResolvedProfile>,
  ): Promise<void> {
    this.saving.value = true;
    this.saveError.value = undefined;
    this.closePreview();
    this.#settingEditsSaveIsWriting = writing;
    this.#entryEdits.begin();
    let wrote = false;
    const shown = this.#saved.value === undefined ? undefined : comparableOwnDraft(this.#saved.value);
    try {
      await write(async () => {
        // The file may have changed since it was read, as by the sync before this turn. An entry is
        // written whole, so one that changed under its change is not written over.
        const current = await this.#store.resolve(this.file);
        this.#saved.value = current;
        this.#entryEdits.setSaved(current);
        // Every save finishes, adds to, or discards the whole draft, so it acts only on the draft that was shown.
        if (!sameValue(shown, comparableOwnDraft(current))) {
          throw new Error("The profile's draft changed elsewhere. Look at it as it is now, then try again.");
        }
        this.#saved.value = await act(writing);
        this.#entryEdits.setSaved(this.#saved.value);
        await this.#readBaseOwner();
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
      this.#settingEditsSaveIsWriting = new Map();
      this.saving.value = false;
    }
    await this.#previewEdits();
    this.#findAgain();
  }

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

  #valueRowStartsFrom(field: SettingField): unknown {
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
      const final = edit === undefined ? this.#valueRowStartsFrom(field) : edit.value;
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
      const writing = this.#settingEditsSaveIsWriting.get(key);
      if (sameValue(next, writing === undefined ? this.#valueRowStartsFrom(target) : writing.value)) {
        edits.delete(key);
      } else {
        edits.set(key, { path: target.path, value: next });
      }
    };
    change(field, value);
    if (value !== undefined) {
      // A setting that stands alone and the rest of its section take each other out.
      for (const other of fieldsOf(field.section)) {
        if (
          other !== field &&
          (field.excludesOtherSettingsInSection || other.excludesOtherSettingsInSection) &&
          this.#valueOf(other, edits) !== undefined
        ) {
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
    const final = edit === undefined ? this.#valueRowStartsFrom(field) : edit.value;
    // A null is a value, which clears the setting on GitHub; only no value here falls through.
    return final === undefined
      ? getIn((this.#profileAsSaveWouldLeaveIt.value ?? this.#saved.value)?.profile, field.path)
      : final;
  }

  async #entriesChanged(): Promise<void> {
    this.saveError.value = undefined;
    await this.#previewEdits();
  }

  /** Every change, save, and fresh read comes through here: each previews what a save would give, and what follows from it. */
  async #previewEdits(): Promise<void> {
    await this.#previewSave();
    // The list is followed as it is typed, and only while GitHub would show it.
    const row = this.sections.value
      .flatMap((section) => section.groups.flatMap((group) => group.rows))
      .find((item) => keyOf(item.field.path) === patternsPath);
    this.patterns?.follow(
      row === undefined || !Array.isArray(row.value)
        ? undefined
        : (row.textBeingTyped?.split('\n') ?? row.value.map(String)),
    );
  }

  async #previewSave(): Promise<void> {
    // Each leaves an open preview of a save out of date.
    this.closePreview();
    const turn = (this.#latestPreviewNumber += 1);
    // An entry that can't be saved as it stands, such as one with no name, is held back before the engine sees it.
    const edits =
      this.#saved.value === undefined
        ? []
        : [...this.#settingWrites(this.#edits.value, 'applies', []), ...this.#entryEdits.writes()];
    if (edits.length === 0) {
      this.#profileAsSaveWouldLeaveIt.value = undefined;
      this.unsavedChangesProblem.value = undefined;
      return;
    }
    try {
      const { after } = await this.#store.preview(this.file, edits);
      if (turn === this.#latestPreviewNumber) {
        this.#profileAsSaveWouldLeaveIt.value = after;
        this.unsavedChangesProblem.value = undefined;
      }
    } catch (error) {
      if (turn === this.#latestPreviewNumber) {
        // No profile to show but the saved one, with each edit laid over its own setting.
        this.#profileAsSaveWouldLeaveIt.value = undefined;
        this.unsavedChangesProblem.value = reasonOf(error, this.file);
      }
    }
  }

  #rows(group: SettingGroup): SettingRow[] {
    const shown = this.#profileAsSaveWouldLeaveIt.value ?? this.#saved.value;
    if (shown === undefined) {
      return [];
    }
    const edits = this.#edits.value;
    const section = fieldsOf(group.fields[0]?.section ?? '');
    const turnedOffOnGitHub = (field: SettingField): TurnedOffOnGitHub | undefined => {
      const condition = field.dependsOn;
      const above = section.find((item) => item.key === condition?.otherSettingKeyInSameSection);
      if (condition === undefined || above === undefined) {
        return undefined;
      }
      const aboveTurnedOff = turnedOffOnGitHub(above);
      if (aboveTurnedOff?.hidden === true) {
        return aboveTurnedOff;
      }
      const aboveValue = this.#valueOf(above, edits);
      const own =
        aboveValue !== undefined && condition.values.some((item) => sameValue(item, aboveValue))
          ? { field: above, value: aboveValue, hidden: condition.hiddenRatherThanGreyedOut }
          : undefined;
      return own?.hidden === true ? own : (aboveTurnedOff ?? own);
    };
    const owner = this.ownerType.value;
    const installation = this.#installation.value;
    return (
      group.fields
        // What owners of the profile's type don't have is left out, settings and choices, so it is never part of a save.
        .filter((field) => fits(owner, needOf(field.path)) && turnedOffOnGitHub(field)?.hidden !== true)
        .map((field) => {
          const turnedOff = turnedOffOnGitHub(field);
          const key = keyOf(field.path);
          const source = shown.sources[sectionOf(field)][field.key];
          const typed = this.#typed.value.get(key);
          const need = needOf(field.path);
          return {
            field,
            optionsForProfileOwnerType: field.options.filter((option) => fits(owner, needOf(field.path, option.value))),
            ownerTag:
              need === 'enterprise'
                ? ('Enterprise Cloud' as const)
                : need === 'organization' && owner === undefined
                  ? ('Organizations' as const)
                  : undefined,
            value: this.#valueOf(field, edits),
            source: source === undefined ? undefined : source === shown.chain[0] ? 'here' : basename(source),
            unsaved: edits.has(key),
            savedDraftHasSetting: this.#draft(field) !== undefined,
            valueShownIsFromDraft: !edits.has(key) && this.#draft(field) !== undefined,
            applied: getIn(this.#saved.value?.profile, field.path),
            greyedOutOnGitHubWhile:
              turnedOff === undefined ? undefined : { field: turnedOff.field, value: turnedOff.value },
            textBeingTyped: typed?.text,
            typedTextProblem: typed?.problem,
            hiddenNamed: section.filter((other) => {
              const otherTurnedOff = turnedOffOnGitHub(other);
              return (
                otherTurnedOff?.hidden === true &&
                otherTurnedOff.field === field &&
                this.#valueOf(other, edits) !== undefined
              );
            }).length,
            missingPermissions:
              installation === undefined
                ? []
                : permissionsMissingForProfilePart(installation, field.section, field.key.split('.')[0]),
            missingPermissionsItsGroupAndSectionDoNotName: [],
          };
        })
    );
  }
}
