# Architecture

Repotted has one engine and three ways in. `packages/core` holds the engine:
the profile schema, one adapter per section, and the plan engine.
`packages/cli` wraps it as the `repotted` CLI and the MCP server. The desktop
app in `desktop/` runs that CLI and shows what it prints. Each layer does one
job, so the rules about what Repotted may write live in one place.

## Profiles

`packages/core/src/schema.ts` defines a profile with zod. Its keys are the
fields that the GitHub REST API's write endpoints take, so GitHub's REST docs
describe each key. Most sections capture the API's response as it is.
Environments are the exception: `sections/environments.ts` turns GitHub's
protection rules into `wait_timer`, `reviewers`, and `prevent_self_review`,
and reads `branch_policies` from a separate endpoint. The schema's objects are
strict, so an unknown key is an error, except inside a rule's `parameters` and
a ruleset's `conditions`, which are open records passed to GitHub as they
are.

`packages/core/src/profile.ts` loads a profile and the chain of profiles it
`extends`, merges them, and only then validates the result. Validating after
the merge lets a base profile rely on what the profiles that extend it add.
Settings merge key by key. A ruleset or environment replaces the base's entry
of the same name whole. The resolved profile records which file sets each value,
which `repotted profile --json` reports and the desktop app shows.

`editProfile` in the same file edits a profile in place for
`repotted profile --set`, `--unset`, `--ruleset`, `--environment`, and the
`--drop-` options. It works on the YAML document rather than the parsed value,
so an edit changes only what differs and keeps comments, line endings, and
indent width. The desktop app saves through it, so a profile edited both by
hand and in the app keeps both sets of changes, except inside an entry the
app rewrites. An edit writes nothing when the result is not a valid profile,
and it refuses a list that shares parts through YAML anchors and aliases,
which an edit could leave dangling or expand.

## Plans

`createPlan` in `packages/core/src/plan.ts` reads only the sections a profile
names. Each section has an adapter in `packages/core/src/sections/` that reads
the repository's live state and returns the changes that bring it in line. A
change, defined in `change.ts`, is one create, update, or delete of one
target, with the fields it changes and the request that makes it.

### Only what the profile names

A profile manages only what it names: a setting it leaves out keeps its live
value, a ruleset or environment it doesn't name is left alone, and inside a
ruleset a key it leaves out keeps its live value. Deleting a ruleset or an
environment needs an explicit `absent: true` entry. As a result, a profile can
cover a repository one setting at a time, and every delete a plan makes
appears in the profile as an `absent: true` entry.

`packages/core/src/match.ts` decides what counts as drift. A desired value
only needs to be present in the live value, so defaults that GitHub fills in
are not drift. Lists match as a whole, in any order. `overlay` lays a desired
value over the live one where GitHub needs the whole object: the rulesets
adapter uses it for a rule's `parameters` and a ruleset's `conditions`, so the
keys a profile leaves out keep their live values. The environment endpoint
replaces every setting, so `writeSettings` in the environments adapter sends
the live value of each setting the profile leaves out, or its default for a
new environment.

### Order

A plan lists its changes in the order they apply, chosen so the repository is
never less protected in between:

1. Repository settings and merge methods.
2. The Actions policy, then its selected-actions list, then workflow
   permissions.
3. Ruleset creates, then updates, then deletes, so a replacement exists before
   the rulesets it replaces go.
4. Environment creates and updates, then deleted deployment patterns, then new
   ones, then environment deletes. Custom branch policies are on before their
   patterns are added, and no branch or tag outside both the old and the new
   lists can deploy in between.

### Checks at plan time

[Merge settings](../user/profiles.md#merge-settings) and
[`prevent_self_review`](../user/profiles.md#environments) are checked before
anything is written. `mergeSettingsProblems` in `schema.ts` runs on the
profile alone when it loads, and again at plan time with the profile laid over
the live settings; `commitPairs` lists the title and message pairs the
repository settings page offers. A setting GitHub leaves out of its response
is not checked. Either failure stops planning, so apply never sees it.

A section that GitHub won't let Repotted read gives a warning, and the other
sections still plan: rulesets on a GitHub plan that doesn't support them, or
environments with a token that can't list them.

## Apply

`applyPlan` takes a reviewed plan, plans again from the plan's saved profile,
and writes only when the new changes are exactly the reviewed ones. It runs the
requests it computed itself, never the requests in the saved plan. A saved
plan is a file that anyone could edit, so treating it as a description to
check, not a script to run, means a changed file can at most cause a stale
plan error. A repository that drifted since the plan gets no writes and a
`StalePlanError` carrying the plan it needs now.

Writes run one at a time in plan order. If one fails, apply stops and reports
the changes it already made with the one that failed, as an `ApplyError`, so
the caller can say where the repository stands.

Keep these properties when you change the plan format or the engine; see the
Safety section of [AGENTS.md](../../AGENTS.md).

## The CLI and the MCP server

`packages/cli/src/commands.ts` holds the commands behind a small `Io`
interface: the GitHub client, the output streams, the prompt, and the sign-in.
Tests run the real commands against the in-memory GitHub in
`packages/core/tests/fake-github.ts`, and `main.ts` only wires in the token,
the terminal, and the version. With `--json`, each command prints the
documents described in [JSON output](../user/json-output.md).

`packages/cli/src/mcp.ts` serves `capture`, `plan`, and `apply`. The server
keeps each plan in memory under a random `plan_id`, and `apply` accepts only
that ID, so an agent can apply only changes it has already shown as a plan, and
each plan applies once. `--read-only` leaves out `apply`. The server looks up
the token on every tool call, since a user token expires and refreshing it
ends the old one; [The GitHub App](github-app.md) describes the sign-in.

The CLI ships to npm as one file bundled for Node, so shipped code uses only
`node:` APIs. AGENTS.md lists the checks that enforce this.

## The desktop app

The app does no GitHub work itself. It runs the CLI with `--json` and shows
what it prints, so the CLI's sign-in, keychain, and plan checks apply unchanged
and exist once. `Services/RepottedCli.cs` runs the CLI as a child process,
streams its JSON Lines, and kills the run whenever whatever started it ends.
`Services/RepottedClient.cs` reads each document strictly with source-generated
System.Text.Json, so a renamed or missing member is an error rather than a
null.

`ContractTests.cs` in `csharp:test` runs the built CLI and reads what it
prints for the commands that need no GitHub: signed-out `status`, `profiles`,
`profile`, and profile saves through `--set`, `--ruleset`, and
`--environment`. A change to those documents that the app doesn't expect
fails the gate. The `capture`, `plan`, `repos`, and `login` documents
need GitHub, so the app's tests read hand-written examples of them, and only the
strict parsing guards them against the real CLI.

Each package ships the CLI beside the app as `repotted-cli`, a Node single
executable application that `packages/cli/sea.ts` builds: the CLI and its
dependencies in one bundle, run by the pinned Node with no Node installed. The
keychain module is native code, which Node loads only from a real file, so it
ships beside the CLI as `repotted-keyring.node` and is signed with the app on
macOS. The CLI has a name of its own because macOS and Windows ignore case in
file names, where `repotted` would collide with the app. It ignores
`NODE_OPTIONS`, so nothing in the environment can add Node flags to the process
that holds the token.
[Development](development.md#run-the-desktop-app) describes how the app finds
the CLI.

### Profiles in the app

The app edits a folder of YAML files. Settings change through
`repotted profile --set` and `--unset`. Rulesets and environments open in an
editor that starts from the entry as the profile resolves it and saves it
through `--ruleset`, `--environment`, and their `--drop-` forms. The editor
changes only what is edited, so keys and rules it doesn't show stay as they
are, and a choice left unset leaves that key to GitHub.

- Editing a base profile's entry sets the whole entry in this profile, over the
  base's, under the same name. So only an entry that this profile alone names
  can be renamed.
- Renaming an entry, or taking it out of the profile, frees its old name only
  once the profile is saved.
- Saving writes each edited entry whole through `--ruleset` or
  `--environment`, so it would undo a change to that entry made since the
  editor read the file, such as by a sync. An edited inherited entry is
  written whole as an override, so it would hide a change to the base's copy
  too. The editor keeps the text of the profile's file and of each file it
  extends as it read them. A save with an edited entry compares the profile's
  own file with that text, and the files it extends too when an edited entry
  is inherited. When one differs, the save waits for the user to keep their
  version or reload, as [State machines](state-machines.md#profile-editor)
  describes.
- When a refresh no longer lists the file of an editor with unsaved changes,
  the editor stays in the cache as removed and the list shows it. A save
  writes the text the editor read back as a new file first, then saves the
  edits over it, and deletes that file again if the save doesn't go through.

A new profile starts empty, extends another profile in the folder, or is
captured with `repotted capture --output`. The app never replaces a file
already in the folder: it creates the new file first, and a capture that
fails or is cancelled removes it. While a capture runs, the profiles list
leaves out the file it holds. A profile that extends another names that file
as the folder lists it, so the reference still works when the folder is
reached through a link.

Profiles kept in a config repository live in a working copy under `config`
in the app data folder, one per repository and folder in it, which the app
edits like any profiles folder and keeps in line with `repotted sync`: once
before the repository is remembered, on every refresh, and after every save.
Saves and syncs run one at a time, so a sync never reads a file a save is
writing. The sync itself is a three-way merge per file against the record it
keeps in `.repotted-sync.json`, and it starts over as a first sync, deleting
nothing, whenever the branch no longer holds the commit that record names.

The app keeps its own settings in `settings.json` in the per-user app data
folder and never writes beside itself, since an update replaces the app's own
folder and it may not be writable.

### Compare

Compare runs `repotted plan --json`, which only reads, and shows each change by
section: what GitHub has now and what the profile sets. A ruleset change names
the part that differs, such as
`rules[pull_request].parameters.allowed_merge_methods`. Matching settings are
counted and shown on request. The app doesn't apply plans.

### Source layout

- `src/Repotted.Desktop/Services`: runs the CLI (`RepottedCli`) and reads its
  JSON (`RepottedClient`).
- `src/Repotted.Desktop/ViewModels`: one view model per page, with
  CommunityToolkit.Mvvm.
- `src/Repotted.Desktop/Views`: the pages in XAML, bound with compiled
  bindings.
- `src/Repotted.Desktop/Theme`: the custom theme. `Colors.axaml` holds the
  light and dark colors, and `Controls.axaml` styles the controls over Fluent.
- `src/Repotted.Desktop/Assets/Fonts`: Atkinson Hyperlegible Next and Mono,
  under the SIL Open Font License.
- `src/Repotted.Desktop/Assets/repotted.ico` and
  `packaging/macos/Repotted.icns`: the app icon, the seedling mark of
  `Views/BrandMark.axaml` on a green tile.
- `packaging`: `package.sh`, which builds the packages, with the macOS bundle's
  `Info.plist` and entitlements and the Windows installer's Inno Setup script.
- `tests/Repotted.Desktop.Tests`: the client, view model, process runner, and
  headless view tests.
