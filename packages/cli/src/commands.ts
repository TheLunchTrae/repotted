import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  addToBatch,
  applyBatch,
  ApplyError,
  applyPlan,
  type Batch,
  batchMemberFile,
  chosenMembers,
  type BatchPlan,
  createBatch,
  discardBatch,
  discardBatchMember,
  editEverywhere,
  isBatchPlan,
  isUnfinished,
  leaveOut,
  type MemberResult,
  parseBatchPlan,
  planBatch,
  readBatch,
  captureProfile,
  createGitHub,
  createPlan,
  currentUser,
  describeFailure,
  describeSkipped,
  editProfile,
  failureReason,
  type EntryEdit,
  formatPlan,
  type GitHub,
  GitHubError,
  type Plan,
  listProfiles,
  listRepositories,
  lockChanges,
  parsePlan,
  parseRepo,
  type ProfileEdit,
  profileFileJsonSchema,
  readAccess,
  resolveProfile,
  skippedDrafts,
  StalePlanError,
  createStagedApply,
  discardStagedApply,
  editStagedApply,
  planStagedApply,
  resolveStagedApply,
  saveStagedEdits,
  type StagedApply,
  type StagedEdit,
  type StagedPlan,
  stringifyProfile,
  syncFolder,
} from '@repotted/core';
import { z } from 'zod';

import {
  enterCode,
  installUrl,
  NotSignedInError,
  type SignIn,
  tokenOrSignIn,
  tokenVariables,
  usesRepottedApp,
} from './auth.js';

/** What the CLI reaches outside itself: GitHub, the terminal, and its own version. */
export interface Io {
  readonly version: string;
  /** The environment, for the token variables and the client ID override. */
  readonly env: NodeJS.ProcessEnv;
  github(): Promise<GitHub>;
  out(text: string): void;
  err(text: string): void;
  /** Whether a person can answer a prompt. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
  /** Starts the device flow; the token is stored once the user enters the code. */
  signIn(): Promise<SignIn>;
  /** Removes the stored sign-in; returns whether there was one. */
  signOut(): Promise<boolean>;
}

const usage = `Usage: repotted <command> [options]

Commands:
  capture <owner/repo> [--output file]          Write the repository's setup as a YAML profile
  plan <owner/repo> --profile file [--out file]  Show the changes a profile needs; --out saves the plan
  plan [owner/repo] --staged file [--out file]   Show the changes a staged apply needs, or each repository
                                                 of a batch, when file is a batch folder
  apply <plan.json> [--yes]                      Apply a saved plan if the repository has not changed; a
        [--only owner/repo] [--stop-on-failure]  batch's plan, one repository at a time
  profiles <folder>                              List the profiles in a folder
  sync <folder> [--repository owner/repo]        Sync a folder of profiles with a GitHub repository
       [--path folder] [--prefer local|remote]   (or a folder in it); --prefer settles files changed on both,
       [--only file] [--message text]            or only the files --only names
  profile <file> [--set key=json] [--unset key]  Show a profile resolved over its bases; edit its settings
          [--ruleset json] [--drop-ruleset name]  and its rulesets and environments; drafts.<section>.<key>
          [--environment json] [--drop-environment name]  keys and "draft": true entries are drafts
          [--drop-draft-ruleset name] [--drop-draft-environment name]
  stage <file> --new owner/repo [--profile file] Start a staged apply: one-off edits for one apply, over a
                                                 profile or over the repository as it is
  stage <file> [--set key=json] [--unset key]    Show a staged apply resolved; edit it as profile does, and
        [--exclude key] [--include key]              exclude values of its profile, as repository.has_wiki or
        [--save-to-profile] [--discard]          rulesets/Main; save its edits to its profile; or remove it
  stage <folder> --batch --new owner/repo ...    Start a batch: a staged apply for each repository, all from
        [--profile file] [--join file]           one profile; --join adds a staged apply as it is
        [--staged-dir folder]                    (new ones go in folder/<owner>/<name>.yaml)
  stage <folder> [--new owner/repo] [--join file]  Add to a batch; leave a repository out of it or put it
        [--leave-out owner/repo] [--put-back owner/repo]  back; edit one with --repo and the options above;
        [--repo owner/repo] [--exclude key --everywhere]  exclude a value from all; or --discard the batch
  schema                                         Print the JSON Schema of a profile file, for editors
  mcp [--read-only]                              Run the MCP server over stdio
  repos                                          List the repositories Repotted can manage
  status                                         Show which GitHub account Repotted signs in as
  login                                          Sign in with the Repotted GitHub App
  logout                                         Remove the sign-in from the OS keychain

The GitHub token comes from GITHUB_TOKEN or GH_TOKEN, then repotted login, then
the GitHub CLI (gh auth token).

Options:
  --json         Print JSON for programs; see docs/user/json-output.md
  -h, --help     Show this help
  -v, --version  Show the version`;

class UsageError extends Error {}

function only(positionals: string[], label: string): string {
  const [value, ...rest] = positionals;
  if (value === undefined || rest.length > 0) {
    throw new UsageError(`Expected one ${label}.`);
  }
  return value;
}

function json(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value)}\n`);
}

/**
 * The page of GitHub's docs that a refusal links to, which text output names
 * after the failure. The refusal may be the cause of the failure, as of a
 * sync GitHub refused.
 */
function docsLink(error: unknown): string {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof GitHubError) {
      return current.documentationUrl === undefined ? '' : `See ${current.documentationUrl}\n`;
    }
  }
  return '';
}

function warn(io: Io, lines: readonly string[]): void {
  for (const line of lines) {
    io.err(`warning: ${line}\n`);
  }
}

async function capture(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, json: { type: 'boolean' } },
  });
  const repo = parseRepo(only(positionals, 'repository'));
  const result = await captureProfile(await io.github(), repo);
  const yaml = stringifyProfile(result.profile);
  if (values.output !== undefined) {
    await writeFile(values.output, yaml);
  }
  if (values.json === true) {
    json(io, { repository: `${repo.owner}/${repo.name}`, profile: result.profile, warnings: result.warnings });
    return 0;
  }
  if (values.output === undefined) {
    io.out(yaml);
  } else {
    io.err(`Wrote ${values.output}\n`);
  }
  warn(io, result.warnings);
  return 0;
}

async function isFolder(target: string): Promise<boolean> {
  return stat(target).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

async function planBatchCommand(io: Io, folder: string, out: string | undefined, asJson: boolean): Promise<number> {
  const result: BatchPlan = await planBatch(await io.github(), folder);
  // The saved plan is the whole document, so apply can end each staged apply it finishes.
  if (out !== undefined) {
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  // A repository that could not be planned leaves the batch unreviewed, which a script should notice.
  const code = result.failures.length > 0 ? 1 : 0;
  if (asJson) {
    json(io, result);
    return code;
  }
  io.out(`${result.plans.map((member) => formatPlan(member, member.locks)).join('\n\n')}\n`);
  for (const { repository, error } of result.failures) {
    io.err(`${repository} could not be planned: ${error.message}\n`);
  }
  if (result.left_out.length > 0) {
    io.err(`Left out of the batch: ${result.left_out.map((member) => member.repository).join(', ')}\n`);
  }
  if (out !== undefined) {
    io.err(`Saved the plans to ${out}. Apply them with: repotted apply ${out}\n`);
  }
  return code;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/** One member's result as text, after the repository's name. */
function describeResult(result: MemberResult): string {
  switch (result.status) {
    case 'applied':
      return `applied ${plural(result.applied.length, 'change')}.${result.ended ? '' : ' Its staged apply stays, since it changed after the review or left the batch.'}`;
    case 'in_line':
      return 'already matches the profile.';
    case 'locked':
      return `not applied: ${plural(result.locks.length, 'change')} locked (${result.locks[0]?.reason ?? 'locked'}).`;
    case 'left_out':
      return 'not applied: the batch no longer holds it as reviewed, since it was left out or taken out, or the batch ended.';
    case 'changed':
      return 'not applied: its staged apply changed after the review. Plan the batch again to review it.';
    case 'stopped':
      return 'not applied, since an earlier repository failed.';
    case 'stale':
      return `${result.message}\n\nThe repository now needs:\n${formatPlan(result.current)}`;
    case 'apply_failed':
      return `${result.message}\n${docsLink(result.cause)}`;
    case 'failed':
      return result.error.message;
  }
}

/** One member's result for --json: an apply failure leaves its cause out, which says no more than its message. */
function resultDocument(result: MemberResult): unknown {
  if (result.status !== 'apply_failed') {
    return result;
  }
  const { cause: _cause, ...rest } = result;
  return rest;
}

interface BatchApplyFlags {
  readonly yes: boolean;
  readonly only: readonly string[] | undefined;
  readonly stopOnFailure: boolean;
  readonly json: boolean;
}

async function applyBatchCommand(io: Io, data: unknown, flags: BatchApplyFlags): Promise<number> {
  const reviewed = parseBatchPlan(data);
  // Checked before anything prints, so a name the plan lacks stops the run at once.
  const chosen = chosenMembers(reviewed, flags.only);
  if (!flags.json) {
    io.out(`${chosen.map((member) => formatPlan(member.plan, member.locks)).join('\n\n')}\n`);
  }
  const changes = chosen
    .filter((member) => member.locks.length === 0)
    .reduce((sum, member) => sum + member.plan.changes.length, 0);
  if (changes > 0 && !flags.yes) {
    if (!io.interactive) {
      throw new UsageError('apply asks before it writes. Run it in a terminal, or pass --yes.');
    }
    const repositories = chosen.filter((member) => member.locks.length === 0 && member.plan.changes.length > 0);
    if (
      !(await io.confirm(
        `Apply ${plural(changes, 'change')} to ${plural(repositories.length, 'repository', 'repositories')}, one at a time? [y/N] `,
      ))
    ) {
      io.err('Nothing applied.\n');
      return 1;
    }
  }
  const results = await applyBatch(await io.github(), reviewed, {
    ...(flags.only === undefined ? {} : { only: flags.only }),
    stopOnFailure: flags.stopOnFailure,
    ...(flags.json
      ? {}
      : { onResult: (result: MemberResult) => io.err(`${result.repository}: ${describeResult(result)}\n`) }),
  });
  // A repository that was not applied, or failed, leaves the batch unfinished, which a script should notice.
  const unfinished = results.filter(isUnfinished);
  if (flags.json) {
    json(io, { batch: reviewed.batch, results: results.map(resultDocument) });
  } else if (unfinished.length > 0) {
    io.err(
      `${plural(unfinished.length, 'repository', 'repositories')} did not finish. Review what is left with: repotted plan --staged ${reviewed.batch}\n`,
    );
  }
  return unfinished.length > 0 ? 1 : 0;
}

async function plan(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      profile: { type: 'string', short: 'p' },
      staged: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (values.staged !== undefined && (await isFolder(values.staged))) {
    if (values.profile !== undefined || positionals.length > 0) {
      throw new UsageError('plan --staged <folder> plans each repository of a batch, so it takes no other.');
    }
    return planBatchCommand(io, values.staged, values.out, values.json === true);
  }
  let repo: ReturnType<typeof parseRepo>;
  let result: Plan;
  // A staged plan's document also says what the plan applies and what leaves each change out.
  let stagedPlan: StagedPlan | undefined;
  let github: GitHub;
  if (values.staged === undefined) {
    repo = parseRepo(only(positionals, 'repository'));
    if (values.profile === undefined) {
      throw new UsageError('plan needs --profile or --staged.');
    }
    const desired = await resolveProfile(values.profile);
    github = await io.github();
    result = await createPlan(github, repo, desired.profile, skippedDrafts(desired.drafts));
  } else {
    if (values.profile !== undefined) {
      throw new UsageError('plan takes --profile or --staged, not both.');
    }
    if (positionals.length > 1) {
      throw new UsageError('Expected at most one repository.');
    }
    const [named] = positionals;
    const file = values.staged;
    github = await io.github();
    // Checked on the plan's own read of the file, before GitHub is read.
    stagedPlan = await planStagedApply(github, file, ({ repository }) => {
      if (named !== undefined && named.toLowerCase() !== repository.toLowerCase()) {
        throw new UsageError(`${file} applies to ${repository}, not ${named}.`);
      }
    });
    repo = parseRepo(stagedPlan.staged.repository);
    result = stagedPlan.plan;
  }
  // Apply checks neither: GitHub decides at the write.
  const access = await readAccess(github, repo);
  const locks = lockChanges(access, result.changes);
  const document = { ...result, access, locks };
  if (values.out !== undefined) {
    await writeFile(values.out, `${JSON.stringify(document, null, 2)}\n`);
  }
  if (values.json === true) {
    json(
      io,
      stagedPlan === undefined
        ? document
        : {
            ...document,
            staged: {
              file: stagedPlan.staged.file,
              repository: stagedPlan.staged.repository,
              base: stagedPlan.staged.base,
              exclude: stagedPlan.staged.exclude,
            },
            exclusions: stagedPlan.exclusions,
          },
    );
    return 0;
  }
  io.out(`${formatPlan(result, locks)}\n`);
  if (values.out !== undefined) {
    io.err(`Saved the plan to ${values.out}. Apply it with: repotted apply ${values.out}\n`);
  }
  return 0;
}

async function apply(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean', short: 'y' },
      only: { type: 'string', multiple: true },
      'stop-on-failure': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const file = only(positionals, 'plan file');
  // A program has no terminal to confirm in; the reviewed plan is its confirmation.
  if (values.json === true && values.yes !== true) {
    throw new UsageError('apply --json needs --yes.');
  }
  const data: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (isBatchPlan(data)) {
    return applyBatchCommand(io, data, {
      yes: values.yes === true,
      only: values.only,
      stopOnFailure: values['stop-on-failure'] === true,
      json: values.json === true,
    });
  }
  if (values.only !== undefined || values['stop-on-failure'] === true) {
    throw new UsageError('--only and --stop-on-failure are for a batch plan, which lists several repositories.');
  }
  const reviewed = parsePlan(data);
  if (values.json !== true) {
    io.out(`${formatPlan(reviewed)}\n`);
  }
  if (reviewed.changes.length === 0) {
    if (values.json === true) {
      json(io, { repository: reviewed.repository, applied: [] });
    }
    return 0;
  }
  if (values.yes !== true) {
    if (!io.interactive) {
      throw new UsageError('apply asks before it writes. Run it in a terminal, or pass --yes.');
    }
    if (!(await io.confirm(`Apply ${reviewed.changes.length} changes to ${reviewed.repository}? [y/N] `))) {
      io.err('Nothing applied.\n');
      return 1;
    }
  }
  try {
    const applied = await applyPlan(await io.github(), reviewed);
    if (values.json === true) {
      json(io, { repository: reviewed.repository, applied });
    } else {
      io.out(`Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'}.\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof StalePlanError) {
      if (values.json === true) {
        json(io, { error: { kind: 'stale_plan', message: error.message, current: error.current } });
      } else {
        io.err(`${error.message}\n\nThe repository now needs:\n${formatPlan(error.current)}\n`);
      }
      return 1;
    }
    if (error instanceof ApplyError) {
      if (values.json === true) {
        json(io, {
          error: {
            kind: 'apply_failed',
            message: describeFailure(error),
            applied: error.applied,
            failed: error.failed,
            reason: failureReason(error),
          },
        });
      } else {
        io.err(`${describeFailure(error)}\n${docsLink(error.cause)}`);
      }
      return 1;
    }
    throw error;
  }
}

async function profiles(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const folder = only(positionals, 'folder');
  const listings = await listProfiles(folder);
  if (values.json === true) {
    json(io, { profiles: listings });
    return 0;
  }
  for (const listing of listings) {
    const notes = [
      listing.extends === null ? '' : `extends ${path.basename(listing.extends)}`,
      listing.problem === null ? '' : 'invalid',
    ].filter(Boolean);
    io.out(`${listing.name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}\n`);
  }
  for (const listing of listings) {
    if (listing.problem !== null) {
      io.err(`${listing.problem}\n`);
    }
  }
  return 0;
}

async function sync(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repository: { type: 'string' },
      path: { type: 'string' },
      prefer: { type: 'string' },
      only: { type: 'string', multiple: true },
      message: { type: 'string', short: 'm' },
      json: { type: 'boolean' },
    },
  });
  const folder = only(positionals, 'folder');
  const prefer = values.prefer;
  if (prefer !== undefined && prefer !== 'local' && prefer !== 'remote') {
    throw new UsageError(`--prefer takes local or remote: ${prefer}`);
  }
  if (values.only !== undefined && prefer === undefined) {
    throw new UsageError('--only names the files that --prefer settles, so it needs --prefer.');
  }
  const result = await syncFolder(await io.github(), folder, {
    ...(values.repository === undefined ? {} : { repository: values.repository }),
    ...(values.path === undefined ? {} : { path: values.path }),
    ...(prefer === undefined ? {} : { prefer }),
    ...(values.only === undefined ? {} : { only: values.only }),
    ...(values.message === undefined ? {} : { message: values.message }),
  });
  // A conflict leaves the folder out of step, which a script should notice.
  const code = result.conflicts.length > 0 ? 1 : 0;
  if (values.json === true) {
    json(io, result);
    return code;
  }
  const where = result.path === '' ? result.repository : `${result.repository}/${result.path}`;
  io.out(
    `Synced ${folder} with ${where} (${result.branch}): ${result.pulled.length} pulled, ${result.pushed.length} pushed.\n`,
  );
  for (const file of result.conflicts) {
    io.err(`${file} changed here and on GitHub. Keep one with --prefer local or --prefer remote.\n`);
  }
  return code;
}

/** Reads `section.key=json` for --set, or `section.key` for --unset. */
function profileEdit(argument: string, unset: boolean): ProfileEdit {
  if (unset) {
    return { path: argument.split('.'), value: undefined };
  }
  const separator = argument.indexOf('=');
  if (separator === -1) {
    throw new UsageError(`--set takes key=value, as in repository.has_wiki=false: ${argument}`);
  }
  const text = argument.slice(separator + 1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A bare word, such as selected, is a string.
    value = text;
  }
  return { path: argument.slice(0, separator).split('.'), value };
}

/** Reads a ruleset or environment for --ruleset or --environment: a JSON object with a name. */
function entryEdit(list: EntryEdit['list'], text: string): EntryEdit {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const entry = z.looseObject({ name: z.string().min(1) }).safeParse(value);
  if (!entry.success) {
    throw new UsageError(`--${list.slice(0, -1)} takes a JSON object with a name, as in {"name":"Main"}: ${text}`);
  }
  return { list, name: entry.data.name, draft: entry.data['draft'] === true, entry: entry.data };
}

const drops: Readonly<Record<string, Pick<EntryEdit, 'list' | 'draft'>>> = {
  'drop-ruleset': { list: 'rulesets', draft: false },
  'drop-environment': { list: 'environments', draft: false },
  'drop-draft-ruleset': { list: 'rulesets', draft: true },
  'drop-draft-environment': { list: 'environments', draft: true },
};

/**
 * The profile edits in command-line order. A write right after a drop from
 * the same list renames the dropped entry, so dropping a draft and writing
 * its entry without `"draft": true` finishes the draft in place.
 */
function profileEdits(tokens: readonly { kind: string; name?: string; value?: string | undefined }[]): ProfileEdit[] {
  const edits: ProfileEdit[] = [];
  for (const token of tokens) {
    const value = token.value ?? '';
    const previous = edits.at(-1);
    if (token.kind !== 'option' || token.name === undefined) {
      continue;
    }
    const drop = drops[token.name];
    if (token.name === 'set' || token.name === 'unset') {
      edits.push(profileEdit(value, token.name === 'unset'));
    } else if (drop !== undefined) {
      edits.push({ ...drop, name: value, entry: undefined });
    } else if (token.name === 'ruleset' || token.name === 'environment') {
      const edit = entryEdit(token.name === 'ruleset' ? 'rulesets' : 'environments', value);
      if (previous !== undefined && 'list' in previous && previous.list === edit.list && previous.entry === undefined) {
        edits[edits.length - 1] = { ...edit, name: previous.name, draft: previous.draft === true };
      } else {
        edits.push(edit);
      }
    }
  }
  return edits;
}

async function profile(io: Io, args: string[]): Promise<number> {
  const { positionals, values, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      set: { type: 'string', multiple: true },
      unset: { type: 'string', multiple: true },
      ruleset: { type: 'string', multiple: true },
      'drop-ruleset': { type: 'string', multiple: true },
      environment: { type: 'string', multiple: true },
      'drop-environment': { type: 'string', multiple: true },
      'drop-draft-ruleset': { type: 'string', multiple: true },
      'drop-draft-environment': { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  });
  const file = only(positionals, 'profile file');
  const edits = profileEdits(tokens);
  const resolved = edits.length === 0 ? await resolveProfile(file) : await editProfile(file, edits);
  if (values.json === true) {
    json(io, resolved);
    return 0;
  }
  io.out(stringifyProfile(resolved.profile));
  if (edits.length > 0) {
    io.err(`Saved ${file}\n`);
  }
  const drafts = skippedDrafts(resolved.drafts);
  if (drafts.length > 0) {
    io.err(`Drafts, left out of plans: ${drafts.map(describeSkipped).join(', ')}\n`);
  }
  warn(io, resolved.warnings);
  return 0;
}

/** What `stage` does to one staged apply file, alone or as a member of a batch. */
interface StageOptions {
  readonly new?: string | undefined;
  readonly profile?: string | undefined;
  readonly saveToProfile: boolean;
  readonly discard: boolean;
  readonly json: boolean;
}

async function stageFile(io: Io, file: string, options: StageOptions, edits: readonly StagedEdit[]): Promise<number> {
  if (options.profile !== undefined && options.new === undefined) {
    throw new UsageError('--profile names what a new staged apply starts from, so it needs --new.');
  }
  if (options.discard) {
    if (options.new !== undefined || edits.length > 0 || options.saveToProfile) {
      throw new UsageError('--discard removes the staged apply, so it takes no other option.');
    }
    await discardStagedApply(file);
    if (options.json) {
      json(io, { discarded: path.resolve(file) });
    } else {
      io.err(`Removed ${file}\n`);
    }
    return 0;
  }
  // Each step returns the staged apply as it leaves it, so the file is read again only when nothing else read it.
  let result: StagedApply | undefined =
    options.new === undefined ? undefined : await createStagedApply(file, options.new, options.profile);
  try {
    if (edits.length > 0) {
      result = await editStagedApply(file, edits);
    }
    if (options.saveToProfile) {
      result = await saveStagedEdits(file);
    }
  } catch (error) {
    // A start whose edits fail leaves no file behind, so it can be run again.
    // The edits' failure is the one to report, even if the cleanup fails too.
    if (options.new !== undefined) {
      await discardStagedApply(file).catch(() => undefined);
    }
    throw error;
  }
  result ??= await resolveStagedApply(file);
  if (options.json) {
    json(io, result);
    return 0;
  }
  io.err(
    `Staged apply to ${result.repository}, ${result.base === null ? 'from the repository as it is' : `from ${result.base}`}\n`,
  );
  if (result.exclude.length > 0) {
    io.err(`Exclusions: ${result.exclude.join(', ')}\n`);
  }
  io.out(stringifyProfile(result.profile));
  if (options.new !== undefined || edits.length > 0 || options.saveToProfile) {
    io.err(`Saved ${file}. See its changes with: repotted plan --staged ${file}\n`);
  }
  const drafts = skippedDrafts(result.drafts);
  if (drafts.length > 0) {
    io.err(`Drafts of its profile, left out: ${drafts.map(describeSkipped).join(', ')}\n`);
  }
  return 0;
}

function printBatch(io: Io, batch: Batch): void {
  io.err(
    `Batch in ${batch.folder}, ${batch.profile === null ? 'from each repository as it is' : `from ${batch.profile}`}\n`,
  );
  for (const member of batch.members) {
    const notes = [member.left_out ? 'left out' : '', member.joined ? 'joined' : ''].filter(Boolean);
    io.out(`${member.repository}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}\n`);
  }
}

/** What `stage` does to a batch folder: start it, add, leave out or put back members, edit them, or discard it. */
interface BatchStageOptions extends StageOptions {
  readonly start: boolean;
  readonly repositories: readonly string[];
  readonly join: readonly string[];
  readonly stagedDir?: string | undefined;
  readonly repo?: string | undefined;
  readonly leaveOut: readonly string[];
  readonly putBack: readonly string[];
  readonly everywhere: boolean;
}

async function stageBatch(
  io: Io,
  folder: string,
  options: BatchStageOptions,
  edits: readonly StagedEdit[],
): Promise<number> {
  const membership =
    options.start || options.repositories.length > 0 || options.join.length > 0 || options.stagedDir !== undefined;
  const leaving = options.leaveOut.length > 0 || options.putBack.length > 0;
  if (options.repo !== undefined) {
    if (membership || leaving || options.everywhere) {
      throw new UsageError('--repo edits one repository of the batch, so it takes only the options of a staged apply.');
    }
    if (options.discard) {
      if (edits.length > 0 || options.saveToProfile || options.profile !== undefined) {
        throw new UsageError('--discard removes the staged apply, so it takes no other option.');
      }
      const result = await discardBatchMember(folder, options.repo);
      if (options.json) {
        json(io, { repository: options.repo, ...result });
        return 0;
      }
      io.err(
        result.discarded
          ? `Took ${options.repo} out of the batch and discarded its staged apply.\n`
          : `Took ${options.repo} out of the batch. Its staged apply joined the batch, so it stays in ${result.file}.\n`,
      );
      if (result.batch === null) {
        io.err('That was its last repository, so the batch ended.\n');
      } else {
        printBatch(io, result.batch);
      }
      return 0;
    }
    return stageFile(io, await batchMemberFile(folder, options.repo), options, edits);
  }
  if (options.discard) {
    if (
      membership ||
      leaving ||
      options.everywhere ||
      edits.length > 0 ||
      options.saveToProfile ||
      options.profile !== undefined
    ) {
      throw new UsageError('--discard removes the batch, so it takes no other option but --repo.');
    }
    await discardBatch(folder);
    if (options.json) {
      json(io, { discarded: path.resolve(folder) });
    } else {
      io.err(`Removed the batch in ${folder}. Staged applies that joined it stay.\n`);
    }
    return 0;
  }
  if (options.everywhere) {
    const [edit, ...more] = edits;
    if (
      edit === undefined ||
      !('exclude' in edit) ||
      more.length > 0 ||
      membership ||
      leaving ||
      options.saveToProfile ||
      options.profile !== undefined
    ) {
      throw new UsageError('--everywhere takes one --exclude or --include, and no other option.');
    }
    const result = await editEverywhere(folder, edit.exclude, edit.excluded);
    if (options.json) {
      json(io, { ...result.batch, changed: result.changed, refused: result.refused });
    } else {
      io.err(
        `${edit.excluded ? 'Excluded' : 'Included'} ${edit.exclude} in ${result.changed.length === 0 ? 'none' : result.changed.join(', ')}\n`,
      );
      for (const { repository, message } of result.refused) {
        io.err(`warning: ${repository} kept its staged apply as it is: ${message}\n`);
      }
    }
    // A repository that refused leaves the batch out of step, which a script should notice.
    return result.refused.length > 0 ? 1 : 0;
  }
  if (edits.length > 0 || options.saveToProfile) {
    throw new UsageError(
      'Name the repository to edit with --repo, or leave a value out of every repository with --exclude key --everywhere.',
    );
  }
  if (options.stagedDir !== undefined && options.repositories.length === 0) {
    throw new UsageError('--staged-dir says where new staged applies go, so it needs --new.');
  }
  let batch: Batch | undefined;
  const additions = {
    repositories: options.repositories,
    join: options.join,
    ...(options.stagedDir === undefined ? {} : { stagedFolder: options.stagedDir }),
  };
  if (options.start) {
    batch = await createBatch(folder, {
      ...additions,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
  } else if (options.profile !== undefined) {
    throw new UsageError("A batch's new repositories start from its profile, so --profile needs --batch.");
  } else if (membership) {
    batch = await addToBatch(folder, additions);
  }
  if (options.leaveOut.length > 0) {
    batch = await leaveOut(folder, options.leaveOut, true);
  }
  if (options.putBack.length > 0) {
    batch = await leaveOut(folder, options.putBack, false);
  }
  const changed = batch !== undefined;
  batch ??= await readBatch(folder);
  if (options.json) {
    json(io, batch);
    return 0;
  }
  printBatch(io, batch);
  if (changed) {
    io.err(`Saved the batch. See its changes with: repotted plan --staged ${folder}\n`);
  }
  return 0;
}

async function stage(io: Io, args: string[]): Promise<number> {
  const { positionals, values, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      new: { type: 'string', multiple: true },
      profile: { type: 'string', short: 'p' },
      set: { type: 'string', multiple: true },
      unset: { type: 'string', multiple: true },
      ruleset: { type: 'string', multiple: true },
      'drop-ruleset': { type: 'string', multiple: true },
      environment: { type: 'string', multiple: true },
      'drop-environment': { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      include: { type: 'string', multiple: true },
      'save-to-profile': { type: 'boolean' },
      discard: { type: 'boolean' },
      batch: { type: 'boolean' },
      join: { type: 'string', multiple: true },
      'staged-dir': { type: 'string' },
      repo: { type: 'string' },
      'leave-out': { type: 'string', multiple: true },
      'put-back': { type: 'string', multiple: true },
      everywhere: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const target = only(positionals, 'staged apply file or batch folder');
  const edits: StagedEdit[] = [
    ...profileEdits(tokens),
    ...tokens.flatMap((token) =>
      token.kind === 'option' && (token.name === 'exclude' || token.name === 'include')
        ? [{ exclude: token.value, excluded: token.name === 'exclude' }]
        : [],
    ),
  ];
  const repositories = values.new ?? [];
  const options = {
    profile: values.profile,
    saveToProfile: values['save-to-profile'] === true,
    discard: values.discard === true,
    json: values.json === true,
  };
  if (values.batch === true || (await isFolder(target))) {
    return stageBatch(
      io,
      target,
      {
        ...options,
        start: values.batch === true,
        repositories,
        join: values.join ?? [],
        stagedDir: values['staged-dir'],
        repo: values.repo,
        leaveOut: values['leave-out'] ?? [],
        putBack: values['put-back'] ?? [],
        everywhere: values.everywhere === true,
      },
      edits,
    );
  }
  const batchOnly = ['join', 'staged-dir', 'repo', 'leave-out', 'put-back', 'everywhere'] as const;
  const misplaced = batchOnly.find((name) => values[name] !== undefined);
  if (misplaced !== undefined) {
    throw new UsageError(`--${misplaced} is for a batch folder; start one with --batch.`);
  }
  if (repositories.length > 1) {
    throw new UsageError('A staged apply is for one repository; stage several as a batch, with --batch.');
  }
  return stageFile(io, target, { ...options, new: repositories[0] }, edits);
}

function schema(io: Io, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  if (values.json === true) {
    json(io, profileFileJsonSchema());
  } else {
    io.out(`${JSON.stringify(profileFileJsonSchema(), null, 2)}\n`);
  }
  return Promise.resolve(0);
}

async function repos(io: Io, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const list = await listRepositories(await io.github());
  if (values.json === true) {
    json(io, list);
    return 0;
  }
  for (const repository of list.repositories) {
    const notes = [repository.private ? 'private' : '', repository.archived ? 'archived' : ''].filter(Boolean);
    io.out(`${repository.full_name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}\n`);
  }
  if (list.repositories.length === 0) {
    io.err(
      list.source === 'installations'
        ? `The GitHub App is not installed on any repositories yet. Install it: ${installUrl}\n`
        : 'This token administers no repositories.\n',
    );
  }
  return 0;
}

/** Where to install the Repotted App on more repositories; null when another App signs in. */
function appInstallUrl(env: NodeJS.ProcessEnv): string | null {
  return usesRepottedApp(env) ? installUrl : null;
}

/** The token variable that is set and used before the sign-in, if any. */
function tokenVariable(env: NodeJS.ProcessEnv): string | null {
  return tokenVariables(env)[0] ?? null;
}

async function status(io: Io, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const signedOut = (
    reason: 'not_signed_in' | 'rejected',
    message: string,
    problems: readonly string[] = [],
  ): number => {
    if (values.json === true) {
      json(io, {
        signed_in: false,
        reason,
        message,
        problems,
        token_variable: tokenVariable(io.env),
        install_url: appInstallUrl(io.env),
      });
    } else {
      io.out(`${message}\n`);
    }
    return 1;
  };
  let user: Awaited<ReturnType<typeof currentUser>>;
  try {
    user = await currentUser(await io.github());
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return signedOut('not_signed_in', error.message, error.problems);
    }
    // GitHub rejects a revoked or mistyped token.
    if (error instanceof GitHubError && error.status === 401) {
      const variable = tokenVariable(io.env);
      return signedOut(
        'rejected',
        variable === null
          ? 'GitHub rejected the sign-in. Run repotted login again.'
          : `GitHub rejected the token in ${variable}.`,
      );
    }
    throw error;
  }
  const variable = tokenVariable(io.env);
  if (values.json === true) {
    json(io, {
      signed_in: true,
      login: user.login,
      name: user.name,
      token_variable: variable,
      install_url: appInstallUrl(io.env),
    });
  } else {
    io.out(`Signed in to GitHub as ${user.login}${variable === null ? '' : `, with ${variable}`}.\n`);
  }
  return 0;
}

async function login(io: Io, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const signIn = await io.signIn();
  if (values.json === true) {
    // JSON Lines: the code to show first, then the outcome once the user enters it.
    json(io, {
      event: 'code',
      verification_uri: signIn.code.verificationUri,
      user_code: signIn.code.userCode,
      expires_at: new Date(signIn.code.expiresAt).toISOString(),
    });
    try {
      await signIn.finished;
    } catch (error) {
      json(io, {
        event: 'error',
        error: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
      });
      return 1;
    }
    json(io, {
      event: 'signed_in',
      install_url: appInstallUrl(io.env),
      token_variable: tokenVariable(io.env),
    });
    return 0;
  }
  io.err(`To sign in to GitHub, ${enterCode(signIn.code)}.\n`);
  await signIn.finished;
  io.out(
    usesRepottedApp(io.env)
      ? `Signed in. Install the Repotted GitHub App on the repositories it should manage: ${installUrl}\n`
      : 'Signed in. Install your GitHub App on the repositories it should manage.\n',
  );
  const overrides = tokenVariables(io.env);
  if (overrides.length > 0) {
    io.err(`${overrides.join(' and ')} ${overrides.length === 1 ? 'is' : 'are'} set and used before this sign-in.\n`);
  }
  return 0;
}

async function logout(io: Io, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const removed = await io.signOut();
  if (values.json === true) {
    json(io, { removed });
  } else {
    io.out(removed ? 'Signed out.\n' : 'Not signed in.\n');
  }
  return 0;
}

async function mcp(io: Io, args: string[]): Promise<number> {
  const mcpToken = tokenOrSignIn();
  const { values } = parseArgs({ args, options: { 'read-only': { type: 'boolean' } } });
  // The server and its SDK load only for this command, so the others start
  // without evaluating them.
  const [{ createServer }, { StdioServerTransport }] = await Promise.all([
    import('./mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);
  const server = await createServer({
    version: io.version,
    github: async () => createGitHub(await mcpToken()),
    cwd: process.cwd(),
    readOnly: values['read-only'] === true,
  });
  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive until the client disconnects.
  return 0;
}

const commands: Record<string, (io: Io, args: string[]) => Promise<number>> = {
  capture,
  plan,
  apply,
  profiles,
  profile,
  stage,
  schema,
  sync,
  mcp,
  repos,
  status,
  login,
  logout,
};

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    io.out(`${usage}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === '-v' || command === '--version') {
    io.out(`${io.version}\n`);
    return 0;
  }
  const handler = commands[command];
  if (handler === undefined) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${usage}\n`);
    return 0;
  }
  return handler(io, rest);
}

/**
 * The JSON failure kind: misuse, a sign-in that is missing or that GitHub
 * refuses, or anything else, including a passing problem such as an
 * unreadable keychain, which the next try may not meet.
 */
function failureKind(error: unknown, misused: boolean): 'usage' | 'signed_out' | 'error' {
  if (misused) {
    return 'usage';
  }
  return (error instanceof NotSignedInError && error.lost) || (error instanceof GitHubError && error.status === 401)
    ? 'signed_out'
    : 'error';
}

/**
 * Runs one command and returns its exit code: 1 when it fails, 2 when it was
 * misused. With `--json`, a failure is a JSON document on stdout as well.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(io, argv);
  } catch (error) {
    // parseArgs reports unknown or malformed options with an ERR_PARSE_ARGS_* code.
    const misused =
      error instanceof UsageError ||
      (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
    const message = error instanceof Error ? error.message : String(error);
    // Also --json=true, which parseArgs rejects, so the rejection is JSON too.
    if (argv.some((arg) => /^--json(?:=|$)/.test(arg))) {
      json(io, { error: { kind: failureKind(error, misused), message } });
    } else {
      io.err(`repotted: ${message}\n${docsLink(error)}`);
      if (misused) {
        io.err('Run repotted --help for usage.\n');
      }
    }
    return misused ? 2 : 1;
  }
}
