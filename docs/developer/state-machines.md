# State machines

Several parts of Repotted move through states that no type names: a sign-in,
a sync, an open profile, a running capture. This page lists each one, its
states and the transitions between them, and the failure states it can reach.
A failure that leaves the user worse off than the state they started from
links to the issue that tracks it.

## Token sources

Every command that talks to GitHub resolves a token in `resolveToken`
(`packages/cli/src/auth/sign-in.ts`). The first source that yields a token wins.

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
fails with `kind: error`, so a program that reads the output can tell a
sign-in that is gone from a problem that may pass.

## Device flow

`repotted login` runs the GitHub App device flow (`packages/cli/src/auth/device-flow.ts`, `startSignIn` in
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

## Web sign-in

The web app signs in through its Worker (`packages/web/src/worker.ts`), and
each tab asks it for the access token through a `Session`
(`packages/web/src/app/account/session.ts`). [The web app](web-app.md#sign-in) explains the
cookies. All tabs share the access token the access cookie keeps, since each
refresh revokes the one before.

| State      | Event                                                                  | Next                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed out | The user presses **Sign in with GitHub**                               | On GitHub, with the state and verifier in the sign-in cookie for 10 minutes. Starting again, in this tab or another, replaces them.                                                          |
| On GitHub  | The user cancels                                                       | Signed out with "The sign-in was cancelled on GitHub."; the sign-in cookie is cleared.                                                                                                       |
| On GitHub  | GitHub returns any other error, such as an unlisted callback URL       | Signed out with "GitHub didn't complete the sign-in.", with GitHub's error code when it's one GitHub documents for a sign-in; GitHub's token endpoint isn't called.                          |
| On GitHub  | The callback's state doesn't match, or the cookie is gone              | Signed out with "That sign-in expired."; GitHub isn't called. A sign-in that another start replaced ends here.                                                                               |
| On GitHub  | GitHub refuses the code, or answers without a refresh token            | Signed out with "GitHub didn't complete the sign-in.", with GitHub's error code when it's one GitHub documents for a sign-in, or else a status that isn't a success; no token cookie is set. |
| On GitHub  | GitHub is out of reach, too slow, or fails on its side                 | The same, with the status where one came back, or "Cloudflare couldn't connect to GitHub" for Cloudflare's own.                                                                              |
| On GitHub  | GitHub issues tokens                                                   | Signed in: the cookies hold the refresh token and the access token, and the sign-in cookie is cleared.                                                                                       |
| Signed in  | A tab needs a token and holds one with over 5 minutes left             | That token is used.                                                                                                                                                                          |
| Signed in  | A tab needs a token and holds none, or one closer to expiry            | Under the site-wide lock, the tab asks the Worker, which returns the kept access token if it has over 5 minutes left. A call in the same tab that waited uses what it got.                   |
| Signed in  | The kept access token has 5 minutes or less left, or is gone           | Refreshing.                                                                                                                                                                                  |
| Signed in  | GitHub's API refuses a tab's token                                     | The tab names that token to the Worker under the lock. If the kept token differs, another tab replaced it, and the tab gets the new one; if not, Refreshing. It tries once more.             |
| Signed in  | GitHub's API refuses the token from that second try too                | The page reads the sign-in as signed out and offers to sign in again.                                                                                                                        |
| Refreshing | GitHub issues tokens                                                   | Signed in with both new tokens in the cookies; GitHub has revoked the old access token.                                                                                                      |
| Refreshing | No refresh cookie, or GitHub refuses the refresh token                 | Signed out in this tab. The cookies are left as they are, since another tab may have stored newer ones; a spent or revoked token is refused again until it expires.                          |
| Refreshing | GitHub, or the Worker, is out of reach, too slow, or fails on its side | The tab keeps the token it held, near or past expiry, and reports which of the two failed; the cookies are kept for the next try.                                                            |
| Signed in  | The user signs out                                                     | Signed out: under the lock, the Worker clears both token cookies, so a refresh that another tab started can't store tokens afterwards. Other tabs keep their token until it expires.         |
| Signed in  | The refresh token's 6 months pass                                      | The browser drops the cookie; the next refresh reads as signed out.                                                                                                                          |

## Web account

`Account` (`packages/web/src/app/account/account.ts`) holds who is signed in to the
tab. The app draws the sign-in page in every state but Signed in.

| State        | Event                                                                       | Next                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checking     | GitHub names the user                                                       | Signed in.                                                                                                                                                                                                                                                                       |
| Checking     | The browser isn't signed in, or GitHub refuses the token                    | Signed out, with why the sign-in failed when the Worker's redirect gave a reason.                                                                                                                                                                                                |
| Checking     | The check fails for any other reason                                        | Check failed, with what failed and **Try again**. See the table below.                                                                                                                                                                                                           |
| Check failed | Try again                                                                   | Checking.                                                                                                                                                                                                                                                                        |
| Signed in    | Any request in the app gets a 401                                           | Signed out with "GitHub no longer accepts this sign-in."; what the page held goes with it.                                                                                                                                                                                       |
| Signed out   | A request that was under way gets a 401                                     | Signed out, with what it already said.                                                                                                                                                                                                                                           |
| Signed in    | Sign out, with no profile holding unsaved changes                           | Signing out: **Sign out** is off, and a second press sends nothing. Pending applies and batches are discarded first, as when their pages are left.                                                                                                                               |
| Signed in    | Sign out, while an apply or a batch is writing                              | Signed in, with word to sign out once it has finished, since the writes need the sign-in.                                                                                                                                                                                        |
| Signed in    | Sign out, with unsaved changes in a profile                                 | Asking, by the profiles' names, since signing out drops what the editors hold.                                                                                                                                                                                                   |
| Asking       | Save and sign out                                                           | Each unsaved profile without a draft is saved in its own turn; Escape waits meanwhile. Signing out when all are saved and synced. Asking still, with word of it, when one keeps its changes: one that can't be saved, or one with a draft, which a save here would apply unseen. |
| Asking       | Save and sign out, and all are saved but the sync failed or left a conflict | Asking whether to sign out before the changes are synced: Sign out anyway, or Stay signed in.                                                                                                                                                                                    |
| Asking       | Discard and sign out                                                        | The changes are dropped: Signing out.                                                                                                                                                                                                                                            |
| Asking       | Stay signed in, or Escape while no save runs                                | Signed in, with every change kept.                                                                                                                                                                                                                                               |
| Signing out  | The Worker clears the cookies                                               | Signed out with "Signed out."                                                                                                                                                                                                                                                    |
| Signing out  | The Worker can't be reached or fails                                        | Signed in, with "Signing out didn't finish. Try again." on the page and in the account menu until the next sign-out. Changes discarded on the way stay discarded.                                                                                                                |

A failed check names its cause, which `signInCheckFailure` in `account.ts`
reads from the error and its causes:

| Cause                                                                        | The page says                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The Worker gives no answer, or none in 20 seconds                            | Repotted's sign-in service didn't answer.                          |
| The Worker answers 502 `unavailable`: GitHub's token endpoint failed         | The sign-in couldn't be renewed just now, and what came back.      |
| The Worker answers any other error                                           | Repotted's sign-in service answered with an error, and its code.   |
| The Worker answers with no access token, such as with a page                 | Repotted couldn't read the sign-in service's answer, and its code. |
| A request to GitHub's API gets no answer, such as a blocked `api.github.com` | Repotted can't reach GitHub.                                       |
| GitHub's API answers with a rate limit                                       | The limit is used up, until the time GitHub gives when it does.    |
| GitHub's API answers 500 or more                                             | GitHub is having trouble, and its code.                            |
| GitHub's answer about the account isn't one Repotted can read                | GitHub's answer about the account couldn't be read.                |
| Anything else                                                                | Checking the sign-in failed, with the error's message.             |

**Try again** checks again with what the first check would have said when signed out, such as why a sign-in had just failed.

Edits to a profile whose file can't be read, including YAML corrections,
count as unsaved and are asked about too. A sign-in GitHub refuses
mid-visit asks nothing.

## Web confirmations

`Notifications` in `packages/web/src/app/notifications.ts` owns one confirmation,
its remaining interval, timer, pause reasons, and disposed flag. The signed-in
shell owns the instance; page navigation leaves it alive. The view tracks
hover, keyboard focus, open dialogs, and page visibility independently.

| State            | Event                                                | Next state                                                                                                                              |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Empty or visible | A deliberate action completes successfully           | Replace the confirmation and its announcement identity, even for identical text, and give it five seconds, starting only when unpaused. |
| Counting down    | Hover, focus, a dialog, or a hidden page             | Cancel the timer, subtract elapsed time, and record the pause reason.                                                                   |
| Paused           | One reason ends                                      | Remove that reason; resume the remaining time only when no reasons remain.                                                              |
| Visible          | Its remaining time elapses or **Dismiss** is pressed | Clear the confirmation and timer.                                                                                                       |
| Any              | Signed-in shell unmounts                             | Clear the confirmation and timer, mark disposed, and ignore late completions.                                                           |

Failed syncs, conflicts, capture omissions, and partial or stale apply results
keep their durable notices. They never become successful confirmations.
Browser preferences confirm only when storage accepts the write or removal.
Batch actions confirm once on completion. A batch apply's individual profile
record saves stay silent, including retries; its success confirmation waits
for all included repositories and their records to finish successfully.
Ordinary profile creation that finishes after its form closes still confirms
through the signed-in shell; it leaves the current route alone. A canceled
capture does not confirm.

## Web pending controls

`usePendingAction` in `views/layout/pending-button.tsx` tracks one control's
pending flag, synchronous activation lock, and mounted state independently of
other controls disabled by the same shared work queue.

| State   | Event             | Next state                                                                                            |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| Idle    | Activate          | Lock immediately, display pending feedback, and start the operation from the gesture.                 |
| Pending | Activate again    | Keep the existing operation; suppress another submission.                                             |
| Pending | Fulfill or reject | Release the lock and reset pending presentation if mounted; the owning operation reports its failure. |
| Any     | Unmount           | Stop updating the control; let the owning operation finish normally.                                  |

The new-profile form distinguishes file reading from creation, so reading an
import keeps **Create** disabled without claiming that creation has started.
The sign-out question also remembers whether it is saving or discarding so
only the chosen action shows progress. Pending buttons expose a busy state
without losing focus, and reduced motion keeps their indicator static.

## Web repositories

`Repositories` (`packages/web/src/app/repositories/repositories.ts`) holds the repository
list for one sign-in.

| State               | Event                                                              | Next                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No list             | The page opens                                                     | Reading, with "Reading your repositories…".                                                                                                                                                       |
| Reading             | GitHub answers                                                     | The list, grouped by owner, once the [shared preferences](#web-shared-preferences) are read again too. An opened repository stays open when the new list still has it, and so does the selection. |
| Reading             | GitHub answers with an installation that lacks permissions         | The list, with a notice for each shown owner whose installation hasn't accepted every permission the Repotted App asks for, until a read finds them accepted.                                     |
| Reading             | Refresh                                                            | Nothing: the read under way finishes, and the button is off.                                                                                                                                      |
| Reading             | The read fails                                                     | The list it had, if any, with why above it.                                                                                                                                                       |
| Reading             | GitHub answers 401                                                 | The account is signed out, as above.                                                                                                                                                              |
| A list              | Refresh                                                            | Reading, with the list dimmed and in use.                                                                                                                                                         |
| A repository opened | A search, a filter, a hidden owner, or a hide takes it out of view | Its panel closes. It opens again when it comes back into view.                                                                                                                                    |

Refresh waits after the read it started, so repeated presses don't spend the
account's GitHub requests. The opening read starts no wait. The wait counts
down in this tab alone and is never saved.

| Refresh | Event                                   | Next                                                                                                                                                                                          |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready   | Refresh                                 | Reading, as in the table above.                                                                                                                                                               |
| Reading | The read that Refresh started ends      | Waiting for `refreshPause`, 15 seconds, counting down on the button, unless a longer wait holds.                                                                                              |
| Reading | The read fails with GitHub's rate limit | Waiting until GitHub's `retry-after` or `x-ratelimit-reset` time, or for a minute when it gives neither or gives a time already past by this device's clock, which may run ahead of GitHub's. |
| Waiting | Refresh                                 | Nothing: the button is off, and stays focusable.                                                                                                                                              |
| Waiting | The wait runs out                       | Ready.                                                                                                                                                                                        |

It keeps the owners the list hides, by login, under `hidden-repository-owners`
in its [shared preferences](#web-shared-preferences), or nothing when it hides
no owner. A hidden owner matches its login in any case. Keeping the hidden
owners rather than the shown ones means an owner new to the list shows.

| Hidden                  | Event                                                | Next                                                                                           |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Any                     | An owner is deselected or selected                   | That owner added or taken out, saved.                                                          |
| Any                     | Only personal                                        | Every owner in the list but the signed-in account, saved.                                      |
| Any                     | Show all                                             | None, saved as nothing.                                                                        |
| Some owners             | The list is read again                               | The hidden owners in the list stay hidden; an owner new to it shows.                           |
| An owner not in list    | An owner is selected or deselected, or Only personal | The owner not in the list stays hidden, with the new choice, saved.                            |
| Every owner in the list | The list is read again or the page opens             | The list shows no repositories and says every owner is hidden; the filter shows **No owners**. |

It keeps the hidden repositories, by `owner/name` in lowercase, under
`hidden-repositories`, or nothing when it hides none. Show hidden is not
kept: each visit starts with the hidden repositories out of the list.

| Hidden repositories | Event                             | Next                                                                                                                            |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Any                 | Hide one or the selected          | Those added, saved, and deselected; the note above the list offers Undo for those that weren't hidden already, and takes focus. |
| Just hidden         | Undo                              | Those taken out, saved, selected again if they were, and the note gone.                                                         |
| Just hidden         | Open, Show hidden, or Refresh     | The note gone; the hidden stay hidden.                                                                                          |
| Some                | Show hidden                       | The list shows them, marked Hidden; the count and the search include them.                                                      |
| Some                | Show in list                      | That repository taken out, saved.                                                                                               |
| One not in the list | The list is read again            | It stays hidden, so it is still hidden if it returns.                                                                           |
| Every one shown     | Show hidden off                   | The list says every repository here is hidden and offers Show hidden, whatever the search.                                      |
| Some                | A search that matches only hidden | The list says no repository matches, how many hidden ones do, and offers Show hidden.                                           |

It keeps the user's folders under `repository-folders`, as a list of
`{ name, repositories, profiles?, applyProfilesOnMove? }` with the repositories by `owner/name`, sorted by
name, or nothing when there is no folder. It keeps the closed folders, by
name, under `closed-repository-folders` in this browser alone, wherever the
profiles are, so opening or closing a folder commits nothing. Folder names and repository names
match in any case. A repository is in one folder at most; a filed repository
shows in its folder and not under its owner. A folder shows the repositories
its owner's group would: none of a hidden owner, and no hidden repository
unless hidden ones show.

| Folders                       | Event                                              | Next                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any                           | New folder with a free name                        | The folder, saved, with the selected repositories, deselected, or the one repository whose **Folder** picked it, selection unchanged, if chosen. Made with the selected repositories, it takes the focus, if it shows.                           |
| Any                           | New folder or Rename with a taken name             | Nothing saved; the dialog says which folder has the name. An empty name is refused the same way.                                                                                                                                                 |
| A folder                      | Rename                                             | The new name, saved; a closed folder stays closed.                                                                                                                                                                                               |
| A folder                      | Delete folder, confirmed                           | The folder and its closed state gone, saved; its repositories go back under their owners.                                                                                                                                                        |
| Any                           | Move, or a repository's own **Folder**             | Those repositories out of every folder and into that one, saved; the panel's Move deselects them and puts focus on that folder, or **New folder**. **No folder** files none.                                                                     |
| An open one with repositories | **Select all** beside its name                     | Its repositories selected, others as they were; once all are, the button reads **Deselect all** and deselects only them. **Deselect all** beside **New folder**, or in the selected panel, deselects every one and puts focus on **New folder**. |
| A folder                      | Its heading clicked, with no search                | Open or closed, kept in this browser. Closing the opened repository's folder closes its panel until the folder opens.                                                                                                                            |
| Folder menu open              | Header crosses the phone breakpoint                | Menu closed. Focus returns to the menu button if it was inside or its action was removed; focus elsewhere stays there.                                                                                                                           |
| Folder selection focused      | Header becomes a phone layout                      | Focus moves to the folder menu button when the desktop selection action is removed.                                                                                                                                                              |
| Some                          | A search                                           | A folder whose name matches shows all it shows; another shows the matching ones; each shows open.                                                                                                                                                |
| A folder with none in view    | No search, or a search for its name, and no filter | An empty folder shows, saying how to fill it; one whose repositories are all hidden doesn't show. With a filter on, neither shows.                                                                                                               |
| A repository not in the list  | The list is read again                             | It stays filed, so it is in its folder again if it returns.                                                                                                                                                                                      |
| A hand-edited file            | It is read                                         | A folder named twice, or a repository in two folders, counts only the first time.                                                                                                                                                                |

Each folder change is saved as a change to the folders, not as the list
that showed, so it applies to the folders the file holds when it is read
or saved, and keeps any made elsewhere. A folder made meanwhile elsewhere
with the same name takes the repositories instead of a second folder, both
when one is made and when one is renamed to that name. A move into a folder
deleted elsewhere meanwhile makes it again, so no repository loses its filing.

Folder profiles default to no profiles and review on move off. Profiles are
paths in the profiles folder, ordered and deduplicated. Profiles are shared
with membership, not with the browser's closed state. The folder's **Profiles**
dialog edits its layers and **Apply profiles to repositories moved here**;
[Folder profile dialog](#folder-profile-dialog) describes its save and apply actions.

| Folder profiles                    | Event                                                                  | Next                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any                                | Header **+**, then a profile                                           | The profile appended to the current saved layers, once; review-on-move kept and the picker closed. No review opens.                                                       |
| Picker open                        | Escape or a click outside                                              | Picker closed, nothing added; Escape returns focus to **+**.                                                                                                              |
| Header profile tags                | Tags exceed the available width                                        | One count badge replaces the tags; **+** stays available, and the phone header stays on one row.                                                                          |
| Header profile count               | Resize or changed tags leave enough space                              | The ordered tags show again; the same button keeps keyboard focus.                                                                                                        |
| Header profile tags or count       | Last profile removed and saved                                         | The tags or count go; **+** stays and takes focus, and the header releases the profile label's space.                                                                     |
| Header tags or count               | Click                                                                  | **Profiles** opens with the full ordered list; closing returns focus to that header control.                                                                              |
| Review on move, with layers        | A local move puts one repository into the folder                       | Membership saved, then the usual single apply review of its effective layers opens. Nothing is applied.                                                                   |
| Review on move, with layers        | A local move puts several repositories into the folder                 | Membership saved, then one batch review opens, each repository with its effective layers. Nothing is applied.                                                             |
| Any                                | A move includes repositories already in that folder                    | Only newly entering repositories count toward the review.                                                                                                                 |
| Review off, or no folder layers    | A local move into the folder                                           | Membership saved; no review.                                                                                                                                              |
| Any                                | A move out, folder rename or deletion, or settings read from elsewhere | Inherited layers and profile status updated; no review and no changes to repository settings.                                                                             |
| Review opened by a move            | A profile is missing, planning fails, or the review is left            | The usual apply or batch failure, or its temporary files discarded; the membership stays saved.                                                                           |
| A single or batch apply is writing | A local move would open a review                                       | Membership saved; the active apply stays. A dismissible shell notice names the moved repositories and asks for a manual review from their panels when the write finishes. |

It keeps the sort order under `repository-sort-order` and the filters, as
`{ visibility, archived, topics }`, under `repository-filters`, both in this
browser alone, wherever the profiles are, so neither commits anything. Each
key is removed when its choice is back at the default: by name from A to Z,
and no filter. A saved value it can't read counts as the default, and a
filter part it can't read counts as off. Neither is per account.

| Sort and filters    | Event                                                   | Next                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any                 | A sort order picked                                     | Each folder and owner group in that order, saved; the order of folders and of owners stays. By last push, a repository GitHub gives no push time for goes last.                         |
| No filter           | Visibility, archived, or a topic chosen                 | Only the repositories that pass show, in folders and under owners; the count counts them; a chip shows for each filter; saved.                                                          |
| Filtered            | A chip clicked                                          | That filter off, saved; focus moves to the chip now in its place, else the one before it, else the search.                                                                              |
| Filtered            | A choice in Filter set back to Any, or a topic unticked | That filter off, saved.                                                                                                                                                                 |
| Filtered            | Clear filters                                           | No filter, and the key removed; focus moves to the search, or stays in the open menu.                                                                                                   |
| Filtered            | Nothing passes                                          | The list says no repository matches these filters, with the search if there is one, and offers Clear filters; when hidden ones would pass, it says how many and offers Show hidden too. |
| A topic chosen      | The list is read again without it                       | It stays chosen and offered, with a count of none, so it can be taken off.                                                                                                              |
| Filtered, selection | A selected repository is filtered out                   | It stays selected.                                                                                                                                                                      |

Topics match when a repository has any of the chosen ones; the filters
combine with each other and with a search, so a repository shows only when
it passes all of them. Each topic in the menu counts the repositories that
would pass with it, leaving the topic filter out.

The selected panel's **Move to a folder** shows **Choose a folder**, with
**Move** off, until a choice is made there. It then shows that choice, or
the folder made from there, under any name it was given since, until that
folder is deleted or nothing is selected, including when a refresh drops
every selected repository from the list. It is not kept.

A browser that refuses storage keeps the choice for the visit only. Every
list is read from the shared preferences each time, so a file read from
the profiles repository changes what the list hides as soon as it arrives.
Each save is a change to the list, such as adding a name or taking one out,
not the list as this page last saw it, so it keeps names another browser
saved meanwhile.

### Folder profile dialog

`FolderSettings` (`packages/web/src/app/repositories/folder-settings.ts`)
holds one dialog's draft and saved baseline. Applying uses every stored
member, independent of the repository list's search, filters, or hidden
owners. Folder layers precede each member's own profiles.

| State                             | Event                                                                                                       | Next                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved                             | Open **Profiles**                                                                                           | Saved, with **Apply** available when both profiles and members exist. **Save** and **Save and apply** are unavailable.                                   |
| Saved or edited                   | Change profiles, their order, or review on move                                                             | Edited, unless the draft matches the baseline. **Apply** is unavailable while edited.                                                                    |
| Saved or edited                   | Pending folder preferences, a failed save reverted to its baseline, or changed settings read from elsewhere | Unsaved until the displayed settings are persisted and match the current folder. **Apply** remains unavailable; **Save** can persist the displayed list. |
| Edited                            | **Save**                                                                                                    | Saving, with controls and Escape blocked until persistence finishes.                                                                                     |
| Edited, with profiles and members | **Save and apply**                                                                                          | Saving, as above; a successful save is followed by a review of all members.                                                                              |
| Saving                            | Repeated action                                                                                             | Ignored; the original save finishes.                                                                                                                     |
| Saving                            | Persistence fails or browser storage refuses                                                                | Edited with the draft retained and an error. No review opens; saving can be retried.                                                                     |
| Saving                            | Another folder change is pending or replaces the displayed settings before review starts                    | Unsaved with an error; no review opens. The displayed settings can be saved again.                                                                       |
| Saving                            | **Save** succeeds                                                                                           | Closed, with settings persisted and no review.                                                                                                           |
| Saving                            | **Save and apply** succeeds                                                                                 | Single review for one member, batch review for several. Nothing applies until the reviewed plan is confirmed.                                            |
| Saved, with profiles and members  | **Apply**                                                                                                   | The same review, without a settings write.                                                                                                               |
| Opening a review                  | A single or batch apply is writing                                                                          | Saved, with an error and **Apply** available to retry after the write finishes.                                                                          |
| Any                               | The folder has no profiles or members                                                                       | Apply actions unavailable; edits can still be saved.                                                                                                     |
| Saved or edited                   | Close, Cancel, or Escape                                                                                    | Closed, with no save or review.                                                                                                                          |
| Saving                            | The dialog unmounts                                                                                         | Closed; the save finishes, but cannot open a review or close another dialog.                                                                             |
| Saving                            | The folder is deleted elsewhere before the save                                                             | Error, without recreating the folder or opening a review.                                                                                                |

## Web repository profiles

`RepositoryProfiles` (`packages/web/src/app/repositories/repository-profiles.ts`)
keeps which profiles each repository uses, in the order they apply, in the
[shared preferences](#web-shared-preferences), so the list follows the
profiles to their config repository. Under `repository-profiles` it keeps,
by `owner/name` in lowercase, `{ profiles, applied, authoritative, appliedAuthoritative }`
(read by `packages/web/src/app/repositories/saved-assignments.ts`): `profiles` are paths
in the profiles folder, such as `web/node.yaml`, and `applied` is each
profile's version at the last apply that recorded, in the order applied.
`profiles` holds only the repository's own layers; the effective list starts
with its folder's layers, then its own, keeping the first occurrence of a
path. Applied versions describe that effective list. A repository with only
inherited layers may have an empty own list with applied versions.
`authoritative` is the repository's optional ownership list, and
`appliedAuthoritative` is the last reviewed list recorded after a full apply.
Omitting either means partial management. Ownership covers the entire
combination, including folder profiles; folders have no ownership defaults.
An owned assignment can have no profiles and deliberately reconcile an empty
section.
A version is a hash of what the profile sets with what it extends, so an
edit to its drafts or comments changes nothing. Under `profile-tags` it
keeps, by profile path, the tags people chose. Every other profile gets a
tag of up to 12 characters made from the start of its name, with more of the
name or a number when that is taken, so each tag is its own. Tags are given in
path order, so a new profile that sorts first can take a made tag from
another; a chosen tag never changes.

A repository's status comes from its list, the profiles folder and the
versions, which `check` reads again whenever the list of profiles or the
saved lists change.

| Status      | When                                                                                                    | Shows                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| None        | The repository uses no profile                                                                          | Nothing on its row; the panel offers Edit.                                                           |
| Checking    | A version isn't read yet                                                                                | The tags; **Review apply** off.                                                                      |
| Missing     | A profile is gone from the folder, can't be read as one, or stopped resolving when its version was read | **Missing profile** on the row; the panel names each and turns **Review apply** off.                 |
| Not applied | None of them has been applied by a recording apply                                                      | **Not applied** on the row; the panel offers **Review apply**.                                       |
| Changed     | One changed, was added or was taken out since the last apply, or their order or ownership changed       | **Profile changed** on the row, **Changed** on a phone; the panel says which, with **Review apply**. |
| Current     | Each was applied at its version now, in this order                                                      | The tags alone.                                                                                      |

| State              | Event                                                                          | Next                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any                | Edit, then Save                                                                | Its own list as the dialog left it, saved; an empty one removes the entry unless folder layers or ownership remain. Applied versions stay, so status says what changed. Nothing is applied. |
| Any                | Folder layers or membership change                                             | Effective layers updated; status compares them with the last recorded versions. The own list stays as it is.                                                                                |
| Any                | Edit, then Cancel or Escape                                                    | Nothing saved.                                                                                                                                                                              |
| A row              | It shows                                                                       | Up to three tags, or two on a phone; with more, **N profiles**, which lists them in order on hover. A phone opens the panel instead.                                                        |
| A hand-edited file | It is read                                                                     | A repository whose entry isn't a list of paths counts as using none.                                                                                                                        |
| Any                | Its saved ownership names a section the app doesn't offer, such as `autolinks` | That section is dropped from both ownership lists, so it is partially managed and status ignores it. The next save writes the filtered lists. Other assignments are unaffected.             |

| State                | Event                                                | Next                                                                                                              |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Any                  | Ownership saved or refreshed from config preferences | Effective ownership changes locally; applied ownership stays, so status reports the change. No repository writes. |
| Owned                | Ownership disabled or assignment removed             | Future reviews stop enforcing it; previously deleted resources stay deleted.                                      |
| Reviewing            | Effective profile order or ownership changes         | Old review refused; single review-again starts from current assignment, and a batch needs a fresh start.          |
| Reviewed             | Assignment changes during engine revalidation        | The post-revalidation guard refuses before any writes for that repository.                                        |
| Reviewed             | One-time ownership differs from the saved assignment | The reviewed changes may apply, but assignment choices and baseline stay unchanged.                               |
| Reviewed, no changes | Record as applied                                    | Engine revalidation must still find no changes before the reviewed ownership and versions are recorded.           |
| Current sources      | An extra resource appears on GitHub                  | Source status stays current; the next comparison shows live drift, including authoritative removals.              |

`repositoriesWithProfiles` names the repositories that use any profile, and
`profilesOf` gives one repository's list, so a filter on the repository list
can read both without parsing the file.
`changedRepositories` names those whose status is Changed, from each
repository's own assignment and its folder's layers. `changedInView` in
`app/repositories/profile-reviews.ts` keeps those the list shows before a
search, by their full names. The repository list shows a notice with how many
changed; **Review apply to N repositories** starts one review of each
repository's effective layers, as a folder move does: a single review for one,
a batch for more. The button is off while an apply or batch writes.

## Web shared preferences

`SharedPreferences` (`packages/web/src/app/preferences/shared-preferences.ts`) keeps the
preferences that follow the user where the profiles are. Its saves and reads
run one at a time, in order. It is given the profiles' place when it is made,
so the first list read already knows what that place hides.

A change is kept as the change (`update(key, change)`, a function from the
value now to the next; `write` is one that ignores the value now), not as
its result, until it is saved. What a preference reads is the file as last
read or saved with the unsaved changes made onto it in order. A save makes
the same changes onto the file as it is then.

`save(key, change)` returns whether its queued change persisted in the
current destination. A storage refusal, failed commit, or destination
change returns false; callers do not start dependent reviews on that result.

| State             | Event                                      | Next                                                                                                                                                            |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In the browser    | Profiles kept in a config repository       | Reading `.repotted-preferences.json` beside the profiles; until it is read, the unsaved changes made onto nothing.                                              |
| Reading           | GitHub answers                             | In the repository, with the file's values and the unsaved changes made onto them. A file that is missing, not JSON, or not an object reads as empty.            |
| Reading           | A change                                   | It shows at once, made onto what is known; it is made onto the file's values when the read finishes, then saved.                                                |
| Reading           | The read fails                             | In the repository with the unsaved changes made onto nothing, and why above the list. A refresh reads again.                                                    |
| In the repository | A change                                   | It shows at once; saving.                                                                                                                                       |
| In the repository | Refresh on the repositories page           | Reading again, so changes saved elsewhere show. A read under way is the one waited for.                                                                         |
| Saving            | —                                          | Reads the file again, makes the unsaved changes onto it, and commits it only if that changes it. Changes made meanwhile go in the next commit.                  |
| Saving            | GitHub answers 409 or 422                  | The file changed or was made elsewhere since it was read: read again and try again, up to three tries in all.                                                   |
| Saving            | The commit fails otherwise                 | The changes stay unsaved and show here, and why shows above the list until they are saved. The next change or the next read, such as Refresh, saves them again. |
| Reading or saving | GitHub answers 401                         | The account is signed out.                                                                                                                                      |
| In the repository | Profiles kept in the browser or a folder   | In the browser, with the browser's values. Changes made for the file are still saved there; any that fail are saved again when that file is read again.         |
| In the repository | Profiles kept in another config repository | Reading that repository's file, as above. Changes made for the old one are still saved there, not here.                                                         |

Two browsers that change different keys, or add different names to the same
list, both keep theirs. A browser shows a change saved elsewhere at its next
refresh or visit. Every change is its own commit, unless it is made while
another is saving.

## Web profiles source

The `listed` flag starts false and resets when the source changes. Only a
successful list read sets it true. Before that read completes, the page shows
a loading state; an error shows the failure instead of an empty list. Later
refreshes keep the successful list visible while work runs.

`Profiles` (`packages/web/src/app/profiles/profiles.ts`) keeps where the profiles are,
saved as `profiles-source` in the browser's
[preferences](web-app.md#the-app), and the sync state the pages show. Every
event below waits its turn in one queue.

| State                              | Event                                                                               | Next                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In browser                         | Refresh, or the app opens                                                           | The folder is listed.                                                                                                                                                                                                                                               |
| On GitHub                          | Sync, or the app opens                                                              | Syncing, then listed.                                                                                                                                                                                                                                               |
| Syncing                            | It records                                                                          | In sync, or conflicts when any file changed on both sides.                                                                                                                                                                                                          |
| Syncing                            | It fails                                                                            | Not synced, with why; the working copy is listed as it is.                                                                                                                                                                                                          |
| Syncing                            | GitHub answers 401                                                                  | Not synced, and the account is signed out.                                                                                                                                                                                                                          |
| Conflicts                          | Keep mine or Use GitHub's                                                           | Syncing, with `prefer` for the files in conflict only.                                                                                                                                                                                                              |
| Any                                | Use a repository, from the connect form                                             | Connecting: profiles kept now are copied into the repository's working copy if asked, skipping names it has, then it syncs.                                                                                                                                         |
| Connecting                         | The sync records                                                                    | On GitHub, saved, with the working copy listed.                                                                                                                                                                                                                     |
| Connecting                         | The name isn't `owner/name`                                                         | As before, with why; GitHub isn't asked.                                                                                                                                                                                                                            |
| Connecting                         | GitHub answers 401                                                                  | As for a failed sync, and the account is signed out.                                                                                                                                                                                                                |
| Connecting                         | The sync fails                                                                      | As before, with why. A working copy that never synced is removed, and one that had loses only what was copied in.                                                                                                                                                   |
| On GitHub                          | Use this browser                                                                    | In browser, saved; the repository and its working copy keep what they have.                                                                                                                                                                                         |
| In browser, never chosen           | Use this browser                                                                    | In browser, saved, with nothing else reset.                                                                                                                                                                                                                         |
| Any                                | **Choose a folder…** in Settings, in a browser that can give a site a folder        | Picking: the browser's own picker shows. Unsaved changes refuse it first, with why.                                                                                                                                                                                 |
| Picking                            | No folder is picked                                                                 | As before.                                                                                                                                                                                                                                                          |
| Picking                            | A folder is picked                                                                  | Connecting to it, in a working copy made ready apart, after unsaved changes are checked again. Profiles kept now are copied in if asked, skipping names the folder has in any case; what a folder used until now never received is copied in always. Then it syncs. |
| Connecting to a folder             | The sync records                                                                    | In a folder, saved, with the folder remembered in place of any other and the working copy put in place and listed.                                                                                                                                                  |
| Connecting to a folder             | The folder can't be read, or a profile can't be written                             | As before, with why, the profiles kept before untouched, and a folder used before still the one remembered. The folder picked keeps what was written to it before the failure.                                                                                      |
| In a folder                        | Sync, a save, a new profile, a deletion, or the app opens, with the browser's leave | Syncing with the folder, then listed. A profile changed on one side goes to the other; one changed on both is a conflict.                                                                                                                                           |
| In a folder                        | The same, on a later visit, before the browser's leave is given again               | Not synced, needing access: the working copy is listed as the last sync left it.                                                                                                                                                                                    |
| Needing access                     | **Allow access**, and the user agrees                                               | Syncing.                                                                                                                                                                                                                                                            |
| Needing access                     | **Allow access**, and the user or the browser refuses                               | Needing access still, with word that the browser didn't allow it.                                                                                                                                                                                                   |
| Needing access, or the folder gone | A save, a new profile, or a deletion                                                | It lands in the working copy only, and goes to the folder at the next sync that works, or with the next folder chosen.                                                                                                                                              |
| In a folder                        | The browser no longer has the folder                                                | Not synced, with word to choose it again in Settings.                                                                                                                                                                                                               |
| Syncing with a folder              | A profile can't be read or written                                                  | Not synced, with why, once every other profile is settled. What was settled stays settled; the next sync takes the folder afresh from the browser, and asks for the user's leave if the browser took it back.                                                       |
| Syncing with a folder              | A profile made here differs only in case from a file in the folder                  | Conflicts. It is never written, whichever side is kept; Use the folder's removes it here.                                                                                                                                                                           |
| Conflicts, in a folder             | Keep mine or Use the folder's                                                       | Syncing, with that side kept for the files in conflict only.                                                                                                                                                                                                        |
| In a folder                        | Use this browser, or a repository connects, after a sync                            | In browser or On GitHub, saved, and the folder forgotten. The folder keeps every profile it has. While the folder lacks a change made here, it stays In a folder, with why.                                                                                         |

A profile open when the list is read again shows its file as it is then, and
closes when the file is gone.

A folder on the computer syncs through `syncLocalFolder`
(`packages/web/src/app/profiles/local-folder.ts`), which compares the working copy,
the folder, and its own record of what the two last agreed on, kept in the
working copy. A first sync, with no record, deletes nothing on either side.
A working copy is replaced record first and record last, so what the browser
keeps of one cut short never reads as profiles deleted here.
Only profile files sync: a hidden file or folder, or a file of another kind,
is never read, written, or deleted.

A repository that is remembered while its working copy is gone, as after the
browser's storage was cleared, syncs as a first sync. Why the last connect
failed stays in Settings until profiles are moved again. The profiles and
where they are kept belong to the browser, not to the account: whoever signs
in on it sees them, and a sync runs with that account's access.

Each change of where profiles are kept that succeeds then moves the
[config repository's mark](#web-config-repository-discovery): the topic comes
off a repository left for any other place, and a repository connected to
gets the topic and a `.repotted.json` naming its folder, followed by one more
sync when that file was committed. A mark GitHub refuses leaves the change
made, with why in `markProblem` until the next change. A marker commit
refused as out of date counts only when the marker GitHub now has names the
same folder, as when another browser wrote it first. A lost sign-in while
the topic comes off skips the mark.

## Web config repository discovery

`ConfigDiscovery` (`packages/web/src/app/profiles/config-discovery.ts`) looks
once a visit, when the repository list first loads. A repository is marked
when the list shows the `repotted-config` topic on it and it isn't archived.

| State      | Event                                                                                          | Next                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Waiting    | The list loads, and the browser has chosen where profiles are kept                             | Done. A chosen repository the list shows with neither the topic nor a `.repotted.json` is marked first; one with a marker had its topic taken off, by a move elsewhere or by hand, and stays unmarked. |
| Waiting    | The list loads, and no repository is marked                                                    | Done.                                                                                                                                                                                                  |
| Waiting    | The list loads with marked repositories                                                        | Looking: each one's `.repotted.json` is read, and the browser's profiles counted in a turn of the profiles' queue.                                                                                     |
| Looking    | One is marked, its file names a usable folder, and the browser holds no profiles               | Connecting in a turn of the queue: Done if a choice was made since, as in Settings, or Asking if a profile was made here since.                                                                        |
| Looking    | Several are marked, a file is missing or names no usable folder, or the browser holds profiles | Asking, with each repository and its folder, or none to type.                                                                                                                                          |
| Looking    | A file can't be read                                                                           | That repository is offered with no folder, to type.                                                                                                                                                    |
| Looking    | GitHub answers 401                                                                             | Done, and the account is signed out.                                                                                                                                                                   |
| Connecting | It connects                                                                                    | Found, with a notice until **Dismiss** or until the profiles move elsewhere.                                                                                                                           |
| Connecting | It fails                                                                                       | Asking, with why.                                                                                                                                                                                      |
| Asking     | **Use this repository**                                                                        | Busy, connecting as the connect form does, then Done, or Asking with why.                                                                                                                              |
| Asking     | **Keep profiles in this browser**                                                              | Busy, then Done with the browser saved as the choice, or Asking with why.                                                                                                                              |
| Asking     | **Not now**                                                                                    | Done for this visit; the next visit looks again.                                                                                                                                                       |
| Asking     | A choice is made in Settings                                                                   | The notice hides.                                                                                                                                                                                      |

A folder is usable when, with slashes trimmed from its ends, it is empty or
every part is neither empty nor starts with `.`, so it can't name a hidden
folder or leave the repository.

## Web config repository protection

`ConfigProtection` (`packages/web/src/app/profiles/config-protection.ts`) checks the
repository the profiles are kept in against the built-in protection that
fits what owns it. Only a personal repository has one for now. A check only
reads: it plans the built-in with the engine's `createPlan` and counts the
changes. Settings checks again each time it opens while the profiles are
kept in a repository, and forgets the check when they are not. A turn
counter drops a check that lands after a later one or after `forget`.

| State    | Event                                                                      | Next                                                                                                                                           |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Any      | Settings opens with profiles kept in a repository                          | Checking, for that repository.                                                                                                                 |
| Checking | The repository is owned by a user, and the account is its admin            | Checked, with the count of changes the built-in would make and why GitHub can't have part of it, as for a private repository with no rulesets. |
| Checking | The repository is owned by an organization, or the account isn't its admin | None: no offer and no row.                                                                                                                     |
| Checking | GitHub can't be read                                                       | Failed, with why. A lost sign-in also goes to the sign-in page.                                                                                |
| Checking | Another check starts, or the profiles leave the repository                 | Checking the new one, or Idle. The first check's result is dropped when it lands.                                                              |
| Checked  | **Review protection…**                                                     | Checked, with an [apply](#web-apply) started from the built-in, written afresh under `/built-in` so it is this version's.                      |
| Failed   | **Check again**                                                            | Checking.                                                                                                                                      |
| Any      | The profiles move to the browser or a folder                               | Idle.                                                                                                                                          |

The offer above the settings list shows only for the repository just picked,
and only while it is Checked with changes. **Not now** hides it until a
repository is picked again; nothing is saved.

## Web profile editor

`ProfileEditor` (`packages/web/src/app/profile-editor/profile-editor.ts`) holds one open
profile's settings and the changes to them that aren't saved. `Profiles`
keeps an editor for each profile opened since profiles were last moved, so
unsaved changes outlast a look at another profile, and reads each again
whenever the list is read.

### The profile

| State  | Event                                              | Next                                                                                                                                                                                      |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None   | A profile is opened for the first time             | Loading, then Loaded with settings and any configuration errors, or Repair for invalid YAML syntax. A file that cannot be read is Unreadable with why.                                    |
| Loaded | Unknown keys are present                           | Loaded without those keys, with **Save** available for cleanup alone when the known configuration is valid. The file and dirty state stay unchanged until a save.                         |
| Loaded | The list is read again, as after a sync            | Loaded from the file as it is then, with the unsaved changes laid over it again.                                                                                                          |
| Loaded | The profile, or one it extends, can't be read then | Loaded with configuration errors when its own YAML syntax is valid; Repair for invalid syntax; Unreadable for a file that cannot be read. Pending setting and entry changes stay unsaved. |
| Loaded | Its file is gone from the list                     | The editor goes, with its unsaved changes.                                                                                                                                                |
| Any    | Profiles are moved to another place                | Every editor goes. Unsaved changes hold the move back, with "Save or reset your unsaved changes first."                                                                                   |
| Loaded | The profile is deleted                             | The editor goes, with its unsaved changes.                                                                                                                                                |

### YAML repair

`ProfileRepair` keeps whole-file syntax corrections in the editor cache.
Configuration errors open in the forms, where known values remain editable
and unknown keys are ignored. This is
offered only for profiles, not staged applies. Repairs are kept in this tab's
memory, so reloading or closing the tab loses unsaved corrections.

| State    | Event                                                              | Next                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repair   | YAML is typed                                                      | Checking, with the text kept exactly as typed and Save off. A change back to the original text is no change.                                                                             |
| Checking | Validation ends                                                    | Repair with Save on only when the text changed and has valid YAML syntax, otherwise with why and Save off. An older result cannot settle newer text.                                     |
| Repair   | Another profile or page is opened                                  | The repair stays cached and its changes count as unsaved, including for save all, discard all, changing source, and sign-out.                                                            |
| Repair   | The list is refreshed                                              | Dirty or saving repairs keep their text and original version and check syntax again. A clean repair follows the saved file.                                                              |
| Repair   | Save                                                               | Saving in the profiles' queue after a sync. The captured text is validated again and unknown keys removed; the original file is compared before writing.                                 |
| Saving   | The file differs from the original, or validation or writing fails | Repair, keeping corrections and showing why. A changed file is never replaced.                                                                                                           |
| Saving   | The write ends                                                     | Loaded with settings and any configuration errors, unless text typed while saving remains unsaved, in which case Repair. Setting and entry changes from before the failure stay unsaved. |
| Repair   | Reload or discard all                                              | Changes are discarded and the current file is read again, becoming Loaded or a clean Repair. Reload is off while saving.                                                                 |

### Unsaved changes

Each change is previewed through the engine's `previewProfile`, so the
editor shows what a save would give, base profiles included. Invalid active
merge message pairs, or code scanning or code quality setup with Actions
disabled, follow the refused preview transition below.

A profile with a [draft](#drafts) of its own opens on it: each setting,
ruleset, environment, and label in the draft starts from the draft, and from
what applies otherwise. A base profile's draft is left out, since its own
file finishes it. So "saved" below is the file as last read, draft included,
and "what the file has" for a setting is its draft's value when it has one.

| State              | Event                                                                          | Next                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loaded with errors | A known field or entry is corrected, or malformed configuration is removed     | Unsaved, previewed; remaining errors stay on their fields or areas. Save requires a valid result.                                                                                                                        |
| Saved              | A setting is chosen or typed                                                   | Unsaved, previewed. A change back to what the file has is no change.                                                                                                                                                     |
| Unsaved            | The engine accepts the preview                                                 | Unsaved, with **Save** on.                                                                                                                                                                                               |
| Unsaved            | The engine refuses the preview                                                 | Unsaved, with why above **Save**, which is off. Each changed setting shows as chosen, and every other as saved.                                                                                                          |
| Unsaved            | A slower preview ends after a later one                                        | Its result is dropped.                                                                                                                                                                                                   |
| Any                | A name or number is typed                                                      | The box keeps the text as typed until it is left. Text that can be a value is an unsaved change at each key. Text that can't stays with why, and **Save** is off until it is corrected or reset.                         |
| Unsaved            | Remove on a setting this profile sets                                          | Unsaved: the file stops naming it, and a base profile's value shows.                                                                                                                                                     |
| Unsaved            | Reset on a setting, or Reset in the footer                                     | That setting, or all of them, as saved. The footer's Reset offers Undo, unless the profile is being repaired, which reads it again.                                                                                      |
| Saved or Unsaved   | Remove all on a group                                                          | Unsaved: the file stops naming each setting of the group whose value is this profile's own, those GitHub hides included. Undo is offered.                                                                                |
| Unsaved            | Reset all on a group                                                           | Each setting of the group as saved, typed text and those GitHub hides included. Undo is offered. Neither group action, nor Undo, runs while saving.                                                                      |
| Saved or Unsaved   | Remove all or Reset all on the settings found                                  | As on a group, for the settings the search or filters found, not those shown only for what sits under them. Undo is offered.                                                                                             |
| Saved or Unsaved   | Remove those matching nothing on the allowed actions' patterns                 | Unsaved: the list without each line whose check found nothing or that GitHub refuses, and without blank lines. Undo is offered.                                                                                          |
| Undo               | Undo                                                                           | Every setting and entry change, typed text, and reusable choices, exactly as before that batch action.                                                                                                                   |
| Undo               | Any other change, a save, a reset, a discard, an owner change, or a fresh read | No undo, though it is set before the batch action's preview, so a change made while that runs clears it too.                                                                                                             |
| Unsaved            | A setting that stands alone is set, or one beside it                           | The other is taken out, as with **Take the site down** and the rest of Pages.                                                                                                                                            |
| Unsaved            | Save                                                                           | Saving in the profiles' queue, after a sync. The changed settings and finished drafts are written. Inactive settings and unknown keys are removed from this file; base files stay unchanged. A sync commits the changes. |
| Saving             | The write ends                                                                 | Saved, then a sync when profiles are kept on GitHub. A change made while it ran stays unsaved.                                                                                                                           |
| Saving             | The write fails                                                                | Unsaved, with why, and **Save** on to try again. A setting changed back meanwhile to what the save was writing keeps its change.                                                                                         |

The save problems list takes the keyboard to a setting or an entry's own
field. Ordinary tab navigation clears that destination. **Reset** clears
unsaved edits; a saved draft's problem instead offers **Go to it** and says
to edit or discard the draft. Resetting save problems also clears batch
Undo. Every typed change closes any pending or open save preview, including
text that cannot become a value.

### The draft

**Save** and **Save as draft** are the two ways out of Unsaved above, and
both take the same turn in the queue. The draft is the open file's own:
its settings under `drafts`, its entries with `draft: true`, and its keys of
`drafts.unset`.

| State                 | Event                                                        | Next                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsaved               | Save as draft                                                | Saving. Each setting or entry that ends as something other than what applies is written as a draft, one that ends as what applies loses its draft, and what the file stops naming is listed in `drafts.unset`. What applies stays as it is. |
| Unsaved               | A new or renamed entry has no name, or another's             | **Save as draft** is off, with why. Nothing else about an entry holds it back, since a draft may be unfinished.                                                                                                                             |
| Unsaved               | A setting is cleared to an empty value, as a runner label    | **Save as draft** is off, with why: a draft of no value reads as no draft. **Save** can still apply it.                                                                                                                                     |
| Saved, with a draft   | Opened, or read again                                        | Each drafted row shows the draft, marked **Draft**, with what applies now beside a setting. The banner counts the draft's changes and lists what stops each from applying.                                                                  |
| Saved, with a draft   | Save, with or without unsaved changes                        | Saving. Every row is written as it ends, so it applies, and the whole draft is taken out: each draft setting, each draft entry, and `drafts.unset` but for the keys the editor has no row for.                                              |
| Saved, with a draft   | The draft can't apply as it stands                           | **Save** is off, with the engine's reason above it, or **Not finished** on the entry. **Save as draft** still keeps further changes.                                                                                                        |
| Saved, with a draft   | A drafted setting or entry is changed to what applies        | Unsaved. Either save takes it out of the draft.                                                                                                                                                                                             |
| Saved, with a draft   | **Put it back** on an entry the draft takes out              | Unsaved, as the entry applies. Either save takes its key out of `drafts.unset`.                                                                                                                                                             |
| Saved, with a draft   | Discard draft, with nothing unsaved                          | Confirming. **Keep it** goes back. **Discard draft** takes the draft out of the file in a save's turn, and keeps what the editor has no row for.                                                                                            |
| Unsaved, with a draft | Discard draft                                                | Off until the changes are saved or reset, since it writes at once.                                                                                                                                                                          |
| Saving, either way    | An entry with a change is out of date                        | Nothing is written, as in the table below. An entry's draft counts as its saved entry, so a draft that changed elsewhere holds its change back.                                                                                             |
| Saving, or discarding | The file's own draft differs from the one shown              | Nothing is written. The editor shows the draft as it is now, with "The profile's draft changed elsewhere." Saving again acts on that draft.                                                                                                 |
| Unsaved               | An entry is given the name of one the draft takes out        | Held back from both saves, with why, until that one is put back.                                                                                                                                                                            |
| Discarding            | The write fails                                              | Saved, with the draft, and why.                                                                                                                                                                                                             |
| Unsaved, or a draft   | Preview, offered while **Save** is                           | Previewing: `previewProfile` makes Save's edits without writing them, and the dialog shows what applies now against what would, as a diff of YAML with unchanged runs folded. A save that would apply nothing new says so.                  |
| Previewing            | Save, or Save as draft                                       | Saving, as above, with the dialog closed.                                                                                                                                                                                                   |
| Previewing            | Close, or Escape                                             | Back, with nothing written.                                                                                                                                                                                                                 |
| Previewing            | The profile is read again, as after a sync, or the page goes | Back, with the preview closed: it no longer shows what Save would do.                                                                                                                                                                       |
| Preview pressed       | A change, a reset, or a save before the preview is made      | No preview opens.                                                                                                                                                                                                                           |
| Unsaved, or a draft   | Preview, and the engine refuses the edits                    | Back, with why above **Save**.                                                                                                                                                                                                              |

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

### The profile's owner type

The editor draws only the settings and choices owners of the profile's type
have, as the engine's `settingRules` say, so the rest are never part of a
save. A profile for any owner draws them all, each marked with who alone has
it. The type changes only through the dialog, which writes at once with the
engine's `changeOwnerType`.

| State    | Event                                                            | Next                                                                                                             |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Closed   | **Change** beside the type                                       | Open, with the profile's type picked.                                                                            |
| Open     | Another type is picked                                           | Open, listing what `owner_changes` says the file would stop managing as that type.                               |
| Open     | A base profile sets the type, whether or not the file repeats it | Open, with the choices off and the base's name: a chain has one type, so that profile changes it.                |
| Open     | Change, with unsaved changes                                     | Not offered: the change writes at once, so it waits for a save or a reset.                                       |
| Open     | Change                                                           | Changing, in a save's turn of the profiles' queue, with a sync first when profiles are kept on GitHub.           |
| Changing | The file read in that turn would leave something else            | Open, with why, and the list as the file is now. Nothing is written.                                             |
| Changing | The file's own draft differs from the one shown                  | Open, with why, as for a save. Nothing is written.                                                               |
| Changing | It succeeds                                                      | Closed. The editor shows the file as the engine resolved it, without what the type lacks, and a sync commits it. |
| Changing | A setting the new type lacks was changed while the change waited | That change is dropped with the row that showed it.                                                              |
| Changing | It fails, as when a base profile sets what the type lacks        | Open, with the engine's reason, which names the base. The file is as it was.                                     |
| Open     | Cancel, or Escape                                                | Closed.                                                                                                          |

### Allowed action pattern checks

`ActionPatternChecks` (`packages/web/src/app/profile-editor/action-pattern-checks.ts`)
says, for each line of **Allowed action patterns**, what its pattern matches
on GitHub, read with the engine's `checkActionPatterns`. The states are those
of one pattern's text, trimmed. A line shows the state of the text it holds
now, so a check that lands after its line changed shows on no other line. A
blank line shows nothing, and a line with a comma holds several patterns and
is never checked. Each editor keeps its checks by pattern text, so they
outlive a save and a fresh read of the profile.

| State               | Event                                                                                                  | Next                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not checked         | The list first holds a pattern to check, as when the profile opens with one, or the first is pasted in | Checking, at once.                                                                                                                                       |
| Not checked         | The list changes to hold the pattern, after a first run                                                | Waiting. Each further change to the list starts the 600 ms pause again; a change to another setting doesn't.                                             |
| Not checked         | GitHub hides the list, as with **Allowed actions** not set to **Selected**                             | Not checked, and nothing runs. Checking at once when the list first shows and nothing was asked before; Waiting otherwise.                               |
| Waiting             | The pause ends                                                                                         | Checking, for every pattern in the list that is Waiting, 100 patterns a run, one run after another.                                                      |
| Waiting             | The pattern leaves the list, the list is hidden, or the profile stops reading                          | Not checked. The pause goes on only while another pattern waits.                                                                                         |
| Checking            | The check lands                                                                                        | Checked, or Failed when GitHub's answer for this pattern was an error or its rate limit.                                                                 |
| Checking            | The whole run fails, such as with no network                                                           | Failed, for every pattern of that run. A lost sign-in also takes the app to the sign-in page.                                                            |
| Checking            | The pattern leaves the list                                                                            | Checking: the run goes on and its result is kept for the text, so typing it back shows it.                                                               |
| Checked             | The pattern leaves the list and comes back                                                             | Checked, with no new run.                                                                                                                                |
| Failed              | The list changes                                                                                       | Failed: a failure isn't tried again by typing.                                                                                                           |
| Checked or Failed   | **Check again**                                                                                        | Checking, at once: every pattern in the list is forgotten and asked about again. The link shows while the list has a line to check and none is Checking. |
| Waiting or Checking | The editor goes, as when its profile is deleted                                                        | The pause may still end and a run may still land; what they find is kept by an editor nothing shows.                                                     |

The checks only inform. Nothing here holds a save back.

### Action search

`ActionSearch` (`packages/web/src/app/profile-editor/action-search.ts`) is the search box
under the list. It runs the engine's `findActions` and shows the
repositories under the box. One search counts at a time: a newer one leaves
the one before it behind, so an older answer never replaces a newer one.

| State              | Event                                                                                    | Next                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Closed             | Two characters or more are typed                                                         | Waiting, closed still. Each further key starts the 500 ms pause again.                                 |
| Any                | The text drops under two characters                                                      | Closed, with any pause dropped and any search left behind.                                             |
| Waiting            | The pause ends, or Enter                                                                 | Searching, for the text trimmed, in place of any results of the search before.                         |
| Searching          | The text changes                                                                         | Waiting, with the search left behind. The box still says it is searching.                              |
| Searching          | The search lands with repositories                                                       | Results.                                                                                               |
| Searching          | The search lands with none                                                               | Message: GitHub found no repositories for the words.                                                   |
| Searching          | The search fails                                                                         | Message: GitHub's search limit is reached, or the error. A lost sign-in also goes to the sign-in page. |
| Results            | **Add**                                                                                  | Results, with `owner/repo@*` on a new line at the end of the list and the row showing Added.           |
| Results            | The list changes                                                                         | Results, each row showing Added while the list holds its `owner/repo@*` on a line, in any case.        |
| Results or Message | Enter                                                                                    | Searching, at once, for the text as it is.                                                             |
| Searching          | Enter, for the words of the search under way                                             | Searching still: a key held down asks once.                                                            |
| Results or Message | The text changes, two characters or more                                                 | Waiting, with what shows left up until the new search starts.                                          |
| Any                | The search's row goes, as when the list is hidden or another profile is opened           | Closed, with any pause dropped and any search left behind.                                             |
| Open, in any state | Escape, the pointer pressed outside the search, or the keyboard moved to another control | Closed, with any search left behind. The text stays, and Enter searches again.                         |

### GitHub App lookup

`GitHubAppLookup` (`packages/web/src/app/profile-editor/bypass-actors.ts`)
finds a GitHub App by its slug for a ruleset's bypass list, with the engine's
`findGitHubApp`. One lookup counts at a time: a newer one, or a reset, leaves
the one before it behind. The names of the apps it finds stay for the
editor's life, so the list names those apps in place of their IDs.

| State   | Event                                                   | Next                                                                  |
| ------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Idle    | **Find**, with a slug or an app's address               | Finding.                                                              |
| Finding | GitHub answers with the app                             | Found, with its name and ID, and its name kept.                       |
| Finding | GitHub answers that it has no such app                  | Missing, with the slug.                                               |
| Finding | The lookup fails                                        | Failed, with the error. A lost sign-in also goes to the sign-in page. |
| Finding | **Find** again                                          | Finding, with the lookup before it left behind.                       |
| Found   | **Add**, or Enter in the field                          | The app is added, unless the list has it, and the form closes.        |
| Any     | The text changes, the form closes, or an actor is added | Idle, with any lookup under way left behind.                          |

### Search and filters

The search and the **Managed**, **Not saved yet**, and **Drafts** filters
find settings across the tabs. What they found is worked out when the search
or a filter changes, or the profile is read or written, and not when a row
changes.

| State | Event                                                                                               | Next                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs  | A word is typed, or a filter is turned on                                                           | Found: the settings that fit every word and every filter show group by group in place of the tabs, each sub-option under the setting it belongs to.                                       |
| Found | A found setting is changed or reset                                                                 | Found, with the same settings, so a row doesn't vanish as it is edited. Its value and marks follow the change.                                                                            |
| Found | A change hides a found setting, as turning off the one above it does                                | Found: the hidden one goes, as on its tab, and the setting that was changed stays to change it back. The count follows what shows.                                                        |
| Found | A save or a discard ends, whether it wrote or failed, or the profile is read again, as after a sync | Found, worked out again, so a setting a save settled leaves **Not saved yet**, and a finished or discarded draft leaves **Drafts**. A setting that shows and has an unsaved change stays. |
| Found | The search or a filter changes                                                                      | Found, worked out again from the rows as they are then.                                                                                                                                   |
| Found | Nothing fits                                                                                        | Found, with why: the words typed, or the filters, and that rulesets, environments, and labels are on their own tabs when one of them would fit.                                           |
| Found | A setting GitHub hides for another's value fits                                                     | Left out, as on its tab.                                                                                                                                                                  |
| Found | The search is emptied and every filter is off                                                       | Tabs, on the tab that was open.                                                                                                                                                           |
| Found | Show every setting, or Escape in the search                                                         | Tabs for the first; the second empties the search and keeps the filters.                                                                                                                  |

### Each ruleset, environment, or label

`EntryEdits` (`packages/web/src/app/profile-editor/entry-edits.ts`) holds the changes to
entries. The engine writes an entry whole, so a change holds the whole entry,
with the saved entry it was made on. An entry's key is its saved name, or a
number for one that is new, so its row is found whatever its name becomes.

| State            | Event                                                              | Next                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved            | A field changes                                                    | Unsaved, previewed with the settings. An entry changed back to what is saved, its name trimmed, is no change.                                                                                                                                                                                                                      |
| None             | New ruleset, environment, or label                                 | New: unsaved, with "Give it a name." until it has one.                                                                                                                                                                                                                                                                             |
| Unsaved          | Its name is empty, or another entry's                              | Held back with why. A ruleset is known by its name as written, an environment or a label by its name in any case.                                                                                                                                                                                                                  |
| Unsaved          | Its name is the saved name of one renamed or taken out             | Held back until that change is saved, since the file still has the name.                                                                                                                                                                                                                                                           |
| Unsaved          | A ruleset requires status checks and names none                    | Held back with why.                                                                                                                                                                                                                                                                                                                |
| Unsaved          | A ruleset's targets GitHub would refuse, or that match nothing     | Held back under its options or patterns, with its own destination in the save problems list.                                                                                                                                                                                                                                       |
| Unsaved          | A label's old names include its own, one twice, or another label's | Held back with why.                                                                                                                                                                                                                                                                                                                |
| Unsaved          | A ruleset sets Pull requests only where GitHub refuses it          | Held back in the bypass list: for a deploy key, or in a tag or push ruleset. **Go to it** focuses that list.                                                                                                                                                                                                                       |
| Unsaved          | A ruleset's bypass list names the same actor twice                 | Held back in the bypass list, with why.                                                                                                                                                                                                                                                                                            |
| Unsaved          | The engine refuses it, such as a color that isn't one              | Unsaved, with why above **Save**, which is off.                                                                                                                                                                                                                                                                                    |
| Any held back    | Another setting or entry changes                                   | The entries that can be saved as they stand are still previewed; **Save** stays off.                                                                                                                                                                                                                                               |
| Managed          | Remove it from the repository                                      | Unsaved: only its name and `absent: true` are written. What it had is kept with the change.                                                                                                                                                                                                                                        |
| Removing         | Manage it                                                          | What it had comes back, under its name as it is then; for one saved as removing, only its name.                                                                                                                                                                                                                                    |
| Saved here       | Take out of profile                                                | Unsaved and struck through: the file stops naming it. **Put it back** undoes that before a save. One only the draft has is taken out of the draft.                                                                                                                                                                                 |
| Saved or Unsaved | Take out all, or Reset all, on the list                            | Each entry this profile names, or that is new, as with Take out of profile, a change to one already gone elsewhere dropped; or each change in the list reset. A base profile's entries and other lists stay. Undo is offered. Neither runs while saving.                                                                           |
| Taken out        | Put all back on the list                                           | Each entry taken out, as with **Put it back**. Undo is offered.                                                                                                                                                                                                                                                                    |
| Any              | An entry's box, Select all, or Deselect all                        | The list's batch actions change only the selected entries while any are, as Reset, Take out, and Put back. Selecting is no change and keeps the undo; a selected entry that goes, as a reset new one does, is no longer selected, and a save or a fresh read clears the selection, since either can give its key to another entry. |
| New              | Take out of profile                                                | Gone, with no change.                                                                                                                                                                                                                                                                                                              |
| From a base      | A field changes                                                    | Unsaved: the save writes the entry here, over the base's. Its name can't change.                                                                                                                                                                                                                                                   |
| Unsaved          | Reset, on one saved before                                         | Saved.                                                                                                                                                                                                                                                                                                                             |
| Unsaved          | The saved entry changes, as a sync can do                          | Out of date: held back with why, and **Keep mine** or **Reset**. The change would write the whole entry over what it is now.                                                                                                                                                                                                       |
| Unsaved          | The saved entry goes                                               | Out of date, still listed. **Keep mine** makes it a new entry; **Reset** lets it go. A change that took it out is dropped, with nothing left to do.                                                                                                                                                                                |
| Out of date      | Take out of profile                                                | Gone, with no change.                                                                                                                                                                                                                                                                                                              |
| Out of date      | Keep mine                                                          | Unsaved, based on the entry as it is now.                                                                                                                                                                                                                                                                                          |
| Unsaved          | Save                                                               | The file is read again in the save's turn. Any entry out of date stops the save, with nothing written. Otherwise the changes as they stood when Save was pressed are written.                                                                                                                                                      |
| Saving           | The write ends                                                     | Saved, under the name the save gave it. One changed again while the save ran, even back to what it was, stays unsaved, based on what was written.                                                                                                                                                                                  |
| Saving           | A malformed area or list item changed before its removal           | Unsaved, with why. The removal is refused until reset and reviewed again, so corrected configuration is never deleted.                                                                                                                                                                                                             |
| Saving           | The write fails                                                    | Unsaved, every change as it is.                                                                                                                                                                                                                                                                                                    |

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

The ruleset form's targets are `conditions.ref_name`, as the profile has
them: the options write GitHub's `~DEFAULT_BRANCH` and `~ALL` into
`include` and `exclude`, and the pattern box writes the other names.
GitHub matches the names in any order, so names that end up the same as
saved, in any order, give the saved entry back. The pattern box stays open
while its option is selected, even when it holds no pattern yet; that is
the form's own state: an entry with patterns opens with it selected,
deselecting it clears the patterns and closes it, and a push target hides
it. Reset leaves an empty open box open, since the form stays mounted.
`refPatternProblem` checks one pattern and `refTargetsProblem` the whole
ruleset, and a ruleset with a problem in its targets can't be saved.

A setting GitHub hides, for the value of the one it follows or because that
one is hidden, is not drawn, and the highest shown setting that hides it
counts how many such settings a profile still names. A setting GitHub greys
out stays in place, off, and names the setting and value that turn it off.
[Settings that depend on another](settings-coverage.md#settings-that-depend-on-another)
lists them.

## Web compare

`Comparison` (`packages/web/src/app/apply/comparison.ts`) compares one repository
with one profile: it resolves the profile, plans it with the engine's
`createPlan`, and reads the account's access to mark what Repotted can't
change. It only reads from GitHub, and reads the profile as saved, without
the editor's unsaved changes. One comparison counts at a time.

| State              | Event                                                           | Next                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle               | **Compare** on a repository's panel, with a profile picked      | Comparing, on the compare page, with the search and **Can't change** cleared.                                                                                                                                                                                  |
| Comparing          | The plan and the access land                                    | Compared: what the profile sets that needs no change, folded away, and the differences by section, each locked one with what it needs, the profile's drafts named as left out, and the plan's warnings.                                                        |
| Comparing          | The profile is for the other kind of owner                      | Failed, with the engine's reason, which says to copy the profile and change the copy's type.                                                                                                                                                                   |
| Comparing          | The profile can't be read, or GitHub can't                      | Failed, with why, by the profile's name. A lost sign-in also goes to the sign-in page.                                                                                                                                                                         |
| Comparing          | Another comparison starts                                       | Comparing, for the new one. The first one's result is dropped when it lands.                                                                                                                                                                                   |
| Compared           | Words are typed in the search, or **Can't change** is turned on | Compared, showing the differences that fit both.                                                                                                                                                                                                               |
| Compared           | **Differs from GitHub** is turned off, or on again              | Compared, with what needs no change shown under each section's differences, or folded away. That is what the profile sets that the plan neither changes nor says it skipped. **Can't change** hides it while it is on. The choice stays for later comparisons. |
| Compared or Failed | **Compare again**                                               | Comparing, with the profile read again as it is saved then, and GitHub as it is then. A shown comparison is never refreshed otherwise.                                                                                                                         |
| Any                | The compare page is left                                        | Idle. One still being made shows nothing when it lands.                                                                                                                                                                                                        |
| Idle               | The compare page is opened by its address                       | Idle, with how to start a comparison.                                                                                                                                                                                                                          |

## Web branch preview

`BranchPreview` (`packages/web/src/app/profiles/branch-preview.ts`) previews a branch
of the repository the profiles are kept in, against the profiles as the
browser has them. It only reads from GitHub. Its address is
`/profiles?preview=<branch>`, and which branch is previewed stays in the
browser. It starts from the profiles in the browser, not the default branch,
so Ready names the profiles changed there since the last sync. One preview
counts at a time.

| State                     | Event                                                                                                                  | Next                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                      | The address names a branch                                                                                             | Loading: the working copy is copied in a turn of the profiles' queue, then the branch's changes are read.                                                                                                                     |
| Loading                   | The branch's changes land                                                                                              | Ready: each profile that applies differently, with its rows by section, its file's text on each side, and banners for unsynced changes, a stale working copy, a branch behind, too many files, or changed shared preferences. |
| Loading                   | The profiles aren't kept in a repository                                                                               | Failed, saying to choose one in Settings.                                                                                                                                                                                     |
| Loading                   | The name isn't a branch name, or GitHub has no such branch, refuses, names the default one, or finds no shared history | Failed, with why. A lost sign-in also goes to the sign-in page. The copy is deleted.                                                                                                                                          |
| Loading                   | Another branch is asked for                                                                                            | Loading, for the new one. The first one's result is dropped and its files deleted when it lands.                                                                                                                              |
| Failed                    | The address names the same branch again                                                                                | Loading, as **Refresh** does.                                                                                                                                                                                                 |
| Loading                   | The same branch is asked for again                                                                                     | Loading, with nothing more read.                                                                                                                                                                                              |
| Ready or Failed           | **Refresh**                                                                                                            | Loading, with the branch and the working copy read again.                                                                                                                                                                     |
| Ready                     | The address names the same branch again                                                                                | Ready, with nothing read, as on the way back from a comparison.                                                                                                                                                               |
| Ready                     | **Compare with a repository**                                                                                          | Ready, kept while the compare page is open; its back link returns to the preview.                                                                                                                                             |
| Loading, Ready, or Failed | **Exit preview**, or the address names no branch on any page but the compare page                                      | Idle, with its files deleted. One still loading shows nothing when it lands.                                                                                                                                                  |
| Loading, Ready, or Failed | The profiles are kept somewhere else                                                                                   | Idle, with its files deleted; the address's branch then loads for the new place, which needs a repository.                                                                                                                    |

## Web apply

`Apply` (`packages/web/src/app/apply/apply.ts`) reviews profiles for one
repository through the engine's [staged apply](#staged-apply), in temporary
files under `/apply/<id>/apply.yaml`. Each start owns its folder. Leaving
removes it, and late work cleans up its own files without changing a later
apply. These files are never kept between visits. It writes to GitHub only
in Applying, with `applyPlan` over the plan held by the review shown, as
[Plan and apply](#plan-and-apply) describes. Drafts belong to profiles.

| State                    | Event                                                                            | Next                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle                     | **Apply** on a repository's panel, with a profile picked                         | Editing, with a temporary staged apply started from the profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Any but Applying         | A single repository moved into a folder with review on move                      | Reviewing directly, with the effective layers, in the same guarded operation that creates its temporary apply. A late start never advances another apply from its edits.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Idle                     | **Review apply** under a repository's **Profiles**                               | Editing, with the repository's profiles together, in their order, later ones over earlier ones. Off while a profile is missing or unreadable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Idle                     | **Change settings once** on a repository's panel                                 | Editing, with a temporary staged apply started without a profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Editing                  | A setting or entry is changed                                                    | Editing, in the [profile editor](#web-profile-editor) over the staged apply, which holds no drafts: it offers no Save as draft, Preview, or draft banner.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Editing                  | The installation's access lands                                                  | Editing, with each setting the installation lacks a permission for turned off, and each such list's **New** off and its entries open read-only, when the editor is still the one it was read for. Access that can't be read turns nothing off, and a lost sign-in goes to the sign-in page. Opening edits after a review uses the access that review read, until the apply is left, discarded or started anew.                                                                                                                                                                                                     |
| Editing                  | Save edits                                                                       | Editing, with the edits written to the staged apply, never to the profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Editing                  | Review changes                                                                   | Reviewing, once edits that aren't saved are saved to the apply. Editing still, with why, while an edit isn't valid or can't be saved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Editing                  | Save edits to profile                                                            | Editing, with the edits written into the profile and cleared from the apply, which resolves the same. The write takes a turn among the profiles' syncs, as a save of the profile does. Editing with why when the engine refuses, as for autolinks, a change between a Pages site and none, or a profile that no longer reads. Not offered without a profile, or for the built-in protection.                                                                                                                                                                                                                       |
| Editing                  | Something the apply leaves out is put back                                       | Editing, with it back in what the apply sets. What is left out is named above the edits, since the engine refuses an edit to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reviewing                | The plan and the access land                                                     | Reviewed: the changes by section, each with what leaves it out, the locked ones with what they need, what is left out, the drafts, and the warnings.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reviewing                | The profile can't be read, or GitHub can't                                       | Failed, with why, the files by their names. A lost sign-in also goes to the sign-in page. While the page stays open, the edits and exclusions can be reviewed again, adjusted, or discarded.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Reviewing                | A review lands after the page moved on, as to another apply                      | Dropped. Its temporary folder is removed when the apply has been left, even if its files were created after leaving. A later apply has a different folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Failed                   | Review again                                                                     | Reviewing. An apply that never started, as when its profile couldn't be read, starts afresh and opens on its edits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Reviewed                 | Leave out, or Put back                                                           | Reviewing, with the staged apply's exclusions changed. The profile keeps the change either way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reviewed                 | A change GitHub would refuse is in the review                                    | Reviewed, with **Apply** off: the apply would stop there and leave the changes after it unwritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reviewed                 | Review again                                                                     | Reviewing, with the profile and GitHub read again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reviewed or Failed       | Back to edits                                                                    | Editing, with the one-off edits for this apply. A one-off change in the review is changed or undone here, not left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Reviewed                 | An apply of one profile from the profiles folder that the repository doesn't use | Reviewed, with **Add** the profile **to this repository's profiles when it applies** selected. Deselected, the apply is one-time and the repository keeps no record of the profile. Each start of an apply selects it again. An apply that leaves a change out or has a one-off edit adds the profile with no version, so it counts as not applied yet.                                                                                                                                                                                                                                                            |
| Reviewed                 | An apply of the repository's own profiles, in its order                          | Reviewed, saying the apply records this version of them as applied, or, when it leaves a change out or has a one-off edit, that it records nothing, since the repository won't then have what they set. Nor does it record when GitHub refused to show a setting, as for want of a permission or a payment method, since granting that can change what the apply does. A setting skipped for another reason, as one that doesn't apply here, doesn't stop it: it would be skipped on every apply. Any other apply, such as one of several picked another way or of a profile built into Repotted, records nothing. |
| Reviewed with no changes | **Record as applied**, for an apply that records                                 | Applied with no changes, with nothing written to the repository and the version of each profile recorded as applied, which commits `.repotted-preferences.json` when the profiles are in a config repository.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Reviewed                 | Apply, then Apply now                                                            | Applying. Cancel in the question goes back with nothing written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Applying                 | The repository changed since the review                                          | Reviewed again, with nothing written and a notice that says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Applying                 | GitHub refuses a change partway                                                  | Reviewed again, showing what is left, with a notice naming the change and how many before it stay written. It can be tried again while the page is open.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Applying                 | Every change is written                                                          | Applied, with the count, and the staged apply removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Applying                 | Every change is written, for an apply that records                               | Applied, with the version of each profile it applied recorded under the repository, and one being added put at the end of its profiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Applying                 | The run fails otherwise, as with no network                                      | Failed, with why. The staged apply stays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Any but Applying         | Discard apply                                                                    | Idle, with the staged apply removed. The profile and GitHub stay as they are.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Any but Applying         | The apply page is left                                                           | Idle, with the temporary folder, edits and exclusions discarded. The next apply starts afresh from the chosen profiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Applying                 | The apply page is left                                                           | Applying still: the run goes on, and the page shows how it ended when it is opened again in the same visit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Applying                 | Apply on a repository's panel, or Discard apply                                  | Applying still: a write already under way is neither replaced nor discarded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Web batch apply

`BatchApply` (`packages/web/src/app/apply/batch-apply.ts`) reviews profiles
for several repositories through the engine's [batch](#batch), in temporary
files under `/apply/<id>/batch`. Each member starts from the selected
profile or its effective folder and own layers. Each start owns its folder, removed when the page is left and never
kept between visits. It writes only in Applying, with `applyBatch` over the
plan held by the review shown. One piece of work counts at a time.

| State            | Event                                                                                                             | Next                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle             | **Review apply**, with repositories selected and a profile picked                                                 | Reviewing, with a temporary batch started from the selected profile for every repository.                                                                            |
| Any but Applying | Several repositories moved into a folder with review on move                                                      | Reviewing, each newly entering repository starting from its effective layers. A prior pending review is discarded.                                                   |
| Reviewing        | Every repository is planned                                                                                       | Reviewed: each repository with its changes, or that it is already in line, needs access, couldn't be compared, or is left out; each change with how many it reaches. |
| Reviewing        | A profile outside the saved assignment disappears after its plan completes                                        | Reviewed with the captured changes. Applying revalidates the source and refuses that member without writes or baseline recording.                                    |
| Reviewing        | The batch can't start or be read                                                                                  | Failed, with why and whether a batch is there. A batch that couldn't start leaves nothing behind. A lost sign-in also goes to the sign-in page.                      |
| Reviewing        | A review lands after the page moved on                                                                            | Dropped. Its temporary folder is removed when the batch has been left, even if its files were created after leaving. A later batch has a different folder.           |
| Reviewing        | Any button                                                                                                        | Nothing: the last review stays in view with its buttons off.                                                                                                         |
| Reviewed         | A repository is deselected, or selected again                                                                     | Reviewing, with it left out of the batch or put back. Its apply stays as it is.                                                                                      |
| Reviewed         | Remove from batch, on a repository left out or not compared                                                       | Reviewing, with the repository and its staged apply removed. Idle when it was the last one, with the temporary folder removed.                                       |
| Reviewed         | Leave out, or Put back, on one repository's change                                                                | Reviewing, with that repository's apply changed.                                                                                                                     |
| Reviewed         | Leave out everywhere, or Put back everywhere                                                                      | Reviewing, with every repository's apply changed. One that refuses, as when its own edits set the value or its apply can't be read, keeps it and is named.           |
| Reviewed         | Review again                                                                                                      | Reviewing.                                                                                                                                                           |
| Reviewed         | Apply, then Apply now, with a repository that has changes to write                                                | Applying, one repository at a time, each result shown as it lands. Cancel in the question goes back with nothing written.                                            |
| Reviewed         | A batch of one profile has repositories that don't use it                                                         | Reviewed, with **Add** the profile **to each repository's profiles when it applies** selected. Deselected, the apply is one-time. Each start selects it again.       |
| Reviewed         | **Mark as applied**, with no writable changes and in-line assigned profiles, or the add selected with its version | Applying through the same engine recheck, without writing settings.                                                                                                  |
| Applying         | A repository is written, or needed nothing                                                                        | It finishes and leaves the batch. A full apply of its effective layers records the reviewed versions; exclusions, one-off edits and refused reads prevent recording. |
| Applying         | A repository that didn't use the batch's one profile is written, or needed nothing, with the add selected         | The profile is added to the end of its own list, with its version when the apply gave all it sets and the repository's ownership, and with none otherwise.           |
| Applying         | A repository changed since the review, is locked, or fails partway                                                | It is not written, or keeps what was written before the failure, and stays in the batch. The next one is tried.                                                      |
| Applying         | GitHub answers 401                                                                                                | That repository fails and the account is signed out, once. The rest are tried and fail the same way.                                                                 |
| Applying         | The last repository is tried                                                                                      | Applied after profile record saves settle: unfinished repositories first, then the rest. Confirm once on full success. The batch ends when every one finished.       |
| Applying         | Review apply or Discard batch                                                                                     | Applying still: a write already under way is neither replaced nor discarded.                                                                                         |
| Applied          | Review again, with repositories left in the batch                                                                 | Reviewing, with what is left in the batch.                                                                                                                           |
| Applied          | Review again, with the batch ended                                                                                | Applied still: nothing is left to review.                                                                                                                            |
| Failed           | Review again, with a batch there                                                                                  | Reviewing.                                                                                                                                                           |
| Failed           | Review again, with no batch, as after one that couldn't start                                                     | Failed still, with why it couldn't start.                                                                                                                            |
| Any but Applying | Discard batch                                                                                                     | Idle, with the temporary folder and all its staged applies and exclusions discarded. A later batch starts afresh.                                                    |
| Any but Applying | The batch page is left                                                                                            | Idle, with the temporary folder and all its staged applies and exclusions discarded. A later batch starts afresh.                                                    |
| Applying         | The batch page is left                                                                                            | Applying still: the run finishes, and its outcome can be viewed again in the same visit.                                                                             |

## Web new profile

`Profiles.create` (`packages/web/src/app/profiles/profiles.ts`) makes a profile for
the new profile form. It never replaces a file: the name is checked against
the list when the form asks, and the write itself refuses a file that is
there. A capture reads GitHub before it takes its turn in the queue, and
holds its name against other new profiles while it reads.

| State                      | Event                                                                    | Next                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing                    | Create or Capture                                                        | The name is checked: a profile of that name in any case, a name a sync would refuse, or a capture making it, refuses it. It is checked again when the turn comes, against the list as the turns before left it.  |
| Creating, empty or extends | Its turn comes                                                           | The file is written, then synced when profiles are kept on GitHub: Created, and the profile opens.                                                                                                               |
| Creating, capture          | Start                                                                    | Reading: the name is held while GitHub is read.                                                                                                                                                                  |
| Reading                    | GitHub answers                                                           | The name is free, the profile is written when its turn comes, and the page names what GitHub refused to show.                                                                                                    |
| Reading                    | GitHub answers, refusing a setting for want of a Repotted App permission | The same, once the installation's settings page is looked up for **Review on GitHub**. A lookup that fails leaves the notice without the link; a 401 makes it a read that failed, and the account is signed out. |
| Reading                    | The read fails                                                           | Editing, with why; the name is free and nothing is written.                                                                                                                                                      |
| Reading                    | GitHub answers 401                                                       | The same, and the account is signed out.                                                                                                                                                                         |
| Reading                    | The form closes                                                          | The read finishes and nothing is written. An empty or extending profile asked for before the form closed is still made.                                                                                          |
| Any creating               | A profile of that name came in meanwhile, such as by a sync              | Editing, with "is already in"; the profile that came in stays.                                                                                                                                                   |
| Any creating               | Where profiles are kept changed meanwhile                                | Editing, with why; nothing is written.                                                                                                                                                                           |
| Created                    | The sync that follows fails                                              | The profile is made and listed; the sync state says why it hasn't reached GitHub.                                                                                                                                |

The form's owner type goes into the file as `owner_type`, except for a
capture, which writes the repository's own, and a profile that extends a
typed base, which takes the base's and writes none.

### Reusable definitions and references

The three definition libraries use the profiles' file store and write queue.
Capture, duplicate, and import keep their existing validation and sync
transitions. The profile tree filters definitions out; other source pickers
still list them for standalone apply and assignments. Cached editors count
in the existing unsaved and source-change guards.

| State                       | Event                                                                                                            | Next                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library                     | New definition                                                                                                   | The existing creation form is fixed to that library's kind, retaining capture, duplicate, import, target naming, and owner choices.                                                             |
| Creating                    | A requested create finishes after its form closes                                                                | The file may remain created, but the abort signal prevents selecting it or navigating over a subsequently opened page. Captures remain cancelled without a file.                                |
| Profile saved               | Add, replace, or remove a reference                                                                              | Unsaved references are previewed with other edits. Save persists paths without copying configuration; drafting references is refused.                                                           |
| References unsaved          | Resolution succeeds                                                                                              | Entry lists show the resolved preview and wait for Save before entry editing resumes. Existing inline entry edits remain part of the save.                                                      |
| References unsaved          | Resolution fails                                                                                                 | Saved entry rows remain editable to repair invalid configuration; the page explains that the changed references cannot yet be previewed.                                                        |
| Invalid profile             | Load for repair                                                                                                  | Valid own links, including valid array elements beside malformed values, remain available to the picker while configuration errors stay reported. Adding a reference preserves those links.     |
| Reference edit              | Save waits behind sync and the profile text changes                                                              | Nothing is overwritten. The edit stays unsaved with the concurrent-change error.                                                                                                                |
| New profile                 | Create, duplicate, or import                                                                                     | The editor selects definitions in each related tab. Duplicate and import retain existing references.                                                                                            |
| New named entry             | Choose to also save a reusable definition                                                                        | The name stays in the cached editor with unsaved changes; invalid names block Save, and Save as draft is refused.                                                                               |
| Reusable choice pending     | Remove or reset a new entry                                                                                      | Its choice is inactive; a batch undo restores the choice with the entry. Reset in the footer clears all choices.                                                                                |
| Reusable choice pending     | Save                                                                                                             | Saving in the profiles' queue. Validate names against files after sync, write definitions exclusively, and save relative references without inline copies. The controls wait until saving ends. |
| Saving reusable definitions | A collision, invalid configuration, or profile write fails                                                       | No profile replacement; remove definitions created in this attempt. Entry edits and reusable choices remain for correction or retry.                                                            |
| Saving reusable definitions | Profile write succeeds                                                                                           | Choices are cleared with the saved edits. Sync and cached editor refresh follow the ordinary profile save.                                                                                      |
| Definition unsaved          | Save definition                                                                                                  | The existing editor save validates and syncs. Cached consumers resolve again and retain unrelated unsaved edits. Known profiles and assigned repositories are displayed before saving.          |
| Any editor                  | Navigate to a library or profile                                                                                 | Its unsaved changes stay cached. Source changes and sign-out include them.                                                                                                                      |
| Deleting definition         | Its type changed, it has unsaved edits, or saved, inherited, or unsaved profile references or assignments remain | Refuse deletion after refreshing in the queue. Name the consumers that must be changed deliberately.                                                                                            |
| Library or profile list     | Select files                                                                                                     | Move and delete use only the current page's selection. Other libraries and the profile list retain their separate selections.                                                                   |
| Moving files                | Relative targets change                                                                                          | Library and profile controls rewrite references and extends with the existing rollback on failed writes.                                                                                        |

Actions policy definitions retain exactly one target name, including drafts.
Profiles reference several policies by path; inline policies replace by name.
General Actions settings follow the settings editor independently.

Missing or invalid references remain engine errors. Definition changes never
write repository settings; reviewed apply owns those writes.

## Web deleting a profile

The open profile's **Delete profile**, or **Delete** for the selected
profiles, asks in a dialog, which names the files and every listed profile
that extends one of them, directly or through another. The question warns
and doesn't block.

| State    | Event                                   | Next                                                                                                                                                                                                    |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle     | Delete profile, or Delete               | Asking.                                                                                                                                                                                                 |
| Asking   | Cancel, or Escape                       | Idle, with nothing changed.                                                                                                                                                                             |
| Asking   | Delete profile                          | Deleting: a turn in the queue, after any sync under way. The button is off while the queue is busy.                                                                                                     |
| Deleting | Its turn comes                          | The files are removed in the one turn, a sync commits that as one commit when profiles are kept on GitHub, and the list is read again: they leave the selection, an open one closes and no other opens. |
| Deleting | The list no longer has the profiles     | Idle, with nothing deleted.                                                                                                                                                                             |
| Deleted  | The sync that follows fails             | The profile is gone here and still on GitHub; the sync state says why, and the next sync commits the delete.                                                                                            |
| Deleted  | The profile changed on GitHub meanwhile | A conflict: **Keep mine** commits the delete, and **Use GitHub's** brings the file back.                                                                                                                |

## Web profile batch actions

`Profiles` (`packages/web/src/app/profiles/profiles.ts`) keeps the profiles
selected on the Profiles page by file, in `batch`, for the visit only. A
profile that leaves the list leaves the selection, and a change of where
profiles are kept clears it. Opening a profile leaves the selection as it is.

| Selection | Event                                                | Next                                                                                     |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| None      | A profile's box, or a **Select all**                 | Some: the panel for the selected profiles shows beside the list, or under it on a phone. |
| Some      | **Deselect all** in the panel                        | None: the panel goes, and the focus moves to the page's heading.                         |
| Some      | Every box cleared, or a **Deselect all** in the list | None: the panel goes, and the focus stays where it was.                                  |
| Some      | A move or a delete of them succeeds                  | None of them; the focus moves to the folder they went to, or to the heading.             |
| Some      | A sync or a move takes a selected one off the list   | Without it.                                                                              |
| Some      | Where profiles are kept changes                      | None.                                                                                    |

A move (`move`, and `renameFolder`, which moves every profile in a folder
and the folders inside it) takes one turn in the queue. When profiles are
kept in a folder on this computer, it syncs first, so a file put there since
counts.

| State  | Event                                                                                 | Next                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asked  | The folder's name is empty, has `/` in a rename, or a part no profile folder can have | Refused, with why; nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Asked  | A folder, or a folder over it, matches one there is already in another case           | Refused with "There is already a folder named"; nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Asked  | A rename names a folder there is already, in the same case                            | Refused with "There is already a folder named": the two folders would merge, and a rename back would move both. Nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Asked  | A rename that only changes the folder's case                                          | Refused: some computers take the two for one folder. Nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Moving | Every profile is already where it would go, or none is still listed                   | Done, with nothing written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Moving | A moving profile doesn't load                                                         | Refused: what it extends is unknown, so it can't be pointed at the new place. Nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Moving | A moving profile, or one whose `extends` would be rewritten, has unsaved changes      | Refused with "Save or reset the changes": its editor would save the old `extends` back. Nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Moving | A profile would land on one that stays or another that arrives, in any case           | Refused with "is already in"; nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Moving | Where one would go runs through a profile's file, in any case                         | Refused with "is a profile, so it can't be a folder"; nothing moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Moving | Otherwise                                                                             | Each moved file is written at its new place under its own name, never over a file there, with `extends` pointed at its base from there; then each listed profile that extends a moved one is rewritten in place, with only the value of `extends` changed; then the old files go. A sync commits it all as one commit when profiles are kept on GitHub, and the list is read again. The open profile follows its file, a move opens the folder they went to, a rename keeps its folders open or closed, and editors of rewritten files are dropped, so each reads its file again. |
| Moving | A write fails partway                                                                 | The writes before it are taken back, the list is read again, and nothing is synced: nothing moved, and the error is shown.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Moving | An old file can't be removed                                                          | The error is shown, and a sync and a fresh list show what is there now: the moved files, and the old ones not yet removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Moved  | The sync that follows fails                                                           | The move is made here and not on GitHub; the sync state says why, and the next sync commits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The rewrite reads `extends` from each file as written, so a profile that
doesn't load, as one whose own base is gone, is still pointed at a moved
profile it names. A file that isn't YAML is left as it is.

## Web kept files

`keepFiles` (`packages/web/src/app/storage/kept-files.ts`) keeps the engine's
files under `/profiles` in IndexedDB, drafts included. It loads only that
workspace; apply and batch files and branch previews are temporary. What is kept must be the files as they were at one moment: a sync
record kept without one of the profiles it lists reads as that profile
deleted here, and the next sync would delete it on GitHub.

| State   | Event                                                                         | Next                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening | Another tab of the site holds the lock                                        | Elsewhere: nothing is loaded or kept, and the app shows only a page that says so, with **Reload**.                                                  |
| Opening | IndexedDB gives the kept files                                                | Keeping: the files are in memory, and each later change is written in order.                                                                        |
| Opening | A kept file can't be placed in memory                                         | Keeping, without that file.                                                                                                                         |
| Opening | IndexedDB can't be opened or read                                             | Visit only: the files last for the visit, and Settings says so.                                                                                     |
| Opening | The browser has no Web Locks, or refuses the lock                             | Visit only, with nothing loaded: no tab can tell that it alone keeps the files.                                                                     |
| Keeping | A file under `/profiles` is written or removed                                | The same is done in IndexedDB, after the changes before it.                                                                                         |
| Keeping | The engine writes a temporary file                                            | Nothing is kept of it.                                                                                                                              |
| Keeping | A file outside `/profiles`, including an apply, batch, or preview, is written | Nothing is kept of it.                                                                                                                              |
| Keeping | A write to IndexedDB fails                                                    | Stopped: no later change is written, so what is kept stays as it was before the failure. A notice on every page says so until the page is reloaded. |
| Keeping | The tab closes                                                                | The lock is free for the next tab.                                                                                                                  |

**Failure:** a tab closed right after a change can lose that change, since
the write to IndexedDB follows the change in memory
([#225](https://github.com/TheLunchTrae/repotted/issues/225)).

## Web navigation

`Router` (`packages/web/src/app/navigation/router.ts`) holds the address of the page
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

## Plan and apply

`createPlan` only reads. `applyPlan` (`packages/core/src/plan/apply.ts`) plans
again from its recorded source and writes only when that yields the same
changes. Sources include profile files, definition files, staged applies, and
inline YAML with its reference directory. Plans without source metadata use
their saved desired profile.

| State    | Event                                                                              | Next                                                                                    |
| -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Planning | A setting needs another planned write                                              | The prerequisite precedes it in the reviewed changes; nested dependencies are followed. |
| Planning | Code scanning or code quality setup needs disabled or unreadable unmanaged Actions | Configuration is skipped with a warning; Actions stays unmanaged.                       |
| Planning | Code scanning or code quality setup turns off                                      | Its shutdown precedes an Actions change and does not depend on enabling Actions.        |
| Reviewed | New live entries appear in an owned section                                        | Stale before any write; new pruning requires a fresh review.                            |
| Reviewed | A source or reference cannot resolve                                               | Refused before any write; repair the source and review a fresh plan.                    |
| Reviewed | The new plan differs                                                               | Stale: `StalePlanError` carries the current plan, and nothing is written.               |
| Reviewed | The new plan matches                                                               | Writing, change by change, from the new plan's requests.                                |
| Writing  | A request fails                                                                    | Partly applied: `ApplyError` lists the changes already made and the one that failed.    |
| Writing  | Every request succeeds                                                             | Applied.                                                                                |

Partly applied is a state of the repository, not of the plan: nothing rolls
back the changes already made. Planning again from the same profile lists
only what still differs.

The CLI's `apply` needs `--yes` with `--json` or without a terminal. The MCP
server keeps plans in memory by `plan_id`. An apply takes its plan out before
it writes, so two calls with one id can't both apply it, and a stale or
failed apply needs a new plan. A sign-in failure comes before that, so it
keeps the plan.

A staged plan resolves its effective inputs again after live reads, including
ownership and the rename identities protected by exclusions. An edit, removal,
or broken reference during those reads refuses the plan before it is returned
or written. A direct profile or text-backed apply performs the same source
check after revalidation and before its first write.

## Drafts

A ruleset, environment, autolink, or setting in a profile file is a draft or
an entry that applies (`packages/core/src/profiles/profile.ts`). The marker lives in
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
| Applies | A second entry of the same name in the same file's list   | The file is invalid before merging its bases; the error names the file and duplicate entry.                   |
| Applies | Saved with the marker                                     | Draft, unless the file already has a draft of that name. The profile stops naming it, as the note below says. |

Turning an entry into a draft doesn't delete it from GitHub. Like any entry a
profile stops naming, it keeps its current state there, unless a base profile
names an entry of that name, which then applies again.

## Staged apply

A staged apply is a file (`packages/core/src/staging/staged.ts`); its state is the
file and the plan made from it. Each edit is checked whole before the file
changes, so every failed event below leaves the file as it was.

| State    | Event                                                                   | Next                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None     | Start in a new file                                                     | Staged, with no edits.                                                                                                                                                    |
| None     | Start where a file exists                                               | None: `createStagedApply` refuses, so a staged apply is never replaced.                                                                                                   |
| None     | Start from a profile that doesn't resolve                               | None: nothing is written.                                                                                                                                                 |
| None     | Start from profiles that don't resolve together                         | None: nothing is written. A profile named twice, one already applied through an earlier one, or profiles for different owner types are refused.                           |
| None     | Start with edits that fail                                              | None: `stage --new` removes the file it started.                                                                                                                          |
| Staged   | Ownership selection changes                                             | Staged with the explicit section list; source profiles remain unchanged and subsequent plans reconcile the full combination.                                              |
| Staged   | An owned section cannot be completely read                              | Staged; planning fails without writes instead of treating unread entries as empty.                                                                                        |
| Staged   | An exclusion protects an owned entry                                    | Staged; that entry is excluded from updates and generated pruning.                                                                                                        |
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
| Staged   | Save when it starts from several profiles                               | Staged as before: there is no one profile to save to.                                                                                                                     |
| Staged   | Discard                                                                 | None: the file is removed, and the profile stays as it is.                                                                                                                |
| Reviewed | Apply                                                                   | As in [Plan and apply](#plan-and-apply): stale, partly applied, or applied.                                                                                               |

Applying does not end the staged apply: the file stays until it is
discarded, so a stale or partly applied apply can be planned again from it.

## Batch

A batch is a folder (`packages/core/src/staging/batch.ts`) whose manifest lists one
staged apply for each repository; each member's own state is as in
[Staged apply](#staged-apply). The manifest has an id, so a batch started
again in the same folder is another batch. It is replaced whole on each
change, from one read of it; a change that finds the manifest changed since
that read starts over, though two programs writing at the same moment can
still lose one change.

| State    | Event                                                               | Next                                                                                                                             |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| None     | Start                                                               | Staged: a new staged apply for each `--new` repository, each joined one as it is, then the manifest.                             |
| None     | Start where a repository already has a staged apply                 | None: the staged applies it started are removed, and so is the folder if the start made it. `--join` adds the existing one.      |
| None     | Start where the folder holds a batch, or with a repository twice    | None: nothing is written, and a folder that was there stays.                                                                     |
| None     | Start from profiles that don't resolve together                     | None: nothing is written.                                                                                                        |
| Any      | Read a manifest that has both `profile` and `profiles`              | The read refuses, and nothing is written.                                                                                        |
| Staged   | Add, leave out, or put back a repository                            | Staged, with the manifest changed. A repository is in a batch once.                                                              |
| Staged   | Exclude or include a key everywhere                                 | Staged: each member that sets the key changes; one that refuses keeps its staged apply and is named.                             |
| Staged   | Plan                                                                | Reviewed: a plan for each member not left out, with the digest of its staged apply. A member that fails is a failure of its own. |
| Reviewed | Edit a member's staged apply                                        | Reviewed, but that member's plan is not applied, since its file no longer has the reviewed digest; plan again.                   |
| Reviewed | Apply a member: applied, or planned again with no changes           | The member ends its staged apply and leaves the batch, if the batch still lists it and its file still has the reviewed digest.   |
| Reviewed | Apply a member: stale, failed partway, or failed                    | The member stays, to plan again. The next member is applied, unless `--stop-on-failure` stops the rest.                          |
| Reviewed | Apply a member that is locked, edited, or left out since the review | The member stays, and nothing is written to it.                                                                                  |
| Reviewed | Apply after the batch ended, moved, or started again                | Nothing is written: each member is left out.                                                                                     |
| Reviewed | The manifest can't be read partway                                  | The member being applied fails with nothing written; the results so far stand.                                                   |
| Reviewed | The last member leaves                                              | None: the manifest is removed, and the folder if nothing else is in it.                                                          |
| Staged   | Take a member out                                                   | Staged without it; a staged apply it started is discarded, a joined one stays. With the last one, None.                          |
| Staged   | Discard                                                             | None: verified staged applies are discarded; joined files stay. Unverified files stay and are reported as warnings.              |

## Config repository sync

`syncFolder` (`packages/core/src/profiles/sync.ts`) brings a folder and a folder in a
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

## Releases

Release CLI releases the CLI, as [Releasing](releasing.md) describes.
Releases wait in one concurrency group, so a run's checks see what the run
before it released; test builds, runs with Publish not selected, wait in a
group for each branch. A release run, one with Publish selected, moves
through these states. A test build stops after Packaged, reports a refused
version as a warning, and attests, publishes, and releases nothing.
Re-running a failed job reuses the run's commit and artifacts, which last 3
days; GitHub allows a re-run for 30 days.

| State     | Event                                        | Next                                                                                                                                                                                        |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued    | The release before it ends                   | Verifying.                                                                                                                                                                                  |
| Queued    | 100 runs are already waiting                 | The new run is cancelled.                                                                                                                                                                   |
| Verifying | Not on `main`, or the version's tag exists   | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The CLI's version is already on npm          | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The gate fails                               | Failed. Nothing is built.                                                                                                                                                                   |
| Verifying | The checks and the gate pass                 | Packaging the CLI tarball.                                                                                                                                                                  |
| Packaged  | The attestation fails                        | Nothing is published; re-running the failed job attests the same files while the artifacts last, and otherwise re-running all jobs builds them again.                                       |
| Attested  | npm refuses the CLI                          | Failed. No tag or release exists; re-running the failed job publishes the attested tarball while the artifact lasts, and otherwise re-running all jobs packs, attests, and publishes again. |
| Attested  | npm already has this exact tarball           | Releasing, without a second upload, as on a re-run after npm took the first.                                                                                                                |
| Attested  | npm accepts the CLI                          | Releasing.                                                                                                                                                                                  |
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
job downloads the tarball from npm and needs no artifact.
