# Profiles

A profile is a YAML file that describes how a repository should be set up.
Repotted compares repositories with it and plans the changes that bring them
in line. This page describes what a profile can hold and how Repotted treats
each part.

## Sections

A profile has up to five sections. Keys are the field names of the
[GitHub REST API](https://docs.github.com/rest), so GitHub's REST docs
describe each one. Repotted rejects a key it doesn't know, so a misspelling
never passes silently.

| Section        | Keys                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`   | `has_issues`, `has_projects`, `has_wiki`, `has_discussions`, `allow_auto_merge`, `allow_update_branch`, `delete_branch_on_merge`, `web_commit_signoff_required` |
| `merge`        | `allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`, and the merge and squash commit title and message settings                                    |
| `actions`      | `enabled`, `allowed_actions`, `selected_actions`, `sha_pinning_required`, `default_workflow_permissions`, `can_approve_pull_request_reviews`                    |
| `rulesets`     | A list of repository rulesets, as the rulesets API describes them                                                                                               |
| `environments` | A list of deployment environments: `name`, `wait_timer`, `prevent_self_review`, `reviewers`, `deployment_branch_policy`, and `branch_policies`                  |

A short profile:

```yaml
repository:
  delete_branch_on_merge: true
merge:
  allow_merge_commit: false
  allow_squash_merge: true
rulesets:
  - name: main
    conditions:
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }
    rules:
      - type: deletion
      - type: non_fast_forward
```

## A profile manages only what it names

A setting the profile leaves out keeps its current value on each repository,
and a ruleset or environment the profile doesn't name is left alone. So you
can start with a few settings and add more later without touching the rest.

To delete a ruleset or an environment, list it as
`{ name: <name>, absent: true }`. Deleting an environment also deletes its
secrets and variables.

Values that GitHub fills in on its own, and the profile doesn't name, don't
count as differences. Lists match as a whole, in any order.

## Rulesets

Rulesets match by name, and inside a ruleset the same rule holds: a key the
profile leaves out, such as `bypass_actors` or `enforcement`, keeps the value
the repository has.

When a ruleset lists `rules`, the profile manages that list. Rules on the
repository that the profile doesn't list are removed, and each listed rule
keeps the parameters the profile leaves out, including keys inside list items,
such as a status check's `integration_id`.

A new ruleset gets `target: branch`, `enforcement: active`, and no bypass
actors. New `pull_request`, `required_status_checks`, and `update` rules get
GitHub's documented defaults for the parameters it requires. The plan shows
each of these values. Other rule types need their required parameters in the
profile.

## Environments

Environments also match by name, without regard to case, as GitHub does. A
setting the profile leaves out keeps its current value. A new environment gets
no wait timer and no reviewers, and lets every branch deploy.

- `reviewers` lists users and teams by ID, as `{ type: User, id: 123 }`, and
  replaces the repository's list whole.
- `branch_policies` lists the branch and tag name patterns that may deploy, as
  `{ name: 'v*', type: tag }`. `type` is `branch` unless you set it. It needs
  `deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }`
  in the same entry. When a profile lists `branch_policies`, it manages the
  list: patterns it doesn't list are deleted, and each pattern may appear once.
- `prevent_self_review: true` needs at least one reviewer, because GitHub keeps
  it on the required-reviewers rule. The plan refuses it on an environment
  that would have no reviewers, and a profile that removes every reviewer turns
  it off.

## Merge settings

Repotted checks merge settings against what GitHub accepts, first in the
profile alone and again when it plans, with the profile laid over the
repository's settings:

- At least one merge method stays on.
- Each commit title and message pair is one that the repository settings page
  offers.

A profile that breaks either rule stops at planning, before anything is
written.

## Extend a base profile

`extends` names a base profile, as a path relative to the profile's file. A
profile that extends a base gets everything the base sets and changes only
what it sets itself:

- Settings merge key by key, and so do the keys of `selected_actions`.
- A ruleset or environment replaces the base's entry of the same name whole.
  Entries with new names go after the base's.

Repotted checks a profile after it merges it with its bases, so a base may
leave out something that each profile extending it adds.

[`examples/base.yaml`](../../examples/base.yaml) is a base profile, and
[`examples/repotted.yaml`](../../examples/repotted.yaml) extends it.

## How changes apply

A plan lists its changes in the order they apply: repository and merge
settings, then the Actions policy, then rulesets, then environments. Within
each, Repotted orders the writes so the repository stays protected throughout.
For example, a new ruleset exists before a ruleset it replaces is deleted.
[Plan and apply](cli.md#plan-and-apply) describes how to review and apply a
plan.
