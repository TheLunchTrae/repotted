# Architecture

Repotted has one engine and three ways in. `packages/core` holds the engine:
the profile schema, one adapter per section, and the plan engine.
`packages/cli` wraps it as the `repotted` CLI and the MCP server. The desktop
app in `desktop/` runs that CLI and shows what it prints. Each layer does one
job, so the rules about what Repotted may write live in one place.

## Profiles

`packages/core/src/schema.ts` defines a profile with zod. Its keys are the
GitHub REST API's field names, so GitHub's REST docs describe each key,
capture writes what the API returns without translating it, and no mapping
layer needs maintaining. Every object is strict, so an unknown key is an error
and a misspelling never passes silently.

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
environment needs an explicit `absent: true` entry. This lets a profile adopt
a repository one setting at a time, and it keeps every destructive change
visible in the profile itself rather than implied by an omission.

`packages/core/src/match.ts` decides what counts as drift. A desired value
only needs to be present in the live value, so defaults that GitHub fills in
are not drift. Lists match as a whole, in any order. `overlay` lays a desired
value over the live one where GitHub needs the whole object. The environment
endpoint, for example, replaces every setting, so each environment write sends
the live value of every setting the profile leaves out.

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

Merge settings are checked against what GitHub accepts, first in the profile
alone and again at plan time with the profile laid over the live settings: at
least one merge method stays on, and each commit title and message pair is one
the repository settings page offers, as `commitPairs` in `schema.ts` lists
them. A setting GitHub leaves out of its response is not checked. The
environments adapter refuses `prevent_self_review` on an environment that
would have no reviewers, since GitHub keeps it on the required-reviewers rule.
Either failure stops planning before apply can write anything.

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
documents described in [JSON output](json-output.md).

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
null. The contract test in `csharp:test` runs the CLI from source, so a change
to the JSON the app reads fails there.

Each package ships the CLI compiled with `bun build --compile` beside the app
as `repotted-cli`. It has a name of its own because macOS and Windows ignore
case in file names, where `repotted` would collide with the app.
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
- GitHub knows rulesets and environments by name, so the editor warns that
  applying a renamed entry creates a new one and leaves the old one as it is.
- Renaming an entry, or taking it out of the profile, frees its old name only
  once the profile is saved.
- Saving writes each edited entry whole, so a change made to that entry in the
  file outside the app since it was opened is lost.

A new profile starts empty, extends another profile in the folder, or is
captured with `repotted capture --output`. The app never replaces a file
already in the folder: it creates the new file first, and a capture that
fails or is cancelled removes it. While a capture runs, the profiles list
leaves out the file it holds. A profile that extends another names that file
as the folder lists it, so the reference still works when the folder is
reached through a link.

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
