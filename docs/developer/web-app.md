# The web app

The web app runs at <https://repotted.dev> on a Cloudflare Worker, `repotted`,
in `packages/web`, and a preview of it runs on the same Worker at
<https://main.preview.repotted.dev>. The Worker serves the app's static files
and handles the GitHub App's web sign-in on the same origin, so the sign-in
needs no cross-origin requests and the client secret stays on the server. The
page runs the [engine](#the-engine) itself and calls GitHub's API from the
browser. It signs in and lists the user's repositories.

## Layout

- `src/worker.ts`: the Worker. It answers only `/api/*`.
- `src/main.tsx`: the page's entry. It makes the session, the engine's GitHub
  client, and the account, and renders the app.
- `src/app/`: the app's state, with no DOM in it, so the tests drive it
  against the in-memory GitHub. Each part, such as `Account` and
  `Repositories`, is a class that keeps its state in
  [signals](https://github.com/preactjs/signals). Its folders group it by
  feature:
  - `account/`: who is signed in, the GitHub App, and `session.ts`, the page's
    access token, refreshed through the Worker, and its calls to GitHub, which
    skip the browser's cache so a read shows changes made elsewhere.
  - `navigation/`: the page's address and the repository it names.
  - `repositories/`: the repository list, its folders, and what is hidden.
  - `preferences/`: the choices kept in this browser, and those kept beside
    the profiles in the config repository.
  - `profiles/`: where the profiles are, the local folder they sync with, the
    built-in protection for the config repository, and the preview of one of
    its branches.
  - `profile-editor/`: one open profile, its entries and settings, and the
    searches and checks it runs.
  - `apply/`: comparing a repository with a profile, and applying to one
    repository or a batch.
  - `storage/`: keeping the engine's files across visits, and running writes
    one at a time.
- `src/views/`: [Preact](https://preactjs.com/) components that draw that
  state and call its methods. They hold no state of their own beyond what a
  control needs, such as an open menu. `app.tsx` puts the pages together,
  `layout/` holds the header, the action bar, links, and the phone layout,
  `settings/` is the Settings page, and each other folder is named for the
  `src/app/` folder it draws.
- `src/engine/`: what the engine needs to run in the page: its in-memory files
  and POSIX paths, the user's local folder through the File System Access API,
  and its GitHub client for the session.
- `tests/`: the same folders as `src/app/`, with `engine/` for the engine's
  stand-ins, `support/` for the fake browser, and `layout/` for the layout
  check. `worker.test.ts` tests the Worker.
- `aliases.ts`: the engine's Node modules and what stands in for each in the
  page. `build.ts` and the root `vitest.config.ts` both read it.
- `static/`: the HTML, the CSS, the fonts, and `_headers`, the headers
  Cloudflare adds to every static file.
- `build.ts`: copies `static/` into `dist/` and bundles the page into
  `dist/app.js`. Wrangler runs it before every deploy and dev session.
- `wrangler.jsonc`: the Worker's config. `assets.run_worker_first` sends only
  `/api/*` to the Worker; Cloudflare serves every other path from `dist/`, and a
  path with no file gets `index.html`, for the app's own routes. The Worker's
  `workers.dev` address and Version URLs are off, and its `previews` block
  holds what the [preview](#deploy) needs. The custom domains are set in the
  dashboard, not here; [Deploy](#deploy) says why.

The Worker and the page run on web platform APIs, so
`packages/web/tsconfig.json` checks them with the DOM library in place of
Node's types; `build.ts` runs under Node and the root config checks it.

## The engine

The page bundles `packages/core` and calls it directly, as the CLI does, so
the rules about what Repotted may write stay in one place. The only Node
modules the engine runs are `node:fs/promises` and `node:path`; everything else it uses,
such as hashing and base64, is on the web platform, which Node has too.
`aliases.ts` maps those two modules for the page's bundle:

- `node:fs/promises` to `src/engine/files.ts`, a tree of files in memory. It
  has the functions the engine calls, with Node's error codes, and no links
  or permissions. `watchFiles` reports each file written or removed, which is
  how a store keeps what the engine writes.
- `node:path` to `src/engine/path.ts`, POSIX paths under `/`.

So a profile, a staged apply, and a batch are files at absolute paths in the
page too, and the engine's functions take the same arguments there as under
Node. The engine's own tests run on Node's file system;
`tests/engine/engine.test.ts` runs its profile, staged apply, and batch flows on the
in-memory one, through the same aliases, in Vitest's `web` project. A Node module that the engine
imports and `aliases.ts` doesn't map fails the build, which `ts:web:check`
runs.

`src/engine/github.ts` gives the engine a GitHub client that sends each
request with the session's current access token. A browser that isn't signed
in gets a 401, as a refused token does, so one check covers both.

## Sign-in

The web app signs in with the Repotted App's web flow, with PKCE. The
[GitHub App](github-app.md) page covers the App itself.

| Endpoint                  | What it does                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/sign-in`   | Makes a state and a PKCE verifier, keeps both in a 10-minute cookie, and sends the browser to GitHub with the state and the verifier's S256 challenge.                                                                                              |
| `GET /api/auth/callback`  | Checks the state against the cookie, trades the code for tokens with the verifier and the client secret, keeps both tokens in cookies, and sends the browser to `/`. A failure goes to `/?sign-in=…`, with GitHub's error code or a failing status. |
| `POST /api/auth/token`    | Returns the kept access token and its seconds left. When that token has 5 minutes or less left, or the request names it as one GitHub refused, it first trades the refresh token for new tokens and keeps both.                                     |
| `POST /api/auth/sign-out` | Clears both tokens' cookies.                                                                                                                                                                                                                        |

The page calls GitHub's API directly with the access token; GitHub's API
allows cross-origin requests. Each tab holds the token in memory and asks the
Worker again when it is within 5 minutes of expiry, timed on the browser's own
clock from the seconds left the Worker returned.

GitHub revokes the old access token whenever a refresh token is used, so every
tab has to share one access token: a tab that refreshed for itself would cut
off the others. The Worker keeps the current access token in a cookie and hands
it to every tab while it has more than 5 minutes left, and refreshes only after
that. The page runs every request for a token, and sign-out, under one
[Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) across the
site's tabs, so no two refreshes send the same refresh token, which works only
once. When GitHub's API refuses a tab's token anyway, the tab names that token
to the Worker, which hands back a newer one if another tab already got it, or
refreshes otherwise, and the tab tries once more.

Both token cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, and named with
the `__Host-` prefix, so the page's scripts can't read them and no subdomain or
plain-HTTP page can set them. The refresh token's cookie lasts as long as the
refresh token, six months; the access token's as long as it, eight hours. The
sign-in's cookie is `SameSite=Lax`, since the browser returns from GitHub on a
cross-site navigation, which carries only Lax cookies.

The two `POST` endpoints refuse a request whose `Origin` isn't the site's own,
so another site's page can't fetch a token or sign the user out. Every API
response is `Cache-Control: no-store`. The Worker waits 10 seconds for GitHub's
token endpoint and the page 20 seconds for the Worker, and either reads a
timeout as GitHub being out of reach.

The Worker sends its requests to GitHub's token endpoint over a TLS socket it
opens with the Workers runtime's `connect()`, not with `fetch`: a Worker on a
custom domain gets Cloudflare's 525 from `fetch` to github.com
([workerd issue 7042](https://github.com/cloudflare/workerd/issues/7042)).
`src/post-over-tls.ts` writes one HTTP/1.1 `POST` that asks for an
uncompressed answer and closes the connection, and reads the answer, whether it
has a length, comes in chunks, or runs to the close, into a `Response`, as
`fetch` would. Once Cloudflare fixes `fetch`, reverting the change that added
the module takes the Worker back to it. An answer that isn't HTTP, or whose
headers don't end within 64 KiB, counts as no answer. One whose body breaks
off, is malformed, or runs past 64 KiB reads as an answer that broke off.

The Worker names itself to GitHub with a `User-Agent` header. Neither a
Worker's `fetch` nor its socket adds one, and GitHub may turn away a request
without one.

Every auth request logs one structured line, with its `route`, its `outcome`,
and, when GitHub's token endpoint was asked and failed, `gitHubStatus`,
`gitHubOAuthError` and `gitHubAnswer`: what GitHub sent, in a few words such as
`status 200, bad_refresh_token` or `status 403, text/html, not JSON`. Failures
log as warnings. No line holds a token, code, verifier, cookie or the client
secret; GitHub's error code is kept only when it is a plain code, and its
media type only when it is a plain type. A failed renewal's 502 and a refused
renewal's 401 carry `gitHubAnswer` too, and the sign-in page shows the 502's;
a refused renewal reads as signed out. A failed sign-in's redirect to
`/?sign-in=failed` carries only GitHub's error code as `github-error`, or else
a status that isn't a success as `github-status`. The address is anyone's to
write, so the page shows only the error codes GitHub documents for a sign-in
and a three-digit status.

A status of 520 to 526 or 530 comes from Cloudflare, not GitHub: Cloudflare
couldn't connect to GitHub. The logs and the page say so. Only `fetch` goes
through Cloudflare's proxy, so the socket never gets these; they stay for when
the Worker goes back to `fetch`.

`observability` in `wrangler.jsonc` keeps Workers Logs and traces on, for
production and Previews alike: `wrangler deploy` turns observability off when
its config leaves it out, even when the dashboard turned it on. The lines
show in the Worker's logs in the dashboard. `redact_query_string` leaves query
strings out of logs and traces, since the callback's holds the sign-in code.

A refused refresh leaves the cookies alone, since clearing them could replace
newer tokens that another tab stored meanwhile. Sign-out ends the sign-in in
this browser; other open tabs keep the access token they hold until it
expires, and the authorization stays on the user's GitHub account until they
revoke it there. [State machines](state-machines.md#web-sign-in) lists each
transition.

## The app

`App` draws the sign-in page until `Account` reads who is signed in, and the
shell with its pages after. A 401 from GitHub anywhere in the app means the
sign-in no longer works, so the part that met it calls `Account.refused`, and
the app returns to the sign-in page with why.
[State machines](state-machines.md#web-account) lists the transitions.

The look follows the approved mock-ups: `static/app.css` holds their colors,
with a light and a dark value where the two differ, which the system's
setting picks, and the
Atkinson Hyperlegible fonts are served from `static/fonts/`. All text is in
sentence case: only the first word and proper names are capitalized.

Choices that belong to the browser, such as where profiles are kept, are in
`localStorage` through `Preferences`, under keys that start with `repotted:`.
They are not kept per account.

Choices that follow the user, such as the owners and repositories the list
hides and the user's folders, go through `SharedPreferences`
(`src/app/preferences/shared-preferences.ts`), which has the same `read` and `write`, and
`update`, which saves a change to a value, such as adding a name to a list,
rather than the value. `save` makes the same change and returns whether it
was persisted in the current destination, so a dependent action can wait
for a successful save. While profiles are kept in a config repository, it
keeps them in `.repotted-preferences.json` beside the profiles and commits
each change there through the contents API; otherwise it passes them to the
browser's `Preferences`. The file is a JSON object keyed by preference key,
such as `hidden-repositories`, `hidden-repository-owners`,
`repository-folders`, `repository-profiles` and `profile-tags`, with keys in order so a commit changes only the values
that did. It is a hidden file, so a profile sync and the profile list leave
it alone. Another list setting that should follow the user takes its own key
in the same file, and changes it through `update`, as folders do. A choice
that changes often and matters to one browser, such as which folders are
closed (`closed-repository-folders`), the list's sort order
(`repository-sort-order`) and its filters (`repository-filters`), goes
straight to the browser's `Preferences` instead, so it never makes a commit.
Each commit's message comes from comparing the file as read with the file
about to be written, in `src/app/preferences/preference-changes.ts`, which
owns the shared keys and how their values are read, except
`repository-profiles`, which `src/app/repositories/saved-assignments.ts`
owns. `src/app/preferences/assignment-changes.ts` names what changed in
repositories' and folders' profiles: a profile assigned, taken off or put in
another order, a change of full section ownership or of applying profiles on
move, and an apply. An apply names only the profiles whose recorded version
is new; one that records no new version, as after a reorder, reads
`Apply profiles to repository: octo/app`. It names changes by profile, as in
`Apply profiles base, web to repositories: octo/a, octo/b`, or by
repository or folder, as in
`Update profiles for repository octo/app: assign core/base, remove base`,
whichever names every change in the subject, then whichever needs fewer
clauses. A folder gone and one
made that share repositories, or are the only ones and the old one was
empty, count as a rename, so
changes saved together still read as what was done. A change it has no line
for, such as a list put in another order or a key it doesn't know, is named
as `Update preference: <label or key>`, so a new shared key adds its wording
there.
Each of those keys is removed when its choice is back at the default, so a
browser that never changed it keeps nothing. Sorting and filtering live in
`src/app/repositories/sort-and-filters.ts`; `Repositories` applies them to
its folders, owner groups and count. Nothing moves between the
browser and the file when the profiles move.
[State machines](state-machines.md#web-shared-preferences) lists the
transitions.

`Router` holds the page's address, and `Link` changes it without loading the
page again. The Worker's asset config answers every path with `index.html`,
so an address works when opened directly.

The header's and menu's page links pass `opensPage`, and `Router` tells its
`onTopOfPage` listeners, so the signed-in shell closes the open profile and
repository: what a page last had open is state in `Profiles` and
`Repositories`, not in the address, so it would come back otherwise. A page
whose work leaving would lose registers a question with `useLeaveQuestion`,
which calls `Router.holdWhileLeaving`. `Router.go` then holds the address
in `leaving` until `leave` or `stay`. `popstate` can't be cancelled, so each
entry the router pushes holds its place in the history, and a back or forward
away from held work is undone with `history.go` while it asks.
`LeaveQuestionDialog` draws the question. Closing the tab still asks through
the browser's own `beforeunload` prompt. A page's own finishing navigation,
such as after Create, passes `withoutAsking`.

Dialogs put their answers at the end, the main one last. A **Cancel** or
**Close** is a plain button that closes the dialog, not a submit button, so
Enter in a field still submits the main answer.

User-triggered completions use `Notifications` in `src/app/notifications.ts`.
The signed-in shell owns its lifetime, so navigation preserves confirmations
and sign-out disposes pending timers and ignores late completions. Profile
confirmations check the sync, conflicts, and listing result before
claiming success; browser copies are described as available in the tab.
Shared preferences report saved keys after a successful write to their
current destination. Batch actions confirm at the action boundary. Batch apply
saves each repository's applied-profile record without a save confirmation,
including on a later retry. It waits for those saves before confirming the
successful batch once with its repository count; failures keep their durable
results without a success toast. Other saves keep their own confirmations,
even when they share a commit with a batch record.
`views/layout/notifications.tsx` draws one confirmation
and pauses it while hovered, focused, obscured by a dialog, or in a hidden
tab. [State machines](state-machines.md#web-confirmations) owns the transitions.

Empty states offer a next action and search resets return focus to the field
without changing other filters. `Profiles.listed` distinguishes a successful
empty read from the initial unread state and resets when the source changes.

Pending page and lookup reads use `views/layout/loading.tsx`. Initial lists
show decorative skeleton rows and one accessible status. A failed initial read
keeps its error instead of drawing an empty state. Refreshes retain existing data. Batch progress uses completed
repository counts from the apply state. Reduced motion stops spinner rotation.

`views/layout/pending-button.tsx` owns pending button presentation. The label
stays as it was when the action started. Idle text and the spinner with that
text share a grid cell, keeping both presentations centred and the button size
stable. Pending buttons stay focusable but suppress activation
and expose `aria-busy` and `aria-disabled`. Existing operation signals drive
buttons with a dedicated state. `usePendingAction` owns a control-local lock
for shared profile operations; it starts work from the user gesture, releases
the lock on fulfillment or rejection, and ignores state updates after unmount.
Reduced motion stops spinner rotation.

## Profiles

`Profiles` (`src/app/profiles/profiles.ts`) holds where the profiles are kept, how the
last sync went, and the list the Profiles page draws. Profiles are files in the
engine's in-memory files, in one of three folders:

- `/profiles/browser`, for profiles kept in this browser only.
- `/profiles/folder`, the working copy of a folder on the user's computer,
  which `syncLocalFolder` keeps in line with the folder through the File
  System Access API. Only Chromium browsers have that API, so elsewhere
  Settings offers no folder. `src/engine/local-folders.ts` holds the API's
  calls and keeps the folder's handle in an IndexedDB database of its own;
  the browser asks the user again on each visit before the page may use it.
- `/profiles/github/<owner>/<name>/@<folder>`, a working copy of a folder in
  a config repository, with the engine's sync record in it. `syncFolder`
  brings it and the repository in line through GitHub's API, as it does a
  folder on disk for the CLI, so conflicts and first syncs follow
  [the same rules](state-machines.md#config-repository-sync).

Syncs, new profiles, deletions, moves, and changes of where profiles are kept
take turns in one queue, so a sync never reads a folder that is being
changed. A capture reads GitHub with the engine's `captureProfile` before it takes its
turn, so a slow read holds nothing up. Of the capture's warnings, the new
profile's page shows only the `refused` ones, which someone can act on:
`uncaptured-settings.ts` names each by its label in `setting-fields.ts` and
groups them by `remedy`, behind a count. A read that covers several settings
is named by the ones that depend on none of the others, leaving out those the
profile's owner type can't hold. What a profile of its owner type
can't hold, what the repository doesn't offer, and a value a profile can't
parse go unmentioned there.
[State machines](state-machines.md#web-profiles-source) lists the
transitions.

A profile folder is a real subfolder of the profiles folder, which the list
shows only while a profile is in it, and a reference is a path from the
profile's own folder. `Profiles.move` and `Profiles.renameFolder` move files,
and in the same turn rewrite the references in every listed profile whose
path to a definition changes, with core's `withRewrittenReferences`. A write that fails takes back the writes before it, so a move is made
whole or not at all. The batch selection, `Profiles.batch`, and which folders
are closed are kept for the visit only, never in shared preferences, so
opening a folder or selecting a profile commits nothing.
[State machines](state-machines.md#web-profile-batch-actions) lists the
transitions.

A config repository is marked so a new browser can find it
(`src/app/profiles/config-marker.ts`): the `repotted-config` topic, set
through the topics API alongside the repository's other topics, and a
hidden `.repotted.json` at the repository's root, `{ "folder": "<path>" }`,
committed through the contents API like `.repotted-preferences.json`.
`Profiles` moves the mark after each change of where profiles are kept that
succeeds, taking the topic off the repository it left, and says in
`markProblem` why when GitHub refuses. The marker's commit moves the default
branch on, so the working copy syncs once more after it. `ConfigDiscovery`
(`src/app/profiles/config-discovery.ts`) runs once a visit, when the
repository list first loads, since each listed repository carries its
`topics`: it marks a chosen repository that has neither the topic nor a
marker, as one chosen before marks existed, and in a
browser that has never chosen (`Profiles.chosen`), offers the marked
repositories through `views/profiles/found-config.tsx`, above every page.
[State machines](state-machines.md#web-config-repository-discovery) lists
the transitions.

`ProfileEditor` (`src/app/profile-editor/profile-editor.ts`) is the open profile's settings
and its unsaved changes. `setting-fields.ts` lists the settings it offers,
tab by tab, with what each depends on; a test sets every one through the
engine, so a setting the engine doesn't take fails there. A change is
previewed with the engine's `previewProfile` and saved with `editProfile`,
which writes only the settings that changed and keeps the file's comments.
Rulesets, environments, and labels are written whole. `entry-forms.ts` has
the functions that change one thing in an entry and leave the rest of it as
the file has it, and `entry-edits.ts` holds each change with the saved entry
it was made on, so a save never writes an entry over one that has since
changed elsewhere. `views/profile-editor/entries.tsx` only draws them.

`views/profiles/definitions.tsx` gives Actions policies, rulesets, and
environments separate routes. It reuses `NewProfileForm` fixed to a kind
and the existing profile editor, preserving capture, duplicate, owner
handling, and drafts. `Profiles.definitions` derives library
lists from the same listings; the profile tree filters them out without
removing definitions from apply and assignment pickers.

An export is the saved file, and for a profile, each definition it
references carried under a top-level `bundled` key, keyed by the reference
as the profile writes it (`exportProfile` in
`packages/core/src/profiles/profile-export.ts`). No saved profile has that
key: `readProfileImport` takes it out and checks each carried definition
against its reference, and `withBundledInside` writes them into the profile
so it resolves as it did with the references. Import also reads a ruleset
in GitHub's export format, without GitHub's own fields.

`app/profiles/profile-import.ts` stages an import under `/imports`, outside
every profiles folder, so nothing is listed or synced before Save. The
staged files keep the profiles folder's layout, so references between them
resolve as they will once saved, and references to files already there are
rewritten from the staging folder and back. `Profiles.importing` holds the
import and an ordinary `ProfileEditor` on the staged file, which saves only
there. `Profiles.chooseImport` stages in a turn of the profiles' queue, so a
sync can't change the libraries while the definitions are placed, and
refuses a name another definition has. `Profiles.saveImport` then writes the import and its new definitions
in the profiles' queue, never over a file, and removes what it wrote when a
write fails. The editor's `canSaveNewFile` lets Save add the file without a
change first. [Imports](state-machines.md#imports) has its states.

`SharedDefinition` adds a reference picker to each related profile editor
tab. Profile creation leaves these choices to the editor; duplication
retains existing references. An existing editor previews and saves
`references` with its settings, checks the original file text before
replacing that mapping, and refuses drafting reference edits.
`ProfileEditor` retains optional reusable choices for new Actions policy, ruleset, and environment rows, includes them in dirty and save guards, and clears them on
reset or a successful write. Entry removal makes its choice inactive;
batch undo restores it with the entry. The profile store's `saveReusable`
capability keeps these controls out of standalone definition and staged
apply editors. `save-reusable-definitions.ts` validates destination names
and effective configuration in the profiles' write turn, writes definitions
exclusively, and replaces the corresponding new inline entries with relative references. A failed profile write removes every
definition created by that attempt. Sync commits the complete change.
Library links use the effective source
files of referenced values. Saving a definition refreshes the existing
editor cache, preserving unrelated edits. Consumer tracking includes cached
unsaved references; deletion refreshes dependencies before checking its
kind, dirty state, profile consumers, and assignments.

`readProfileForEditing` opens syntactically valid YAML even when the
configuration cannot resolve. It retains known invalid values with
path-based problems and source files, and omits unknown keys. The editor
shows field and area errors before a change is made. Unique entry names
keep their row identities; unnamed or duplicate entries use their original
list positions. Unknown keys enable a cleanup-only save without marking the
profile as an unsaved user edit. The save preview lists those keys. Saving
prunes unknown fields from the original YAML document while retaining known
invalid values, comments, and open records such as rule parameters.
Referenced files stay untouched. Syntax-repair saves use the same cleanup.
Corrections edit the original document before validating
the result. Planning still uses `resolveProfile`, which requires a valid
configuration.

If the YAML syntax is invalid, `ProfileRepair` in `profile-editor/` keeps its
original text and editable YAML. It validates syntax through
`readProfileForEditing` with replacement text at the file's real path.
Configuration errors remain available in the forms after a syntax repair. It validates again in the profiles' write
queue after syncing, then compares the file with the original text before
replacing it. A mismatch refuses the save and keeps the corrections. Dirty
repairs keep their original version through refreshes, even if the saved file
becomes valid. The editor cache keeps corrections across navigation; a
successful save returns to the settings unless newer text remains unsaved.
Pending setting and entry edits survive a failed read and a repair too.
Staged applies use their own store and do not offer whole-file repair.

A value is checked by the engine's own rules, so the editor refuses what a
profile file would, in the same words: `settingValueProblems` and
`entryValueProblems` in core check one setting by its path, or one entry,
against the profile's schema. `parse` checks typed text first for its kind,
such as a whole number, then by `settingValueProblems`. An entry's problem
names the field of its form it is in (`EntryField`), so the form shows it
under that box. `ProfileEditor.problemsBlockingSave` lists everything that
holds Save back, in tab order: typed text that can't be a value, a setting
GitHub hides included; an entry that can't be saved to apply; and the engine's
refusal of the changes together. `views/profile-editor/save-problems.tsx`
draws it as the save bar's count and list, and `resetEverythingBlockingSave`
resets each setting and unsaved entry in it. A saved draft entry offers
navigation but no reset until it has an unsaved change. Ordinary tab
navigation clears a previous destination, so returning to a tab does not
reopen a form the user closed.

`comparison.ts` compares a repository with a profile: the engine's
`createPlan` over the resolved profile, shown as rows by section, with
`lockChanges` marking what the account's access can't change.

`branch-preview.ts` previews a branch of the config repository. The engine's
`readBranchChanges` (`packages/core/src/profiles/branch-changes.ts`) asks GitHub's
compare API what the branch changes since it left the default branch, then
reads only the blobs of the profiles it adds or changes. The preview copies
the working copy, in a turn of the profiles' queue so no sync changes it
mid-read, into `/preview/<n>/before` and `/preview/<n>/after`, lays the
branch's files over the second, and resolves every profile on both sides, so
a profile that changes only through a definition it references shows too. A
profile whose chain leaves its side's folder doesn't load, so a branch can't point one at
the browser's other profiles. The before side is the working copy, not the
default branch, so the preview lists the profiles whose blob ids differ from
the sync record, which it would show as undone by the branch. Its rows reuse
the comparison's names for settings and values. `keepFiles` keeps nothing under
`/preview`, and the preview deletes its folder when it closes. A read costs
one request for the repository, one for the branch, one comparison, and one
for each changed profile.

`apply.ts` applies a profile through the engine's staged apply, in temporary
files under `/apply/<id>/apply.yaml`. Its first step is the profile editor
over that file, followed by the review. An `EditorStore` gives
`ProfileEditor` the engine functions that read, preview, and write a profile
or a staged apply. It reviews with `planStagedApply` and writes through the
apply queue.

`apply-queue.ts` makes every write to a repository's setup, for the apply
page and the batch page alike. An entry is one repository's reviewed plan,
kept as a file under `/queue` so it outlasts the tab, and the engine plans
the repository again before it writes, so an entry is safe to run twice.
Queuing the setup a repository should end up with, not the requests, is what
lets a cut-off apply carry on: a request may or may not have landed when the
tab closed, and planning again finds out. The header's card
(`views/apply/queue-status.tsx`) shows the queue on every page. When the app
opens with entries left, it carries on by itself if the oldest was queued
within 60 minutes, and otherwise waits for **Continue with N changes**, so
that changes someone asked for long ago aren't written the moment they come
back. The queue needs no lock of its own, since one tab at a time keeps the
files. [State machines](state-machines.md#web-apply-queue) lists the states.

Pending applies belong to their pages, in the client's in-memory filesystem.
Leaving discards their files and edits; a write already under way finishes. Each start has its own folder, so
cleanup and late work from an apply left behind cannot remove or replace a
later one. A late file creation is cleaned up when its work settles. Drafts
belong to profiles and never form an apply state.

`config-protection.ts` holds the built-in protection for a config
repository, as profile YAML by what owns the repository, and checks the
repository the profiles are kept in against it. Its apply is an ordinary
apply whose staged file lists `/built-in/<name>.yaml` in `extends`, which `Apply` marks
`builtIn` so the edits can't be saved back to it. A new built-in, such as one
for organizations, is another entry there.
[State machines](state-machines.md#web-config-repository-protection) lists
the states.

`batch-apply.ts` reviews several repositories through the engine's batch in
`/apply/<id>/batch`. Each member starts from the selected profile or its
effective folder and own layers, and the batch has the same page-scoped
lifetime as a single apply. The engine limits concurrent planning as it
does for every batch.

Repository folders keep optional `profiles` and `applyProfilesOnMove` fields
alongside their membership in `repository-folders`. Omitted fields mean no
layers and no review on move. `RepositoryProfiles.profilesOf` combines a
repository's folder layers with its own, keeping the first occurrence of a
path; the engine resolves shared ancestors once. `ownProfilesOf` supplies
the editable repository list, so inherited layers are never copied into it.
Folders are flat and inherit all their layers; there is no per-layer opt-out.

`views/repositories/folder-profiles.tsx` draws both the header tags with their
quick picker and the **Profiles** dialog. The picker appends a profile to the
current saved list immediately; the dialog keeps edits local until saved.
Header tags measure their intrinsic width with a `ResizeObserver` and
collapse to a count when they exceed the available space. Phone headers
keep one row with the tags on the right and selection in the folder menu.
The tag names and count stay measurable while hidden. The header reserves
the smaller of their intrinsic widths plus the picker, so a side panel
cannot clip the badge. A phone's width budget comes from the full tag list
even while collapsed. Measuring rendered widths avoids parsing CSS math
expressions and lets the count expand when that budget grows.
The header picker only saves the folder. `FolderSettings` in
`app/repositories/folder-settings.ts` owns the dialog's draft, saved baseline,
and pending save. **Save** waits for `SharedPreferences.save` without opening
a review. **Save and apply** waits for persistence, then
`Repositories.reviewFolderProfiles` reviews every stored member, independent
of the list's visibility. **Apply** uses saved profiles and is unavailable
while the draft differs from its baseline or current settings, or folder
preferences are pending. Failed saves retain the draft. A successful save
whose review is blocked leaves **Apply** available. Closing the dialog lets
a pending save finish without opening a late review.

`Repositories.moveToFolder` calls its review callback only for repositories
newly entering a known folder with the setting on and layers assigned.
Preference reads, **Save**, header profile additions, renames, deletions, moves out, and moves to
the same folder never call it. Both move and explicit folder reviews use
`reviewAssignedProfiles` in `profile-reviews.ts` to open a single review
or one batch using each member's effective layers. A single review
starts atomically in `Apply.startReview`, so late work cannot advance a
newer apply from its edits. An active single or batch write refuses the
review; a shell notice names the moved repositories and asks for a manual
review after the write finishes. The move remains saved
when planning fails or the review closes. Changes read from another browser
update inherited layers and status through the shared preferences without
opening a review.

The repository list's changed-profiles notice, in
`views/repositories/repository-profiles.tsx`, opens its review through the
same `reviewAssignedProfiles`. Which repositories it counts comes from
`changedInView` in `profile-reviews.ts`, which keeps those
`Repositories.repositoriesBeforeSearch` shows and names them by their full
names, since assignments keep them in lowercase.

Repository assignments keep optional `authoritative` and
`appliedAuthoritative` section lists beside `profiles` and `applied` in
shared preferences. Omitted lists mean partial management. Ownership belongs
to the repository, never the folder, and covers the entire resolved effective
profile combination. Changing the own profile list preserves ownership unless
the dialog explicitly saves another choice. An assignment with ownership and
no profiles remains meaningful: its owned sections have an empty desired set.

The app offers the engine's ownable sections except autolinks, which it has no
editor for; the CLI still owns them. `app/repositories/saved-assignments.ts`
lists the offered sections and drops any other saved section when it reads
the preferences, so such a section goes back to partial
management instead of making every assignment unreadable.

`app/repositories/assignment-review.ts` owns the `ProfileAssignments` interface
consumed by both apply flows and implemented by `RepositoryProfiles`. It
recognizes an apply of the assigned profile order or an offer to add one
profile, checks whether exclusions, one-off edits, refused reads, or differing
ownership prevent recording, and verifies the source versions before returning
an applied baseline. Batch review classifies the source before resolving it for
baseline recording, so a profile outside the assignment needs no extra read,
unless it is the batch's one profile, which it may add to that repository's
list. A source of that kind lost after planning is not added, and the apply
refuses it.
Single and batch apply keep their own page state and
write orchestration; neither imports the other's implementation to interpret
an assignment.

`Apply` uses saved ownership when its source list matches the assignment;
an explicit ownership argument overrides it for that apply. `BatchApply`
writes each assignment's ownership to its own staged file before planning.
Both carry a snapshot of effective profile order and ownership through the
review and check it after engine revalidation, before writes begin. A changed
assignment refuses the old review. Single review-again rebuilds from the
current assignment; a batch asks for a fresh review. Successful recording
compares the staged ownership with the saved choice, so a one-time override
never advances the assignment baseline. A no-change single apply also
revalidates through the queue before recording. The queue makes that check
and the record for both flows, from what each entry carries, so they still
happen for an entry that is finished after a reload.

A review reads source versions before live planning and checks them against
the versions it would record afterward. A changed source refuses the review,
so its plan and assignment baseline cannot describe different source states.
A successful full apply records the versions and ownership reviewed without
changing the repository's own layers. Batch reviews carry those versions beside each
plan, and record them only for successful or in-line members, without
exclusions, one-off edits, or refused reads. An entirely in-line batch offers
**Mark as applied**, which rechecks each repository through the batch engine
and records versions without writing repository settings.
Its change summary groups exclusion keys into readable
labels using the comparison's setting fields, and retains each affected
repository once per key. That summary includes repositories with locked
changes, marked as needing access; the heading and confirmation list only
the ready repositories with changes and no locks.

`action-pattern-checks.ts` asks GitHub what each allowed action pattern
matches, with the engine's `checkActionPatterns`, and keeps the answers by
pattern text. `action-search.ts` searches GitHub for repositories to add to
the list, with the engine's `findActions`. `Profiles` gives each editor its
own of both.

`setting-search.ts` finds settings by the words typed: each must start a
word of the setting's label, key, note, choices, group, tab, or the other
names it lists, and a sub-option is also found by the setting it sits under.

The editor opens on the file's own [draft](architecture.md#drafts) and saves
two ways, as [the draft's table](state-machines.md#the-draft) lists. Each
row has what applies, the draft, and the change over them, and one function
for settings and one for entries turn how a row ends into the engine's
edits for each kind of save, so a preview, a save, and a save as a draft
agree on what a row means.

`keepFiles` (`src/app/storage/kept-files.ts`) keeps files under `/profiles` across
visits: it loads what IndexedDB holds into memory before the app draws, then
writes each change there in order, by the file's path. So a working copy,
with saves that haven't reached GitHub, is there on the next visit. The
engine's temporary files, pending applies and batches, and branch previews
are not kept or restored. In a browser that gives the site no storage, the
files last for the visit, and Settings says so.

What is kept must be the files as they were at one moment, or a later sync
can take a profile the browser lost for one the user deleted. So one tab
keeps the files at a time, under a Web Lock that it holds until it closes,
and a second tab shows a page that says so. And the first change that can't
be kept, such as when storage is full, is the last one tried: a notice says
that changes last until the tab closes. Since a change reaches IndexedDB
after it is made in memory, the page asks the browser to hold the tab open
(`beforeunload`) while any write is pending. The page registers that in
`main.tsx` rather than in a view, so it holds after the view that made the
change is gone. A save doesn't wait for its write: the prompt covers a
closed tab either way, and a crash loses a pending write whether or not the
save has reported back.
[State machines](state-machines.md#web-kept-files) lists the states.

The profiles belong to the browser, not to the signed-in account, as a
folder on disk does for the CLI.

## Headers

`static/_headers` sets a Content Security Policy on every static file: scripts,
styles, fonts, and requests come only from the site, plus requests to
`api.github.com` and images from `avatars.githubusercontent.com`. The page
loads no third-party script, and nothing may frame it. It also sends no
referrer, and tells browsers to use only HTTPS for repotted.dev for two years.

## Run it locally

Wrangler serves the Worker and the assets together at
`http://localhost:8787`, rebuilding on changes. Sign-in needs a GitHub App that
lists `http://localhost:8787/api/auth/callback` as a callback URL, and a client
secret for it in `packages/web/.dev.vars`, which git ignores. For an App other
than the Repotted App, its client ID goes there too, in place of the one in
`wrangler.jsonc`:

```sh
REPOTTED_APP_CLIENT_SECRET=...
REPOTTED_APP_CLIENT_ID=Iv23...
```

```sh
mise run ts:install
cd packages/web
pnpm run dev
```

Browsers keep `Secure` cookies on `localhost`, though some, such as Safari,
don't, and sign-in there fails.

`mise run ts:web:check` builds the site and runs `wrangler deploy --dry-run`,
which bundles the Worker and reads the assets as a deploy does and uploads
nothing. The gate runs it, and Vitest runs `packages/web/tests`.

## Deploy

The Deploy Web workflow, `.github/workflows/deploy-web.yml`, deploys `main`.
Like the [release workflows](releasing.md), only the owner starts it, with
**Run workflow** on `main`; no push or other event does, so a merge never
changes the site by itself. It runs `ts:web:check` from the locked downloads,
then deploys the Worker.

Its **Publish** input picks where, as Publish picks a test build or a release
in the release workflows:

| Publish          | Command                            | Where it runs                       |
| ---------------- | ---------------------------------- | ----------------------------------- |
| Off, the default | `wrangler preview --name <branch>` | <https://main.preview.repotted.dev> |
| On               | `wrangler deploy`                  | <https://repotted.dev>              |

A preview deploys a Preview named for the run's branch, one of Cloudflare's
[Worker Previews](https://developers.cloudflare.com/workers/previews/), under
the same `repotted` Worker. The name is the branch made a DNS label: lowercase,
with each run of other characters turned into a hyphen and cut to 40
characters, so `feature/Sign-in` would be `feature-sign-in`. Deploy Web runs
only on main, so today that is the `main` Preview. Previews of other branches
would also need the branch rule loosened in the workflow and the environment,
and each Preview's callback URL added to the Repotted App.

repotted.dev keeps serving its own version, and
each preview replaces the last one at the same address, which the run's
summary and its environment link give. The Preview keeps its earlier
deployments, each at its own `<deployment id>-main.preview.repotted.dev`
address, until it reaches Cloudflare's limit of 100 and drops the oldest.

Previews take their address from the custom domain `preview.repotted.dev`,
attached to the Worker for Previews only, as
`<preview name>.preview.repotted.dev`. Cloudflare adds a wildcard DNS record
and certificate for `*.preview.repotted.dev`; the first certificate can take a
while to issue. The preview is public, as repotted.dev is, unless Cloudflare
Access is put in front of it.

The client ID is public, so it is a variable in `wrangler.jsonc`, the same ID as
`app.clientId` in `packages/cli/src/auth/sign-in.ts`; a CLI test fails when they differ.
Previews take none of the production variables, so it is set again in the
`previews` block. The client secret is set once as the Worker secret
`REPOTTED_APP_CLIENT_SECRET`, in the dashboard or with `wrangler secret put`,
and once for Previews, as below. Wrangler never deletes a Worker's secrets:
every deploy keeps the ones the version before it had, and every preview
deployment the ones the Preview had, so the workflow never handles the secret.

A change to the Previews Base reaches only Previews created after it, so
rotating the secret sets it in three places: production, the Previews Base, and
the `main` Preview, with
`wrangler preview secret put REPOTTED_APP_CLIENT_SECRET --name main`.

The sign-in's cookies are named with `__Host-`, so the browser keeps them for
the one host that set them: a sign-in on the preview never reaches
repotted.dev, or the other way round. Each site keeps its own sign-in, and its
own browser storage.

The workflow takes its values from the `deploy-web` environment, which allows
only `main`:

| Name                    | Kind     | Value                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Secret   | A Cloudflare API token with the permission below.                         |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account that holds the Worker and the `repotted.dev` zone. |

The API token needs one permission, from Cloudflare's
[Workers roles](https://developers.cloudflare.com/workers/authorization/workers/):
Workers, Editor, scoped to the `repotted` Worker. That covers deploying the
Worker and its Previews with their assets and variables, and setting the
Worker's `workers.dev` address and Version URLs. Editor can't create a Worker,
so the Worker is created once in the dashboard, named `repotted`, before the
first deploy replaces it.

The custom domains need zone permissions that a token scoped to Workers can't
have, so they are attached once in the dashboard rather than in
`wrangler.jsonc`. Wrangler changes a Worker's custom domains only for those its
config lists; with none listed, a deploy leaves the dashboard's domains as they
are. Had the config listed them, every deploy would set them again, and in CI
would replace any other DNS record on the names without asking.

A custom domain sends every path on its host to the Worker, and the asset
config answers the app's own paths with `index.html`, so the app needs no
Cloudflare Route. A Route such as `*.repotted.dev/` matches `/`, with no query
string, on every subdomain of the zone, the preview's hosts included. A Route
takes precedence over a custom domain on the same host and always runs the
production version, so the preview's `/`, where sign-in returns, would get
production's page. Add no Route, and delete any that exists.

`preview_urls` is set to `false`, though that follows from `workers_dev`,
because Wrangler leaves the Worker's Version URLs as they were when it is
unset. The next publish turns them off.

The Worker keeps nothing on the server between requests, so it needs no KV,
R2, or D1, and the token no permission for them.

Before the first deploy:

1. Add `repotted.dev` to the Cloudflare account and point its nameservers at
   Cloudflare, so the zone is active.
2. Create the `repotted` Worker in the dashboard. In its **Settings**, under
   **Domains & Routes**, add the custom domain `repotted.dev`, enabled for
   production, and `preview.repotted.dev`, enabled for Preview. Add no
   Route.
3. Create the API token above.
4. In the Repotted App's settings, add the callback URLs
   `https://repotted.dev/api/auth/callback` and
   `https://main.preview.repotted.dev/api/auth/callback`, keep **Expire user
   authorization tokens** on, and generate a client secret.
5. In the Worker's **Settings**, add the client secret as the secret
   `REPOTTED_APP_CLIENT_SECRET` under both **Production** and **Previews
   Base**. A new Preview copies the base secrets when it is created, so set it
   before the first preview; for a Preview that already exists, run
   `wrangler preview secret put REPOTTED_APP_CLIENT_SECRET --name main`.
6. Create the `deploy-web` environment with the values above, limited to
   `main`.
