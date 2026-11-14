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

## Web sign-in

The web app signs in through its Worker (`packages/web/src/worker.ts`), and
each tab asks it for the access token through a `Session`
(`packages/web/src/session.ts`). [The web app](web-app.md#sign-in) explains the
cookies. All tabs share the access token the access cookie keeps, since each
refresh revokes the one before.

| State      | Event                                                                  | Next                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed out | The user presses **Sign in with GitHub**                               | On GitHub, with the state and verifier in the sign-in cookie for 10 minutes. Starting again, in this tab or another, replaces them.                                                  |
| On GitHub  | The user cancels                                                       | Signed out with "The sign-in was cancelled on GitHub."; the sign-in cookie is cleared.                                                                                               |
| On GitHub  | GitHub returns any other error, such as an unlisted callback URL       | Signed out with "GitHub didn't complete the sign-in."; GitHub's token endpoint isn't called.                                                                                         |
| On GitHub  | The callback's state doesn't match, or the cookie is gone              | Signed out with "That sign-in expired."; GitHub isn't called. A sign-in that another start replaced ends here.                                                                       |
| On GitHub  | GitHub refuses the code, or answers without a refresh token            | Signed out with "GitHub didn't complete the sign-in."; no token cookie is set.                                                                                                       |
| On GitHub  | GitHub is out of reach, too slow, or fails on its side                 | The same.                                                                                                                                                                            |
| On GitHub  | GitHub issues tokens                                                   | Signed in: the cookies hold the refresh token and the access token, and the sign-in cookie is cleared.                                                                               |
| Signed in  | A tab needs a token and holds one with over 5 minutes left             | That token is used.                                                                                                                                                                  |
| Signed in  | A tab needs a token and holds none, or one closer to expiry            | Under the site-wide lock, the tab asks the Worker, which returns the kept access token if it has over 5 minutes left. A call in the same tab that waited uses what it got.           |
| Signed in  | The kept access token has 5 minutes or less left, or is gone           | Refreshing.                                                                                                                                                                          |
| Signed in  | GitHub's API refuses a tab's token                                     | The tab names that token to the Worker under the lock. If the kept token differs, another tab replaced it, and the tab gets the new one; if not, Refreshing. It tries once more.     |
| Signed in  | GitHub's API refuses the token from that second try too                | The page reads the sign-in as signed out and offers to sign in again.                                                                                                                |
| Refreshing | GitHub issues tokens                                                   | Signed in with both new tokens in the cookies; GitHub has revoked the old access token.                                                                                              |
| Refreshing | No refresh cookie, or GitHub refuses the refresh token                 | Signed out in this tab. The cookies are left as they are, since another tab may have stored newer ones; a spent or revoked token is refused again until it expires.                  |
| Refreshing | GitHub, or the Worker, is out of reach, too slow, or fails on its side | The tab keeps the token it held, near or past expiry, and reports that GitHub can't be reached; the cookies are kept for the next try.                                               |
| Signed in  | The user signs out                                                     | Signed out: under the lock, the Worker clears both token cookies, so a refresh that another tab started can't store tokens afterwards. Other tabs keep their token until it expires. |
| Signed in  | The refresh token's 6 months pass                                      | The browser drops the cookie; the next refresh reads as signed out.                                                                                                                  |

## Web account

`Account` (`packages/web/src/app/account.ts`) holds who is signed in to the
tab. The app draws the sign-in page in every state but Signed in.

| State       | Event                                                    | Next                                                                                                 |
| ----------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Checking    | GitHub names the user                                    | Signed in.                                                                                           |
| Checking    | The browser isn't signed in, or GitHub refuses the token | Signed out, with why the sign-in failed when the Worker's redirect gave a reason.                    |
| Checking    | GitHub or the Worker can't be reached                    | Unreachable, with **Try again**.                                                                     |
| Unreachable | Try again                                                | Checking.                                                                                            |
| Signed in   | Any request in the app gets a 401                        | Signed out with "GitHub no longer accepts this sign-in."; what the page held goes with it.           |
| Signed out  | A request that was under way gets a 401                  | Signed out, with what it already said.                                                               |
| Signed in   | Sign out                                                 | Signing out: **Sign out** is off, and a second press sends nothing.                                  |
| Signing out | The Worker clears the cookies                            | Signed out with "Signed out."                                                                        |
| Signing out | The Worker can't be reached or fails                     | Signed in, with "Signing out didn't finish. Try again." in the account menu until the next sign-out. |

## Web repositories

`Repositories` (`packages/web/src/app/repositories.ts`) holds the repository
list for one sign-in.

| State                 | Event                                           | Next                                                                                             |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No list               | The page opens                                  | Reading, with "Reading your repositories…".                                                      |
| Reading               | GitHub answers                                  | The list, grouped by owner. A selected repository stays selected when the new list still has it. |
| Reading               | Refresh                                         | Nothing: the read under way finishes, and the button is off.                                     |
| Reading               | The read fails                                  | The list it had, if any, with why above it.                                                      |
| Reading               | GitHub answers 401                              | The account is signed out, as above.                                                             |
| A list                | Refresh                                         | Reading, with the list dimmed and in use.                                                        |
| A repository selected | A search or a hidden owner takes it out of view | Its panel closes. It is selected again when it comes back into view.                             |

It keeps the owners the list hides, by login, under `hidden-repository-owners`
in the browser's [preferences](web-app.md#the-app), or nothing when it hides
no owner. A hidden owner matches its login in any case. Keeping the hidden
owners rather than the shown ones means an owner new to the list shows.

| Hidden                  | Event                                            | Next                                                                                           |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| None                    | An owner is unticked                             | That owner, saved.                                                                             |
| Any                     | Only personal                                    | Every owner in the list but the signed-in account, saved.                                      |
| Any                     | Show all                                         | None, saved as nothing.                                                                        |
| Some owners             | The list is read again                           | The hidden owners in the list stay hidden; an owner new to it shows.                           |
| An owner not in list    | An owner is ticked or unticked, or Only personal | The owner not in the list stays hidden, with the new choice, saved.                            |
| Every owner in the list | The list is read again or the page opens         | The list shows no repositories and says every owner is hidden; the filter shows **No owners**. |

A browser that refuses storage keeps the choice for the visit only.

## Web profiles source

`Profiles` (`packages/web/src/app/profiles.ts`) keeps where the profiles are,
saved as `profiles-source` in the browser's
[preferences](web-app.md#the-app), and the sync state the pages show. Every
event below waits its turn in one queue.

| State      | Event                                   | Next                                                                                                                        |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| In browser | Refresh, or the app opens               | The folder is listed.                                                                                                       |
| On GitHub  | Sync, or the app opens                  | Syncing, then listed.                                                                                                       |
| Syncing    | It records                              | In sync, or conflicts when any file changed on both sides.                                                                  |
| Syncing    | It fails                                | Not synced, with why; the working copy is listed as it is.                                                                  |
| Syncing    | GitHub answers 401                      | Not synced, and the account is signed out.                                                                                  |
| Conflicts  | Keep mine or Use GitHub's               | Syncing, with `prefer` for the files in conflict only.                                                                      |
| Any        | Use a repository, from the connect form | Connecting: profiles kept now are copied into the repository's working copy if asked, skipping names it has, then it syncs. |
| Connecting | The sync records                        | On GitHub, saved, with the working copy listed.                                                                             |
| Connecting | The name isn't `owner/name`             | As before, with why; GitHub isn't asked.                                                                                    |
| Connecting | GitHub answers 401                      | As for a failed sync, and the account is signed out.                                                                        |
| Connecting | The sync fails                          | As before, with why. A working copy that never synced is removed, and one that had loses only what was copied in.           |
| On GitHub  | Use this browser                        | In browser, saved; the repository and its working copy keep what they have.                                                 |

A profile open when the list is read again shows its file as it is then, and
closes when the file is gone.

A repository that is remembered while its working copy is gone, as after the
browser's storage was cleared, syncs as a first sync. Why the last connect
failed stays in Settings until profiles are moved again. The profiles and
where they are kept belong to the browser, not to the account: whoever signs
in on it sees them, and a sync runs with that account's access.

## Web profile editor

`ProfileEditor` (`packages/web/src/app/profile-editor.ts`) holds one open
profile's settings and the changes to them that aren't saved. `Profiles`
keeps an editor for each profile opened since profiles were last moved, so
unsaved changes outlast a look at another profile, and reads each again
whenever the list is read.

### The profile

| State  | Event                                              | Next                                                                                                                                                   |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None   | A profile is opened for the first time             | Loading, then Loaded with its settings, or Unreadable with why and no settings.                                                                        |
| Loaded | The list is read again, as after a sync            | Loaded from the file as it is then, with the unsaved changes laid over it again.                                                                       |
| Loaded | The profile, or one it extends, can't be read then | Unreadable, with why and no settings. Its changes are kept and count as nothing unsaved, so they hold no move back; they show again if it reads again. |
| Loaded | Its file is gone from the list                     | The editor goes, with its unsaved changes.                                                                                                             |
| Any    | Profiles are moved to another place                | Every editor goes. Unsaved changes hold the move back, with "Save or reset your unsaved changes first."                                                |
| Loaded | The profile is deleted                             | The editor goes, with its unsaved changes.                                                                                                             |

### Unsaved changes

Each change is previewed through the engine's `previewProfile`, so the
editor shows what a save would give, base profiles included.

A profile with a [draft](#drafts) of its own opens on it: each setting,
ruleset, environment, and label in the draft starts from the draft, and from
what applies otherwise. A base profile's draft is left out, since its own
file finishes it. So "saved" below is the file as last read, draft included,
and "what the file has" for a setting is its draft's value when it has one.

| State   | Event                                                | Next                                                                                                                                                                                             |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved   | A setting is chosen or typed                         | Unsaved, previewed. A change back to what the file has is no change.                                                                                                                             |
| Unsaved | The engine accepts the preview                       | Unsaved, with **Save** on.                                                                                                                                                                       |
| Unsaved | The engine refuses the preview                       | Unsaved, with why above **Save**, which is off. Each changed setting shows as chosen, and every other as saved.                                                                                  |
| Unsaved | A slower preview ends after a later one              | Its result is dropped.                                                                                                                                                                           |
| Any     | A name or number is typed                            | The box keeps the text as typed until it is left. Text that can be a value is an unsaved change at each key. Text that can't stays with why, and **Save** is off until it is corrected or reset. |
| Unsaved | Remove on a setting this profile sets                | Unsaved: the file stops naming it, and a base profile's value shows.                                                                                                                             |
| Unsaved | Reset on a setting, or Reset in the footer           | That setting, or all of them, as saved.                                                                                                                                                          |
| Unsaved | A setting that stands alone is set, or one beside it | The other is taken out, as with **Take the site down** and the rest of Pages.                                                                                                                    |
| Unsaved | Save                                                 | Saving: a turn in the profiles' queue. A sync first brings in what changed on GitHub, then only the settings changed are written, so what the file gained stays, and a sync commits them.        |
| Saving  | The write ends                                       | Saved, then a sync when profiles are kept on GitHub. A change made while it ran stays unsaved.                                                                                                   |
| Saving  | The write fails                                      | Unsaved, with why, and **Save** on to try again. A setting changed back meanwhile to what the save was writing keeps its change.                                                                 |

### The draft

**Save** and **Save as draft** are the two ways out of Unsaved above, and
both take the same turn in the queue. The draft is the open file's own:
its settings under `drafts`, its entries with `draft: true`, and its keys of
`drafts.unset`.

| State                 | Event                                                     | Next                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsaved               | Save as draft                                             | Saving. Each setting or entry that ends as something other than what applies is written as a draft, one that ends as what applies loses its draft, and what the file stops naming is listed in `drafts.unset`. What applies stays as it is. |
| Unsaved               | A new or renamed entry has no name, or another's          | **Save as draft** is off, with why. Nothing else about an entry holds it back, since a draft may be unfinished.                                                                                                                             |
| Unsaved               | A setting is cleared to an empty value, as a runner label | **Save as draft** is off, with why: a draft of no value reads as no draft. **Save** can still apply it.                                                                                                                                     |
| Saved, with a draft   | Opened, or read again                                     | Each drafted row shows the draft, marked **Draft**, with what applies now beside a setting. The banner counts the draft's changes and lists what stops each from applying.                                                                  |
| Saved, with a draft   | Save, with or without unsaved changes                     | Saving. Every row is written as it ends, so it applies, and the whole draft is taken out: each draft setting, each draft entry, and `drafts.unset` but for the keys the editor has no row for.                                              |
| Saved, with a draft   | The draft can't apply as it stands                        | **Save** is off, with the engine's reason above it, or **Not finished** on the entry. **Save as draft** still keeps further changes.                                                                                                        |
| Saved, with a draft   | A drafted setting or entry is changed to what applies     | Unsaved. Either save takes it out of the draft.                                                                                                                                                                                             |
| Saved, with a draft   | **Put it back** on an entry the draft takes out           | Unsaved, as the entry applies. Either save takes its key out of `drafts.unset`.                                                                                                                                                             |
| Saved, with a draft   | Discard draft, with nothing unsaved                       | Confirming. **Keep it** goes back. **Discard draft** takes the draft out of the file in a save's turn, and keeps what the editor has no row for.                                                                                            |
| Unsaved, with a draft | Discard draft                                             | Off until the changes are saved or reset, since it writes at once.                                                                                                                                                                          |
| Saving, either way    | An entry with a change is out of date                     | Nothing is written, as in the table below. An entry's draft counts as its saved entry, so a draft that changed elsewhere holds its change back.                                                                                             |
| Saving, or discarding | The file's own draft differs from the one shown           | Nothing is written. The editor shows the draft as it is now, with "The profile's draft changed elsewhere." Saving again acts on that draft.                                                                                                 |
| Unsaved               | An entry is given the name of one the draft takes out     | Held back from both saves, with why, until that one is put back.                                                                                                                                                                            |
| Discarding            | The write fails                                           | Saved, with the draft, and why.                                                                                                                                                                                                             |

The editor has no rows for custom properties, topics, and the other
settings its tabs leave to the profile's file. Their drafts count in the
banner, a save that applies finishes each as it is, and **Discard draft**
takes them out. Autolinks are the exception: both saves and **Discard
draft** leave a draft autolink, and an `autolinks/` key of `drafts.unset`,
in the file. A draft of a key no section has stays too, with the profile's
warning. A save as a draft drops a key of `drafts.unset` that names what the
file doesn't set, which finishing the draft would not change.

A ruleset, environment, or label renamed in a draft is a draft under the new
name and a `drafts.unset` key for the one that applies, so its row becomes
two: the old one taken out in the draft, and the new one new in it.

### Search and filters

The search and the **Managed**, **Not saved yet**, and **Drafts** filters
find settings across the tabs. What they found is worked out when the search
or a filter changes, or the profile is read or written, and not when a row
changes.

| State | Event                                                                   | Next                                                                                                                                                |
| ----- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs  | A word is typed, or a filter is turned on                               | Found: the settings that fit every word and every filter show group by group in place of the tabs, each sub-option under the setting it belongs to. |
| Found | A found setting is changed or reset                                     | Found, with the same settings, so a row doesn't vanish as it is edited. Its value and marks follow the change.                                      |
| Found | A change hides a found setting, as turning off the one above it does    | Found: the hidden one goes, as on its tab, and the one above it stays to change back. The count follows what shows.                                 |
| Found | A save or a discard ends, or the profile is read again, as after a sync | Found, worked out again, so a setting a save settled leaves **Not saved yet**, and a finished or discarded draft leaves **Drafts**.                 |
| Found | The search or a filter changes                                          | Found, worked out again from the rows as they are then.                                                                                             |
| Found | Nothing fits                                                            | Found, with why: the words typed, or the filters, and that rulesets, environments, and labels are on their own tabs when one of them would fit.     |
| Found | A setting GitHub hides for another's value fits                         | Left out, as on its tab.                                                                                                                            |
| Found | The search is emptied and every filter is off                           | Tabs, on the tab that was open.                                                                                                                     |
| Found | Show every setting, or Escape in the search                             | Tabs for the first; the second empties the search and keeps the filters.                                                                            |

### Each ruleset, environment, or label

`EntryEdits` (`packages/web/src/app/entry-edits.ts`) holds the changes to
entries. The engine writes an entry whole, so a change holds the whole entry,
with the saved entry it was made on. An entry's key is its saved name, or a
number for one that is new, so its row is found whatever its name becomes.

| State         | Event                                                              | Next                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved         | A field changes                                                    | Unsaved, previewed with the settings. An entry changed back to what is saved, its name trimmed, is no change.                                                                 |
| None          | New ruleset, environment, or label                                 | New: unsaved, with "Give it a name." until it has one.                                                                                                                        |
| Unsaved       | Its name is empty, or another entry's                              | Held back with why. A ruleset is known by its name as written, an environment or a label by its name in any case.                                                             |
| Unsaved       | Its name is the saved name of one renamed or taken out             | Held back until that change is saved, since the file still has the name.                                                                                                      |
| Unsaved       | A ruleset requires status checks and names none                    | Held back with why.                                                                                                                                                           |
| Unsaved       | A label's old names include its own, one twice, or another label's | Held back with why.                                                                                                                                                           |
| Unsaved       | The engine refuses it, such as a color that isn't one              | Unsaved, with why above **Save**, which is off.                                                                                                                               |
| Any held back | Another setting or entry changes                                   | The entries that can be saved as they stand are still previewed; **Save** stays off.                                                                                          |
| Managed       | Remove it from the repository                                      | Unsaved: only its name and `absent: true` are written. What it had is kept with the change.                                                                                   |
| Removing      | Manage it                                                          | What it had comes back, under its name as it is then; for one saved as removing, only its name.                                                                               |
| Saved here    | Take out of profile                                                | Unsaved and struck through: the file stops naming it. **Put it back** undoes that before a save. One only the draft has is taken out of the draft.                            |
| New           | Take out of profile                                                | Gone, with no change.                                                                                                                                                         |
| From a base   | A field changes                                                    | Unsaved: the save writes the entry here, over the base's. Its name can't change.                                                                                              |
| Unsaved       | Reset, on one saved before                                         | Saved.                                                                                                                                                                        |
| Unsaved       | The saved entry changes, as a sync can do                          | Out of date: held back with why, and **Keep mine** or **Reset**. The change would write the whole entry over what it is now.                                                  |
| Unsaved       | The saved entry goes                                               | Out of date, still listed. **Keep mine** makes it a new entry; **Reset** lets it go. A change that took it out is dropped, with nothing left to do.                           |
| Out of date   | Keep mine                                                          | Unsaved, based on the entry as it is now.                                                                                                                                     |
| Unsaved       | Save                                                               | The file is read again in the save's turn. Any entry out of date stops the save, with nothing written. Otherwise the changes as they stood when Save was pressed are written. |
| Saving        | The write ends                                                     | Saved, under the name the save gave it. One changed again while the save ran, even back to what it was, stays unsaved, based on what was written.                             |
| Saving        | The write fails                                                    | Unsaved, every change as it is.                                                                                                                                               |

Only an entry with a change or a draft is checked, so a profile the engine
takes can always be saved, whatever its other entries hold, and a draft the
form would hold back says so on its row.

A renamed ruleset or environment is renamed in the file; applying creates
one of the new name and leaves the old on each repository, and the form says
so. A renamed label offers to list its old name under `renamed_from`.

`entry-forms.ts` holds what each form writes. A ruleset whose `rules` is
unset leaves each repository's rules alone, while one that sets any removes
every other on apply: turning the last rule off unsets `rules` again when the
file set none, and **Leave its rules to GitHub** unsets it outright.

A setting GitHub hides for the value of the one it follows is not drawn, and
that one counts how many such settings a profile still names. A setting
GitHub greys out stays in place, off.

## Web new profile

`Profiles.create` (`packages/web/src/app/profiles.ts`) makes a profile for
the new profile form. It never replaces a file: the name is checked against
the list when the form asks, and the write itself refuses a file that is
there. A capture reads GitHub before it takes its turn in the queue, and
holds its name against other new profiles while it reads.

| State                      | Event                                                       | Next                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing                    | Create or Capture                                           | The name is checked: a profile of that name in any case, a name a sync would refuse, or a capture making it, refuses it. It is checked again when the turn comes, against the list as the turns before left it. |
| Creating, empty or extends | Its turn comes                                              | The file is written, then synced when profiles are kept on GitHub: Created, and the profile opens.                                                                                                              |
| Creating, capture          | Start                                                       | Reading: the name is held while GitHub is read.                                                                                                                                                                 |
| Reading                    | GitHub answers                                              | The name is free, and the profile is written when its turn comes, with what the capture left out.                                                                                                               |
| Reading                    | The read fails                                              | Editing, with why; the name is free and nothing is written.                                                                                                                                                     |
| Reading                    | GitHub answers 401                                          | The same, and the account is signed out.                                                                                                                                                                        |
| Reading                    | The form closes                                             | The read finishes and nothing is written. An empty or extending profile asked for before the form closed is still made.                                                                                         |
| Any creating               | A profile of that name came in meanwhile, such as by a sync | Editing, with "is already in"; the profile that came in stays.                                                                                                                                                  |
| Any creating               | Where profiles are kept changed meanwhile                   | Editing, with why; nothing is written.                                                                                                                                                                          |
| Created                    | The sync that follows fails                                 | The profile is made and listed; the sync state says why it hasn't reached GitHub.                                                                                                                               |

The form's owner type goes into the file as `owner_type`, except for a
capture, which writes the repository's own, and a profile that extends a
typed base, which takes the base's and writes none.

## Web deleting a profile

The open profile's **Delete profile** asks in a dialog, which names the file
and every listed profile that extends it, directly or through another. The
question warns and doesn't block.

| State    | Event                                   | Next                                                                                                                                          |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle     | Delete profile                          | Asking.                                                                                                                                       |
| Asking   | Cancel, or Escape                       | Idle, with nothing changed.                                                                                                                   |
| Asking   | Delete profile                          | Deleting: a turn in the queue, after any sync under way. The button is off while the queue is busy.                                           |
| Deleting | Its turn comes                          | The file is removed, a sync commits that when profiles are kept on GitHub, and the list is read again: the profile closes and no other opens. |
| Deleting | The list no longer has the profile      | Idle, with nothing deleted.                                                                                                                   |
| Deleted  | The sync that follows fails             | The profile is gone here and still on GitHub; the sync state says why, and the next sync commits the delete.                                  |
| Deleted  | The profile changed on GitHub meanwhile | A conflict: **Keep mine** commits the delete, and **Use GitHub's** brings the file back.                                                      |

## Web kept files

`keepFiles` (`packages/web/src/app/kept-files.ts`) keeps the engine's files in
IndexedDB. What is kept must be the files as they were at one moment: a sync
record kept without one of the profiles it lists reads as that profile
deleted here, and the next sync would delete it on GitHub.

| State   | Event                                             | Next                                                                                                                                                |
| ------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening | Another tab of the site holds the lock            | Elsewhere: nothing is loaded or kept, and the app shows only a page that says so, with **Reload**.                                                  |
| Opening | IndexedDB gives the kept files                    | Keeping: the files are in memory, and each later change is written in order.                                                                        |
| Opening | A kept file can't be placed in memory             | Keeping, without that file.                                                                                                                         |
| Opening | IndexedDB can't be opened or read                 | Visit only: the files last for the visit, and Settings says so.                                                                                     |
| Opening | The browser has no Web Locks, or refuses the lock | Visit only, with nothing loaded: no tab can tell that it alone keeps the files.                                                                     |
| Keeping | A file is written or removed                      | The same is done in IndexedDB, after the changes before it.                                                                                         |
| Keeping | The engine writes a temporary file                | Nothing is kept of it.                                                                                                                              |
| Keeping | A write to IndexedDB fails                        | Stopped: no later change is written, so what is kept stays as it was before the failure. A notice on every page says so until the page is reloaded. |
| Keeping | The tab closes                                    | The lock is free for the next tab.                                                                                                                  |

**Failure:** a tab closed right after a change can lose that change, since
the write to IndexedDB follows the change in memory
([#225](https://github.com/TheLunchTrae/repotted/issues/225)).

## Web navigation

`Router` (`packages/web/src/app/router.ts`) holds the address of the page
within the app.

| State    | Event                              | Next                                                     |
| -------- | ---------------------------------- | -------------------------------------------------------- |
| Any page | A link to one of the app's pages   | That page, with a new entry in the browser's history.    |
| Any page | A link to the page already shown   | The same page; the history gets no entry.                |
| Any page | The browser's back or forward      | The page at that entry.                                  |
| Any page | An address the app has no page for | "There's no page here", with a link to the repositories. |

A trailing slash names the same page. Leaving Settings while its connect form
is syncing lets the sync finish: the profiles move, or the reason they
didn't shows in Settings.

## Desktop navigation

`ShellViewModel.Page` is the page the signed-in app shows: 0 for the
repositories, with a compare, an apply or a batch standing in for the list,
1 for the profiles, and 2 for the settings where they are a page. The sidebar
binds `NavPage`, which is Page for the first two and -1 on the settings, and
`SettingsNavPage`, which is 0 only on the settings. Each ignores the -1 its
list sets as the other list takes the selection.

`SettingsInWindow` is true on macOS. There the settings never become a page:
`OpenSettings` raises `SettingsWindowRequested`, and `ShellView` opens a
`SettingsWindow` over the main window, or brings the open one forward. The
window shows `SettingsTab`, 0 for the account and 1 for the profiles, and
closes when the shell leaves the visual tree, as when signing out replaces it.

| State                    | Event                                                                  | Next                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any page                 | Repositories or Profiles in the sidebar                                | That page. Leaving the repositories closes a compare, and an apply or batch that can leave, as in [Desktop apply](#desktop-apply).                                                                                                                         |
| Any page                 | Settings, Ctrl+comma, or the account menu, on Windows                  | The settings page, closing a compare as above.                                                                                                                                                                                                             |
| Any page                 | Repotted > Settings…, Command+comma, or the account menu, on macOS     | The page stays; the settings window opens or comes forward.                                                                                                                                                                                                |
| Any page                 | Use a GitHub repository or Change repository, wherever it is           | After [Leaving with unsaved changes](#leaving-with-unsaved-changes), the connect form opens in the settings, at the Profiles tab on macOS; the profiles page says so and offers Show settings.                                                             |
| The connect form is open | It connects or is cancelled                                            | The settings show where the profiles are kept again.                                                                                                                                                                                                       |
| Any page                 | A way out asks about unsaved profiles, or one opens after the question | The profiles page, which shows the question or the profile; on macOS the settings window closes and the main window comes forward, since the settings window stays above it. An apply or batch that cannot leave shows the repositories page the same way. |
| The settings window      | Command+W or its close button                                          | Closed; the next open makes a new one.                                                                                                                                                                                                                     |
| The settings window      | The shell is replaced                                                  | Closed.                                                                                                                                                                                                                                                    |

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

Reviewing has two views, which `Editing` picks: the one-off edits, where every
start, resume or failed start that is reviewed again lands, and the changes,
which Apply goes from. Planning keeps the view, so a plan after a save, a leave
out or Review again stays where it was, and an apply that comes back Stale or
Partly applied is reviewed again on the changes.

| State                                     | Event                                       | Next                                                                                                                           |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Starting                                  | No staged file for the repository           | Planning, after `stage --new`, from the chosen profile or from the repository as it is.                                        |
| Starting                                  | A staged file is there                      | Unfinished, naming what it starts from; one the CLI can't read can still be started over.                                      |
| Starting                                  | `stage --new` fails                         | Failed, with the CLI's message; with no staged file there is nothing to review or discard.                                     |
| Unfinished                                | Resume                                      | Planning, from the file as it is.                                                                                              |
| Unfinished                                | Start over                                  | Starting: the file and its plan are removed, and a new one starts from the chosen profile.                                     |
| Planning                                  | `plan --staged` succeeds                    | Reviewing, with each row's exclusion key, and the one-off edits' diff rebuilt from this plan with its folds closed.            |
| Planning                                  | `plan --staged` fails                       | Failed; Review again plans once more, and Discard apply is offered while the staged file is there.                             |
| Reviewing, on the changes                 | Leave out or Put back                       | Working, then Planning; a refused change keeps the review as it was and shows why.                                             |
| Reviewing, on the edits                   | Save edits to profile                       | Unsaved edits save first, as for Review changes; then Working and Planning. A refused save or change stays on the edits.       |
| Working                                   | The change succeeds                         | Planning, with the one-off edits showing the staged apply the change returns, which is not read again.                         |
| Reviewing, Confirming, Confirming discard | Save the one-off edits                      | Planning, since the edits change the plan; a plan reviewed before the save is never applied.                                   |
| Reviewing                                 | One-off edits not saved yet                 | Reviewing, with leaving out and leaving the page held until saved or undone; Apply is on the changes, which show none.         |
| Reviewing, on the edits                   | An unsaved edit isn't valid                 | Reviewing: Review changes and Save edits to profile wait until it is fixed or undone.                                          |
| Reviewing, on the edits                   | Review changes, with no edits unsaved       | Reviewing, on the changes, from the plan already there; nothing runs.                                                          |
| Reviewing, on the edits                   | Review changes, with edits unsaved          | The edits save, then Planning; on the changes only if the save and plan succeed. A refused save stays on the edits.            |
| Reviewing, on the changes                 | Back to edits                               | Reviewing, on the edits; nothing runs.                                                                                         |
| Reviewing, on the changes                 | Apply, with a locked change                 | Reviewing: Apply stays held until each change the locks say GitHub refuses is left out or planned again with access.           |
| Reviewing, on the changes                 | Apply, with changes to make and none locked | Confirming. The one-off edits can change only in Reviewing, so none waits under a plan about to be applied.                    |
| Confirming                                | Cancel                                      | Reviewing; nothing is written.                                                                                                 |
| Confirming                                | Apply now                                   | Applying: `apply --yes` on the reviewed plan file. It waits while the edits are read or saved.                                 |
| Applying                                  | Every change written                        | Applied: the staged file and plan are removed. A failed removal leaves the file, to be offered again.                          |
| Applying                                  | The repository changed since the review     | Stale: nothing was written. Review again plans from the file.                                                                  |
| Applying                                  | A write fails partway                       | Partly applied: the outcome counts what was written and names what failed. Review again shows the rest.                        |
| Applying                                  | Any other failure                           | Failed, warning that some changes may already be on GitHub.                                                                    |
| Reviewing, Stale, Partly applied, Failed  | Discard apply, with the staged file there   | Confirming discard, from the edits when Reviewing. It shows the review behind it, and waits while a change runs or edits save. |
| Confirming discard                        | Keep it                                     | The state it came from.                                                                                                        |
| Confirming discard                        | Discard apply                               | Discarded: the file and plan are removed and the page closes. A refused discard returns with the error.                        |

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
| One-off edits are unsaved                               | The page goes to its edits and asks to save or undo them first.                                               |
| Asking, and the edits are saved                         | The saved edits are planned again, then the act goes on, so the page never stays behind with an old plan.     |
| Asking, and the edits are undone or the apply discarded | The act goes on.                                                                                              |
| Asking, and Stay here, or another act asks              | The act is put aside and the edits stay as they are; a later question replaces an open one.                   |

Unsaved profile changes on the Profiles page are asked about after the apply.
A lost sign-in that asked either question checks the sign-in again once it is
answered. Opening another apply while one is open does nothing.

## Desktop batch

The Batch apply page (`BatchViewModel`) drives a batch through the CLI: the
manifest is kept in a `batch` folder in the app data folder, its members'
staged applies in `staged/` as the Apply page keeps them, and the reviewed
plan as `batch.plan.json`. Leaving the page keeps the batch, so the
Repositories page offers it again, and opening the Apply page for one of its
members opens the batch. Each repository's entry (`BatchMemberViewModel`) is
Planned, Left out or Failed, and its one-off edits open, in the same profile
editor as the Apply page, when it is first selected.

| State                   | Event                                              | Next                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting                | No batch, with repositories chosen                 | Planning, after `stage --batch`; a repository with a staged apply joins as it is, and the notice names it.                                                                                                    |
| Starting                | No batch, and none chosen (Resume)                 | Failed: there is no batch to resume.                                                                                                                                                                          |
| Starting                | A batch is there, and none chosen                  | Planning, from the batch as it is.                                                                                                                                                                            |
| Starting                | A batch is there, with repositories chosen         | Unfinished, naming the batch's size and profile; one the CLI can't read can still be started over.                                                                                                            |
| Unfinished              | Resume                                             | Planning.                                                                                                                                                                                                     |
| Unfinished              | Start over                                         | Starting: the batch is discarded, keeping staged applies that joined it, the plan is removed, and a new batch starts. One the CLI cannot read is removed as it is, and the notice says so.                    |
| Planning                | `stage` and `plan --staged` succeed                | Reviewing. Entries are kept by repository with their edits and the selection; one that left the batch goes.                                                                                                   |
| Planning                | Either fails                                       | Failed; Review again plans once more, and Discard batch is offered while the batch is there.                                                                                                                  |
| Reviewing               | Leave out or Put back a member, a row, or a change | Working, then Planning. Everywhere changes name each repository that kept its own; a refused change shows why. Open one-off edits are read again.                                                             |
| Reviewing               | One-off edits not saved yet                        | Reviewing, with Apply, every change and leaving held until saved or undone.                                                                                                                                   |
| Reviewing               | The edits are saved                                | Planning, since the edits change that member's plan.                                                                                                                                                          |
| Reviewing               | Apply, with changes to write                       | Confirming. Members that need access, left out or failed are not in it.                                                                                                                                       |
| Confirming              | Cancel                                             | Reviewing; nothing is written.                                                                                                                                                                                |
| Confirming              | Apply now                                          | Applying: `apply --only` on the plan file for each ready member in order. Members that need access are marked as waiting.                                                                                     |
| Applying                | A member's run ends                                | Its result: Finished when applied or in line, otherwise Unfinished with why; a failed run warns some may be written, and a lost sign-in stops the rest. Applied but not let go of by the batch is Unfinished. |
| Applying                | Stop after this repository                         | The member being applied finishes; the rest are marked not applied.                                                                                                                                           |
| Applying                | The last member's run ends                         | Done. With no batch left, the plan file and empty staged folders are removed and the batch is finished; otherwise the batch stays with what didn't finish or wasn't in the apply.                             |
| Done                    | Review again, with the batch still there           | Planning, for the members still in the batch.                                                                                                                                                                 |
| Reviewing, Done, Failed | Discard batch, with the batch there                | Confirming discard. Held while a change runs or the edits are read or saved.                                                                                                                                  |
| Confirming discard      | Keep it                                            | The state it came from; held while the discard runs.                                                                                                                                                          |
| Confirming discard      | Discard batch                                      | Discarded: the batch, the staged applies it started and the plan are removed, and the page closes. A refusal returns.                                                                                         |

Leaving the page goes by `CanLeave` as the Apply page does: not while it
starts, plans, applies or runs a change, nor while the edits of the selected
member are read, saved or unsaved, and the same question asks to save or undo
them first, showing that member's edits.

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

## Desktop repository owners

`RepositoriesViewModel` keeps the owners the repository list hides, by login,
saved as `hidden_repository_owners` in the app's `settings.json`, or none when
it hides no owner. The list's owners come from each read of the list, and a
hidden owner matches its login in any case. Keeping the hidden owners rather
than the shown ones means an owner new to the list shows. The hidden owners
are not kept per account, so they apply whichever account is signed in.

| Hidden                  | Event                                   | Next                                                                                                                      |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| None                    | An owner is unticked                    | That owner, saved.                                                                                                        |
| Some owners             | Every owner in the list is ticked       | Only hidden owners not in the list, or none, saved.                                                                       |
| Any                     | Only personal                           | Every owner in the list but the signed-in account, saved.                                                                 |
| Any                     | Show all                                | None, saved as none.                                                                                                      |
| Some owners             | The list is read again                  | The hidden owners in the list stay hidden; an owner new to it shows.                                                      |
| An owner not in list    | An owner is unticked or Only personal   | The owner not in the list stays hidden, with the new choice, saved.                                                       |
| Every owner in the list | The list is read again or the app opens | The list shows no repositories and says the filter hides them all; the filter shows **No owners**, even for a lone owner. |
| Any                     | The read fails                          | The owners and their ticks stay as they were, and the filter is hidden.                                                   |

A save that fails, such as an unwritable app data folder, is let go: the
choice holds for this run and is lost at the next.

## Desktop profiles source

`ProfileFolder` keeps the profiles folder, the config repository if there is
one, and the sync state the page shows. `ProfilesViewModel` holds one, and the
Apply page and the new profile form write through the same one.

| State        | Event                                              | Next                                                        |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| Local folder | Refresh                                            | The folder is listed.                                       |
| Connected    | Refresh                                            | Syncing, then listed.                                       |
| Connected    | A save                                             | Syncing, then listed again when the sync pulled anything.   |
| Connected    | A delete                                           | Syncing, then listed.                                       |
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
edits to the profile on the Apply page, the new profile form's move of a
capture, and deleting a profile write through the folder itself. Some writes and syncs run outside the
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

A profile with a draft opens on it: each setting, ruleset, environment and
label in this profile's own draft starts from the draft, and from what applies
otherwise. A base profile's draft is left out, and its file saves it. So
"saved" below is the file as last read, draft included, and the final values
are the rows as they stand.

| State               | Event                       | Next                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading             | The CLI resolves the file   | Saved, with a draft when the file has one of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Loading             | It fails                    | Error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Saved               | Any edit                    | Changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Changed             | Reset                       | Saved: every row as last saved, draft included. A group's or a list's Reset does this for its rows alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Changed, or a draft | Save                        | Out of date when a file changed since the editor read it under an edited ruleset, environment or label. Otherwise saving the final values, which finishes the draft: settings through `--set` and `--unset`, with each own draft setting unset and `drafts.unset` emptied but for autolinks, which the editor doesn't show; entries whole through `--ruleset`, `--environment` and `--label`, taken-out entries through `--drop-ruleset`, `--drop-environment` and `--drop-label`, and each own draft entry dropped with `--drop-draft-ruleset`, `--drop-draft-environment` or `--drop-draft-label`. A draft of a key no section has stays in `drafts`, with the profile's warning, and a `drafts.unset` key for what the file doesn't set just leaves the list. |
| Changed             | Save as draft               | Saving the final values against what applies, as the draft: a setting as `drafts.<section>.<key>`, an entry with `draft: true`, and what stops applying in `drafts.unset`. What applies stays as it is. Refused while a draft entry has no name or shares one with another draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Changed, or a draft | Preview                     | Previewing: `profile --preview` makes Save's edits without saving them and prints what applies before and after, shown as a diff. Save and Save as draft there save as above; Close goes back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Saved, with a draft | Discard draft               | Confirming discard. Keep it goes back; Discard draft unsets each own draft setting and `drafts.unset`, keeping keys the editor doesn't show such as autolinks, and drops each own draft entry. Offered only with nothing unsaved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Saving              | It succeeds                 | Saved, then a sync for a config repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Saving              | It fails                    | Changed, with the error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Out of date         | Keep mine                   | Saving, over the change to the file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Out of date         | Reload                      | Loading, without the unsaved edits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Out of date         | Reset                       | Saved, as the editor read the file; the next refresh loads the file again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Changed             | Save, with the file gone    | Removed, without saving; the list shows it as removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Removed             | Save                        | Saving, after the text the editor read is written back as a new file. If the save stops or fails, that file is deleted again and the editor stays Removed. A file already back is never deleted: the save takes it as listed first, as below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Removed             | Reset, or every edit undone | Gone from the cache and the list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Removed             | A refresh lists the file    | Changed, when the file is back as the editor read it. Out of date for any edit, settings too, when it came back as something else, such as a new profile of the same name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The one-off edits on the Apply page use the same editor without drafts: it
offers no Save as draft, Preview or draft banner, and shows the YAML pane,
which a profile's editor hides until **Show YAML**.

### The owner type

The editor shows only what the profile's owner type has, and leaves out the
rows of the rest when it makes them, so they are never part of a save. The
type changes only through the picker, which writes at once with
`profile <file> --owner-type`.

| State    | Event                                                  | Next                                                                                               |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Closed   | The type is clicked                                    | Open, with the profile's type picked.                                                              |
| Open     | Another type is picked                                 | Open, listing what `owner_changes` says that type leaves not managed.                              |
| Open     | Change, with unsaved changes                           | Not offered: the change would lose them, so it waits for a save or Reset.                          |
| Open     | Change, with the file changed since the editor read it | Open, with the file read again and a note to check what the change leaves; nothing is written.     |
| Open     | Change                                                 | Changing, in the queue that keeps saves and syncs apart.                                           |
| Changing | It succeeds                                            | Closed, and the editor shows the file as the CLI resolved it, then a sync for a config repository. |
| Changing | It fails, as when a base sets what the new type lacks  | Open, with the error naming the base; the file is as it was.                                       |
| Open     | A load or save shows the file again                    | Open, listing what the file as shown would leave not managed.                                      |
| Open     | Cancel                                                 | Closed.                                                                                            |

### Each setting

A `SettingViewModel` is one row of a settings tab. Its value comes from the
profile, a base profile, or neither; a change waits until the profile is
saved. A field marked `EmptyIsNull`, a runner label, saves an empty box as
`null` and shows a `null` as an empty box, so leaving it empty is no change.
A field with `DependsOn` follows the row it names above it, through that
row's own parent, as `settings-coverage.md` lists; changing a row refreshes
the rows above and below it.

| State              | Event                                                    | Next                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved              | Choose a value, or type a valid one                      | Changed. Typing back the text the box started with, or choosing the value this profile itself saved, is Saved instead.                                                                                                                               |
| Saved, set here    | Remove                                                   | Changed, to leave the value out; a base profile's value then applies.                                                                                                                                                                                |
| Saved or changed   | Type text that isn't a valid value                       | Invalid: the value is as saved, the box keeps the text and says why. It counts as an unsaved change, and the profile can't be saved until it is fixed.                                                                                               |
| Invalid            | Type a valid value                                       | Changed, or Saved when it is the value the row started with.                                                                                                                                                                                         |
| Changed or invalid | Reset, on the row, its group or the profile              | Saved, with the box showing the saved value: the draft's, when the row is in it.                                                                                                                                                                     |
| Any, in a section  | A setting that must stand alone there is set             | Each other setting this profile's file would hold there is left out: removed when set here, undone when only changed. Pages' `absent` is such a setting.                                                                                             |
| Any, in a section  | Another setting is set beside one that stands alone      | The setting that stands alone is left out the same way, since the CLI refuses a file that holds both. Resetting one side doesn't bring the other back; resetting the group or profile does.                                                          |
| Any                | The setting that turns it off shows that value           | Off, as a runner label is with standard runners: the box can't be typed in but keeps its value, rail and way back. On once that setting has another value or none.                                                                                   |
| Any                | The setting that hides it shows that value, or is hidden | Hidden, as the allowed actions are with Actions off: the tab leaves the row out, and results show it off. It keeps its value, and the setting that hides it counts it while the profile names it. Shown once that setting has another value or none. |

### Settings search

The profile editor's search and its **Managed**, **Not saved yet** and
**Drafts** filters
live on `ProfileViewModel`; `SettingSearch` holds the text each setting is
found by, built once from `ProfileFields`. The result rows are made once for
each load of the profile, the first time a search or filter is on; a search
then shows and hides them, and one that finds the same changes nothing.

| State   | Event                               | Next                                                                                                                                                                             |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs    | Type a search, or turn on a filter  | Results: the settings that fit, across every settings tab, with a matched sub-option's setting, and any setting that hides or turns it off, shown above it. The tabs are hidden. |
| Results | Change the search or a filter       | Results, found again; Tabs when the search is blank and every filter is off.                                                                                                     |
| Results | Edit, reset or remove a setting     | Results, unchanged: a row that no longer fits stays until the search or a filter changes, so it doesn't vanish while being edited.                                               |
| Results | The profile loads, reloads or saves | Results, found again among the new rows.                                                                                                                                         |
| Results | Escape in the search box            | The search is cleared: Results while a filter is on, otherwise Tabs.                                                                                                             |
| Results | **Clear**                           | Tabs, with the search cleared and every filter off.                                                                                                                              |

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

### Allowed action pattern checks

`ActionPatternsViewModel` sits on the **Allowed action patterns** row and
shows beside each line what its pattern matches on GitHub, read with
`repotted check-actions --json`. The states are those of one pattern's text,
trimmed; a line shows the state of the text it holds now, so a check that
lands after its line changed shows on no other line. A blank line shows
nothing, and a line with a comma holds several patterns and is never checked.
The checks are kept on the profile's editor by pattern text, so they outlive
the rows of a load, a reload or a save, and go with the editor.

| State               | Event                                                                                                                         | Next                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not checked         | The profile loads with the pattern in the list                                                                                | Checking, at once.                                                                                                                                                                                         |
| Not checked         | The list changes to hold the pattern                                                                                          | Waiting. Each further change starts the 600 ms pause again.                                                                                                                                                |
| Not checked         | GitHub hides the row, as with **Allowed actions** not set to **Selected**                                                     | Not checked, and nothing runs. Waiting once the row shows, or Checking at once when nothing was read before.                                                                                               |
| Waiting             | The pause ends                                                                                                                | Checking, in one run of the command for every pattern still in the list that is Not checked, 100 patterns a run.                                                                                           |
| Waiting             | The pattern leaves the list                                                                                                   | Not checked. The pause goes on only while another pattern waits.                                                                                                                                           |
| Checking            | The check lands                                                                                                               | Checked, or Failed when GitHub's answer for this pattern was an error or its rate limit, which every pattern the run had not yet looked up gets too.                                                       |
| Checking            | The whole run fails, such as with no network                                                                                  | Failed, for every pattern of that run. A lost sign-in also takes the app to the sign-in page.                                                                                                              |
| Checking            | The pattern leaves the list                                                                                                   | Checking: the run goes on and its result is kept for the text, so typing it back shows it.                                                                                                                 |
| Checked             | The pattern leaves the list and comes back                                                                                    | Checked, with no new run.                                                                                                                                                                                  |
| Failed              | The list changes                                                                                                              | Failed: a failure isn't tried again by typing.                                                                                                                                                             |
| Checked or Failed   | **Check again**                                                                                                               | Checking, at once: every pattern in the list is forgotten and asked about again, so a repository made or a tag pushed since shows. The link shows while the list has a line to check and none is Checking. |
| Waiting or Checking | The rows are replaced, or the editor goes: it leaves the cache, its apply or batch closes, or its repository leaves the batch | The pause and the run are cancelled. What a run had already kept stays for the editor's next rows.                                                                                                         |

### Action search

`ActionSearchViewModel` is the search box under the list. It runs
`repotted find-actions --json` and shows the repositories in a popup. One
search runs at a time: a newer one cancels the run before it, so an older
answer never replaces a newer one.

| State              | Event                                | Next                                                                                                   |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Closed             | Type two characters or more          | Waiting, closed still. Each further change starts the 500 ms pause again.                              |
| Any                | The text drops under two characters  | Closed, with any pause or search cancelled.                                                            |
| Waiting            | The pause ends, or Enter             | Searching: the popup opens and says so, in place of any results of the search before.                  |
| Searching          | The text changes                     | Waiting, with the search cancelled. The popup stays open and still says it is searching.               |
| Searching          | The search lands with repositories   | Results.                                                                                               |
| Searching          | The search lands with none           | Message: GitHub found no repositories for the words.                                                   |
| Searching          | The search fails                     | Message: GitHub's search limit is reached, or the error. A lost sign-in also goes to the sign-in page. |
| Results            | **Add**                              | Results, with `owner/repo@*` on a new line at the end of the list and the row showing Added.           |
| Results            | The list changes                     | Results, each row showing Added while the list holds its `owner/repo@*` on a line, in any case.        |
| Results or Message | Enter                                | Searching, at once, for the text as it is.                                                             |
| Open, in any state | Escape, or a click outside the popup | Closed, with any search cancelled. The text stays, and Enter searches again.                           |
| Any                | The rows are replaced                | Gone with them, with any pause or search cancelled.                                                    |

### Each ruleset, environment or label

| State                                     | Event               | Next                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved                                     | Edit                | Changed; a changed name on an entry this profile owns is a rename.                                                                                                                                                                                                       |
| Saved draft, set in this profile          | Saved               | Applies. With no entry of that name in this file, a drop of the draft, then a write of the same name, which the CLI reads as a rename in place; a base's of that name is overridden. Over this file's own entry of that name, a write over it, then a drop of the draft. |
| Changed                                   | Save as draft       | A draft with `draft: true`, and what applies stays; an entry taken out goes in `drafts.unset` as `<list>/<name>`.                                                                                                                                                        |
| New                                       | Reset               | Gone from the list.                                                                                                                                                                                                                                                      |
| Saved or changed, and set in this profile | Take out of profile | Dropped. An entry from a base profile can't be taken out here.                                                                                                                                                                                                           |
| Dropped                                   | Put back            | Saved, as the profile has it.                                                                                                                                                                                                                                            |
| Any                                       | Save                | Plain writes go first, then drops, then each rename as a drop and a write, since the CLI reads a write right after a drop as a rename. A draft that replaces this file's entry is a plain write and a drop.                                                              |

A draft can share its name with an entry, but not with another draft, and
once saved replaces that entry: this file's own in place, and a base's as any
override does. The editor shows the profile's draft warnings, what each draft
still needs, as the profile was last read or saved.

An editor builds the entry it saves from the copy it loaded, so saving writes
the whole entry as that copy plus the edits. That is why a save checks the
files first: it compares each with the text the editor read when it loaded or
last saved, and stops at Out of date when one differs. The profile's own file
counts for any edited entry, and each file it extends counts for an edited
entry it inherits, which the save writes whole as an override. The check runs
in the save's turn after any sync ahead of it, and Save, Keep mine, Reload,
and Reset wait while the editor loads.

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

### Closing

`ProfilesViewModel` closes the open editor through **Close profile** or its
shortcut, which leaves the page with no profile open. The editor stays in the
cache, as it does when another profile opens.

| State          | Event                                                                  | Next                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Open           | Close, with no unsaved changes                                         | None open.                                                                                                                               |
| Open           | Close, with unsaved changes                                            | Asking, as [Leaving with unsaved changes](#leaving-with-unsaved-changes) describes, about this profile alone; other editors keep theirs. |
| Asking         | Save or Discard settles this profile's edits                           | None open.                                                                                                                               |
| Asking         | A save fails                                                           | Open, with the error.                                                                                                                    |
| Asking         | Choose another profile, or open the new profile form                   | That one shows, and the question is taken back as if cancelled.                                                                          |
| Open or asking | The profile is deleted                                                 | None open, and any question about closing it is taken back, as [Deleting a profile](#deleting-a-profile) describes.                      |
| Asking         | A refresh or sync                                                      | Asking, with this profile open; a refresh opens no other profile while the question waits.                                               |
| None open      | A refresh                                                              | None open: a refresh opens no profile in place of one the user closed.                                                                   |
| None open      | Choose a profile, or choose or connect a folder, the same one included | Open, as at startup.                                                                                                                     |

### Leaving with unsaved changes

Changing the folder, connecting or changing the repository, closing the
window, signing out, and a lost sign-in that would replace the app go through
`ProfilesViewModel.ConfirmLeaveAsync`, which asks only when a cached editor
has unsaved changes. [Closing](#closing) a profile goes through it too, and
asks only about that profile. The question shows on the **Profiles** page.
The settings show it too when it asks about every profile, as changing the
folder or the repository does, since those start there. Closing
the window, signing out, and a lost sign-in show the **Profiles** page first,
through `ShellViewModel.ConfirmLeaveAsync`. Closing the window cancels the
close and closes again once the question settles.

| State            | Event                                                                                                   | Next                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle             | Change folder, connect a repository, close the window, sign out, or a lost sign-in                      | Asking, when any editor has unsaved changes. Otherwise it goes on. The question names the profiles that had unsaved changes when it was asked.                                                                                                                                                                                               |
| Asking           | Save                                                                                                    | Saving: each changed editor saves in turn, as a draft when the profile has one, so leaving never applies a draft, and Save, Discard and Cancel wait until the saves end.                                                                                                                                                                     |
| Saving           | Every save ends                                                                                         | It goes on when no editor has changes left; otherwise it opens the first one that does on the profiles page, with its error, its Out of date choice, why it can't be kept as a draft, or that its file is gone, even when a search hides it, and stays.                                                                                      |
| Asking           | Discard                                                                                                 | Every changed editor that can discard does. It goes on when none has changes left; an editor still loading keeps its changes, opens, and it stays.                                                                                                                                                                                           |
| Saving or asking | A save failed, or an editor still loading kept its changes, while a capture runs                        | It stays, but opens nothing, since that would close the new profile form and stop its capture. A notice names the profile and why, such as "orgs could not be saved, so you cannot change the folder yet.", over any notice already showing. It goes once that profile opens or a way out asks again, and the notice it covered shows again. |
| Asking           | Cancel                                                                                                  | Idle, with nothing changed. A new profile form that was open stays open.                                                                                                                                                                                                                                                                     |
| Asking           | Another change of folder, connect, or close of the window, or a close of a profile with unsaved changes | Asking, about the new act: every editor, or only the profile closing. The earlier one stays where it was, as if cancelled.                                                                                                                                                                                                                   |
| Asking           | A close of a profile with no unsaved changes                                                            | The profile closes, and the question stays as it is.                                                                                                                                                                                                                                                                                         |

The folder is picked before the question, so cancelling the folder picker asks
nothing.

### Deleting a profile

The list's context menu and shortcut, and the editor's **Delete profile**,
ask through `ProfilesViewModel.AskDelete`, which sets `Deleting` and words the
question. The question warns rather than blocks: it names every listed profile
that extends this one, directly or through another, and says unsaved changes
are discarded. For a config repository it says what GitHub keeps, from
`.repotted-sync.json`: the file whole when its blob id matches the record,
only the synced version when it doesn't, and nothing for a file the record
lacks or a link. A Removed editor offers no delete, since its file is already
gone; **Reset** lets it go. While the new profile form is open, a
right-click opens a profile's menu without selecting the profile, since
selecting one closes the form.

| State    | Event                                                 | Next                                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle     | Delete a profile                                      | Asking, about that profile; asking about another replaces it.                                                                                                                                                                                                                                                                                  |
| Asking   | Cancel                                                | Idle, with nothing changed.                                                                                                                                                                                                                                                                                                                    |
| Asking   | The profile's edits change, or the list is read again | Asking, worded again. Idle when the list no longer has the profile.                                                                                                                                                                                                                                                                            |
| Asking   | The profile's editor is loading or saving             | Asking, with **Delete profile** off until it ends, so a save never lands after the delete.                                                                                                                                                                                                                                                     |
| Asking   | Delete profile                                        | Deleting: a turn in the folder's `WriteAsync`, so it waits for a running save or sync. `DeleteRunning` holds until the list is read again: the page, the leave choices and every delete are off, and `Busy` holds.                                                                                                                             |
| Deleting | Its turn comes, in the same folder                    | The folder's entry for the profile is deleted (a link, not what it points to), its editor leaves the cache, and a question about closing it is taken back. If it was open, it closes as if the user closed it, so no other profile opens in its place; another open profile stays open. A folder with no entry of that name counts as deleted. |
| Deleting | The entry can't be told, or deleting it fails         | Idle, with a notice that names the profile and why. The file and its editor stay. An entry can't be told when the folder can't be read, or two entries of that name could each be it.                                                                                                                                                          |
| Deleting | Its turn comes after another folder opened            | Idle, with nothing deleted.                                                                                                                                                                                                                                                                                                                    |
| Deleted  | A config repository                                   | A sync, which pushes the delete as its own commit, or shows a conflict when the file changed on GitHub; Keep mine pushes the delete and Use GitHub's brings the file back.                                                                                                                                                                     |
| Deleted  | The sync ends, or there is no repository              | The folder is listed again, the new profile form checks its name again, and Idle.                                                                                                                                                                                                                                                              |
| Any      | The folder changes                                    | Idle: the question goes with the folder.                                                                                                                                                                                                                                                                                                       |

`ProfileFolder` remembers which conflicts are files deleted here, so the
conflict banner and the note after a sync say so, for one file or several.

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

The form's owner type goes into the file it writes as `owner_type`, except
for a capture, which writes the repository's own, and a profile that extends
a typed base, which takes the base's and writes none.

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

## Releases

Release CLI and Release Desktop release the CLI and the desktop app, as
[Releasing](releasing.md) describes. Releases of each wait in one concurrency
group, so a run's checks see what the run before it released; test builds,
runs with Publish not selected, wait in a group for each branch. A release
run, one with Publish selected, moves through these states. A test build stops
after Packaged, reports a refused version as a warning, and attests,
publishes, and releases nothing. Re-running a failed job reuses the run's
commit and artifacts, which last 3 days; GitHub allows a re-run for 30 days.

| State     | Event                                        | Next                                                                                                                                                                                        |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued    | The release before it ends                   | Verifying.                                                                                                                                                                                  |
| Queued    | 100 runs are already waiting                 | The new run is cancelled.                                                                                                                                                                   |
| Verifying | Not on `main`, or the version's tag exists   | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The CLI's version is already on npm          | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The gate fails                               | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The checks and the gate pass                 | Packaging: the CLI tarball, or the app on each platform.                                                                                                                                    |
| Packaging | A desktop platform fails                     | No attestation or release; re-running the failed job builds that platform again.                                                                                                            |
| Packaged  | The attestation fails                        | Nothing is published; re-running the failed job attests the same files while the artifacts last, and otherwise re-running all jobs builds them again.                                       |
| Attested  | npm refuses the CLI                          | Failed. No tag or release exists; re-running the failed job publishes the attested tarball while the artifact lasts, and otherwise re-running all jobs packs, attests, and publishes again. |
| Attested  | npm already has this exact tarball           | Releasing, without a second upload, as on a re-run after npm took the first.                                                                                                                |
| Attested  | npm accepts the CLI, or desktop attests      | Releasing.                                                                                                                                                                                  |
| Releasing | npm doesn't serve the new CLI in 5 minutes   | No tag exists; re-running the job waits again.                                                                                                                                              |
| Releasing | Creating the draft or attaching a file fails | No tag exists. Re-running the job deletes any draft the attempt left and starts again.                                                                                                      |
| Releasing | GitHub refuses to publish the draft          | The draft stays without a tag, as when a ruleset blocks creating the tag. Re-running the job, once the cause is fixed, replaces the draft and publishes.                                    |
| Releasing | The tag already holds the release            | Released, as on a re-run after GitHub published the release but the job failed. A tag at another commit fails the job.                                                                      |
| Releasing | The release is published                     | Released. Publishing creates the tag at the run's commit, and an immutable release can't change, so a fix needs the next version.                                                           |

Deploy Web deploys the web app, as [the web app](web-app.md#deploy) describes.
By default it deploys the Preview named for its branch, `main`, and leaves
repotted.dev's version live; with Publish it deploys to repotted.dev. Previews
and publishes each wait in a concurrency group of their own, so the last one
started stays live, and a preview never holds up a publish. A run on another
branch fails before it checks out anything, and one whose `ts:web:check` fails,
or whose environment lacks a value, deploys nothing. A preview run fails after
its deploy when the Preview has no address on a custom domain. When Cloudflare
refuses a deploy, the version before it stays live; re-running the job tries
again.

When npm has the CLI but its release is missing, a new run refuses the
version, so re-run the failed jobs of the run that published it; the release
job downloads the tarball from npm and needs no artifact. When a desktop
release job fails after its artifacts expire, a new run on `main` builds,
attests, and releases the version again, since its tag doesn't exist, and the
first run's attestations then name packages that were never released.
