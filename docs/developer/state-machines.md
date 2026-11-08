# State machines

Several parts of Repotted move through states that no type names: a sign-in,
a sync, an open profile, a running capture. This page lists each one, its
states and the transitions between them, and the failure states it can reach.
A failure that leaves the user worse off than the state they started from
links to the issue that tracks it.

## Token sources

Every command that talks to GitHub resolves a token in `resolveToken`
(`packages/cli/src/auth.ts`). The first source that yields a token wins.

| Step                                                                       | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Next                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GITHUB_TOKEN` or `GH_TOKEN` is set                                        | That token is used, unchecked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Done.                                                          |
| The keychain holds no sign-in                                              | No token from the keychain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The GitHub CLI.                                                |
| The keychain sign-in expires in more than 5 minutes, or never              | Its access token is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Done.                                                          |
| The sign-in is close to expiry and its refresh token is missing or expired | The problem "The Repotted sign-in expired." is kept. The sign-in is lost.                                                                                                                                                                                                                                                                                                                                                                                                                                      | The GitHub CLI.                                                |
| The sign-in is close to expiry and its refresh token is usable             | The token is refreshed and the result is stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done.                                                          |
| The refresh fails                                                          | The keychain is read again: another run may have used the refresh token first. A newer usable token there is used. When GitHub answered with an OAuth error, such as `bad_refresh_token`, the keychain is read once more after a second, since that run may still be storing its token, and otherwise the sign-in is lost. When GitHub was out of reach or failed on its side, the sign-in is kept for the next try. A keychain that can't be read for these looks leaves the refresh's own failure to report. | Done, or the GitHub CLI with the problem kept.                 |
| The refresh succeeds but the keychain refuses the new token                | The refresh token is spent, so the sign-in is lost although a valid token was in hand. The problem says the sign-in could not be refreshed.                                                                                                                                                                                                                                                                                                                                                                    | The GitHub CLI with the problem kept; the user signs in again. |
| The keychain can't be read                                                 | The problem is kept, and the sign-in with it for the next try, since the cause may pass, such as a dismissed unlock prompt.                                                                                                                                                                                                                                                                                                                                                                                    | The GitHub CLI.                                                |
| `gh auth token` prints a token                                             | That token is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Done.                                                          |
| Nothing yields a token                                                     | `NotSignedInError` with the kept problems. Its `lost` is false when a kept problem may pass.                                                                                                                                                                                                                                                                                                                                                                                                                   | `status` reports `not_signed_in`; other commands fail.         |

A token that resolves can still be refused: `status` reports a 401 from
GitHub as `rejected`, and names the token variable when one was used. With
`--json`, any other command that meets a 401, or a `NotSignedInError` whose
sign-in is lost, fails with `kind: signed_out`. One whose problem may pass
fails with `kind: error`, so the desktop app shows it on the page and stays
open. Each CLI the desktop app starts inherits the app's
environment, which is fixed at launch, so the app sees a changed variable only
after it restarts.

## Device flow

`repotted login`, and the desktop app's sign-in through it, run the GitHub
App device flow (`packages/cli/src/device-flow.ts`, `startSignIn` in
`auth.ts`).

| State                | Event                                    | Next                                                                                                   |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Start                | The keychain can't be read               | Fails with `KeychainError` before a code is shown, so the user never enters a code that can't be kept. |
| Start                | GitHub issues a device code              | Waiting for the user.                                                                                  |
| Waiting for the user | `authorization_pending`                  | Waiting, after the same interval.                                                                      |
| Waiting for the user | `slow_down`                              | Waiting, with the interval 5 seconds longer.                                                           |
| Waiting for the user | A token                                  | Storing.                                                                                               |
| Waiting for the user | Any other error, such as `access_denied` | Fails with GitHub's description.                                                                       |
| Waiting for the user | The code's expiry passes                 | Fails: "The sign-in code expired before it was entered."                                               |
| Storing              | The keychain stores it                   | Signed in.                                                                                             |
| Storing              | The keychain refuses it                  | Fails with `KeychainError`: the user signed in, but the token is lost.                                 |

## MCP sign-in

The MCP server can't prompt, so `tokenOrSignIn` in `auth.ts` turns a missing
token into a sign-in that finishes between tool calls.

| State           | Event                                              | Next                                                                                                                |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Idle            | A call resolves a token                            | Idle; concurrent calls share one lookup, so an expiring token is refreshed once.                                    |
| Idle            | `NotSignedInError`                                 | Sign-in pending: a device flow starts, and the call fails with its code.                                            |
| Sign-in pending | Another call, which finds no token                 | The same code again, from the same flow.                                                                            |
| Sign-in pending | The flow stores a token                            | Idle; the next call finds the token.                                                                                |
| Sign-in pending | The flow fails with `KeychainError`                | Keychain failed: every later call without a token fails with that error, since another code would end the same way. |
| Sign-in pending | The flow fails in another way                      | Idle; the next call starts a new flow and repeats the reason first.                                                 |
| Any             | The keychain can't be read when a flow would start | The call fails and nothing is remembered, so a passing problem clears itself.                                       |

A token set through `GITHUB_TOKEN` or the GitHub CLI still works in the
keychain-failed state, because the lookup runs before that state is checked.

## Desktop sign-in

`MainViewModel` picks the page from `repotted status --json`, and
`SignInViewModel` runs the device flow through `repotted login --json`.
Each app gets a `RepottedClient` of its own, which raises `SignInLost` when
any command fails with `kind: signed_out`. `MainViewModel` checks again in
response, on the UI thread, if that app is still the page. The app stays
while the check runs, and pages that fail meanwhile check nothing more, so
a run that loses a race to refresh the token, while another run stores the
new one, leaves the app and what it holds in place.

| State                                  | Event                                      | Next                                                                                                                             |
| -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Checking                               | Signed in                                  | The app, which refreshes the repositories and profiles.                                                                          |
| Checking                               | Signed out or rejected                     | Sign-in, with a notice for a rejected or unusable earlier sign-in.                                                               |
| Checking                               | The CLI is missing or fails                | Problem, with a retry that checks again.                                                                                         |
| Sign-in                                | Start                                      | Starting, then showing the code once the CLI prints it.                                                                          |
| Sign-in                                | The flow ends                              | Checking.                                                                                                                        |
| Sign-in                                | The flow fails                             | Sign-in, with the error.                                                                                                         |
| Sign-in                                | Cancel, or the app closes                  | Sign-in; the CLI process is stopped.                                                                                             |
| Sign-in, for a rejected token variable | Any                                        | Signing in stays off: the variable comes first, so the user must change it and reopen the app.                                   |
| The app                                | A command fails with `kind: signed_out`    | Checking the sign-in, with the app still showing.                                                                                |
| Checking the sign-in                   | A command fails with `kind: signed_out`    | Nothing more: the check already running answers for it.                                                                          |
| Checking the sign-in                   | Signed in as the same account              | The app, as it was; the page that failed shows its error.                                                                        |
| Checking the sign-in                   | The CLI is missing or fails                | The app, as it was; the page that failed shows its error.                                                                        |
| Checking the sign-in                   | Signed out or rejected                     | Asking to leave, to sign in again.                                                                                               |
| Checking the sign-in                   | Signed in as another account               | Asking to leave, to continue as that account.                                                                                    |
| Asking to leave                        | Nothing is unsaved                         | Sign-in, or the app for the other account, as from Checking.                                                                     |
| Asking to leave                        | Save or Discard goes on                    | Checking, again, since the answer can come long after the check.                                                                 |
| Asking to leave                        | Cancel, a failed save, or a newer question | The app, as it was; the next failure checks again.                                                                               |
| An app already replaced                | A command fails with `kind: signed_out`    | Nothing: the app showing now stays.                                                                                              |
| The app                                | Sign out, while no save or sync runs       | Asking to sign out, when a profile has unsaved changes; then Signing out: `repotted logout --json` removes the keychain sign-in. |
| Asking to sign out                     | Cancel, a failed save, or a newer question | The app, as it was.                                                                                                              |
| The app                                | Replaced, or the app closes                | A running capture and a connect's first sync stop, and clean up as when their form closes.                                       |
| The app                                | Replaced, while a save or sync runs        | The save or sync finishes and no sync follows it; the next app syncs only once it ends.                                          |
| Signing out                            | It succeeds                                | Checking.                                                                                                                        |
| Signing out                            | It fails                                   | Problem, with a retry that checks again.                                                                                         |

The app offers **Sign out** only for the Repotted sign-in: the list comes from
the App's installations and no token variable is set. A token variable or the
GitHub CLI's sign-in would still apply after signing out, so checking would
lead straight back to the app. **Sign out** is off while a save or a sync
runs, including the sync a save starts, since neither can be stopped
partway. A saved editor that a listing drops from the cache while the sync
after its save runs, such as when that sync pulled a file, no longer counts,
so **Sign out** comes back once that sync ends. Asking to leave and Asking to
sign out are the question in
[Leaving with unsaved changes](#leaving-with-unsaved-changes), on the
**Profiles** page.

## Plan and apply

`createPlan` only reads. `applyPlan` (`packages/core/src/plan.ts`) plans
again from the reviewed plan's profile and writes only when that yields the
same changes.

| State    | Event                  | Next                                                                                 |
| -------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Reviewed | The new plan differs   | Stale: `StalePlanError` carries the current plan, and nothing is written.            |
| Reviewed | The new plan matches   | Writing, change by change, from the new plan's requests.                             |
| Writing  | A request fails        | Partly applied: `ApplyError` lists the changes already made and the one that failed. |
| Writing  | Every request succeeds | Applied.                                                                             |

Partly applied is a state of the repository, not of the plan: nothing rolls
back the changes already made. Planning again from the same profile lists
only what still differs.

The CLI's `apply` needs `--yes` with `--json` or without a terminal. The MCP
server keeps plans in memory by `plan_id`. An apply takes its plan out before
it writes, so two calls with one id can't both apply it, and a stale or
failed apply needs a new plan. A sign-in failure comes before that, so it
keeps the plan.

## Drafts

A ruleset, environment, autolink, or setting in a profile file is a draft or
an entry that applies (`packages/core/src/profile.ts`). The marker lives in
the file, so the state is whatever the file says when it's read.

| State   | Event                                                     | Next                                                                                                          |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| None    | Saved with `draft: true`, or under `drafts`               | Draft. Only its name, or an autolink's prefix, is checked; its problems are warnings.                         |
| Draft   | Edited, valid or not                                      | Draft.                                                                                                        |
| Draft   | Finished: saved without the marker, and the profile valid | Applies, in place of the draft. The next plan includes it.                                                    |
| Draft   | Finished, but the profile would be invalid                | Draft: `editProfile` refuses, names the problem, and leaves the file as it was.                               |
| Draft   | Finished while the file has an entry of the same name     | Draft: `editProfile` refuses. Replacing the entry and dropping the draft, in one edit, finishes it.           |
| Draft   | Planned or applied                                        | Draft: left out of the changes and listed in `skipped`.                                                       |
| Draft   | A second draft of the same name in the same list          | The profile is invalid, as a duplicate entry makes it.                                                        |
| Applies | Saved with the marker                                     | Draft, unless the file already has a draft of that name. The profile stops naming it, as the note below says. |

Turning an entry into a draft doesn't delete it from GitHub. Like any entry a
profile stops naming, it keeps its current state there, unless a base profile
names an entry of that name, which then applies again.

## Staged apply

A staged apply is a file (`packages/core/src/staged.ts`); its state is the
file and the plan made from it. Each edit is checked whole before the file
changes, so every failed event below leaves the file as it was.

| State    | Event                                                                   | Next                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None     | Start in a new file                                                     | Staged, with no edits.                                                                                                                                                    |
| None     | Start where a file exists                                               | None: `createStagedApply` refuses, so a staged apply is never replaced.                                                                                                   |
| None     | Start from a profile that doesn't resolve                               | None: nothing is written.                                                                                                                                                 |
| None     | Start with edits that fail                                              | None: `stage --new` removes the file it started.                                                                                                                          |
| Staged   | An edit or exclusion                                                    | Staged, with the edit. The profile is checked once the exclusions are left out.                                                                                           |
| Staged   | An edit the profile makes invalid                                       | Staged as before: `editStagedApply` throws.                                                                                                                               |
| Staged   | An exclusion and an edit of the same value                              | Staged as before: the file check refuses it.                                                                                                                              |
| Staged   | An exclusion that names no section, setting, or entry                   | Staged as before.                                                                                                                                                         |
| Staged   | An exclusion that leaves nothing out of the profile                     | Staged as before: a mistyped name is refused.                                                                                                                             |
| Staged   | A draft, or an exclusion of `drafts`                                    | Staged as before: a staged apply holds no drafts, since all it sets applies.                                                                                              |
| Staged   | The profile it starts from changes                                      | Staged: it resolves over the new profile; a plan already made keeps the old one. An exclusion that now leaves nothing out is a warning.                                   |
| Staged   | Another program changes the file while it is shown, planned, or edited  | Staged: each of those reads the file once, so its result comes from one version of the file, never part of two. An edit's write replaces whatever was written in between. |
| Staged   | The profile it starts from stops resolving                              | Staged: showing and planning it fail until the profile is fixed; discarding still works.                                                                                  |
| Staged   | Plan                                                                    | Reviewed: a plan from the resolved profile, as in [Plan and apply](#plan-and-apply). The profile's drafts stay out, as in [Drafts](#drafts).                              |
| Staged   | Save edits to the profile                                               | Staged, with no edits and its exclusions; it resolves the same.                                                                                                           |
| Staged   | Save edits that another program changes before they are cleared         | Staged as the other program left it, and the profile with the edits: clearing them refuses, as when the second write fails.                                               |
| Staged   | Save edits that hold autolinks, or switch Pages between a site and none | Staged as before, and the profile as it was: `saveStagedEdits` refuses.                                                                                                   |
| Staged   | Save when it starts from the repository                                 | Staged as before: there is no profile to save to.                                                                                                                         |
| Staged   | Discard                                                                 | None: the file is removed, and the profile stays as it is.                                                                                                                |
| Reviewed | Apply                                                                   | As in [Plan and apply](#plan-and-apply): stale, partly applied, or applied.                                                                                               |

Applying does not end the staged apply: the file stays until it is
discarded, so a stale or partly applied apply can be planned again from it.

## Batch

A batch is a folder (`packages/core/src/batch.ts`) whose manifest lists one
staged apply for each repository; each member's own state is as in
[Staged apply](#staged-apply). The manifest has an id, so a batch started
again in the same folder is another batch. It is replaced whole on each
change, from one read of it; a change that finds the manifest changed since
that read starts over, though two programs writing at the same moment can
still lose one change.

| State    | Event                                                               | Next                                                                                                                                     |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| None     | Start                                                               | Staged: a new staged apply for each `--new` repository, each joined one as it is, then the manifest.                                     |
| None     | Start where a repository already has a staged apply                 | None: the staged applies it started are removed, and so is the folder if the start made it. `--join` adds the existing one.              |
| None     | Start where the folder holds a batch, or with a repository twice    | None: nothing is written, and a folder that was there stays.                                                                             |
| Staged   | Add, leave out, or put back a repository                            | Staged, with the manifest changed. A repository is in a batch once.                                                                      |
| Staged   | Exclude or include a key everywhere                                 | Staged: each member that sets the key changes; one that refuses keeps its staged apply and is named.                                     |
| Staged   | Plan                                                                | Reviewed: a plan for each member not left out, with the digest of its staged apply. A member that fails is a failure of its own.         |
| Reviewed | Edit a member's staged apply                                        | Reviewed, but that member's plan is not applied, since its file no longer has the reviewed digest; plan again.                           |
| Reviewed | Apply a member: applied, or planned again with no changes           | The member ends its staged apply and leaves the batch, if the batch still lists it and its file still has the reviewed digest.           |
| Reviewed | Apply a member: stale, failed partway, or failed                    | The member stays, to plan again. The next member is applied, unless `--stop-on-failure` stops the rest.                                  |
| Reviewed | Apply a member that is locked, edited, or left out since the review | The member stays, and nothing is written to it.                                                                                          |
| Reviewed | Apply after the batch ended, moved, or started again                | Nothing is written: each member is left out.                                                                                             |
| Reviewed | The manifest can't be read partway                                  | The member being applied fails with nothing written; the results so far stand.                                                           |
| Reviewed | The last member leaves                                              | None: the manifest is removed, and the folder if nothing else is in it.                                                                  |
| Staged   | Take a member out                                                   | Staged without it; a staged apply it started is discarded, a joined one stays. With the last one, None.                                  |
| Staged   | Discard                                                             | None: the staged applies the batch started are discarded; joined ones stay as they were. A listed file that isn't its member's stops it. |

## Desktop apply

The Apply page (`ApplyViewModel`) drives one staged apply per repository,
kept at `staged/<owner>/<name>.yaml` in the app data folder with its reviewed
plan beside it as `<name>.plan.json`. Leaving the page keeps the file, so an
apply left unfinished is offered again. A change runs with `Working` set, and
no other change, apply or discard starts until it ends.

| State                                     | Event                                         | Next                                                                                                                         |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Starting                                  | No staged file for the repository             | Planning, after `stage --new`, from the chosen profile or from the repository as it is.                                      |
| Starting                                  | A staged file is there                        | Unfinished, naming what it starts from; one the CLI can't read can still be started over.                                    |
| Starting                                  | `stage --new` fails                           | Failed, with the CLI's message; with no staged file there is nothing to review or discard.                                   |
| Unfinished                                | Resume                                        | Planning, from the file as it is.                                                                                            |
| Unfinished                                | Start over                                    | Starting: the file and its plan are removed, and a new one starts from the chosen profile.                                   |
| Planning                                  | `plan --staged` succeeds                      | Reviewing, with each row's exclusion key, and the one-off edits' diff rebuilt from this plan with its folds closed.          |
| Planning                                  | `plan --staged` fails                         | Failed; Review again plans once more, and Discard apply is offered while the staged file is there.                           |
| Reviewing                                 | Leave out, Put back, or Save edits to profile | Working, then Planning; a refused change keeps the review as it was and shows why.                                           |
| Working                                   | The change succeeds                           | Planning, with the one-off edits showing the staged apply the change returns, which is not read again.                       |
| Reviewing, Confirming, Confirming discard | Save the one-off edits                        | Planning, since the edits change the plan; a plan reviewed before the save is never applied.                                 |
| Reviewing                                 | One-off edits not saved yet                   | Reviewing, with Apply, leaving out, saving to the profile and leaving the page held until saved or undone.                   |
| Reviewing                                 | Apply, with a locked change                   | Reviewing: Apply stays held until each change the locks say GitHub refuses is left out or planned again with access.         |
| Reviewing                                 | Apply, with changes to make and none locked   | Confirming. The one-off edits can change only in Reviewing, so none waits under a plan about to be applied.                  |
| Confirming                                | Cancel                                        | Reviewing; nothing is written.                                                                                               |
| Confirming                                | Apply now                                     | Applying: `apply --yes` on the reviewed plan file. It waits while the edits are read or saved.                               |
| Applying                                  | Every change written                          | Applied: the staged file and plan are removed. A failed removal leaves the file, to be offered again.                        |
| Applying                                  | The repository changed since the review       | Stale: nothing was written. Review again plans from the file.                                                                |
| Applying                                  | A write fails partway                         | Partly applied: the outcome counts what was written and names what failed. Review again shows the rest.                      |
| Applying                                  | Any other failure                             | Failed, warning that some changes may already be on GitHub.                                                                  |
| Reviewing, Stale, Partly applied, Failed  | Discard apply, with the staged file there     | Confirming discard, which shows the review behind it while it asks. Held while a change runs or the edits are read or saved. |
| Confirming discard                        | Keep it                                       | The state it came from.                                                                                                      |
| Confirming discard                        | Discard apply                                 | Discarded: the file and plan are removed and the page closes. A refused discard returns with the error.                      |

For that, the text of each file under the one-off edits is read before the
change, so a file it doesn't write that changes meanwhile, such as the profile
under a sync, still stops a save over it. The staged file, which every change
writes and only the page does, is read after the change, and so is the profile
that **Save edits to profile** writes, within the write.

Leaving the page, whether by Back to repositories, by choosing Repositories in
the sidebar again, or by closing the window, signing out or a lost sign-in,
goes by `CanLeave`: not while a change, a plan or an apply runs, nor while the
one-off edits are read, saved or unsaved. A discarded apply can always leave.
Choosing Profiles in the sidebar shows that page and leaves the apply open
behind it, to come back to.

| When leaving                                            | What happens                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The page can close                                      | It closes; an unfinished staged apply stays to resume.                                                        |
| A run is going, or the edits are read or saved          | The page shows itself, says the act waits until Repotted is done, and stays. The note goes when the run ends. |
| The same, for a lost sign-in                            | The check waits for the run to end, then goes on as below, since the app can't leave a run partway.           |
| One-off edits are unsaved                               | The page shows its edits and asks to save or undo them first.                                                 |
| Asking, and the edits are saved                         | The saved edits are planned again, then the act goes on, so the page never stays behind with an old plan.     |
| Asking, and the edits are undone or the apply discarded | The act goes on.                                                                                              |
| Asking, and Stay here, or another act asks              | The act is put aside and the edits stay as they are; a later question replaces an open one.                   |

Unsaved profile changes on the Profiles page are asked about after the apply.
A lost sign-in that asked either question checks the sign-in again once it is
answered. Opening another apply while one is open does nothing.

## Config repository sync

`syncFolder` (`packages/core/src/sync.ts`) brings a folder and a folder in a
repository in line, file by file, against the blob ids in
`.repotted-sync.json`. Only `.yaml` and `.yml` files sync, and a file or
folder whose name starts with a dot stays out on both sides. So the
temporary files that a pull, a save or a capture writes never reach a commit.

### The record

| State      | When                                                                                     | Effect                                                                                |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| None       | No record, or the repository has another id than the record names                        | First sync: nothing is deleted on either side, and a file that differs is a conflict. |
| Kept       | The branch's history holds the recorded commit                                           | Three-way merge against the record.                                                   |
| Reset      | The history doesn't hold that commit, such as after a force push or a new default branch | The pass runs as a first sync. The file keeps the old record until a pass records.    |
| Refused    | The folder already syncs with another repository or path                                 | `SyncError`; the folder is left alone.                                                |
| Unreadable | `.repotted-sync.json` isn't a sync record                                                | Every sync fails until the file is fixed or removed.                                  |

### Each file

`decide(base, local, remote)` compares blob ids, where a missing file has
none.

| Local and remote | Local is base | Remote is base | Action                                      |
| ---------------- | ------------- | -------------- | ------------------------------------------- |
| Equal            | Any           | Any            | Same; the record takes that id.             |
| Differ           | Yes           | No             | Pull, including a delete.                   |
| Differ           | No            | Yes            | Push, including a delete.                   |
| Differ           | No            | No             | Conflict, unless `prefer` settles the file. |

A pull checks the file again just before it writes. A file that changed since
the pass read it, such as by a save, stays as it is and joins the conflicts.

### The pass

| State      | Event                                            | Next                                                                |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Pass       | Nothing to push                                  | Recorded: the record is written and the result returned.            |
| Pass       | Files to push, and the branch has commits        | One commit with every push, then a fast-forward of the branch.      |
| Pass       | Files to push, and the repository has no commits | The first file goes up through the contents API, then another pass. |
| Committing | The branch moved                                 | Another pass, which starts from both sides as they are now.         |
| Committing | GitHub refuses, such as for a ruleset            | `SyncError` that says what to change.                               |
| Pass       | The fourth pass ends without recording           | `SyncError`: the repository kept changing.                          |

The record is written only when a pass records, so a failed sync leaves the
last good record in place and the next sync starts from it.

## Desktop profiles source

`ProfileFolder` keeps the profiles folder, the config repository if there is
one, and the sync state the page shows. `ProfilesViewModel` holds one, and the
Apply page and the new profile form write through the same one.

| State        | Event                                              | Next                                                        |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| Local folder | Refresh                                            | The folder is listed.                                       |
| Connected    | Refresh                                            | Syncing, then listed.                                       |
| Connected    | A save                                             | Syncing, then listed again when the sync pulled anything.   |
| Syncing      | It records                                         | In sync, or conflicts when any file changed on both sides.  |
| Syncing      | It fails                                           | Not synced: saves stay on this computer until a sync works. |
| Conflicts    | Keep this computer's or GitHub's version           | Syncing, with `prefer` for those files only.                |
| Any          | Choose another folder, which leaves any repository | Local folder, listed from the start.                        |
| Any          | Connect another repository                         | Connecting, through the connect form below.                 |
| Any          | The app is replaced                                | Stopped: a save under way finishes, and no sync starts.     |

Saves to the folder and syncs of it take turns in one `SerialQueue` in
`ProfileFolder` (`WriteAsync` and `SyncAsync`), so a sync never reads a file a
save is writing. A profile editor's save writes through its `ProfileStore`,
which `ProfileStore.Profile` gives the folder's `WriteAsync`; saving one-off
edits to the profile on the Apply page and the new profile form's move of a
capture write through the folder itself. Some writes and syncs run outside the
queue:

- The connect form's first sync.
- The new profile form's empty start and its start that extends another
  profile, which create the file only if no file has that name.
- A capture's read of GitHub, which writes a dot-prefixed file that no sync
  reads. Only the move of the finished capture to the profile's name joins the
  queue, and the profile syncs once it is whole, as the
  [New profile form](#new-profile-form) describes.

## Profile editor

Each open profile is a `ProfileViewModel`, and `ProfilesViewModel` keeps one
per file in a cache.

### The profile

| State       | Event                         | Next                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading     | The CLI resolves the file     | Saved.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Loading     | It fails                      | Error.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Saved       | Any edit                      | Changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Changed     | Discard                       | Saved.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Changed     | Save                          | Out of date when a file changed since the editor read it under an edited ruleset or environment. Otherwise saving: settings through `--set` and `--unset`, then their drafts as `drafts.<section>.<key>`, each draft written before any is taken out; entries whole through `--ruleset` and `--environment`, and taken-out entries through `--drop-ruleset` and `--drop-environment`, or `--drop-draft-ruleset` and `--drop-draft-environment` for a draft. |
| Saving      | It succeeds                   | Saved, then a sync for a config repository.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Saving      | It fails                      | Changed, with the error.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Out of date | Keep mine                     | Saving, over the change to the file.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Out of date | Reload                        | Loading, without the unsaved edits.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Out of date | Discard                       | Saved, as the editor read the file; the next refresh loads the file again.                                                                                                                                                                                                                                                                                                                                                                                  |
| Changed     | Save, with the file gone      | Removed, without saving; the list shows it as removed.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Removed     | Save                          | Saving, after the text the editor read is written back as a new file. If the save stops or fails, that file is deleted again and the editor stays Removed. A file already back is never deleted: the save takes it as listed first, as below.                                                                                                                                                                                                               |
| Removed     | Discard, or every edit undone | Gone from the cache and the list.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Removed     | A refresh lists the file      | Changed, when the file is back as the editor read it. Out of date for any edit, settings too, when it came back as something else, such as a new profile of the same name.                                                                                                                                                                                                                                                                                  |

### Each setting

A `SettingViewModel` is one row of a settings tab. Its value comes from the
profile, a base profile, or neither; a change waits until the profile is
saved. A field marked `EmptyIsNull`, a runner label, saves an empty box as
`null` and shows a `null` as an empty box, so leaving it empty is no change.

| State              | Event                                               | Next                                                                                                                                                               |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved              | Choose a value, or type a valid one                 | Changed. Typing back the text the box started with, or choosing the value this profile itself saved, is Saved instead.                                             |
| Saved, set here    | Remove                                              | Changed, to leave the value out; a base profile's value then applies.                                                                                              |
| Saved or changed   | Type text that isn't a valid value                  | Invalid: the value is as saved, the box keeps the text and says why. It counts as an unsaved change, and the profile can't be saved until it is fixed.             |
| Invalid            | Type a valid value                                  | Changed, or Saved when it is the value the row started with.                                                                                                       |
| Changed or invalid | Undo, or Discard on the profile                     | Saved, with the box showing the saved value.                                                                                                                       |
| Any, in a section  | A setting that must stand alone there is set        | Each other setting this profile's file would hold there is left out: removed when set here, undone when only changed. Pages' `absent` is such a setting.           |
| Any, in a section  | Another setting is set beside one that stands alone | The setting that stands alone is left out the same way, since the CLI refuses a file that holds both. Undoing one side doesn't bring the other back; Discard does. |
| Any                | The setting that turns it off shows that value      | Off, as a runner label is with standard runners: the box can't be typed in but keeps its value, rail and way back. On once that setting has another value or none. |

### Settings search

The profile editor's search and its **Managed**, **Not saved yet** and
**Drafts** filters
live on `ProfileViewModel`; `SettingSearch` holds the text each setting is
found by, built once from `ProfileFields`. The result rows are made once for
each load of the profile, the first time a search or filter is on; a search
then shows and hides them, and one that finds the same changes nothing.

| State   | Event                                      | Next                                                                                                                                |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tabs    | Type a search, or turn on a filter         | Results: the settings that fit, across every settings tab, with a matched sub-option's setting shown above it. The tabs are hidden. |
| Results | Change the search or a filter              | Results, found again; Tabs when the search is blank and every filter is off.                                                        |
| Results | Edit, undo or remove a setting, or Discard | Results, unchanged: a row that no longer fits stays until the search or a filter changes, so it doesn't vanish while being edited.  |
| Results | The profile loads, reloads or saves        | Results, found again among the new rows.                                                                                            |
| Results | Escape in the search box                   | The search is cleared: Results while a filter is on, otherwise Tabs.                                                                |
| Results | **Clear**                                  | Tabs, with the search cleared and every filter off.                                                                                 |

The compare view's search and its **Differs from GitHub** and **Can't
change** filters live on `CompareViewModel` and each
`CompareSectionViewModel`. A row is shown when it differs (or that filter is
off), is locked (or that filter is off), and matches every word searched.
While a search or **Can't change** is on, a section with no row shown is
hidden, unless Repotted couldn't read it and the search finds its title; the
view says so when a search finds nothing. A section's rows are replaced only
when what it shows changes. **Can't change** is offered only while a difference is locked, so
loading a comparison with nothing locked turns it off. Loading a comparison
finds again with the current search and filters.

### Each ruleset or environment

| State                                     | Event                                                             | Next                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved                                     | Edit                                                              | Changed; a changed name on an entry this profile owns is a rename.                                                                                                                                                                                                        |
| Saved, set in this profile                | Draft turned on or off                                            | Changed. It is a move, saved as a rename is: a drop from the drafts or the entries, then a write to the other. A draft's fields aren't checked; turning it off checks them. A draft of an override leaves the base profile's entry applying, so the tab's count keeps it. |
| Saved, from a base profile                | Draft turned on or off                                            | Can't happen: the box is off, since a base's entry or draft is that file's to change.                                                                                                                                                                                     |
| Saved draft, set in this profile          | Finished under the name of an entry that applies and isn't edited | Changed, and that entry is shown as replaced and left out of the count. This file's own entry takes the draft's content in place, saved as a write over it and a drop of the draft; a base's is overridden.                                                               |
| New                                       | Discard                                                           | Gone from the list.                                                                                                                                                                                                                                                       |
| Saved or changed, and set in this profile | Take out of profile                                               | Dropped. An entry from a base profile can't be taken out here.                                                                                                                                                                                                            |
| Dropped                                   | Put back                                                          | Saved, as the profile has it.                                                                                                                                                                                                                                             |
| Any                                       | Save                                                              | Plain writes go first, then drops, then each rename as a drop and a write, since the CLI reads a write right after a drop as a rename. A draft that replaces this file's entry is a plain write and a drop.                                                               |

A draft can share its name with an entry, but not with another draft. A
draft that is finished may take the name of an entry that applies and isn't
being edited, which it then replaces: this file's own in place, and a base's
as any override does. The editor shows the profile's draft warnings, what
each draft still needs, as the profile was last read or saved.

An editor builds the entry it saves from the copy it loaded, so saving writes
the whole entry as that copy plus the edits. That is why a save checks the
files first: it compares each with the text the editor read when it loaded or
last saved, and stops at Out of date when one differs. The profile's own file
counts for any edited entry, and each file it extends counts for an edited
entry it inherits, which the save writes whole as an override. The check runs
in the save's turn after any sync ahead of it, and Save, Keep mine, Reload,
and Discard wait while the editor loads.

### Each setting's draft

A setting row holds its value and, apart from it, a draft
(`SettingViewModel`). Only this profile's own draft can be finished or
discarded; a base's shows, read-only.

| State                   | Event                             | Next                                                                         |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| No draft, value changed | Save as draft                     | A draft of the chosen value; the value goes back to what the profile saves.  |
| Own draft               | Finish draft                      | No draft, and the value changed to the draft's, so it applies once saved.    |
| Own draft               | Discard draft                     | No draft, and a base's draft of the setting, if any, shows again, read-only. |
| Any draft               | Choose, type, or remove the value | The draft stays as it is; only the value changes.                            |
| Any                     | Undo                              | The value and the draft both as the profile saves them.                      |

### The base

Each editor keeps the base it last resolved alone, the profile its file
extends, with the text of each file that base resolves from. The text is the
copy the editor read for its own load or save, so it is what the stale-file
check compares against too. A change on the Apply page that shows the edits
it returned counts as a load here.

| State     | Event                                                               | Next                                                                      |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| None kept | A load or save of a profile that extends one                        | Kept: `profile <base>` resolves it, with the text of each file it reads.  |
| Kept      | A load or save, with the same chain and each file reading as it did | Kept, with no run.                                                        |
| Kept      | A load or save, with another chain or a file that reads otherwise   | Kept again, resolved anew, such as after a sync changed the base.         |
| Any       | The base is not a valid profile by itself                           | None kept, and the editor shows no base values; the next one tries again. |

### The cache

| State                | Event                           | Next                                                                                            |
| -------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cached, no changes   | A refresh lists the file        | Dropped from the cache, so the next open loads the file again.                                  |
| Cached, with changes | A refresh lists the file        | Kept as it is, with its loaded copy, and Out of date when a file under an edited entry changed. |
| Cached, no changes   | A refresh doesn't list the file | Dropped from the cache.                                                                         |
| Cached, with changes | A refresh doesn't list the file | Removed, and listed with a note that its edits aren't saved.                                    |
| Cached               | Another folder or repository    | Dropped from the cache.                                                                         |

A refresh never makes a Removed editor Out of date. A save can, when a file it
extends changed under an edited inherited entry: the put-back file is deleted
again, and the choice offers only Keep mine, since there is no file to reload.
A rename by a sync shows as the old file removed and the new one listed, so a
save brings the old name back beside the new one.

### Leaving with unsaved changes

Changing the folder, connecting or changing the repository, closing the
window, signing out, and a lost sign-in that would replace the app go through
`ProfilesViewModel.ConfirmLeaveAsync`, which asks only when a cached editor
has unsaved changes. Closing the window, signing out, and a lost sign-in show
the **Profiles** page first, through `ShellViewModel.ConfirmLeaveAsync`.
Closing the window cancels the close and closes again once the question
settles.

| State            | Event                                                                              | Next                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle             | Change folder, connect a repository, close the window, sign out, or a lost sign-in | Asking, when any editor has unsaved changes. Otherwise it goes on. The question names the profiles that had unsaved changes when it was asked.                                                                                                                                                                                               |
| Asking           | Save                                                                               | Saving: each changed editor saves in turn, and Save, Discard and Cancel wait until the saves end.                                                                                                                                                                                                                                            |
| Saving           | Every save ends                                                                    | It goes on when no editor has changes left; otherwise it opens the first one that does, with its error, its Out of date choice, or that its file is gone, even when a search hides it, and stays.                                                                                                                                            |
| Asking           | Discard                                                                            | Every changed editor that can discard does. It goes on when none has changes left; an editor still loading keeps its changes, opens, and it stays.                                                                                                                                                                                           |
| Saving or asking | A save failed, or an editor still loading kept its changes, while a capture runs   | It stays, but opens nothing, since that would close the new profile form and stop its capture. A notice names the profile and why, such as "orgs could not be saved, so you cannot change the folder yet.", over any notice already showing. It goes once that profile opens or a way out asks again, and the notice it covered shows again. |
| Asking           | Cancel                                                                             | Idle, with nothing changed. A new profile form that was open stays open.                                                                                                                                                                                                                                                                     |
| Asking           | Another change of folder, connect, or close                                        | Asking, about the new act. The earlier one stays where it was, as if cancelled.                                                                                                                                                                                                                                                              |

The folder is picked before the question, so cancelling the folder picker asks
nothing.

## New profile form

`NewProfileViewModel` never replaces a file already in the folder. It reads
the name once, when Create is pressed, and the name and what the profile
starts from can't change while it works. A capture writes a file of its own,
`.<name>.yaml.<random>.repotted-capture`, which is dot-prefixed and not a
`.yaml` file, so neither a sync nor the list reads it, and two copies of the
app capturing one name never share it. The profile takes its name only once
the capture is whole. `ProfilesViewModel` keeps the names of the captures
still running, in open and closed forms alike, and those names are held
against every other form until each capture ends.

The move to the profile's name runs in the queue that keeps saves and syncs
apart, after any sync under way, so a pull can't write that name between the
check and the move. On macOS and Linux, .NET's move that doesn't overwrite
checks for the file and then renames, so it can still replace a file of that
name that another program writes at that moment; on Windows the move refuses
it.

| State                      | Event                                                                                            | Next                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing                    | Create                                                                                           | Checks the name again, since the folder may have changed. A file of that name, or another capture running, refuses it.                                                                 |
| Creating, empty or extends | The file is written                                                                              | Created; the list opens it.                                                                                                                                                            |
| Creating, capture          | Start                                                                                            | Holding: `repotted capture --output` writes the capture's file.                                                                                                                        |
| Holding                    | The capture ends                                                                                 | Placing, once any save or sync under way ends; no sync starts until it does.                                                                                                           |
| Placing                    | The name is free                                                                                 | The capture's file moves to the profile's name: Created, and the name is no longer held.                                                                                               |
| Placing                    | A file of that name came in meanwhile                                                            | Editing, with "is already in this folder"; the file that came in stays, and the capture's file is removed.                                                                             |
| Holding                    | The capture fails                                                                                | Editing, with the error; the capture's file is removed.                                                                                                                                |
| Holding or placing         | The form closes                                                                                  | The capture is stopped, or its move skipped, and its file removed, also when the app is left.                                                                                          |
| Holding                    | Another folder, a repository, signing out, a lost sign-in or quitting asks about unsaved changes | The capture runs on while the question waits, and still makes its profile in the folder it started in. Going on closes the form; a question that can't settle keeps it, with a notice. |
| Any end of a capture       | Its file can't be removed, such as when the folder is gone                                       | The name is no longer held and the form is editable again; the file stays, as when the app quits.                                                                                      |
| Holding                    | The app quits                                                                                    | The capture's file may stay behind. It holds no name, and no later capture writes to it, so it stays until it is deleted.                                                              |

## Connect form

`ConfigRepositoryViewModel` starts a working copy for a repository and folder.

| State   | Event           | Next                                                                                                           |
| ------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| Editing | Connect         | Copies the local profiles over if asked, skipping names already there, then syncs.                             |
| Syncing | It records      | Connected; the app remembers the repository.                                                                   |
| Syncing | It fails        | Editing, with the error; a working copy that never synced is removed, and otherwise only the copied files are. |
| Syncing | The form closes | The sync is stopped and cleaned up the same way, with no error shown; also when the app is left.               |

## CLI runs

`RepottedCli` runs the bundled CLI once per call, with stdin closed so it
can't wait for input.

| State    | Event                  | Next                                                                                                                                                       |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting | The CLI can't be found | `CliNotFoundException`.                                                                                                                                    |
| Running  | It exits               | Its exit code and output; a failure's JSON `error.message` becomes a `CliException`, or a `SignInLostException` after `SignInLost` for `kind: signed_out`. |
| Running  | Cancelled              | The process tree is stopped.                                                                                                                               |

Only the sign-in, captures and the connect form pass a cancellation token.
Other calls run until the CLI exits, which every command does on its own.

## CLI releases

`.github/workflows/publish.yml` publishes the CLI, as
[Releasing](releasing.md#the-cli) describes. Every published release starts a
run, and every run joins one concurrency group, so a run holds the group from
its start to its end, including the wait for the `npm` approval. Runs for
desktop releases and prereleases wait their turn too, then skip every job.

| State                | Event                               | Next                                                                                                                                                                              |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued               | The run before it ends              | Verifying, in the order the releases were published.                                                                                                                              |
| Queued               | 100 runs are already waiting        | The new run is cancelled, and its version isn't published.                                                                                                                        |
| Verifying            | A check of the release fails        | Failed. Nothing is published, and the next queued run starts.                                                                                                                     |
| Verifying            | The checks pass                     | Waiting for approval.                                                                                                                                                             |
| Waiting for approval | The owner approves                  | Publishing.                                                                                                                                                                       |
| Waiting for approval | The owner rejects, or the wait ends | Failed. Nothing is published, and the next queued run starts.                                                                                                                     |
| Publishing           | npm accepts the tarball             | Published.                                                                                                                                                                        |
| Publishing           | npm refuses it                      | Failed. Re-running the failed job waits its turn and the approval again, then publishes the verified tarball, which lasts 3 days; after that, re-running all jobs verifies again. |

## Desktop releases

`.github/workflows/desktop.yml` packages the app, as
[Releasing](releasing.md#the-desktop-app) describes. Three states matter when a
run fails. Re-running a failed job reuses the run's packages, which last 3
days; after that, re-running all jobs builds, signs, and attests them again.

| State    | Event                 | Next                                                                                                                    |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Packaged | A platform fails      | No attestation or upload; re-running the failed job continues the same tag, and the attestation and upload then follow. |
| Packaged | The attestation fails | No upload; re-running the failed job attests the same packages, and the upload then creates the draft.                  |
| Attested | The upload fails      | Re-running the failed job attaches the attested packages, replacing any files the first try left on the draft.          |
| Draft    | The owner publishes   | Released. A published release is immutable, so a fix needs the next version's tag.                                      |
