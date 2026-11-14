import { computed, signal } from '@preact/signals';
import type { resolveProfile } from '@repotted/core';

import { basename } from '../engine/path.js';
import { type Entry, isEntry, labelProblem, rulesetProblem } from './entry-forms.js';
import { sameValue } from './same-value.js';

type ResolvedProfile = Awaited<ReturnType<typeof resolveProfile>>;

export const entryLists = ['rulesets', 'environments', 'labels'] as const;
export type EntryList = (typeof entryLists)[number];

/** One ruleset, environment, or label as the editor draws it. */
export interface EntryRow {
  readonly list: EntryList;
  /** What the editor knows the entry by while it is open, whatever its name becomes. */
  readonly key: string;
  /** The entry as it stands with the unsaved changes, or undefined when they take it out of this profile. */
  readonly entry: Entry | undefined;
  /** The entry as the profile has it saved, here or in a base profile, when it does. */
  readonly saved: Entry | undefined;
  /** Its name as saved, or undefined for one that is new. */
  readonly savedName: string | undefined;
  /** The profile that sets it: 'here', a base profile's file name, or undefined for one that is new. */
  readonly source: string | undefined;
  readonly unsaved: boolean;
  /**
   * Whether the saved entry changed, or went, since this change was made on
   * it, as a sync can do. The change would write the whole entry over that,
   * so it waits until the user keeps theirs or resets it.
   */
  readonly outOfDate: boolean;
  /** Why it can't be saved as it stands, such as a name another entry has. */
  readonly problem: string | undefined;
}

/** One entry to write under the name the file knows it by, or to stop naming, as the engine takes it. */
export interface EntryWrite {
  readonly list: EntryList;
  readonly name: string;
  readonly entry: Entry | undefined;
}

interface EntryChange {
  readonly list: EntryList;
  /** The name the file has for the entry, or undefined for one that is new. */
  readonly name: string | undefined;
  readonly entry: Entry | undefined;
  /** The saved entry the change was made on. */
  readonly base: Entry | undefined;
  /** The entry as it was managed, while the change removes it from repositories, so managing it again brings it back. */
  readonly kept?: Entry;
}

const nouns: Readonly<Record<EntryList, string>> = {
  rulesets: 'a ruleset',
  environments: 'an environment',
  labels: 'a label',
};

function nameOf(entry: Entry | undefined): string {
  return typeof entry?.['name'] === 'string' ? entry['name'].trim() : '';
}

/** An entry as it is written: its name trimmed, and first. */
function written(entry: Entry): Entry {
  const { name: _name, ...rest } = entry;
  return { name: nameOf(entry), ...rest };
}

/** What GitHub knows an entry by: a ruleset by its name as written, an environment or a label by its name in any case. */
function identity(list: EntryList, name: string): string {
  return list === 'rulesets' ? name : name.toLowerCase();
}

function write(change: EntryChange): EntryWrite {
  return {
    list: change.list,
    name: change.name ?? nameOf(change.entry),
    entry: change.entry === undefined ? undefined : written(change.entry),
  };
}

/**
 * The changes to a profile's rulesets, environments, and labels that aren't
 * saved. A change holds its entry whole, since the engine writes an entry
 * whole, with the saved entry it was made on, so a change is never written
 * over an entry that has since changed elsewhere.
 */
export class EntryEdits {
  readonly #saved = signal<ResolvedProfile | undefined>(undefined);
  readonly #changes = signal<ReadonlyMap<string, EntryChange>>(new Map());
  /** The changes a save under way is writing. */
  #writing: ReadonlyMap<string, EntryChange> = new Map();
  /** Numbers the new entries, so each has a key before it has a name. */
  #added = 0;

  readonly rows = computed<Readonly<Record<EntryList, readonly EntryRow[]>>>(() => ({
    rulesets: this.#rows('rulesets'),
    environments: this.#rows('environments'),
    labels: this.#rows('labels'),
  }));

  /** How many entries have a change. */
  readonly count = computed(() => this.#changes.value.size);

  /** Whether any changed entry can't be saved as it stands. */
  readonly held = computed(() =>
    entryLists.some((list) => this.rows.value[list].some((row) => row.problem !== undefined)),
  );

  /** Takes the profile as it is saved now, as after a sync or a save. */
  setSaved(saved: ResolvedProfile | undefined): void {
    this.#saved.value = saved;
    // A change that takes out an entry that is already gone has nothing left to do.
    const changes = new Map(this.#changes.value);
    for (const [key, change] of changes) {
      if (
        change.entry === undefined &&
        change.name !== undefined &&
        this.#savedEntry(change.list, change.name) === undefined
      ) {
        changes.delete(key);
      }
    }
    if (changes.size !== this.#changes.value.size) {
      this.#changes.value = changes;
    }
  }

  /** The changes the engine can take as they stand, for a preview: those of entries with no problem. */
  writes(): EntryWrite[] {
    const fine = new Set(
      entryLists.flatMap((list) =>
        this.rows.value[list].filter((row) => row.problem === undefined).map((row) => row.key),
      ),
    );
    return [...this.#changes.value].filter(([key]) => fine.has(key)).map(([, change]) => write(change));
  }

  /** Starts a ruleset, environment, or label, and answers the key the editor knows it by. */
  add(list: EntryList, entry: Entry): string {
    this.#added += 1;
    const key = `${list}:new:${this.#added}`;
    this.#set(key, { list, name: undefined, entry, base: undefined });
    return key;
  }

  /** Replaces an entry with what its form made of it. An entry changed back to what is saved is no change. */
  change(row: EntryRow, entry: Entry): void {
    this.#put(row, { entry });
  }

  /**
   * Has the profile remove the entry from each repository, or manage it
   * again. Removing keeps only its name, and managing it again brings back
   * what it had.
   */
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
    const kept = this.#changes.value.get(row.key)?.kept ?? (row.saved?.['absent'] === true ? undefined : row.saved);
    this.#put(row, { entry: kept === undefined ? { name } : { ...kept, name } });
  }

  /** Stops this profile from managing an entry it names itself, or lets go of one that is new. */
  takeOut(row: EntryRow): void {
    if (row.savedName === undefined && !this.#writing.has(row.key)) {
      this.#set(row.key, undefined);
    } else {
      this.#put(row, { entry: undefined });
    }
  }

  /**
   * Puts an entry back as it is saved. While a save is writing a change to
   * it, putting it back is itself a change, to what it was: the entry as it
   * was saved, or for one that was new, none.
   */
  reset(row: EntryRow): void {
    if (this.#writing.has(row.key)) {
      this.#set(row.key, { list: row.list, name: row.savedName, entry: row.saved, base: row.saved });
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
    if (row.saved === undefined) {
      this.#set(row.key, undefined);
      this.#added += 1;
      this.#set(`${row.list}:new:${this.#added}`, { ...change, name: undefined, base: undefined });
    } else {
      this.#set(row.key, { ...change, base: row.saved });
    }
  }

  resetAll(): void {
    this.#changes.value = new Map();
  }

  /** The changes a save writes, which stay as they are until `saved` says how it went. */
  begin(): EntryWrite[] {
    this.#writing = this.#changes.value;
    return [...this.#writing.values()].map(write);
  }

  /**
   * Whether a change the save is about to write was made on an entry that
   * has since changed or gone. The save checks this once it has read the
   * file in its turn, whatever became of the change while it waited.
   */
  writesOverChange(): boolean {
    return [...this.#writing.values()].some((change) =>
      change.name === undefined
        ? // A new entry whose name the file has by now would be written over that entry.
          this.#savedEntries(change.list).some(
            (entry) => identity(change.list, nameOf(entry)) === identity(change.list, nameOf(change.entry)),
          )
        : !sameValue(change.base, this.#savedEntry(change.list, change.name)),
    );
  }

  /**
   * Ends a save. One that wrote leaves only what changed again while it ran,
   * based on what it wrote and under the name it gave. One that failed
   * leaves every change as it is.
   */
  saved(wrote: boolean): void {
    const writing = this.#writing;
    this.#writing = new Map();
    if (!wrote) {
      return;
    }
    const left = new Map<string, EntryChange>();
    for (const [key, change] of this.#changes.value) {
      const was = writing.get(key);
      if (was === undefined) {
        left.set(key, change);
      } else if (change !== was && !sameValue(change.entry, was.entry)) {
        const name = was.entry === undefined ? undefined : nameOf(was.entry);
        const base = was.entry === undefined ? undefined : written(was.entry);
        // An entry the save took out and that has one again is a new one.
        if (name === undefined && change.entry !== undefined) {
          this.#added += 1;
        }
        left.set(name === undefined ? `${change.list}:new:${this.#added}` : `${change.list}/${name}`, {
          ...change,
          name,
          base,
        });
      }
    }
    this.#changes.value = left;
  }

  #put(row: EntryRow, next: { readonly entry: Entry | undefined; readonly kept?: Entry }): void {
    const current = this.#changes.value.get(row.key);
    const saved = row.saved;
    // While a save writes this entry, every change to it is kept, since what is saved is about to be what the save wrote.
    const same =
      !this.#writing.has(row.key) &&
      saved !== undefined &&
      next.entry !== undefined &&
      sameValue(written(next.entry), written(saved));
    this.#set(
      row.key,
      same
        ? undefined
        : {
            list: row.list,
            name: row.savedName,
            entry: next.entry,
            base: current === undefined ? saved : current.base,
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

  #savedEntries(list: EntryList): readonly Entry[] {
    const entries: unknown = this.#saved.value?.profile[list];
    return Array.isArray(entries) ? entries.filter(isEntry) : [];
  }

  #savedEntry(list: EntryList, name: string): Entry | undefined {
    return this.#savedEntries(list).find((entry) => entry['name'] === name);
  }

  #rows(list: EntryList): EntryRow[] {
    const saved = this.#saved.value;
    if (saved === undefined) {
      return [];
    }
    const changes = this.#changes.value;
    const sourceOf = (name: string): string => {
      const file = Object.entries(saved.sources[list]).find(
        ([known]) => identity(list, known) === identity(list, name),
      )?.[1];
      return file === undefined || file === saved.chain[0] ? 'here' : basename(file);
    };
    const listed = this.#savedEntries(list).map((entry) => {
      const name = nameOf(entry);
      const key = `${list}/${name}`;
      const change = changes.get(key);
      return {
        list,
        key,
        entry: change === undefined ? entry : change.entry,
        saved: entry,
        savedName: name,
        source: sourceOf(name),
        unsaved: change !== undefined,
        outOfDate: change !== undefined && !sameValue(change.base, entry),
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
        savedName: change.name,
        source: change.name === undefined ? undefined : 'here',
        unsaved: true,
        // A change to an entry the file had, which is gone from it now.
        outOfDate: change.name !== undefined,
      }));
    const all = [...listed, ...others];
    return all.map((row) => ({ ...row, problem: row.unsaved ? this.#problem(row, all) : undefined }));
  }

  #problem(row: Omit<EntryRow, 'problem'>, all: readonly Omit<EntryRow, 'problem'>[]): string | undefined {
    const { list, entry } = row;
    const name = nameOf(entry);
    if (row.outOfDate) {
      const known = row.savedName ?? name;
      return row.saved === undefined
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
    // The file still has that name for an entry whose change renames it or takes it out, until a save.
    if (
      others.some((other) => other.unsaved && other.savedName !== undefined && identity(list, other.savedName) === id)
    ) {
      return `${name} is the saved name of one you renamed or took out. Save that first, or choose another name.`;
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
