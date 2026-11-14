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
fails with `kind: error`, so a program that reads the output can tell a
sign-in that is gone from a problem that may pass.

## Device flow

`repotted login` runs the GitHub App device flow (`packages/cli/src/device-flow.ts`, `startSignIn` in
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

| State       | Event                                                                       | Next                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checking    | GitHub names the user                                                       | Signed in.                                                                                                                                                                                                                                                                       |
| Checking    | The browser isn't signed in, or GitHub refuses the token                    | Signed out, with why the sign-in failed when the Worker's redirect gave a reason.                                                                                                                                                                                                |
| Checking    | GitHub or the Worker can't be reached                                       | Unreachable, with **Try again**.                                                                                                                                                                                                                                                 |
| Unreachable | Try again                                                                   | Checking.                                                                                                                                                                                                                                                                        |
| Signed in   | Any request in the app gets a 401                                           | Signed out with "GitHub no longer accepts this sign-in."; what the page held goes with it.                                                                                                                                                                                       |
| Signed out  | A request that was under way gets a 401                                     | Signed out, with what it already said.                                                                                                                                                                                                                                           |
| Signed in   | Sign out, with no profile holding unsaved changes                           | Signing out: **Sign out** is off, and a second press sends nothing. An apply's edits that can be saved are saved first, as when its page is left.                                                                                                                                |
| Signed in   | Sign out, while an apply or a batch is writing                              | Signed in, with word to sign out once it has finished, since the writes need the sign-in.                                                                                                                                                                                        |
| Signed in   | Sign out, with unsaved changes in a profile                                 | Asking, by the profiles' names, since signing out drops what the editors hold.                                                                                                                                                                                                   |
| Asking      | Save and sign out                                                           | Each unsaved profile without a draft is saved in its own turn; Escape waits meanwhile. Signing out when all are saved and synced. Asking still, with word of it, when one keeps its changes: one that can't be saved, or one with a draft, which a save here would apply unseen. |
| Asking      | Save and sign out, and all are saved but the sync failed or left a conflict | Asking whether to sign out before the changes are synced: Sign out anyway, or Stay signed in.                                                                                                                                                                                    |
| Asking      | Discard and sign out                                                        | The changes are dropped: Signing out.                                                                                                                                                                                                                                            |
| Asking      | Stay signed in, or Escape while no save runs                                | Signed in, with every change kept.                                                                                                                                                                                                                                               |
| Signing out | The Worker clears the cookies                                               | Signed out with "Signed out."                                                                                                                                                                                                                                                    |
| Signing out | The Worker can't be reached or fails                                        | Signed in, with "Signing out didn't finish. Try again." on the page and in the account menu until the next sign-out. Changes discarded on the way stay discarded.                                                                                                                |

Edits to a profile whose file can't be read then, as after a sync brought
in one that isn't valid YAML, are not counted as unsaved, so they are not
asked about. A sign-in GitHub refuses mid-visit asks nothing either.

## Web repositories

`Repositories` (`packages/web/src/app/repositories.ts`) holds the repository
list for one sign-in.

| State                 | Event                                                    | Next                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No list               | The page opens                                           | Reading, with "Reading your repositories…".                                                                                                                                 |
| Reading               | GitHub answers                                           | The list, grouped by owner, once the [shared preferences](#web-shared-preferences) are read again too. A selected repository stays selected when the new list still has it. |
| Reading               | Refresh                                                  | Nothing: the read under way finishes, and the button is off.                                                                                                                |
| Reading               | The read fails                                           | The list it had, if any, with why above it.                                                                                                                                 |
| Reading               | GitHub answers 401                                       | The account is signed out, as above.                                                                                                                                        |
| A list                | Refresh                                                  | Reading, with the list dimmed and in use.                                                                                                                                   |
| A repository selected | A search, a hidden owner, or a hide takes it out of view | Its panel closes. It is selected again when it comes back into view.                                                                                                        |

It keeps the owners the list hides, by login, under `hidden-repository-owners`
in its [shared preferences](#web-shared-preferences), or nothing when it hides
no owner. A hidden owner matches its login in any case. Keeping the hidden
owners rather than the shown ones means an owner new to the list shows.

| Hidden                  | Event                                            | Next                                                                                           |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Any                     | An owner is unticked or ticked                   | That owner added or taken out, saved.                                                          |
| Any                     | Only personal                                    | Every owner in the list but the signed-in account, saved.                                      |
| Any                     | Show all                                         | None, saved as nothing.                                                                        |
| Some owners             | The list is read again                           | The hidden owners in the list stay hidden; an owner new to it shows.                           |
| An owner not in list    | An owner is ticked or unticked, or Only personal | The owner not in the list stays hidden, with the new choice, saved.                            |
| Every owner in the list | The list is read again or the page opens         | The list shows no repositories and says every owner is hidden; the filter shows **No owners**. |

It keeps the hidden repositories, by `owner/name` in lowercase, under
`hidden-repositories`, or nothing when it hides none. Show hidden is not
kept: each visit starts with the hidden repositories out of the list.

| Hidden repositories | Event                             | Next                                                                                                                          |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Any                 | Hide one or the ticked            | Those added, saved, and unticked; the note above the list offers Undo for those that weren't hidden already, and takes focus. |
| Just hidden         | Undo                              | Those taken out, saved, ticked again if they were, and the note gone.                                                         |
| Just hidden         | Select, Show hidden, or Refresh   | The note gone; the hidden stay hidden.                                                                                        |
| Some                | Show hidden                       | The list shows them, marked Hidden; the count and the search include them.                                                    |
| Some                | Show in list                      | That repository taken out, saved.                                                                                             |
| One not in the list | The list is read again            | It stays hidden, so it is still hidden if it returns.                                                                         |
| Every one shown     | Show hidden off                   | The list says every repository here is hidden and offers Show hidden, whatever the search.                                    |
| Some                | A search that matches only hidden | The list says no repository matches, how many hidden ones do, and offers Show hidden.                                         |

A browser that refuses storage keeps the choice for the visit only. Both
lists are read from the shared preferences each time, so a file read from
the profiles repository changes what the list hides as soon as it arrives.
Each save is a change to the list, such as adding a name or taking one out,
not the list as this page last saw it, so it keeps names another browser
saved meanwhile.

## Web shared preferences

`SharedPreferences` (`packages/web/src/app/shared-preferences.ts`) keeps the
preferences that follow the user where the profiles are. Its saves and reads
run one at a time, in order. It is given the profiles' place when it is made,
so the first list read already knows what that place hides.

A change is kept as the change (`update(key, change)`, a function from the
value now to the next; `write` is one that ignores the value now), not as
its result, until it is saved. What a preference reads is the file as last
read or saved with the unsaved changes made onto it in order. A save makes
the same changes onto the file as it is then.

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

`Profiles` (`packages/web/src/app/profiles.ts`) keeps where the profiles are,
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
(`packages/web/src/app/local-folder.ts`), which compares the working copy,
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

`ActionPatternChecks` (`packages/web/src/app/action-pattern-checks.ts`)
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

`ActionSearch` (`packages/web/src/app/action-search.ts`) is the search box
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

### Search and filters

The search and the **Managed**, **Not saved yet**, and **Drafts** filters
find settings across the tabs. What they found is worked out when the search
or a filter changes, or the profile is read or written, and not when a row
changes.

| State | Event                                                                                               | Next                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs  | A word is typed, or a filter is turned on                                                           | Found: the settings that fit every word and every filter show group by group in place of the tabs, each sub-option under the setting it belongs to.                                       |
| Found | A found setting is changed or reset                                                                 | Found, with the same settings, so a row doesn't vanish as it is edited. Its value and marks follow the change.                                                                            |
| Found | A change hides a found setting, as turning off the one above it does                                | Found: the hidden one goes, as on its tab, and the one above it stays to change back. The count follows what shows.                                                                       |
| Found | A save or a discard ends, whether it wrote or failed, or the profile is read again, as after a sync | Found, worked out again, so a setting a save settled leaves **Not saved yet**, and a finished or discarded draft leaves **Drafts**. A setting that shows and has an unsaved change stays. |
| Found | The search or a filter changes                                                                      | Found, worked out again from the rows as they are then.                                                                                                                                   |
| Found | Nothing fits                                                                                        | Found, with why: the words typed, or the filters, and that rulesets, environments, and labels are on their own tabs when one of them would fit.                                           |
| Found | A setting GitHub hides for another's value fits                                                     | Left out, as on its tab.                                                                                                                                                                  |
| Found | The search is emptied and every filter is off                                                       | Tabs, on the tab that was open.                                                                                                                                                           |
| Found | Show every setting, or Escape in the search                                                         | Tabs for the first; the second empties the search and keeps the filters.                                                                                                                  |

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

## Web compare

`Comparison` (`packages/web/src/app/comparison.ts`) compares one repository
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

## Web apply

`Apply` (`packages/web/src/app/apply.ts`) is one apply of a profile to one
repository, kept as the engine's [staged apply](#staged-apply) in the
browser's files under `/staged/<owner>/<name>.yaml`. It writes to GitHub
only in Applying, with the engine's `applyPlan` over the plan last reviewed,
as [Plan and apply](#plan-and-apply) describes. One piece of work counts at a
time, so work that lands late changes nothing, and the reviewed state holds
the plan it shows, so no other plan can be applied in its place.

| State                                   | Event                                                       | Next                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle                                    | **Apply** on a repository's panel, with a profile picked    | Editing, with a staged apply started from the profile. Unfinished when the repository already has one.                                                                                                                                                                                                                                                       |
| Idle                                    | **Change settings once** on a repository's panel            | Editing, with a staged apply started from the repository as it is, with no profile. Not offered, and nothing started, while the repository has an unfinished apply.                                                                                                                                                                                          |
| Idle                                    | **Resume** on a repository with an unfinished apply         | Editing, the apply as it was left.                                                                                                                                                                                                                                                                                                                           |
| Unfinished                              | Pick it up                                                  | Editing, the apply as it was left, whatever profile it started from.                                                                                                                                                                                                                                                                                         |
| Unfinished                              | Start over                                                  | Editing, with the old apply discarded and one started from the profile picked.                                                                                                                                                                                                                                                                               |
| Editing                                 | A setting or entry is changed                               | Editing, in the [profile editor](#web-profile-editor) over the staged apply, which holds no drafts: it offers no Save as draft, Preview, or draft banner.                                                                                                                                                                                                    |
| Editing                                 | Save edits                                                  | Editing, with the edits written to the staged apply, never to the profile.                                                                                                                                                                                                                                                                                   |
| Editing                                 | Review changes                                              | Reviewing, once edits that aren't saved are saved to the apply. Editing still, with why, while an edit isn't valid or can't be saved.                                                                                                                                                                                                                        |
| Editing                                 | Save edits to profile                                       | Editing, with the edits written into the profile and cleared from the apply, which resolves the same. The write takes a turn among the profiles' syncs, as a save of the profile does. Editing with why when the engine refuses, as for autolinks, a change between a Pages site and none, or a profile that no longer reads. Not offered without a profile. |
| Editing                                 | Something the apply leaves out is put back                  | Editing, with it back in what the apply sets. What is left out is named above the edits, since the engine refuses an edit to it.                                                                                                                                                                                                                             |
| Editing                                 | The apply page is left                                      | Idle, with edits that can be saved written to the apply first. An edit that isn't valid is lost.                                                                                                                                                                                                                                                             |
| Reviewing                               | The plan and the access land                                | Reviewed: the changes by section, each with what leaves it out, the locked ones with what they need, what is left out, the drafts, and the warnings.                                                                                                                                                                                                         |
| Reviewing                               | The profile can't be read, or GitHub can't                  | Failed, with why, the files by their names. A lost sign-in also goes to the sign-in page. The apply is kept, with its edits and what it leaves out, to review again, go back to its edits, or discard.                                                                                                                                                       |
| Reviewing                               | A review lands after the page moved on, as to another apply | Dropped. A review carries its own plan, so the plan an apply writes is the one of the review shown, for its repository.                                                                                                                                                                                                                                      |
| Reviewing                               | The apply's file is gone from the browser                   | Failed, saying to start it again from its repository.                                                                                                                                                                                                                                                                                                        |
| Failed                                  | Review again                                                | Reviewing. An apply that never started, as when its profile couldn't be read, starts then and opens on its edits.                                                                                                                                                                                                                                            |
| Reviewed                                | Leave out, or Put back                                      | Reviewing, with the staged apply's exclusions changed. The profile keeps the change either way.                                                                                                                                                                                                                                                              |
| Reviewed                                | A change GitHub would refuse is in the review               | Reviewed, with **Apply** off: the apply would stop there and leave the changes after it unwritten.                                                                                                                                                                                                                                                           |
| Reviewed                                | Review again                                                | Reviewing, with the profile and GitHub read again.                                                                                                                                                                                                                                                                                                           |
| Reviewed, or Failed with the apply kept | Back to edits                                               | Editing. A change that comes from a one-off edit is marked in the review and is changed or undone there, not left out.                                                                                                                                                                                                                                       |
| Reviewed                                | Apply, then Apply now                                       | Applying. Cancel in the question goes back with nothing written.                                                                                                                                                                                                                                                                                             |
| Applying                                | The repository changed since the review                     | Reviewed again, with nothing written and a notice that says so.                                                                                                                                                                                                                                                                                              |
| Applying                                | GitHub refuses a change partway                             | Reviewed again, showing what is left, with a notice naming the change and how many before it stay written. The staged apply stays to pick up.                                                                                                                                                                                                                |
| Applying                                | Every change is written                                     | Applied, with the count, and the staged apply removed.                                                                                                                                                                                                                                                                                                       |
| Applying                                | The run fails otherwise, as with no network                 | Failed, with why. The staged apply stays.                                                                                                                                                                                                                                                                                                                    |
| Any but Applying                        | Discard apply                                               | Idle, with the staged apply removed. The profile and GitHub stay as they are.                                                                                                                                                                                                                                                                                |
| Any but Applying                        | The apply page is left                                      | Idle. The staged apply stays, and its repository's panel says an apply there is not finished.                                                                                                                                                                                                                                                                |
| Applying                                | The apply page is left                                      | Applying still: the run goes on, and the page shows how it ended when it is opened again in the same visit.                                                                                                                                                                                                                                                  |
| Applying                                | Apply or Resume on a repository's panel, or Discard apply   | Applying still: an apply that is writing is neither replaced, joined, nor discarded.                                                                                                                                                                                                                                                                         |

## Web batch apply

`BatchApply` (`packages/web/src/app/batch-apply.ts`) applies one profile to
several repositories through the engine's [batch](#batch), a folder in the
browser's files at `/batch`. Its members are staged applies under `/staged`,
the same files as [applies made one at a time](#web-apply), so an apply in
progress joins a batch as it is. It writes to GitHub only in Applying, with
the engine's `applyBatch` over the plan of the review shown, which the
reviewed state holds. One piece of work counts at a time.

| State            | Event                                                                                 | Next                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle             | **Review apply**, with repositories ticked, a profile picked, and no batch unfinished | Reviewing, with a batch started: a new apply for each repository, and each apply already in progress joined as it is.                                                                                                                                                                          |
| Idle             | **Review apply** with a batch unfinished, which the repositories page disables        | Failed, under the unfinished batch's own profile, with a batch to review again. Nothing starts.                                                                                                                                                                                                |
| Idle             | **Resume** on the repositories page, with a batch unfinished                          | Reviewing, the batch as it was left.                                                                                                                                                                                                                                                           |
| Reviewing        | Every repository is planned                                                           | Reviewed, under the profile the batch itself names: each repository with its changes, or that it is already in line, needs access, couldn't be compared, or is left out; each change with how many it reaches; and a note on an apply that starts from another profile or none.                |
| Reviewing        | The batch can't start or be read                                                      | Failed, with why and whether a batch is there. A batch that couldn't start leaves nothing behind. A lost sign-in also goes to the sign-in page.                                                                                                                                                |
| Reviewing        | A review lands after the page moved on                                                | Dropped.                                                                                                                                                                                                                                                                                       |
| Reviewing        | Any button                                                                            | Nothing: the last review stays in view with its buttons off.                                                                                                                                                                                                                                   |
| Reviewed         | A repository is unticked, or ticked again                                             | Reviewing, with it left out of the batch or put back. Its apply stays as it is.                                                                                                                                                                                                                |
| Reviewed         | Remove from batch, on a repository left out or not compared                           | Reviewing, with it out of the batch; an apply the batch started for it is discarded. Idle when it was the last one, and the batch has ended.                                                                                                                                                   |
| Reviewed         | Leave out, or Put back, on one repository's change                                    | Reviewing, with that repository's apply changed.                                                                                                                                                                                                                                               |
| Reviewed         | Leave out everywhere, or Put back everywhere                                          | Reviewing, with every repository's apply changed. One that refuses, as when its own edits set the value or its apply can't be read, keeps it and is named.                                                                                                                                     |
| Reviewed         | Review again                                                                          | Reviewing.                                                                                                                                                                                                                                                                                     |
| Reviewed         | Apply, then Apply now, with a repository that has changes to write                    | Applying, one repository at a time, each result shown as it lands. Cancel in the question goes back with nothing written.                                                                                                                                                                      |
| Applying         | A repository is written, or needed nothing                                            | It finishes and leaves the batch.                                                                                                                                                                                                                                                              |
| Applying         | A repository changed since the review, is locked, or fails partway                    | It is not written, or keeps what was written before the failure, and stays in the batch. The next one is tried.                                                                                                                                                                                |
| Applying         | GitHub answers 401                                                                    | That repository fails and the account is signed out, once. The rest are tried and fail the same way.                                                                                                                                                                                           |
| Applying         | The last repository is tried                                                          | Applied: those that didn't finish first, with why, then the rest. The batch ends when every one finished.                                                                                                                                                                                      |
| Applying         | Review apply, Resume, or Discard batch                                                | Applying still: a batch that is writing is neither replaced, resumed, nor discarded.                                                                                                                                                                                                           |
| Applied          | Review again, with repositories left in the batch                                     | Reviewing, with what is left in the batch.                                                                                                                                                                                                                                                     |
| Applied          | Review again, with the batch ended                                                    | Applied still: nothing is left to review.                                                                                                                                                                                                                                                      |
| Failed           | Review again, with a batch there                                                      | Reviewing.                                                                                                                                                                                                                                                                                     |
| Failed           | Review again, with no batch, as after one that couldn't start                         | Failed still, with why it couldn't start.                                                                                                                                                                                                                                                      |
| Any but Applying | Discard batch                                                                         | Reviewing with nothing shown while it goes, so nothing is applied from it, then Idle, with the batch removed and the applies it started. An apply that joined it stays, to resume on its own. A batch that can't be read loses its list only. One that can't be discarded is Failed, with why. |
| Any but Applying | The batch page is left                                                                | Idle. The batch stays, and the repositories page says a batch apply is not finished.                                                                                                                                                                                                           |

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
