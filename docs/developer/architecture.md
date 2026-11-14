# Architecture

Repotted has one engine and three ways in. `packages/core` holds the engine:
the profile schema, one adapter per section, and the plan engine.
`packages/cli` wraps it as the `repotted` CLI and the MCP server, and
`packages/web` runs it in the browser as the web app. Each layer does one
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
`repotted profile --json` reports and the web app shows.

### Owner types

`owner.ts` lists what only some owners have, as
[Settings coverage](settings-coverage.md#owners) does, and `ownerConflicts`
finds those parts of a profile. The `profile` schema runs it in a
`superRefine`, and `resolveChain` validates the merged chain against it with
the type the nearest file names, so one file's type holds for every file it
builds on. `resolveChain` checks the chain's draft settings too, and warns of
a draft ruleset or environment that has what the type lacks, since a draft
entry may be unfinished. The schema's JSON Schema marks the same settings and
values with `x-repotted-owner` and `x-repotted-owner-values`, for tools that
read the schema.

`changeOwnerType` writes the new type and the edits that `ownerConflicts`
names in the file, drafts included: an unset setting, a dropped push ruleset,
or a ruleset or environment written whole without what it can't have, and
without a list that leaves empty. It runs through `editLayer`, as other edits
do, so the file keeps its comments and gets `owner_type` first, or right
after `extends`. It edits only the one file, so when the edit fails because a
base file sets what the type lacks, and the file doesn't override it, the
error names that base. `captureProfile` leaves out what the
repository's owner lacks with `withoutOwnerConflicts` and warns of each part,
as GitHub can report such a setting for a repository that doesn't have it.

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
doesn't exist yet. The web app saves through it, so a profile edited
both by hand and in the app keeps both sets of changes, except inside an
entry the app rewrites. An edit writes nothing when the result is not a
valid profile, and it refuses a list that shares parts through YAML anchors
and aliases, which an edit could leave dangling or expand.

## Plans

`createPlan` in `packages/core/src/plan.ts` reads only the sections a profile
names. Each section has an adapter in `packages/core/src/sections/` that reads
the repository's live state and returns the changes that bring it in line. A
change, defined in `change.ts`, is one create, update, or delete of one
target, with the fields it changes and the request that makes it. A change to
a list entry also has `entry`, which names that entry as the profile writes
it, with the branch policy for a change to one of an environment's policies.
Programs find a change's entry by `entry`, never by parsing `target`: the
target only names the change for people, and two can read the same, as for an
environment named `Prod: branch main` and the `main` branch policy of `Prod`.
GitHub can't edit an autolink, so the autolinks adapter remakes one that
differs as a delete and a create of the same entry, and the create's fields
say what differs. Each request stays one change, which apply makes and
reports on its own.

Apply compares a saved plan's changes whole with a new plan's, and
`savedChange` in `plan.ts` reads them with a schema that drops any member it
doesn't name. A new member of a change goes into `savedChange` in the same
change, or every saved plan reads as stale; a test applies a saved plan with a
change to each list to hold that.

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

A profile with an owner type makes `createPlan` read the repository first and
throw `OwnerMismatchError` when its `owner.type` is the other kind, before any
section reads. Batch reports it per member as `owner_mismatch`.

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
warning that names the permission it needs, from `permissions.ts`; one it
refuses with a `402`, for want of a payment method on file, gives a warning
with GitHub's reason and the same `refused` cause. `capture`
warns only about the refused settings and sections, since a feature the
repository lacks is no news: every reader returns the same `Unavailable` from
`endpoints.ts`, whose `cause` says which it is. A `403` on a write stops
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

Each warning is a `Warning` from `change.ts`, data rather than text. One that
skips something names where, by section, key and field, and why, by `cause`:
`refused` and `unavailable` mostly come from `Unavailable`, `not_applicable`
from a plan step that sees a setting doesn't apply with the others, and
`unloadable` from a capture that can't hold what GitHub reports, as when a
setting fails its schema. Its `message` is the reason
alone. A warning without a cause skips nothing, such as the note on a change
of visibility, and its `message` is the whole text. Readers go by these
members, never by the wording, since a reason that GitHub words, such as
"GitHub keeps none with standard runners", can explain a setting that simply
doesn't apply. `describeWarning` in `plan.ts` builds the line that text
output and the MCP server print, as `Skipped <where>: <message>`.

Before anything is written, `readAccess` in `repositories.ts` reads the
account's role from the repository and, with a Repotted App token, the
permissions of the App's installation that covers it. `lockChanges` in
`permissions.ts` sets those against each change and returns the ones Repotted
can't make, by index. The CLI adds both to the plan document as `access` and
`locks`, outside `changes`, so the plan that apply compares is unchanged.
Apply checks neither: GitHub decides at the write, and `failureReason` in
`plan.ts` turns a lasting `402`, `403` or `422` into a short reason.

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
fields map to profile keys. A change to a list entry maps to the entry its
`entry` names; a settings field maps to its setting, or to the group it is
in, since GitHub writes a group at once and may tie its fields together. A test excludes
every key a wide plan names and checks that its change leaves the plan.

## Batches

A batch (`packages/core/src/batch.ts`) is a folder whose `batch.yaml` lists
staged applies, one for each repository, with paths relative to the folder.
It adds no engine of its own: each member is planned with `planStagedApply`
and applied with `applyPlan`, so it keeps every property of a staged apply,
and a repository still has one staged apply at a time, since a batch starts a
new one with `createStagedApply`, which never replaces a file, or joins one
in progress. Members are planned a few at a time and applied one at a time,
in the manifest's order, and a member's failure is a result of its own rather
than the batch's. The saved batch plan records the batch's id and each staged apply's
SHA-256, and apply writes a member, and ends its staged apply, only while the
file still has it, so a plan reviewed before an edit is never applied and the
edit is never discarded. Apply also reads the manifest before each member, so
a member left out or taken out after the review, or a batch that ended or
started again, is not applied. A member with no changes is planned again too,
so it ends only when the repository still matches. Discarding checks that each
listed file is its member's staged apply before it removes any.

## The CLI and the MCP server

`packages/cli/src/commands.ts` holds the commands behind a small `Io`
interface: the GitHub client, the output streams, the prompt, and the sign-in.
Tests run the real commands against the in-memory GitHub in
`packages/core/tests/fake-github.ts`, and `main.ts` only wires in the token,
the terminal, and the version. With `--json`, each command prints the
documents described in [JSON output](../user/json-output.md).
`commands.test.ts` holds each document to a fixture in
`packages/cli/tests/fixtures`, with the test folder's paths and random ids as
placeholders, so a change to what scripts read fails the tests until its
fixture is written again with `pnpm vitest run -u`, and shows in review as a
change to the file.

`packages/cli/src/mcp.ts` serves `capture`, `plan`, and `apply`, and the two
action lookups below. The server
keeps each plan in memory under a random `plan_id`, and `apply` accepts only
that ID, so an agent can apply only changes it has already shown as a plan, and
each plan applies once. `--read-only` leaves out `apply`. The server looks up
the token on every tool call, since a user token expires and refreshing it
ends the old one; [The GitHub App](github-app.md) describes the sign-in.

`packages/core/src/action-patterns.ts` checks allowed action patterns and
searches for actions, for `check-actions`, `find-actions` and the MCP tools
of the same names. Both only read. GitHub saves any pattern, so a check
parses each one as GitHub documents them and looks up only the parts it
names exactly: the owner of a wildcard repository, or the repository, then
its ref, then its path at that ref. A ref goes into the path of its lookup, so a ref
git can't have, such as one with `..`, is not a pattern and is never asked
about. A lookup's failure belongs to its
pattern, so one pattern's failure leaves the others checked. Once GitHub
limits a lookup, the patterns not yet looked up get the same error without a
request; a rejected sign-in fails the command instead, so the caller hears
`signed_out`, and nothing more is asked. Lookups
are shared by path within one run, and four patterns run at once. GitHub has
no API that searches the Marketplace's actions, so `findActions` searches
repositories and lists the top of each for an action file; a repository
GitHub fails to list counts as one without, and only a rate limit or a
rejected sign-in fails the search.

The CLI ships to npm as one file bundled for Node, so shipped code uses only
`node:` APIs. AGENTS.md lists the checks that enforce this. `repotted mcp`
imports the server and the MCP SDK when it runs, so the other commands, each
a short process, start without loading the SDK and its JSON Schema validator.

## The web app

The web app bundles the engine into its page and calls it directly, with its
state in classes the tests drive against the same in-memory GitHub. It runs
no CLI and reads no JSON output. [The web app](web-app.md) describes it, and
[State machines](state-machines.md) lists the flows it moves through.
