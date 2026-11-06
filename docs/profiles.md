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
| `actions`    | `enabled`, `allowed_actions`, `selected_actions`, `default_workflow_permissions`, `can_approve_pull_request_reviews`                                            |
| `rulesets`   | A list of repository rulesets, as the rulesets API describes them                                                                                               |

A profile manages only what it names. A setting it leaves out keeps its
current value, and a ruleset it does not name is left alone. To delete a
ruleset, list it as `{ name: <name>, absent: true }`.

Rulesets match by name. Within a ruleset, a profile's values only need to be
present: defaults that GitHub fills in, such as rule parameters the profile
leaves out, are not drift. Lists match as a whole, in any order.

`extends` names a base profile, relative to the file. Settings merge key by
key, and `selected_actions` merges the same way. A ruleset in the override
replaces the base ruleset of the same name whole, and new names are added
after the base ones. `examples/base.yaml` is a base profile, and
`examples/repotted.yaml` extends it.

## Plans and apply

`repotted plan` reads only the sections the profile names and lists the
changes, in the order they apply:

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

## Authentication

Repotted uses `GITHUB_TOKEN`, then `GH_TOKEN`, then the GitHub CLI's sign-in
(`gh auth token`). The token needs read access for capture and plan, and
administration write access to apply.

## MCP server

`repotted mcp` runs an MCP server over stdio with three tools:

- `capture` returns a repository's profile as YAML.
- `plan` takes a repository and a profile, as YAML text or a file path, and
  returns the plan with a `plan_id`. It writes nothing.
- `apply` takes a `plan_id` from `plan` and applies that plan, with the same
  check as the CLI. It accepts nothing else, so an agent can only apply
  changes it has already shown as a plan. Each plan applies once.

`--read-only` leaves out `apply`. Paths and `extends` resolve from the
directory the server starts in. To add it to an MCP client:

```json
{
  "mcpServers": {
    "repotted": { "command": "npx", "args": ["-y", "repotted", "mcp"] }
  }
}
```
