# Architecture

Repotted has one engine and three ways in. `packages/core` holds the engine:
the profile schema, one adapter per section, and the plan engine.
`packages/cli` wraps it as the `repotted` CLI and the MCP server. The desktop
app in `desktop/` runs that CLI and shows what it prints. Each layer does one
job, so the rules about what Repotted may write live in one place.

## Profiles

`packages/core/src/schema.ts` defines a profile with zod. Its keys are the
fields that the GitHub REST API's write endpoints take, so GitHub's REST docs
describe each key. A setting at an endpoint of its own is kept under that
endpoint's key, with the endpoint's fields inside it when there are several;
`endpoints.ts` reads and plans those settings, and
[Settings coverage](settings-coverage.md) says where each section's
endpoints are listed and what they need. Most
sections capture the API's response as it is.
Environments are the exception: `sections/environments.ts` turns GitHub's
protection rules into `wait_timer`, `reviewers`, and `prevent_self_review`,
and reads `branch_policies` from a separate endpoint. The schema's objects are
strict, so an unknown key is an error, except inside a rule's `parameters` and
a ruleset's `conditions`, which are open records passed to GitHub as they
are. `ruleParameters` checks the parameters of the rule types whose values
GitHub's REST description constrains, such as a `pull_request` rule's
`allowed_merge_methods`, so a profile GitHub would refuse partway through an
apply fails when it loads. Each parameter there is optional, because a rule
keeps the live parameters the profile leaves out; other parameters and rule
types stay open. Entry lists and `pages` pick a branch by `absent` and, in a
profile file, by `draft`, with zod's discriminated unions, so an error names
the field that fails rather than the whole entry. Every branch but the one a
key marks has that key as `undefined`, which a discriminated union needs.

`profileFileJsonSchema` turns `profileFile` into a Draft 7 JSON Schema for
editors, which `repotted schema` prints. JSON Schema has no `undefined`, so
there a marking key that a branch leaves out becomes `not: {}`, a key the
branch rules out; any other type JSON Schema can't hold still throws. The
refinements that span keys, such as `mergeSettingsProblems` and repeated
names, have no JSON Schema form and stay out of it.

`packages/core/src/profile.ts` loads a profile and the chain of profiles it
`extends`, merges them, and only then validates the result. Validating after
the merge lets a base profile rely on what the profiles that extend it add.
Settings merge key by key, and so do the keys inside an object of settings,
such as `selected_actions`. `flattenSettings` gives each setting its path, as
`has_wiki` or `selected_actions.verified_allowed`, and `unflattenSettings`
turns paths back into settings, so merging, the sources the resolved profile
records, and saving a staged apply's edits all read a group the same way. A
ruleset, environment, label, or autolink replaces the base's entry of the same
name or prefix whole, and `pages: { absent: true }` replaces a base's site. The
resolved profile records which file sets each value, which
`repotted profile --json` reports and the desktop app shows.

### Drafts

A [draft](../user/profiles.md#drafts) is a ruleset, environment, label or autolink
with `draft: true`, or a setting under the profile's `drafts` section. Each file
is split into what applies and its drafts as it is read, and the two merge
separately. So drafts never change what applies: the resolved `profile` is
exactly what the files would give with their drafts deleted, and plan, apply,
compare, and the MCP server never see a draft. Keeping drafts out of the
profile type, rather than marking them and filtering later, means a new
section or adapter can't forget to skip them.

A draft keeps any key and value, so `profileFile` only checks that a draft
entry has a name, or an autolink its prefix. `draftWarnings` checks each
draft against the schema that would apply to it and reports what fails as
warnings. A draft setting is checked against its section's field in
`sectionSchemas`, so a field added to a section is checkable as a draft with
no other change. Draft settings merge with the same `mergeSettings` as
settings, so a group such as `selected_actions` merges key by key in drafts
too. A new settings section goes in `settingsSections` in `profile.ts` and in
`draftSettings` in `schema.ts`, which a test keeps in step; `skippedDrafts` in
`plan.ts` follows `sections` in `change.ts`.

A file can hold a draft and an entry of the same name, which is how a change
to a ruleset is drafted beside the version that applies. An `EntryEdit`
therefore says which of the two it edits, and writing an entry without
`draft: true` over a draft finishes it in place. Draft names are unique among
drafts, as entry names are among entries.

Plans record the drafts they left out in `skipped`. Apply carries `skipped`
over from the reviewed plan and compares only `changes`.

`draft: true` is not `enforcement: disabled`: a disabled ruleset is GitHub
state that apply writes, and a draft is never sent.

Sync moves profile files as they are, drafts included, so a draft follows its
profile to every computer that syncs it.

`editProfile` in the same file edits a profile in place for
`repotted profile --set`, `--unset`, `--ruleset`, `--environment`, and the
`--drop-` options. It works on the YAML document rather than the parsed value,
so an edit changes only what differs and keeps comments, line endings, and
indent width. Edits under `drafts` take any key below a settings section,
and a key inside one of its groups, since a draft may name a key that
doesn't exist yet. The desktop app saves through it, so a profile edited
both by hand and in the app keeps both sets of changes, except inside an
entry the app rewrites. An edit writes nothing when the result is not a
valid profile, and it refuses a list that shares parts through YAML anchors
and aliases, which an edit could leave dangling or expand.

## Plans

`createPlan` in `packages/core/src/plan.ts` reads only the sections a profile
names. Each section has an adapter in `packages/core/src/sections/` that reads
the repository's live state and returns the changes that bring it in line. A
change, defined in `change.ts`, is one create, update, or delete of one
target, with the fields it changes and the request that makes it.

### Only what the profile names

A profile manages only what it names: a setting it leaves out keeps its live
value, a ruleset, environment or label it doesn't name is left alone, and
inside a ruleset a key it leaves out keeps its live value. Deleting a ruleset,
an environment or a label needs an explicit `absent: true` entry. As a result, a profile can
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
5. Label deletes, then renames, then updates, then creates. A label pairs
   with the repository's by name in any case, or, when the repository lacks
   it, by the first name in its `renamed_from` that the repository has, which
   it renames so the label stays on its issues. `addRenameIssues` in
   `schema.ts` refuses an old name that a profile label has or that two labels
   claim, so no two changes write one label.

### Checks at plan time

[Merge settings](../user/profiles.md#merge-settings) and
[`prevent_self_review`](../user/profiles.md#environments) are checked before
anything is written. `mergeSettingsProblems` in `schema.ts` runs on the
profile alone when it loads, and again at plan time with the profile laid over
the live settings; `commitPairs` lists the title and message pairs the
repository settings page offers. At plan time a pair the profile doesn't
name is left out of the check, since no write sends it. A setting GitHub
leaves out of its response is not checked. Either failure stops planning, so apply never sees it.

A section that GitHub won't let Repotted read gives a warning, and the other
sections still plan: rulesets on a GitHub plan that doesn't support them, or
environments with a token that can't list them. The same holds for each
setting at an endpoint of its own. A setting the repository doesn't have gives
a warning with GitHub's reason, and one GitHub refuses with a `403` gives a
warning that names the permission it needs, from `permissions.ts`. `capture`
warns only about the refused settings and sections, since a feature the
repository lacks is no news: every reader returns the same `Unavailable` from
`endpoints.ts`, whose `refused` says which it is. A `403` on a write stops
apply, and the failure names the permission too. `captureProfile` also parses
each setting it captures with that setting's schema, and leaves out, with a
warning, one that fails, such as an option GitHub added after `schema.ts`, so
a captured profile always loads. The fields of an endpoint's object and of
`security_and_analysis` are parsed one by one, so only the field that fails is
left out. A commit message setting goes with its title setting, and the other
way round, since GitHub takes them only as a pair. A ruleset or environment
that fails its schema is left out whole, with a warning, and so is a label: without one of its
rules, a ruleset would have that rule removed on apply, while a profile leaves
alone a ruleset it doesn't name.

Before anything is written, `readAccess` in `repositories.ts` reads the
account's role from the repository and, with a Repotted App token, the
permissions of the App's installation that covers it. `lockChanges` in
`permissions.ts` sets those against each change and returns the ones Repotted
can't make, by index. The CLI adds both to the plan document as `access` and
`locks`, outside `changes`, so the plan that apply compares is unchanged.
Apply checks neither: GitHub decides at the write, and `failureReason` in
`plan.ts` turns a lasting `403` or `422` into a short reason.

The engine reaches GitHub only through the `GitHub` interface in
`github.ts`. `createGitHub` turns a refused request into a `GitHubError` read
from GitHub's response rather than from Octokit's message: GitHub's own
message followed by the details it lists in `errors`, the link to its docs
apart in `documentationUrl`, and `rateLimited` from the status and the
rate-limit headers, as GitHub documents them. Warnings and reasons quote the
message, so they carry no docs link; the CLI's text output names it after a
failure. The in-memory GitHub builds its refusals with the same
`responseError`, from the bodies GitHub sends.

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

## Staged applies

A staged apply (`packages/core/src/staged.ts`) is a profile layer in a file of
its own. The file names the repository in `apply_to`, extends the profile it
starts from with `extends`, and holds one-off edits as profile keys, so
`resolveProfile` lays it over the profile the way an override lays over a
base: settings key by key, and a ruleset or environment whole by name. Its
`exclude` list then takes values out of the resolved profile. Planning and
applying use the engine unchanged, so a staged apply keeps every property of
[Apply](#apply): the saved plan holds the profile it was made from, and apply
plans again from that.

The profile chain reads the staged file as a `Layer`, whose `LayerSchema`
checks the whole file, its own keys included, and yields from one parse the
profile layer, the file's own keys, and the `Adjust` that leaves its
exclusions out of the merged profile and names each one that leaves nothing
out. Showing, planning, and editing each read the staged file once, so what
they report comes from one version of it even when another program changes
the file meanwhile. `editLayer` edits it the way `editProfile` edits a
profile: it works out the edits from that one read, with `exclude` as a key of
its own, and runs a last check that the exclusions still leave a valid
profile before it writes, so a failed edit leaves the file as it was. An
exclusion and an edit of the same value are refused, since the result would
depend on which one wins.

Saving edits to the profile writes the layer's settings and entries into the
profile with `editProfile`, then clears them from the staged file. Between the
two writes, both files set the same values, so the staged apply resolves the
same whichever write fails. The clear refuses, as a failed write, when another
program changed the staged file's edits after the save read them, since
clearing them would lose a change no profile holds. A staged apply that
starts from the repository has no profile to save to.

`planStagedApply` also names the exclusion that leaves out each change of the
plan, so a program can offer to leave out a row without knowing how plan
fields map to profile keys. A change to a list entry maps to the entry by its
target; a settings field maps to its setting, or to the group it is in, since
GitHub writes a group at once and may tie its fields together. A test excludes
every key a wide plan names and checks that its change leaves the plan.

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
`node:` APIs. AGENTS.md lists the checks that enforce this. `repotted mcp`
imports the server and the MCP SDK when it runs, so the other commands, each
a short process, start without loading the SDK and its JSON Schema validator.

## The desktop app

The app does no GitHub work itself. It runs the CLI with `--json` and shows
what it prints, so the CLI's sign-in, keychain, and plan checks apply unchanged
and exist once. `Services/RepottedCli.cs` runs the CLI as a child process,
streams its JSON Lines, and kills the run whenever whatever started it ends.
`Services/RepottedClient.cs` reads each document strictly with source-generated
System.Text.Json, so a renamed or missing member is an error rather than a
null. A failure with `kind: signed_out`, from any command, raises
`SignInLost`, and `MainViewModel` then checks the sign-in again, so a sign-in
that stops working mid-session leads back to the sign-in page, while one that
still works keeps the app.

`ContractTests.cs` in `csharp:test` runs the built CLI and reads what it
prints for the commands that need no GitHub: signed-out `status`, `profiles`,
`profile`, profile saves through `--set`, `--ruleset`, and `--environment`,
drafts included, and a staged apply through `stage` from `--new` to
`--discard`. A change to those documents that the app doesn't expect fails the
gate. It also reads `schema`, the profile file's JSON Schema, and checks the
settings the app edits in `ViewModels/ProfileFields.cs` against it: every
setting in the schema is a field there or on the test's list of settings left
to the YAML, and each field with choices offers exactly the values the schema
allows. Labels, groups and notes stay in `ProfileFields.cs`, since they are
the app's own words. The `capture`, `plan`, `repos`, and `login` documents
need GitHub, and `logout` would remove a real sign-in, so the app's tests
read hand-written examples of them, and only the strict parsing guards them
against the real CLI. The app ships its own CLI, so every member that CLI
always prints is required, and a hand-written example that leaves one out
fails to parse rather than reading as empty.

Each package ships the CLI beside the app as `repotted-cli`, a Node single
executable application that `packages/cli/sea.ts` builds: the CLI and its
dependencies in one bundle inside the pinned Node, so it needs no Node on the
machine. The keychain module is native code, which Node loads only from a real
file, so it ships beside the CLI as `repotted-keyring.node` and is signed with
the app on macOS. The CLI has a name of its own because macOS and Windows ignore case in
file names, where `repotted` would collide with the app. It ignores
`NODE_OPTIONS`, so nothing in the environment can add Node flags to the process
that holds the token.
[Development](development.md#run-the-desktop-app) describes how the app finds
the CLI.

The app starts the CLI for every read and save, so the executable starts from a
V8 startup snapshot: `sea.ts` has Node evaluate the bundle once at build time
and store the resulting heap, and each run starts from that heap and calls
`main` through `v8.startupSnapshot.setDeserializeMainFunction`. That skips
evaluating the bundle, about half the time a short command takes. The snapshot
sets how the code is built:

- Node builds a snapshot only from a CommonJS main script, which can't
  `import()`, so the executable's bundle is CommonJS and turns each `import()`
  of a built-in module into a `require`. The npm bundle stays an ES module.
  esbuild only warns about code that breaks in CommonJS, such as
  `import.meta`, which it leaves empty, so `sea.ts` fails the build on any
  esbuild warning.
- The snapshot freezes whatever the bundle computes at load time, so code reads
  the environment, the working directory, the arguments, and the time when it
  runs, not at module scope.
- A snapshot can't hold a native module, so the keychain module loads on first
  use, after the snapshot.
- Node hasn't verified some built-in modules, such as `child_process` and
  `readline`, in snapshots, so the code that uses them loads them on use, and
  `sea.ts` fails the build when Node warns that the bundle loaded one.
- A snapshot runs only on the platform that built it, so each package builds
  its CLI on a runner of its own platform.

The snapshot makes the executable about 9 MB larger. The MCP server is in the
executable's bundle, but it loads on use, so the snapshot holds it unevaluated
and `repotted mcp` evaluates it when it runs.

Releases build the executable only in the desktop packaging, so
`ts:sea:check`, part of the gate on every pull request, also builds it, on
Linux in CI, with fake `GITHUB_TOKEN` and `REPOTTED_GITHUB_CLIENT_ID` values.
It fails when the executable holds either value, then runs `node-smoke.mjs`
and a relative `profile` from the examples folder, and `status --json` without
those values. A CLI or core change that reads those variables or the working
directory at load time, or that breaks the snapshot, fails before a release.
Other variables aren't checked, so code reads the environment only when a
command runs.

### Applying from the app

The Apply page is a staged apply, as `repotted stage` makes one, kept in the
app data folder per repository. Its one-off edits tab is the profile editor
over the staged file: `ProfileStore` swaps the editor's reads and saves for
`stage`, which takes the same edits as `profile`, so every setting the editor
shows can be overridden once. A profile's store writes in its turn with the
syncs of the profiles folder; the staged file is the app's alone, so its
store writes at once. The page plans with `plan --staged`, whose
`exclusions` name the key that leaves out each row, so the app never maps a
plan field to a profile key itself. It applies the saved plan file with
`apply --yes`, which re-plans and stops on any difference.
[State machines](state-machines.md#desktop-apply) lists its transitions.

Compare and Apply list every section a plan changes. Sections the profile
editor has no tab for, such as security, Pages, autolinks and custom
properties, show as a row per change. `ViewModels/PlanSections.cs` turns a
plan into those sections and rows, and `Views/PlanTable.axaml` shows them on
both pages; Apply adds **Leave out**, or the **One-off edit** chip, to each
row it can leave out.

Beside the one-off edits, the Apply page shows the plan as a diff of profile
YAML, which `PlanDiff` builds in the app from the plan's `desired` and
`changes`. Both sides start from the resolved profile, and each field a change
writes takes GitHub's value on one side and the written value on the other.
GitHub's value is cut down to the keys the profile sets, and a list follows
the profile's order, matching items by the keys that name them, such as a
rule's `type`, so the diff shows what the plan compares and not GitHub's
defaults, nor the defaults the API body adds for a new rule, which the
comparison lists. It only shapes what the page shows: the plan decides what
differs, and the diff is rebuilt from each plan the page shows.

### Profiles in the app

The app edits a folder of YAML files. Settings change through
`repotted profile --set` and `--unset`; an empty runner label box sets the
label to `null`, the profile's value for no label. Rulesets, environments and
labels open in an editor that starts from the entry as the profile resolves it
and saves it through `--ruleset`, `--environment`, `--label`, and their
`--drop-` forms. The label editor checks each label's name and
`renamed_from` against the other labels as the save would leave them, removed
labels included and drafts left out, as `addRenameIssues` does, so a clash
shows before the save. The editor changes only what is edited, so keys and rules it doesn't show stay as
they are, and a choice left unset leaves that key to GitHub.

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
- The editor also resolves the profile it extends alone, for the value each
  setting falls back to. It keeps that base beside the text of the files it
  resolves from, the same copy the save check compares, and resolves it again
  only when one of them differs, so a save or a reload runs the CLI once.
  Keeping it in the editor, rather than having `profile --json` print the base
  as well, leaves the documents scripts read as they are.
- When a refresh no longer lists the file of an editor with unsaved changes,
  the editor stays in the cache as removed and the list shows it. A save
  writes the text the editor read back as a new file first, then saves the
  edits over it, and deletes that file again if the save doesn't go through.

A new profile starts empty, extends another profile in the folder, or is
captured with `repotted capture --output`. The app never replaces a file
already in the folder. A capture writes a dot-prefixed file and gives it the
profile's name only once it is whole, so neither the profiles list nor a sync
reads a capture under way, and one that fails or is cancelled leaves nothing
behind; [State machines](state-machines.md#new-profile-form) has the details.
A profile that extends another names that file as the folder lists it, so the
reference still works when the folder is reached through a link.

Profiles kept in a config repository live in a working copy under `config`
in the app data folder, one per repository and folder in it, which the app
edits like any profiles folder and keeps in line with `repotted sync`: once
before the repository is remembered, on every refresh, and after every save.
Saves and syncs run one at a time, so a sync never reads a file a save is
writing. A save and a pull both write through `replaceFile` in `files.ts`,
which keeps the file's permissions and tries the move again while Windows
holds the file, as antivirus and the search indexer do just after a write.
The sync itself is a three-way merge per file against the record it
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
  CommunityToolkit.Mvvm. A row that only bindings listen to tells them
  everything changed at once, with `OnAllPropertiesChanged`; a page view
  model that other code listens to raises each name.
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
