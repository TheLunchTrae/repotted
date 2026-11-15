import { computed, signal } from '@preact/signals';

import { basename } from '../../engine/path.js';
import { type Entry, isEntry, labelProblem, rulesetProblem } from './entry-forms.js';
import { ownUnsets, type ResolvedProfile } from './own-drafts.js';
import { sameValue } from './same-value.js';

export const entryLists = ['rulesets', 'environments', 'labels'] as const;
export type EntryList = (typeof entryLists)[number];

export type SaveMode = 'applies' | 'draft';

export interface EntryRow {
  readonly list: EntryList;
  /** Stable while the editor is open, whatever the entry's name becomes. */
  readonly key: string;
  /** With the unsaved changes, or undefined when this profile stops naming it. */
  readonly entry: Entry | undefined;
  /**
   * What the row starts from: this profile's draft of the entry when it has
   * one, and what applies otherwise. Undefined for one that is new, and for
   * one the draft takes out of the profile.
   */
  readonly saved: Entry | undefined;
  /** As it applies now, here or from a base profile. */
  readonly applied: Entry | undefined;
  /** Undefined for one that is new. */
  readonly savedName: string | undefined;
  /** 'here', a base profile's file name, or undefined for one that is new. */
  readonly source: string | undefined;
  readonly unsaved: boolean;
  /**
   * What this profile's draft does with the entry, while no unsaved change
   * is over it: adds it, changes it, or takes it out of the profile.
   */
  readonly inDraft: 'new' | 'changed' | 'taken-out' | undefined;
  /**
   * Whether the saved entry changed, or went, since this change was made on
   * it, as a sync can do. The change would write the whole entry over that,
   * so it waits until the user keeps theirs or resets it.
   */
  readonly outOfDate: boolean;
  readonly applyProblem: string | undefined;
  /** A draft may be unfinished, so this is only what is wrong with its name. */
  readonly draftProblem: string | undefined;
}

type Row = Omit<EntryRow, 'applyProblem' | 'draftProblem'>;

/** A base profile's entry can only be overridden here, so taking it out is for one this profile names, or a new one. */
export function canBeTakenOut(row: EntryRow): boolean {
  return row.entry !== undefined && (row.source === 'here' || row.source === undefined);
}

export interface EntryChangesSnapshot {
  readonly changes: ReadonlyMap<string, EntryChange>;
}

export interface EntryWrite {
  readonly list: EntryList;
  readonly name: string;
  /** Whether the file's draft of that name is meant, and not its entry that applies. */
  readonly draft?: true;
  readonly entry: Entry | undefined;
}

interface EntryChange {
  readonly list: EntryList;
  /** Undefined for one that is new. */
  readonly name: string | undefined;
  readonly entry: Entry | undefined;
  readonly savedEntryChangeWasMadeOn: Entry | undefined;
  /** The entry as it was managed, while the change removes it from repositories, so managing it again brings it back. */
  readonly kept?: Entry;
}

interface Slot {
  readonly key: string;
  readonly applied: Entry | undefined;
  readonly openFileNamesAppliedEntry: boolean;
  readonly baseProfileNamingAppliedEntry: string | undefined;
  /** Without its `draft` key. */
  readonly openFileDraft: Entry | undefined;
  readonly openFileDraftTakesOut: boolean;
}

const nouns: Readonly<Record<EntryList, string>> = {
  rulesets: 'a ruleset',
  environments: 'an environment',
  labels: 'a label',
};

function nameOf(entry: Entry | undefined): string {
  return typeof entry?.['name'] === 'string' ? entry['name'].trim() : '';
}

function withTrimmedNameFirst(entry: Entry): Entry {
  const { name: _name, ...rest } = entry;
  return { name: nameOf(entry), ...rest };
}

/** What GitHub knows an entry by: a ruleset by its name as written, an environment or a label by its name in any case. */
function identity(list: EntryList, name: string): string {
  return list === 'rulesets' ? name : name.toLowerCase();
}

function entryRowStartsFrom(slot: Slot): Entry | undefined {
  return slot.openFileDraftTakesOut ? undefined : (slot.openFileDraft ?? slot.applied);
}

function same(left: Entry | undefined, right: Entry | undefined): boolean {
  return sameValue(
    left === undefined ? undefined : withTrimmedNameFirst(left),
    right === undefined ? undefined : withTrimmedNameFirst(right),
  );
}

/**
 * What a save writes for one entry that ends as `final`, and the key of
 * `drafts.unset` a draft lists for it. Saving so it applies takes the draft
 * out, since what it held applies or is reset. Saving as a draft leaves what
 * applies as it is.
 */
function writesFor(
  list: EntryList,
  slot: Slot | undefined,
  final: Entry | undefined,
  mode: SaveMode,
): { readonly writes: readonly EntryWrite[]; readonly unset: string | undefined } {
  const applied = slot?.applied;
  const own = slot?.openFileNamesAppliedEntry === true ? nameOf(applied) : undefined;
  const draft = slot?.openFileDraft === undefined ? undefined : nameOf(slot.openFileDraft);
  const dropDraft: EntryWrite[] = draft === undefined ? [] : [{ list, name: draft, draft: true, entry: undefined }];
  const applies = final !== undefined && applied !== undefined && same(final, applied);
  if (mode === 'applies') {
    if (final === undefined) {
      return {
        writes: [...(own === undefined ? [] : [{ list, name: own, entry: undefined }]), ...dropDraft],
        unset: undefined,
      };
    }
    const entry = withTrimmedNameFirst(final);
    if (applies) {
      return { writes: dropDraft, unset: undefined };
    }
    if (own !== undefined) {
      return { writes: [{ list, name: own, entry }, ...dropDraft], unset: undefined };
    }
    // A draft with no entry of this file under it is finished where it is.
    return {
      writes: [draft === undefined ? { list, name: nameOf(final), entry } : { list, name: draft, draft: true, entry }],
      unset: undefined,
    };
  }
  if (final === undefined || applies) {
    return { writes: dropDraft, unset: final === undefined && own !== undefined ? `${list}/${own}` : undefined };
  }
  const entry = { ...withTrimmedNameFirst(final), draft: true };
  const name = nameOf(final);
  return {
    writes: same(final, slot?.openFileDraft) ? [] : [{ list, name: draft ?? name, draft: true, entry }],
    // A draft under another name leaves the entry that applies behind, so finishing it takes that one out.
    unset: own !== undefined && identity(list, own) !== identity(list, name) ? `${list}/${own}` : undefined,
  };
}

/**
 * The changes to a profile's rulesets, environments, and labels that aren't
 * saved, over the profile as saved: what applies and this profile's own
 * draft, which each row starts from. A change holds its entry whole, since
 * the engine writes an entry whole, with the saved entry it was made on, so
 * a change is never written over an entry that has since changed elsewhere.
 */
export class EntryEdits {
  readonly #saved = signal<ResolvedProfile | undefined>(undefined);
  readonly #changes = signal<ReadonlyMap<string, EntryChange>>(new Map());
  #changesSaveIsWriting: ReadonlyMap<string, EntryChange> = new Map();
  #lastNewEntryNumber = 0;

  readonly #slots = computed<Readonly<Record<EntryList, readonly Slot[]>>>(() => ({
    rulesets: this.#slotsOf('rulesets'),
    environments: this.#slotsOf('environments'),
    labels: this.#slotsOf('labels'),
  }));

  readonly rows = computed<Readonly<Record<EntryList, readonly EntryRow[]>>>(() => ({
    rulesets: this.#rows('rulesets'),
    environments: this.#rows('environments'),
    labels: this.#rows('labels'),
  }));

  readonly count = computed(() => this.#changes.value.size);

  readonly draftCount = computed(() =>
    entryLists.reduce(
      (count, list) =>
        count +
        this.#slots.value[list].filter((slot) => slot.openFileDraft !== undefined || slot.openFileDraftTakesOut).length,
      0,
    ),
  );

  readonly someEntryCannotBeSavedToApply = computed(() => this.#some((row) => row.applyProblem !== undefined));

  readonly someChangedEntryCannotBeDraft = computed(() => this.#some((row) => row.draftProblem !== undefined));

  setSaved(saved: ResolvedProfile | undefined): void {
    this.#saved.value = saved;
    // A change that takes out an entry that is already gone has nothing left to do.
    const changes = new Map(this.#changes.value);
    for (const [key, change] of changes) {
      if (change.entry === undefined && change.name !== undefined && this.#slot(change.list, key) === undefined) {
        changes.delete(key);
      }
    }
    if (changes.size !== this.#changes.value.size) {
      this.#changes.value = changes;
    }
  }

  /** For a preview: only the entries with no problem, each one's draft finished with it. */
  writes(): EntryWrite[] {
    const fine = new Set(
      entryLists.flatMap((list) =>
        this.rows.value[list].filter((row) => row.applyProblem === undefined).map((row) => row.key),
      ),
    );
    return this.#plan(this.#changes.value, 'applies', (key) => fine.has(key)).writes;
  }

  add(list: EntryList, entry: Entry): string {
    this.#lastNewEntryNumber += 1;
    const key = `${list}:new:${this.#lastNewEntryNumber}`;
    this.#set(key, { list, name: undefined, entry, savedEntryChangeWasMadeOn: undefined });
    return key;
  }

  /** An entry changed back to what is saved is no change. */
  change(row: EntryRow, entry: Entry): void {
    this.#put(row, { entry });
  }

  /** Removing keeps only the entry's name, and managing it again brings back what it had. */
  setAbsent(row: EntryRow, absent: boolean): void {
    const entry = row.entry;
    if (entry === undefined || (entry['absent'] === true) === absent) {
      return;
    }
    const name = entry['name'];
    if (absent) {
      this.#put(row, { entry: { name, absent: true }, kept: entry });
      return;
    }
    // An entry saved as removing has nothing to bring back but what applies, when its draft is what removes it.
    const managed = [row.saved, row.applied].find((found) => found !== undefined && found['absent'] !== true);
    const kept = this.#changes.value.get(row.key)?.kept ?? managed;
    this.#put(row, { entry: kept === undefined ? { name } : { ...kept, name } });
  }

  takeOut(row: EntryRow): void {
    if (row.savedName === undefined && !this.#changesSaveIsWriting.has(row.key)) {
      this.#set(row.key, undefined);
    } else {
      this.#put(row, { entry: undefined });
    }
  }

  /**
   * Puts back an entry that is out of the profile: one an unsaved change
   * took out goes back as it is saved, and one the draft takes out goes back
   * as it applies, which is a change to the draft.
   */
  putBack(row: EntryRow): void {
    if (row.unsaved) {
      this.reset(row);
    } else if (row.applied !== undefined) {
      this.#put(row, { entry: row.applied });
    }
  }

  /**
   * While a save is writing a change to the entry, putting it back is itself
   * a change, to what it was: the entry as it was saved, or for one that was
   * new, none.
   */
  reset(row: EntryRow): void {
    if (this.#changesSaveIsWriting.has(row.key)) {
      this.#set(row.key, {
        list: row.list,
        name: row.savedName,
        entry: row.saved,
        savedEntryChangeWasMadeOn: row.saved,
      });
    } else {
      this.#set(row.key, undefined);
    }
  }

  /**
   * Keeps a change whose entry changed elsewhere: it is written over what
   * the entry is now, or for an entry that is gone, written as a new one.
   */
  keepMine(row: EntryRow): void {
    const change = this.#changes.value.get(row.key);
    if (change === undefined) {
      return;
    }
    if (this.#slot(row.list, row.key) === undefined) {
      this.#set(row.key, undefined);
      this.#lastNewEntryNumber += 1;
      this.#set(`${row.list}:new:${this.#lastNewEntryNumber}`, {
        ...change,
        name: undefined,
        savedEntryChangeWasMadeOn: undefined,
      });
    } else {
      this.#set(row.key, { ...change, savedEntryChangeWasMadeOn: row.saved });
    }
  }

  resetAll(): void {
    this.#changes.value = new Map();
  }

  /** Every change to the list's entries goes, as Reset does on each; not while a save is writing, which the editor waits for. */
  resetAllIn(list: EntryList): void {
    this.#changes.value = new Map([...this.#changes.value].filter(([, change]) => change.list !== list));
  }

  /** Each entry the list can take out of the profile, as Take out of profile does: one this profile names, or one that is new. */
  takeOutAllIn(list: EntryList): void {
    for (const row of this.rows.value[list].filter(canBeTakenOut)) {
      this.takeOut(row);
    }
  }

  /** What `restore` puts back exactly, for an undo of a change to many entries at once. */
  snapshot(): EntryChangesSnapshot {
    return { changes: this.#changes.value };
  }

  restore(snapshot: EntryChangesSnapshot): void {
    this.#changes.value = snapshot.changes;
  }

  /** Marks the changes a save writes, which stay as they are until `saved` says how it went. */
  begin(): void {
    this.#changesSaveIsWriting = this.#changes.value;
  }

  saving(mode: SaveMode): { readonly writes: EntryWrite[]; readonly unsets: string[] } {
    return this.#plan(this.#changesSaveIsWriting, mode, () => true);
  }

  discards(): EntryWrite[] {
    return entryLists.flatMap((list) =>
      this.#slots.value[list].flatMap((slot): EntryWrite[] =>
        slot.openFileDraft === undefined
          ? []
          : [{ list, name: nameOf(slot.openFileDraft), draft: true, entry: undefined }],
      ),
    );
  }

  /**
   * Whether a change the save is about to write was made on an entry that
   * has since changed or gone. The save checks this once it has read the
   * file in its turn, whatever became of the change while it waited.
   */
  writesOverChange(): boolean {
    return [...this.#changesSaveIsWriting].some(([key, change]) => {
      if (change.name === undefined) {
        // A new entry whose name the file has by now would be written over that entry.
        return this.#slotNamed(change.list, nameOf(change.entry)) !== undefined;
      }
      const slot = this.#slot(change.list, key);
      return slot === undefined || !sameValue(change.savedEntryChangeWasMadeOn, entryRowStartsFrom(slot));
    });
  }

  /**
   * Ends a save. One that wrote leaves only what changed again while it ran,
   * based on what it wrote and under the name it gave. One that failed
   * leaves every change as it is.
   */
  saved(wrote: boolean): void {
    const writing = this.#changesSaveIsWriting;
    this.#changesSaveIsWriting = new Map();
    if (!wrote) {
      return;
    }
    const left = new Map<string, EntryChange>();
    for (const [key, change] of this.#changes.value) {
      const was = writing.get(key);
      if (was === undefined) {
        left.set(key, change);
      } else if (change !== was && !sameValue(change.entry, was.entry)) {
        // The row the save left the entry in, which the change is now made on.
        const slot =
          was.entry === undefined ? this.#slot(change.list, key) : this.#slotNamed(change.list, nameOf(was.entry));
        if (slot !== undefined) {
          left.set(slot.key, {
            ...change,
            name: nameOf(entryRowStartsFrom(slot) ?? slot.applied),
            savedEntryChangeWasMadeOn: entryRowStartsFrom(slot),
          });
        } else if (change.entry !== undefined) {
          // An entry the save took out and that has one again is a new one.
          this.#lastNewEntryNumber += 1;
          left.set(`${change.list}:new:${this.#lastNewEntryNumber}`, {
            ...change,
            name: undefined,
            savedEntryChangeWasMadeOn: undefined,
          });
        }
      }
    }
    this.#changes.value = left;
  }

  #some(test: (row: EntryRow) => boolean): boolean {
    return entryLists.some((list) => this.rows.value[list].some(test));
  }

  #put(row: EntryRow, next: { readonly entry: Entry | undefined; readonly kept?: Entry }): void {
    const current = this.#changes.value.get(row.key);
    const saved = row.saved;
    // While a save writes this entry, every change to it is kept, since what is saved is about to be what the save wrote.
    // An entry the draft takes out is saved as out, so taking it out is no change either.
    const unchanged =
      !this.#changesSaveIsWriting.has(row.key) &&
      row.savedName !== undefined &&
      (next.entry === undefined
        ? saved === undefined && !row.outOfDate
        : saved !== undefined && same(next.entry, saved));
    this.#set(
      row.key,
      unchanged
        ? undefined
        : {
            list: row.list,
            name: row.savedName,
            entry: next.entry,
            savedEntryChangeWasMadeOn: current === undefined ? saved : current.savedEntryChangeWasMadeOn,
            ...(next.kept === undefined
              ? current?.kept === undefined
                ? {}
                : { kept: current.kept }
              : { kept: next.kept }),
          },
    );
  }

  #set(key: string, change: EntryChange | undefined): void {
    const changes = new Map(this.#changes.value);
    if (change === undefined) {
      changes.delete(key);
    } else {
      changes.set(key, change);
    }
    this.#changes.value = changes;
  }

  #slot(list: EntryList, key: string): Slot | undefined {
    return this.#slots.value[list].find((slot) => slot.key === key);
  }

  #slotNamed(list: EntryList, name: string): Slot | undefined {
    const id = identity(list, name);
    return this.#slots.value[list].find((slot) =>
      [slot.applied, slot.openFileDraft].some((entry) => entry !== undefined && identity(list, nameOf(entry)) === id),
    );
  }

  #slotsOf(list: EntryList): Slot[] {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return [];
    }
    const own = saved.chain[0];
    const fileOf = (sources: Readonly<Record<string, string>>, name: string): string | undefined =>
      Object.entries(sources).find(([known]) => identity(list, known) === identity(list, name))?.[1];
    const entries = (found: unknown): Entry[] => (Array.isArray(found) ? found.filter(isEntry) : []);
    // Only this profile's own draft shows: a base profile's draft is that profile's to finish.
    const drafts = entries(saved.drafts[list])
      .filter((entry) => fileOf(saved.sources.drafts[list], nameOf(entry)) === own)
      .map(({ draft: _draft, ...entry }): Entry => entry);
    const unsets = new Set(
      ownUnsets(saved)
        .filter((key) => key.startsWith(`${list}/`))
        .map((key) => identity(list, key.slice(list.length + 1))),
    );
    const paired = new Set<Entry>();
    const applying = entries(saved.profile[list]).map((applied): Slot => {
      const name = nameOf(applied);
      const file = fileOf(saved.sources[list], name);
      const draft = drafts.find((entry) => identity(list, nameOf(entry)) === identity(list, name));
      if (draft !== undefined) {
        paired.add(draft);
      }
      const here = file === undefined || file === own;
      return {
        key: `${list}/${name}`,
        applied,
        openFileNamesAppliedEntry: here,
        baseProfileNamingAppliedEntry: here ? undefined : basename(file),
        openFileDraft: draft,
        // Only an entry this file names can be taken out of it.
        openFileDraftTakesOut: here && draft === undefined && unsets.has(identity(list, name)),
      };
    });
    // A draft of an entry that doesn't apply yet follows what applies.
    const alone = drafts
      .filter((draft) => !paired.has(draft))
      .map((draft): Slot => ({
        key: `${list}/${nameOf(draft)}`,
        applied: undefined,
        openFileNamesAppliedEntry: false,
        baseProfileNamingAppliedEntry: undefined,
        openFileDraft: draft,
        openFileDraftTakesOut: false,
      }));
    return [...applying, ...alone];
  }

  /** What a save writes for `changes` over the saved profile, leaving out the rows `takes` refuses. */
  #plan(
    changes: ReadonlyMap<string, EntryChange>,
    mode: SaveMode,
    takes: (key: string) => boolean,
  ): { writes: EntryWrite[]; unsets: string[] } {
    const writes: EntryWrite[] = [];
    const unsets: string[] = [];
    const add = (list: EntryList, slot: Slot | undefined, final: Entry | undefined): void => {
      const planned = writesFor(list, slot, final, mode);
      writes.push(...planned.writes);
      if (planned.unset !== undefined) {
        unsets.push(planned.unset);
      }
    };
    for (const list of entryLists) {
      for (const slot of this.#slots.value[list]) {
        if (takes(slot.key)) {
          const change = changes.get(slot.key);
          add(list, slot, change === undefined ? entryRowStartsFrom(slot) : change.entry);
        }
      }
      for (const [key, change] of changes) {
        // A change to an entry that is gone waits for its row's choice, and one that takes nothing out writes nothing.
        if (change.list === list && change.name === undefined && change.entry !== undefined && takes(key)) {
          add(list, undefined, change.entry);
        }
      }
    }
    return { writes, unsets };
  }

  #rows(list: EntryList): EntryRow[] {
    const changes = this.#changes.value;
    const slots = this.#slots.value[list];
    if (this.#saved.value === undefined) {
      return [];
    }
    const listed = slots.map((slot) => {
      const change = changes.get(slot.key);
      const start = entryRowStartsFrom(slot);
      return {
        list,
        key: slot.key,
        entry: change === undefined ? start : change.entry,
        saved: start,
        applied: slot.applied,
        savedName: nameOf(start ?? slot.applied),
        // A draft of a base profile's entry overrides it here once it is finished.
        source:
          slot.openFileNamesAppliedEntry || slot.openFileDraft !== undefined
            ? 'here'
            : slot.baseProfileNamingAppliedEntry,
        unsaved: change !== undefined,
        inDraft:
          change !== undefined
            ? undefined
            : slot.openFileDraftTakesOut
              ? ('taken-out' as const)
              : slot.openFileDraft === undefined
                ? undefined
                : slot.applied === undefined
                  ? ('new' as const)
                  : ('changed' as const),
        outOfDate: change !== undefined && !sameValue(change.savedEntryChangeWasMadeOn, start),
      };
    });
    const known = new Set(listed.map((row) => row.key));
    const others = [...changes]
      .filter(([key, change]) => change.list === list && !known.has(key))
      .map(([key, change]) => ({
        list,
        key,
        entry: change.entry,
        saved: undefined,
        applied: undefined,
        savedName: change.name,
        source: change.name === undefined ? undefined : 'here',
        unsaved: true,
        inDraft: undefined,
        // A change to an entry the file had, which is gone from it now.
        outOfDate: change.name !== undefined,
      }));
    const all = [...listed, ...others];
    return all.map((row) => ({
      ...row,
      // A draft is checked as its change is, since a save that applies finishes it.
      applyProblem: row.unsaved || row.inDraft !== undefined ? this.#problem(row, all, true) : undefined,
      draftProblem: row.unsaved ? this.#problem(row, all, false) : undefined,
    }));
  }

  /** Why a row can't be saved: for one that applies, anything; for a draft, which may be unfinished, only its name. */
  #problem(row: Row, all: readonly Row[], applies: boolean): string | undefined {
    const { list, entry } = row;
    const name = nameOf(entry);
    if (row.outOfDate) {
      const known = row.savedName ?? name;
      return row.saved === undefined && row.applied === undefined
        ? `${known} was removed elsewhere since you changed it. Keep yours to add it again, or reset it.`
        : `${known} changed elsewhere since you changed it. Keep yours over that change, or reset it to see it.`;
    }
    if (entry === undefined) {
      return undefined;
    }
    if (name === '') {
      return 'Give it a name.';
    }
    const id = identity(list, name);
    const others = all.filter((other) => other !== row);
    if (others.some((other) => other.entry !== undefined && identity(list, nameOf(other.entry)) === id)) {
      return `The profile already has ${nouns[list]} named ${name}.`;
    }
    // An entry the draft takes out keeps its name in the file, and the draft can't both take it out and change it.
    if (others.some((other) => other.inDraft === 'taken-out' && identity(list, other.savedName ?? '') === id)) {
      return `The draft takes ${name} out of the profile. Put that one back to change it, or choose another name.`;
    }
    // The file still has that name for an entry whose change renames it or takes it out, until a save.
    if (
      others.some((other) => other.unsaved && other.savedName !== undefined && identity(list, other.savedName) === id)
    ) {
      return `${name} is the saved name of one you renamed or took out. Save that first, or choose another name.`;
    }
    if (!applies) {
      return undefined;
    }
    if (list === 'rulesets') {
      return rulesetProblem(entry);
    }
    if (list === 'labels') {
      return labelProblem(
        entry,
        others.map((other) => identity(list, nameOf(other.entry))).filter((other) => other !== ''),
      );
    }
    return undefined;
  }
}
