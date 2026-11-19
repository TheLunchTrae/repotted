// Every write to a repository's setup goes through this queue, one entry for
// each repository. An entry holds the plan that was reviewed: the setup the
// repository should end up with and the changes the review listed, never
// requests to replay. The engine plans the repository again before it writes,
// so an entry is safe to run twice. Entries are files in a folder the browser
// keeps, which is how a queue outlasts its tab, and only the one tab that
// keeps the files runs the app, so no two tabs run the same queue.

import { computed, signal } from '@preact/signals';
import {
  ApplyError,
  applyPlan,
  describeFailure,
  type GitHub,
  parsePlan,
  type Plan,
  resumeApply,
  StalePlanError,
} from '@repotted/core';
import * as z from 'zod/mini';

import { mkdir, readdir, readFile, rm, writeFile } from '../../engine/files.js';
import { isSignedOut } from '../account/account.js';
import { assignmentKey, type ProfileAssignments } from '../repositories/assignment-review.js';
import { applyQueueFolder } from '../storage/kept-files.js';

/** A queue older than this waits to be asked for, rather than carrying on by itself when the app opens. */
export const resumeWindowMs = 60 * 60 * 1000;

const savedRecord = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('applied'),
    versions: z.array(z.object({ profile: z.string(), version: z.string() })),
    notify: z.boolean(),
  }),
  z.object({
    kind: z.literal('added'),
    profile: z.string(),
    version: z.optional(z.string()),
    notify: z.boolean(),
  }),
]);

/** What a finished apply records on the repository's profiles. */
export type AssignmentRecord = z.infer<typeof savedRecord>;

const savedProblem = z.object({ kind: z.enum(['stale', 'failed']), message: z.string() });

const savedEntry = z.object({
  account: z.string(),
  queuedAt: z.number(),
  position: z.number(),
  repository: z.string(),
  profileName: z.string(),
  plan: z.unknown(),
  /**
   * Whether a write of it may have landed: set before GitHub is asked for anything, and taken back when a try
   * ends having written nothing. A tab that closes in between can't say, so the entry then counts as begun.
   */
  hasBegun: z.boolean(),
  /** Waits to be asked for because GitHub refused the sign-in. An entry too old when the app opens waits too, which its age says. */
  held: z.optional(z.boolean()),
  assignmentKey: z.optional(z.string()),
  record: z.optional(savedRecord),
  problem: z.optional(savedProblem),
});

interface Entry extends Omit<z.infer<typeof savedEntry>, 'plan'> {
  readonly id: string;
  readonly plan: Plan;
  readonly held: boolean;
  /** Held because a sign-in ended, which is the only hold that is kept: an age is read from when it was queued. */
  readonly signInLost: boolean;
}

export interface QueuedApply {
  readonly id: string;
  readonly repository: string;
  readonly profileName: string;
  readonly changes: number;
  /** `stale` needs a new review; `failed` can be tried again. */
  readonly status: 'waiting' | 'writing' | 'held' | 'stale' | 'failed';
  readonly message: string | undefined;
}

export interface ApplyRequest {
  readonly repository: string;
  readonly profileName: string;
  /** The plan of the review that is shown. */
  readonly plan: Plan;
  /** The repository's profiles as reviewed, which must still be so when it is written. */
  readonly assignmentKey: string | undefined;
  readonly record: AssignmentRecord | undefined;
}

export interface AppliedOutcome {
  readonly applied: Plan['changes'];
  /** Whether what the apply records on the repository's profiles was saved. */
  readonly recorded: Promise<boolean>;
}

interface Waiter {
  /** The plan as reviewed, with the files it was made from, which are read again while the page still has them. */
  readonly plan: Plan;
  readonly resolve: (outcome: AppliedOutcome) => void;
  readonly reject: (error: unknown) => void;
}

export interface ApplyQueueOptions {
  readonly github: GitHub;
  /** Whose queue this is. Another account's entries are never run. */
  readonly account: string;
  readonly onSignedOut: () => void;
  readonly assignments: ProfileAssignments;
  readonly now: () => number;
  /** Resolves once the files written so far are kept, or can't be. */
  readonly filesKept: () => Promise<void>;
  /** Resolves once the repositories' profiles are known, which an entry's check of them needs. */
  readonly assignmentsLoaded: Promise<void>;
  /** For applies no page is waiting on, once the queue has nothing left to write. */
  readonly onApplied: (repositories: number) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function count(amount: number, noun: string): string {
  return amount === 1 ? `1 ${noun}` : `${amount} ${noun}s`;
}

function fileOf(id: string): string {
  return `${applyQueueFolder}/${id}.json`;
}

function problemOf(entry: Entry, error: unknown): z.infer<typeof savedProblem> {
  if (error instanceof StalePlanError) {
    return {
      kind: 'stale',
      message: `${entry.repository} changed since you reviewed this apply, so nothing ${entry.hasBegun ? 'more ' : ''}was written. Review it again.`,
    };
  }
  if (error instanceof ApplyError) {
    return {
      kind: 'failed',
      // The message's first line says what failed and why; the rest is advice for a terminal.
      message: `${describeFailure(error).split('\n')[0] ?? ''}. ${count(error.applied.length, 'change')} before it ${error.applied.length === 1 ? 'stays' : 'stay'} written, and nothing after it was.`,
    };
  }
  return { kind: 'failed', message: messageOf(error) };
}

export class ApplyQueue {
  readonly #options: ApplyQueueOptions;
  readonly #entries = signal<readonly Entry[]>([]);
  readonly #writing = signal<string | undefined>(undefined);
  readonly #finished = signal(0);
  readonly #running = signal(false);
  readonly #waiters = new Map<string, Waiter>();
  /**
   * The entries a page waits for, each with its page, from when they are added
   * until the page has shown how they ended or lets them go.
   */
  readonly #watched = signal<ReadonlyMap<string, object>>(new Map());
  /** How many entries each page waited for are written, which the page has yet to show. */
  readonly #writtenUnshown = new Map<object, number>();
  /** Written, with files that stay until what they record is saved. */
  readonly #recording = new Set<string>();
  #finishedWithoutWaiter = 0;
  #added = 0;

  constructor(options: ApplyQueueOptions) {
    this.#options = options;
  }

  /** In the order they are written. A problem that a page waits to show is that page's to say. */
  readonly applies = computed((): readonly QueuedApply[] =>
    this.#entries.value
      .filter((entry) => entry.problem === undefined || !this.#watched.value.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        repository: entry.repository,
        profileName: entry.profileName,
        changes: entry.plan.changes.length,
        status: entry.problem?.kind ?? (entry.id === this.#writing.value ? 'writing' : entry.held ? 'held' : 'waiting'),
        message: entry.problem?.message,
      })),
  );

  /** True from the first entry it takes up until it has none left to write. */
  readonly running = computed(() => this.#running.value);

  /** Of the entries taken up since it last had none: how many are done, and the one being written. */
  readonly progress = computed(() => {
    if (!this.#running.value) {
      return undefined;
    }
    const left = this.applies.value.filter((apply) => apply.status === 'waiting' || apply.status === 'writing');
    return {
      finished: this.#finished.value,
      total: this.#finished.value + left.length,
      repository: left.find((apply) => apply.status === 'writing')?.repository,
    };
  });

  /** Entries that wait to be asked for, with when the oldest was queued. */
  readonly held = computed(() => {
    const held = this.#entries.value.filter((entry) => entry.held && entry.problem === undefined);
    return held.length === 0
      ? undefined
      : {
          repositories: held.length,
          changes: held.reduce((sum, entry) => sum + entry.plan.changes.length, 0),
          since: Math.min(...held.map((entry) => entry.queuedAt)),
          signInLost: held.some((entry) => entry.signInLost),
        };
  });

  /**
   * Reads what an earlier visit left. It carries on by itself when the oldest
   * entry still to write was queued within `resumeWindowMs`, and otherwise
   * holds them until `continueHeld`.
   */
  async load(): Promise<void> {
    const names = await readdir(applyQueueFolder, { withFileTypes: true }).then(
      (found) => found.map((item) => item.name),
      () => [],
    );
    const kept: Entry[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/u, '');
      // One added since the app opened is in the queue already.
      if (this.#recording.has(id) || this.#entries.value.some((entry) => entry.id === id)) {
        continue;
      }
      const entry = await this.#read(id);
      if (entry === undefined) {
        // Unreadable, or another account's, so it can never be run here.
        await rm(fileOf(id), { force: true });
      } else {
        kept.push(entry);
      }
    }
    const waiting = kept.filter((entry) => entry.problem === undefined);
    const age = this.#options.now() - Math.min(...waiting.map((entry) => entry.queuedAt));
    // A clock set back since leaves an age that says nothing, so that asks too.
    const held = waiting.length > 0 && (age < 0 || age > resumeWindowMs);
    this.#entries.value = [
      ...kept.map((entry) => ({ ...entry, held: (held || entry.held) && entry.problem === undefined })),
      ...this.#entries.value,
    ].toSorted((left, right) => left.position - right.position);
    this.#run();
  }

  async #read(id: string): Promise<Entry | undefined> {
    try {
      const saved = savedEntry.parse(JSON.parse(await readFile(fileOf(id), 'utf8')));
      return saved.account === this.#options.account
        ? { ...saved, id, plan: parsePlan(saved.plan), held: saved.held === true, signInLost: saved.held === true }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Queues one repository's reviewed plan and answers as `applyPlan` does once
   * it is written: with the changes made, or its error. The entry is queued,
   * in the order of the calls, before this returns. `page` is whoever waits
   * for the answer, and says so with `shownBy` or `letGo`.
   */
  add(request: ApplyRequest, page: object = request): Promise<AppliedOutcome> {
    const { source: _source, ...plan } = request.plan;
    let kept: Plan;
    try {
      // What is written is what is kept, so a plan the browser can't hold whole shows now and not after a reload.
      kept = parsePlan(JSON.parse(JSON.stringify(plan)));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#added += 1;
    const queuedAt = this.#options.now();
    const entry: Entry = {
      id: `${queuedAt}-${this.#added}-${crypto.randomUUID()}`,
      account: this.#options.account,
      queuedAt,
      position: Math.max(0, ...this.#entries.value.map((other) => other.position)) + 1,
      repository: request.repository,
      profileName: request.profileName,
      plan: kept,
      hasBegun: false,
      assignmentKey: request.assignmentKey,
      record: request.record,
      problem: undefined,
      held: false,
      signInLost: false,
    };
    // A new apply of a repository replaces one of it that waits to be asked for, or that left a problem to look at.
    const replaced = this.#entries.value.filter(
      (other) =>
        (other.held || other.problem !== undefined) &&
        other.repository.toLowerCase() === entry.repository.toLowerCase(),
    );
    this.#entries.value = [...this.#entries.value.filter((other) => !replaced.includes(other)), entry];
    const outcome = new Promise<AppliedOutcome>((resolve, reject) => {
      this.#waiters.set(entry.id, { plan: request.plan, resolve, reject });
    });
    this.#watched.value = new Map([...this.#watched.value, [entry.id, page]]);
    // Run whether or not the entry could be kept: the page that waits is told either way.
    Promise.all([...replaced.map((other) => rm(fileOf(other.id), { force: true })), this.#keep(entry)])
      .catch(() => undefined)
      .then(() => {
        this.#run();
      })
      .catch(() => undefined);
    return outcome;
  }

  async continueHeld(): Promise<void> {
    const held = this.#entries.value.filter((entry) => entry.held);
    this.#entries.value = this.#entries.value.map((entry) => ({ ...entry, held: false, signInLost: false }));
    this.#run();
    await Promise.all(held.map((entry) => this.#keepIfQueued(entry.id)));
  }

  async discardHeld(): Promise<void> {
    await this.#remove(this.#entries.value.filter((entry) => entry.held));
  }

  /** How many entries are written before the first one the page waits for. */
  earlierThan(page: object): number {
    const left = this.#entries.value.filter((entry) => entry.problem === undefined && !entry.held);
    return Math.max(
      left.findIndex((entry) => this.#watched.value.get(entry.id) === page),
      0,
    );
  }

  /** For a page that shows how the entries it waited for ended, so nothing is left of them to say here. */
  async shownBy(page: object): Promise<void> {
    this.#writtenUnshown.delete(page);
    // A file that can't be removed shows its problem again after a reload, which is all that is lost.
    await this.#remove(this.#watchedBy(page).filter((entry) => entry.problem !== undefined)).catch(() => undefined);
  }

  /**
   * For a page that moves on to other work before it has shown how its entries
   * ended. Those still queued stay queued and end as entries no page waits
   * for, and what has ended is said here instead: a problem in `applies`, and
   * the written ones through `onApplied`. One being written tells its page
   * when it ends, so the page keeps the files its plan reads until then; the
   * others tell it now.
   */
  letGo(page: object): void {
    const released = this.#watchedBy(page);
    this.#unwatch(released.map((entry) => entry.id));
    for (const entry of released) {
      this.#waiters.get(entry.id)?.reject(new Error('The page moved on before the apply was written.'));
      this.#waiters.delete(entry.id);
    }
    this.#finishedWithoutWaiter += this.#writtenUnshown.get(page) ?? 0;
    this.#writtenUnshown.delete(page);
    if (!this.#running.value) {
      this.#sayApplied();
    }
  }

  #watchedBy(page: object): readonly Entry[] {
    return this.#entries.value.filter((entry) => this.#watched.value.get(entry.id) === page);
  }

  #unwatch(ids: readonly string[]): void {
    this.#watched.value = new Map([...this.#watched.value].filter(([id]) => !ids.includes(id)));
  }

  #sayApplied(): void {
    const finishedWithoutWaiter = this.#finishedWithoutWaiter;
    this.#finishedWithoutWaiter = 0;
    if (finishedWithoutWaiter > 0) {
      this.#options.onApplied(finishedWithoutWaiter);
    }
  }

  /** For an entry with a problem, which is then left as it is on GitHub. */
  async dismiss(id: string): Promise<void> {
    await this.#remove(this.#entries.value.filter((entry) => entry.id === id && entry.problem !== undefined));
  }

  /** Finishes a failed entry, which writes only what is left of its reviewed changes. */
  async tryAgain(id: string): Promise<void> {
    const entry = this.#entries.value.find((other) => other.id === id);
    if (entry?.problem?.kind !== 'failed') {
      return;
    }
    await this.#replace({ ...entry, problem: undefined });
    this.#run();
  }

  /** For signing out. An entry being written finishes; nothing else is kept or run. */
  async discardAll(): Promise<void> {
    await this.#remove(this.#entries.value.filter((entry) => entry.id !== this.#writing.value));
  }

  async #remove(entries: readonly Entry[]): Promise<void> {
    this.#entries.value = this.#entries.value.filter((entry) => !entries.includes(entry));
    for (const entry of entries) {
      this.#waiters.get(entry.id)?.reject(new Error('The apply was discarded before it was written.'));
      this.#waiters.delete(entry.id);
    }
    this.#unwatch(entries.map((entry) => entry.id));
    await Promise.all(entries.map((entry) => rm(fileOf(entry.id), { force: true })));
  }

  async #replace(entry: Entry): Promise<void> {
    this.#entries.value = this.#entries.value.map((other) => (other.id === entry.id ? entry : other));
    await this.#keep(entry);
  }

  /** Keeps the entry as the queue has it now, unless it has left the queue meanwhile. */
  async #keepIfQueued(id: string): Promise<void> {
    const entry = this.#entries.value.find((other) => other.id === id);
    if (entry !== undefined) {
      await this.#keep(entry);
    }
  }

  async #keep(entry: Entry): Promise<void> {
    const { id: _id, signInLost, ...saved } = entry;
    await mkdir(applyQueueFolder, { recursive: true });
    await writeFile(fileOf(entry.id), JSON.stringify({ ...saved, held: entry.held && signInLost }));
  }

  #next(): Entry | undefined {
    return this.#entries.value.find((entry) => entry.problem === undefined && !entry.held);
  }

  #run(): void {
    if (this.#running.value || this.#next() === undefined) {
      return;
    }
    this.#running.value = true;
    this.#drain()
      // An entry's failure is kept with the entry, so nothing is left to say of one here.
      .catch(() => undefined)
      .then(() => {
        this.#running.value = false;
        this.#writing.value = undefined;
        this.#finished.value = 0;
        this.#sayApplied();
        // One added as the last entry ended found the queue still running.
        this.#run();
      })
      .catch(() => undefined);
  }

  async #drain(): Promise<void> {
    // A failed read leaves the profiles as they are known, which an entry's check then refuses if they differ.
    await this.#options.assignmentsLoaded.catch(() => undefined);
    for (let entry = this.#next(); entry !== undefined; entry = this.#next()) {
      await this.#write(entry);
    }
  }

  async #write(entry: Entry): Promise<void> {
    this.#writing.value = entry.id;
    const waiter = this.#waiters.get(entry.id);
    this.#waiters.delete(entry.id);
    try {
      // Kept before GitHub is asked for anything, so an entry that is cut off is known to have begun.
      await this.#replace({ ...entry, hasBegun: true });
      await this.#options.filesKept();
      const plan = waiter?.plan ?? entry.plan;
      const applied = await (entry.hasBegun ? resumeApply : applyPlan)(this.#options.github, plan, () => {
        if (
          entry.assignmentKey !== undefined &&
          entry.assignmentKey !== assignmentKey(this.#options.assignments, entry.repository)
        ) {
          throw new Error('The repository assignment changed since review. Review again before applying.');
        }
      });
      const recorded = this.#record(entry);
      this.#recording.add(entry.id);
      this.#entries.value = this.#entries.value.filter((other) => other.id !== entry.id);
      this.#finished.value += 1;
      // The file goes once the record is saved, so an entry cut off before then records again.
      recorded
        .then(() => rm(fileOf(entry.id), { force: true }))
        .catch(() => undefined)
        .finally(() => {
          this.#recording.delete(entry.id);
        });
      const page = this.#watched.value.get(entry.id);
      if (page === undefined) {
        this.#finishedWithoutWaiter += 1;
      } else {
        this.#writtenUnshown.set(page, (this.#writtenUnshown.get(page) ?? 0) + 1);
      }
      this.#unwatch([entry.id]);
      waiter?.resolve({ applied, recorded });
    } catch (error) {
      // Only a write that failed partway can have left something written by this try.
      const hasBegun = entry.hasBegun || error instanceof ApplyError;
      if (isSignedOut(error) || (error instanceof ApplyError && isSignedOut(error.cause))) {
        // What is left stays queued, and is kept as waiting to be asked for, so the next sign-in doesn't write it unasked.
        const left = this.#entries.value.filter((other) => other.problem === undefined);
        this.#entries.value = this.#entries.value.map((other) =>
          other.problem === undefined
            ? {
                ...other,
                hasBegun: other.id === entry.id ? hasBegun : other.hasBegun,
                held: true,
                signInLost: true,
              }
            : other,
        );
        this.#options.onSignedOut();
        waiter?.reject(error);
        for (const other of this.#waiters.values()) {
          other.reject(error);
        }
        this.#waiters.clear();
        // Signing out takes the pages away, so the problems they waited to show are the next sign-in's to show.
        this.#watched.value = new Map();
        await Promise.all(left.map((other) => this.#keepIfQueued(other.id))).catch(() => undefined);
        return;
      }
      // Kept until a page that waits has shown it, so a page that moves on first loses nothing.
      const kept = this.#replace({ ...entry, hasBegun, problem: problemOf(entry, error) });
      waiter?.reject(error);
      await kept;
    }
  }

  async #record(entry: Entry): Promise<boolean> {
    const { record, repository } = entry;
    const { assignments } = this.#options;
    if (record === undefined) {
      return true;
    }
    try {
      return await (record.kind === 'applied'
        ? assignments.recordApplied(repository, record.versions, entry.plan.authoritative ?? [], record.notify)
        : assignments.recordAdded(repository, record.profile, record.version, record.notify));
    } catch {
      return false;
    }
  }
}

/** A queue nothing shares, for an apply that is given none: it runs only that apply's plans. */
export function pageQueue(github: GitHub, onSignedOut: () => void, assignments: ProfileAssignments): ApplyQueue {
  return new ApplyQueue({
    github,
    account: '',
    onSignedOut,
    assignments,
    now: Date.now,
    filesKept: () => Promise.resolve(),
    assignmentsLoaded: Promise.resolve(),
    onApplied: () => undefined,
  });
}
