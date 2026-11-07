# Profiles, plans, and the MCP server

## Profiles

A profile is YAML with up to four sections. Keys are the GitHub REST API's
field names, so the REST docs describe each one. `packages/core/src/schema.ts`
is the full schema; an unknown key is an error, so a misspelling never passes
silently.

| Section      | Keys                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository` | `has_issues`, `has_projects`, `has_wiki`, `has_discussions`, `allow_auto_merge`, `allow_update_branch`, `delete_branch_on_merge`, `web_commit_signoff_required` |
| `merge`      | `allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`, and the merge and squash commit title and message settings                                    |
| `actions`    | `enabled`, `allowed_actions`, `selected_actions`, `sha_pinning_required`, `default_workflow_permissions`, `can_approve_pull_request_reviews`                    |
| `rulesets`   | A list of repository rulesets, as the rulesets API describes them                                                                                               |

A profile manages only what it names. A setting it leaves out keeps its
current value, and a ruleset it does not name is left alone. To delete a
ruleset, list it as `{ name: <name>, absent: true }`.

Rulesets match by name, and the same rule holds inside one: a key the profile
leaves out, such as `bypass_actors` or `enforcement`, keeps its live value.
When a profile lists `rules`, it manages the list: live rules it does not list
are removed, and each listed rule keeps the live parameters the profile leaves
out, including keys inside list items such as a status check's
`integration_id`. A new ruleset gets `target: branch`, `enforcement: active`
and no bypass actors, and new `pull_request`, `required_status_checks` and
`update` rules get the documented defaults for parameters the API requires;
the plan shows each of them. Other rule types need their required parameters
in the profile.

Merge settings are checked against what GitHub accepts, first in the profile
alone and again at plan time with the profile laid over the live settings: at
least one merge method stays on, and each commit title and message pair is one
the repository settings page offers, as `commitPairs` in
`packages/core/src/schema.ts` lists them. Planning stops with an error before
apply can write anything. A setting GitHub leaves out of its response is not
checked.

A profile's values only need to be present in the repository: defaults that
GitHub fills in are not drift. Lists match as a whole, in any order.

`extends` names a base profile, relative to the file. Settings merge key by
key, and `selected_actions` merges the same way. A ruleset in the override
replaces the base ruleset of the same name whole, and new names are added
after the base ones. `examples/base.yaml` is a base profile, and
`examples/repotted.yaml` extends it.

## Plans and apply

`repotted plan` reads only the sections the profile names and lists the
changes, with every value each one writes, in the order they apply:

1. Repository settings and merge methods.
2. The Actions policy, then its selected-actions list, then workflow
   permissions.
3. Ruleset creates, then updates, then deletes, so a replacement exists
   before the rulesets it replaces go.

`--out` saves the plan as JSON. `repotted apply` shows the saved plan, asks
before it writes (or takes `--yes`), and then plans again from the saved
profile. It writes only when the new plan has exactly the saved changes, and
it runs the requests it computed itself, never requests read from the file. A
repository that changed since the plan gets no writes; plan again.

If a write fails partway, apply stops and lists the changes it already made.
Plan again to see where the repository stands.

A repository whose GitHub plan does not support rulesets gets a warning, and the
other sections still plan.

## JSON output

`--json` on `capture`, `plan` and `apply` prints exactly one JSON document on
stdout, for programs such as the desktop app. Repotted writes nothing to stderr
in this mode; anything that appears there, such as a deprecation notice from
the GitHub client, is diagnostic and not a failure. `--help` and `--version`
still print text.

- `capture` prints `{ repository, profile, warnings }`, where `profile` is the
  profile the YAML would hold. It does not combine with `--output`.
- `plan` prints the plan, the same document `--out` saves.
- `apply` needs `--yes`, since a program has no terminal to confirm in, and
  prints `{ repository, applied }` with the changes it made.

A failure prints `{ error: { kind, message } }` and exits 1, or 2 for misuse,
which has `kind: usage`. A stale plan has `kind: stale_plan` and `current`, the
plan the repository needs now. A write that fails partway has
`kind: apply_failed`, with the changes in `applied` and the one in `failed`.
Anything else, such as a missing token, an invalid profile or a network error,
has `kind: error`.

## Authentication

`repotted login` signs in with the Repotted GitHub App through the device
flow: it prints a code to enter at github.com/login/device and keeps the token
in the OS keychain (Keychain on macOS, Credential Manager on Windows, the
Secret Service, such as GNOME Keyring or KWallet, on Linux). Without a Secret
Service, use `GITHUB_TOKEN` or the GitHub CLI instead. The token expires after
eight hours and Repotted refreshes it as needed; each refresh lasts six months,
so the sign-in holds as long as Repotted runs at least that often. `repotted
logout` removes it from the keychain; revoke the App's access in your GitHub
settings under Applications.

The App reaches only repositories it is installed on, so install it on the
ones Repotted manages; on an organization, an owner installs it or approves
the request. It asks for the Administration permission: capture and plan read
with it, and apply writes with it, within what your own account may do.

Repotted takes the first token it finds:

1. `GITHUB_TOKEN`, then `GH_TOKEN`, for CI and scripts. A fine-grained token
   needs the Administration permission, read for capture and plan and write
   for apply; a classic token needs the `repo` scope.
2. The `repotted login` token.
3. The GitHub CLI's sign-in for github.com (`gh auth token --hostname
   github.com`).

`REPOTTED_GITHUB_CLIENT_ID` signs in with another GitHub App, given its client
ID.

## MCP server

`repotted mcp` runs an MCP server over stdio with three tools:

- `capture` returns a repository's profile as YAML.
- `plan` takes a repository and a profile, as YAML text or a file path, and
  returns the plan with a `plan_id`. It writes nothing.
- `apply` takes a `plan_id` from `plan` and applies that plan, with the same
  check as the CLI. It accepts nothing else, so an agent can only apply
  changes it has already shown as a plan. Each plan applies once.

`--read-only` leaves out `apply`. Paths and `extends` resolve from the
directory the server starts in. With no token, the first tool call starts the
device flow and returns the code for the user to enter; once they have, the
next call finds the token. To add it to an MCP client:

```json
{
  "mcpServers": {
    "repotted": { "command": "npx", "args": ["-y", "repotted", "mcp"] }
  }
}
```
