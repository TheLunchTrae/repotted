# The command line

The `repotted` command captures repositories as profiles, plans the changes a
profile needs, and applies a plan once you have reviewed it. It also runs the
MCP server that lets an AI agent do the same.

## Install

Repotted needs [Node.js](https://nodejs.org/) 22 or later. Run the latest
published version with `npx`:

```sh
npx repotted --help
```

Or install it once:

```sh
npm install --global repotted
repotted --help
```

The examples on this page use `npx repotted`.

## Sign in

```sh
npx repotted login
npx repotted status
```

`login` prints a code to enter on GitHub. `status` shows which GitHub account
Repotted uses, and `logout` signs out. [Sign in](sign-in.md) has the details,
including how to use a token in CI.

`npx repotted repos` lists the repositories Repotted can manage: those the
Repotted App is installed on and that you administer. With a token instead of
the App, it lists every repository your account administers.

## Capture a repository

```sh
npx repotted capture octo-org/app --output app.yaml
```

`capture` reads every section of a repository, from its settings and merge
methods to its rulesets, environments and labels, and writes them as a profile. It
leaves out settings that name the repository, such as its description and
topics, so the profile suits other repositories too. When GitHub reports a
value that a profile can't hold, such as an option newer than Repotted, the
capture leaves that value out and warns about it, so the profile always
loads. It also warns about each setting or section that GitHub refuses to
show it, and leaves out without a warning what the repository doesn't have,
such as rulesets on a GitHub plan that lacks them. Without `--output`, it
prints the profile. Capturing only reads from GitHub.

Edit the profile so it names only what you want Repotted to manage, then use
it for any number of repositories. [Profiles](profiles.md) describes what a
profile can hold.

## Plan and apply

```sh
npx repotted plan octo-org/app --profile app.yaml --out plan.json
npx repotted apply plan.json
```

`plan` compares a repository with a profile and lists every change that would
bring it in line, with every value each change writes. Planning only reads
from GitHub. `--out` saves the plan to a file.

`apply` shows the saved plan and asks before it writes; `--yes` skips the
question. Before it writes anything, it plans again from the same profile. It
makes the changes only when the repository still needs exactly the changes you
reviewed. If the repository changed since you planned, `apply` writes nothing:
plan again and review the new changes.

If a write fails partway through, `apply` stops and lists the changes it
already made. Plan again to see where the repository stands.

If the repository doesn't have a setting the profile names, such as rulesets
on a GitHub plan that lacks them, `plan` warns you and still plans the rest.
When GitHub refuses to read or change a setting, the warning or error names
the GitHub App permission it needs. When GitHub links a failure to a page of
its docs, the CLI prints that link on a line of its own after the error.

`plan` also marks each change Repotted can't make, as in
`(locked: Needs Pages write)`. With a Repotted App sign-in, it checks the
permissions the App's installation was granted and your role on the
repository. Repotted treats every change as needing admin on the repository.
Another token, such as the GitHub CLI's or Actions' `GITHUB_TOKEN`, can't see
the App, so `plan` marks only what your role rules out. Limits of the repository's GitHub plan or its
owner's policies show only when `apply` fails. `apply` still tries every
change; the marks only tell you ahead of time.

## Stage an apply

A staged apply is one apply to one repository, prepared in a file of its own.
It starts from a profile, or from the repository as it is, and holds one-off
edits for this apply only, such as a ruleset with enforcement turned off
while you set a repository up. The profile stays as it is.

```sh
npx repotted stage setup.yaml --new octo-org/app --profile app.yaml
npx repotted stage setup.yaml --ruleset '{"name":"Main","enforcement":"disabled"}'
npx repotted stage setup.yaml --exclude repository.has_wiki
npx repotted plan --staged setup.yaml --out plan.json
npx repotted apply plan.json
```

`stage <file> --new owner/repo` starts a staged apply in a new file. With
`--profile`, it starts from that profile; without it, from the repository as
it is, so its plan holds only your edits. It never replaces a file that
exists, and when edits given with `--new` fail, it leaves no file behind.

`stage <file>` prints the profile the staged apply brings the repository to.
It takes the editing options of `profile`, described below, for one-off edits.
A ruleset, environment or label you edit replaces the profile's entry of that name
for this apply, so give the whole entry. It also takes:

- `--exclude key` leaves a value of the profile out of this apply, so the
  repository keeps what it has: a section, as `pages`; a setting or a group
  of settings, as `repository.has_wiki` or `actions.selected_actions`; or one
  entry of a list, as `rulesets/Main`, `environments/production`,
  `labels/bug`, or `autolinks/JIRA-`. `--include key` takes it back. A value can't be both
  excluded and edited, and an exclusion has to name something the profile
  sets, so a mistyped name is refused, as is one already left out by a wider
  exclusion, or one the profile no longer sets. An environment's or a label's
  name matches in any case, as GitHub's does; a ruleset's name and an autolink's prefix
  match as written. The profile is checked once the exclusions are out, so an edit
  that only fits without an excluded value is fine.
- `--save-to-profile` writes the one-off edits into the profile the staged
  apply starts from and clears them from the staged apply, which then
  resolves the same. Exclusions stay, since they only say what this apply leaves
  out. It refuses, and changes neither file, when the edits hold autolinks or
  turn a Pages site into no site, or the reverse; make those changes in the
  profile file itself.
- `--discard` removes the staged apply file. The profile stays as it is.

The profile's [drafts](profiles.md#drafts) stay out of a staged apply, as they
stay out of any plan, and `stage` lists them. A staged apply holds no drafts of
its own, since everything in it is for this apply.

`plan --staged <file>` plans the staged apply for the repository it names, and
`apply` applies that plan as it does any other: it writes only the reviewed
changes, and nothing if the repository changed since you planned. A staged
apply that starts from a profile reads the profile each time it resolves, so
plan it again after the profile changes; a saved plan keeps the profile it was
made from. With `--json`, the plan also says which `--exclude` key leaves out
each change, as [JSON output](json-output.md) describes.

## Apply a profile to several repositories

A batch applies one profile to several repositories, through a staged apply
for each. You review, edit and apply each repository as you would one staged
apply, and the profile stays as it is.

```sh
npx repotted stage rollout --batch --new octo-org/app --new octo-org/web --profile app.yaml
npx repotted stage rollout --exclude rulesets/Main --everywhere
npx repotted stage rollout --repo octo-org/web --set repository.has_wiki=true
npx repotted plan --staged rollout --out plans.json
npx repotted apply plans.json
```

`stage <folder> --batch` starts a batch in a folder, which it makes if it is
missing. Each `--new owner/repo` gets a staged apply at
`<folder>/<owner>/<name>.yaml`, or under `--staged-dir`, from `--profile`, or
from the repository as it is without one. A repository that already has a
staged apply there is refused, so it never has two at once; `--join file` adds
that staged apply to the batch as it is instead. The folder's `batch.yaml`
lists the repositories. When a start fails, it leaves no file behind.

`stage <folder>` lists the batch's repositories, and with these options
changes it:

- `--new owner/repo` and `--join file` add repositories, from the batch's
  profile.
- `--leave-out owner/repo` keeps a repository in the batch but out of its
  plans and applies; `--put-back owner/repo` takes it back.
- `--repo owner/repo` with any option of `stage <file>` above shows or edits
  that repository's staged apply, and `--repo owner/repo --discard` takes it
  out of the batch and discards its staged apply, unless it joined the batch,
  when it stays as it was.
- `--exclude key --everywhere` leaves a value out of every repository whose
  profile sets it, and `--include key --everywhere` takes it back in each. A
  repository whose own one-off edits set that value keeps its staged apply as
  it is, and `stage` names it and exits 1.
- `--discard` ends the batch. It discards the staged applies the batch
  started; one that joined stays as it was.

`plan --staged <folder>` plans every repository of the batch that isn't left
out, a few at a time. A repository that can't be planned, such as one the
Repotted App isn't installed on, is reported on its own, and the rest are
planned all the same, and `plan` exits 1.

`apply` applies a batch's saved plan one repository at a time, in the batch's
order, after you confirm all of them at once. Each repository is applied as
one plan is: planned again first, and written only when its changes are the
ones you reviewed. It skips a repository whose changes are locked, one whose
staged apply you edited since the review, and one you left out of the batch
or took out of it since the review. A repository that fails doesn't stop
the rest unless you pass `--stop-on-failure`; `--only owner/repo` applies only
the repositories it names. Each repository that is applied, or still
matches when planned again, ends its staged apply and leaves the batch. The
batch ends with its last repository. `apply` exits 1 when any repository
didn't finish; plan the batch again to review what is left.

## Work with profiles

`npx repotted profiles <folder>` lists the profiles in a folder and its
subfolders, and says why any of them can't be used. A profile in a subfolder
prints with its folder, such as `team/oss`, and so does a profile it extends.
Hidden subfolders, such as `.git`, and linked ones are left out, as a sync
leaves them out.

`npx repotted profile <file>` prints a profile with everything it gets from the
profiles it extends. With these options, it edits the file instead:

- `--set section.key=value` sets one setting of the `repository`, `merge`,
  `actions`, `security`, `custom_properties`, or `pages` section, such as
  `--set repository.has_wiki=false`,
  `--set actions.selected_actions.github_owned_allowed=true`, or
  `--set custom_properties.team=platform`. A key inside an object of
  settings takes its own path, as `security.code_scanning_default_setup.state`.
  The value is JSON, or a bare word as a string.
- `--unset section.key` removes a setting from the file, so a base profile's
  value applies, or else the repository keeps its own.
- `--ruleset json`, `--environment json` and `--label json` write one
  ruleset, environment or label, given as a JSON object with a `name`. It replaces the file's own entry of
  that name, or goes after the others when the file has none.
- `--drop-ruleset name`, `--drop-environment name` and `--drop-label name`
  remove the file's own
  entry, so an entry of that name in a base profile applies again.
- `--set drafts.section.key=value` and `--unset drafts.section.key` set and
  remove a [draft](profiles.md#drafts) setting. A draft value is saved even
  when it wouldn't apply, and its problems print as warnings.
- `--ruleset`, `--environment` or `--label` with `"draft": true` in the JSON
  writes a draft, and `--drop-draft-ruleset name`,
  `--drop-draft-environment name` and `--drop-draft-label name` remove one.

You can give several options at once; they apply in order. A write right after
a drop from the same list renames the dropped entry in place, which can also
change only the case of an environment's or a label's name. Dropping a draft and then
writing the entry without `"draft": true` finishes the draft in place.
GitHub knows rulesets and environments by name, so applying a renamed entry
creates a new one and leaves the old one on the repository, unless an
`absent: true` entry removes it. A label keeps its issues through a rename
only when its old name is in [`renamed_from`](profiles.md#labels).

An edit changes only what differs and keeps the rest of the file, including
comments, line endings, and indent width, though YAML quoting and list
indentation may change. It removes a section the edit leaves empty, along with
any comment above it. It writes nothing when the result would not be a valid
profile, and it refuses to edit a list that shares parts through YAML anchors
and aliases.

## Edit profiles with completion

`npx repotted schema` prints the JSON Schema of a profile file. Save it next
to your profiles:

```sh
npx repotted schema > profile.schema.json
```

An editor that uses the YAML language server, such as Visual Studio Code with
the Red Hat YAML extension, then completes keys and values in a profile and
marks the ones Repotted rejects. Point a profile at the schema with a comment
on its first line, as a path from the profile's folder, and a blank line after
it:

```yaml
# yaml-language-server: $schema=profile.schema.json

repository:
  delete_branch_on_merge: true
```

The blank line keeps the comment apart from the first section, so it stays
when an edit removes that section, as it would a comment above it.

The schema checks each key and its values, but not the rules that span keys,
such as the commit title and message pairs GitHub allows or two rulesets with
the same name; Repotted reports those when it reads the profile. Save the
schema again after you update Repotted. `sync` leaves the schema file out,
since only `.yaml` and `.yml` files sync, so save it on each machine.

## Sync profiles with a GitHub repository

A folder of profiles can live in a GitHub repository, the **config
repository**, so it follows you between machines and keeps its history.
`npx repotted sync <folder> --repository owner/name` brings a local folder in line
with the repository's default branch; `--path` names a folder in the
repository instead of its root. The folder records the repository, the branch
and what both sides last agreed on in `.repotted-sync.json`, so later syncs
need only the folder.

- A file that changed on one side since the last sync takes that side's
  version, deletes included.
- Local changes go to the branch as one commit, which only fast-forwards it.
  When another commit lands first, the sync reads the branch again and builds
  on it. `--message` sets the commit message. A ruleset or branch protection
  that requires pull requests on that branch refuses the commit unless you or
  the Repotted App can bypass it, and the sync says so.
- A file that changed on both sides is left as it is on each and reported as
  a conflict, and `sync` exits 1, until `--prefer local` or `--prefer remote`
  settles it; `--only file`, given once per file, limits `--prefer` to those
  files. A file edited here while the sync runs is kept and reported the same
  way.
- A folder's first sync deletes nothing on either side, and treats a file that
  exists on both sides with different content as a conflict. So does a sync
  whose branch no longer holds the commit the folder last synced at, such as
  after the repository was made again under the same name, emptied, force
  pushed, or switched to a default branch without that commit. A renamed
  default branch keeps its history, so the sync carries on from it.
- Only `.yaml` and `.yml` files sync, in the folder and the folders under it.
  Hidden files and folders, such as `.github`, links, and anything else stay
  out of it on both sides. A sync never reads or writes through a link, so it
  never reaches a file outside the folder: a pull into a linked folder stops
  the sync with an error. Two names that differ only in case also stop it,
  since macOS and Windows cannot keep both. Profiles hold no secrets, and a
  config repository should hold none.
- An empty repository starts with the folder's profiles.

Syncing needs the Contents permission on the config repository, read to pull
and write to push (see [Sign in](sign-in.md#give-the-app-your-repositories)).

## Use Repotted from an agent

`repotted mcp` runs an MCP server that gives an AI agent three tools:

- `capture` returns a repository's profile as YAML.
- `plan` compares a repository with a profile, given as YAML or a file path,
  and returns the plan with a `plan_id`. It writes nothing.
- `apply` applies one plan from `plan`, by its `plan_id`, with the same check
  as `repotted apply`. An agent can only apply changes it has already shown as
  a plan, and each plan applies once.

To add Repotted to an MCP client:

```json
{
  "mcpServers": {
    "repotted": { "command": "npx", "args": ["-y", "repotted", "mcp"] }
  }
}
```

Add `"--read-only"` after `"mcp"` to leave out the `apply` tool, so the agent
can capture and plan but never change a repository. File paths and `extends`
resolve from the folder the server starts in.

If you haven't signed in, the agent's first tool call replies with a code to
enter on GitHub. Once you have entered it, the agent's next call works.

## Output for scripts

`--json` makes `capture`, `plan`, `apply`, `profile`, `profiles`, `sync`,
`repos`, and `status` print one JSON document instead of text, and `schema`
print its schema on one line. The [JSON output reference](json-output.md)
describes each document.
