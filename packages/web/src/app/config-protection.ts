import { signal } from '@preact/signals';
import { createPlan, type GitHub, type OwnerType, parseProfile, parseRepo } from '@repotted/core';

import { mkdir, writeFile } from '../engine/files.js';
import { isSignedOut } from './account.js';
import type { ComparedProfile } from './comparison.js';

/** Where the browser keeps the built-in protection an apply starts from, apart from the profiles. */
export const builtInFolder = '/built-in';

/**
 * The protection Repotted offers for the repository the profiles are kept
 * in, by what owns it. Each one leaves the default branch open to the direct
 * commits a sync makes: it never requires pull requests, and blocks only
 * what a sync never does.
 */
const builtIns: Partial<Record<OwnerType, { readonly name: string; readonly text: string }>> = {
  user: {
    name: 'config repository protection',
    text: `# Repotted's built-in protection for a personal config repository.
owner_type: user

# Workflows get a read-only token and can't approve pull requests.
actions:
  default_workflow_permissions: read
  can_approve_pull_request_reviews: false

# A sync commits straight to the default branch and only fast-forwards it,
# so these block nothing Repotted does. Nobody bypasses them.
rulesets:
  - name: 'Main: Block Deletion'
    bypass_actors: []
    conditions:
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }
    rules:
      - type: deletion

  - name: 'Main: Block Force Pushes'
    bypass_actors: []
    conditions:
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }
    rules:
      - type: non_fast_forward
`,
  },
};

export type ProtectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly repository: string }
  /** No built-in protection fits what owns the repository, so none is offered. */
  | { readonly kind: 'none'; readonly repository: string }
  | {
      readonly kind: 'checked';
      readonly repository: string;
      /** What owns the repository, which picks the protection that fits it. */
      readonly owner: OwnerType;
      /** How many changes an apply of the protection would make; 0 when the repository has it all. */
      readonly changes: number;
      /** Why part of the protection can't be had there, such as a plan with no rulesets. */
      readonly limits: readonly string[];
    }
  | { readonly kind: 'failed'; readonly repository: string; readonly message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerOf(answer: unknown): OwnerType | undefined {
  const owner: unknown = typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'owner') : undefined;
  const type: unknown = typeof owner === 'object' && owner !== null ? Reflect.get(owner, 'type') : undefined;
  return type === 'User' ? 'user' : type === 'Organization' ? 'organization' : undefined;
}

/**
 * The built-in protection for the repository the profiles are kept in:
 * whether it fits that repository, and what an apply of it would change
 * there. Checking only reads; the protection is written only by an apply
 * the user reviews, from `profile`.
 */
export class ConfigProtection {
  readonly state = signal<ProtectionState>({ kind: 'idle' });

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  /** Counts the checks, so one that lands after a later one changes nothing. */
  #turn = 0;

  constructor(github: GitHub, onSignedOut: () => void) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
  }

  /** Reads what an apply of the protection would change in `repository`, `owner/name`. */
  async check(repository: string): Promise<void> {
    const turn = (this.#turn += 1);
    this.state.value = { kind: 'checking', repository };
    let next: ProtectionState;
    try {
      const repo = parseRepo(repository);
      const owner = ownerOf(await this.#github.request('GET', `/repos/${repo.owner}/${repo.name}`));
      const builtIn = owner === undefined ? undefined : builtIns[owner];
      if (owner === undefined || builtIn === undefined) {
        next = { kind: 'none', repository };
      } else {
        const { profile } = await parseProfile(builtIn.text, builtInFolder);
        const plan = await createPlan(this.#github, repo, profile);
        next = {
          kind: 'checked',
          repository,
          owner,
          changes: plan.changes.length,
          limits: plan.warnings.filter((warning) => warning.cause === 'unavailable').map((warning) => warning.message),
        };
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      next = { kind: 'failed', repository, message: messageOf(error) };
    }
    if (turn === this.#turn) {
      this.state.value = next;
    }
  }

  /** Forgets the last check, as when the profiles are no longer kept in a repository. */
  forget(): void {
    this.#turn += 1;
    this.state.value = { kind: 'idle' };
  }

  /**
   * Writes the protection that fits the checked repository where an apply
   * can start from it, and gives it as the profile to apply. The file is
   * written afresh each time, so an apply starts from the protection this
   * version of Repotted has.
   */
  async profile(): Promise<ComparedProfile | undefined> {
    const state = this.state.value;
    if (state.kind !== 'checked') {
      return undefined;
    }
    const builtIn = builtIns[state.owner];
    if (builtIn === undefined) {
      return undefined;
    }
    const file = `${builtInFolder}/${builtIn.name}.yaml`;
    await mkdir(builtInFolder, { recursive: true });
    await writeFile(file, builtIn.text);
    return { file, name: builtIn.name, folder: builtInFolder };
  }
}
