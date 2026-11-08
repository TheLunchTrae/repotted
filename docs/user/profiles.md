# Profiles

A profile is a YAML file that describes how a repository should be set up.
Repotted compares repositories with it and plans the changes that bring them
in line. This page describes what a profile can hold and how Repotted treats
each part.

## Sections

A profile has up to nine sections. Keys are the field names of the
[GitHub REST API](https://docs.github.com/rest), so GitHub's REST docs
describe each one. Repotted rejects a key it doesn't know, so a misspelling
never passes silently. The exceptions are a rule's `parameters` and a
ruleset's `conditions`, which Repotted passes to GitHub as they are.

| Section             | Keys                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`        | `description`, `homepage`, `visibility`, `default_branch`, `topics`, `is_template`, `allow_forking`, `has_issues`, `has_projects`, `has_wiki`, `has_discussions`, `has_pull_requests`, `pull_request_creation_policy`, `pull_request_creation_cap`, `allow_auto_merge`, `allow_update_branch`, `delete_branch_on_merge`, `web_commit_signoff_required`, `immutable_releases` |
| `merge`             | `allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`, and the merge and squash commit title and message settings                                                                                                                                                                                                                                                 |
| `actions`           | `enabled`, `allowed_actions`, `selected_actions`, `sha_pinning_required`, `default_workflow_permissions`, `can_approve_pull_request_reviews`, `access_level`, `approval_policy`, `fork_pr_workflows_private_repos`, `artifact_and_log_retention`, `max_cache_retention_days`, `max_cache_size_gb`, `oidc_customization_sub`                                                  |
| `security`          | `security_and_analysis`, `vulnerability_alerts`, `automated_security_fixes`, `private_vulnerability_reporting`, `code_scanning_default_setup`, `code_scanning_ai_scan`, `code_quality_setup`, `dependabot_runner_settings`                                                                                                                                                   |
| `custom_properties` | The organization's custom properties, by name, with the repository's value                                                                                                                                                                                                                                                                                                   |
| `pages`             | The GitHub Pages site: `build_type`, `source`, `cname`, `https_enforced`, `public`                                                                                                                                                                                                                                                                                           |
| `autolinks`         | A list of autolink references: `key_prefix`, `url_template`, `is_alphanumeric`                                                                                                                                                                                                                                                                                               |
| `rulesets`          | A list of repository rulesets, as the rulesets API describes them                                                                                                                                                                                                                                                                                                            |
| `environments`      | A list of deployment environments: `name`, `wait_timer`, `prevent_self_review`, `reviewers`, `deployment_branch_policy`, and `branch_policies`                                                                                                                                                                                                                               |

Most keys are settings GitHub keeps on the repository. The rest each have an
endpoint of their own, and a key whose value is an object, such as
`code_scanning_default_setup` or `oidc_customization_sub`, holds that
endpoint's fields. How Repotted reads and writes each section, and the
GitHub App permissions it needs, is in
[Settings coverage](../developer/settings-coverage.md).

Some settings depend on the repository's plan or owner. Code scanning, the
Actions access level for private repositories, and custom properties exist
only on some repositories, for example. A plan skips a setting the repository
doesn't have, with a warning that says why. When GitHub refuses to read or
change a setting because the Repotted App lacks a permission, the warning or
the error names the permission.

A few options on GitHub's settings pages have no API, such as wiki's
**Restrict editing to collaborators only**, so no profile can set them.
[Settings coverage](../developer/settings-coverage.md#settings-with-no-api)
lists them.

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

## Drafts

A draft is part of a profile that you've saved but don't want applied yet. It
can be unfinished or invalid. Plans leave every draft out, so a draft never
reaches GitHub, and a plan lists each draft it skipped.

- A ruleset, environment, or autolink becomes a draft with `draft: true`.
  Only its name, or an autolink's `key_prefix`, has to be valid.
- Draft settings go in a `drafts` section, which holds the same sections of
  settings as the profile: `repository`, `merge`, `actions`, `security`,
  `custom_properties`, and `pages`.

```yaml
repository:
  has_wiki: false
drafts:
  repository:
    has_wiki: true # turn on once the docs move
rulesets:
  - name: Tags
    draft: true
    target: tag
```

Here the wiki stays off, and the `Tags` ruleset waits until you finish it.

Repotted still reads every draft and checks it against the rules for its
setting or entry, and warns about what fails, such as a key it doesn't know
or a value GitHub doesn't take. Rules that tie settings together, such as
keeping one merge method on, are checked only when you finish the draft.
To finish a draft, move a setting out of `drafts` into its section, or remove
an entry's `draft: true`. From then on it's checked like the rest of the
profile.

Drafts never change what applies. A draft can share a name with an entry in
the same profile or in a base profile, and a draft setting can sit beside the
same setting, which applies until you finish the draft. Two drafts in the same
list can't share a name or prefix, and a draft setting's name can't hold a
dot, which joins a group to its key. A Pages draft with `absent: true` turns
the site off, so Repotted warns about any other key beside it.

`draft: true` is separate from a ruleset's `enforcement: disabled`. A disabled
ruleset is a real state that Repotted applies: GitHub has the ruleset, turned
off. A draft ruleset isn't sent to GitHub at all.

## A profile manages only what it names

A setting the profile leaves out keeps its current value on each repository,
and a ruleset, environment, autolink or custom property the profile doesn't
name is left alone. So you can start with a few settings and add more later
without touching the rest.

To delete a ruleset or an environment, list it as
`{ name: <name>, absent: true }`. Deleting an environment also deletes its
secrets and variables. To delete an autolink, list it as
`{ key_prefix: <prefix>, absent: true }`, and to take down the Pages site, set
`pages: { absent: true }`. To clear a custom property, set it to `null`. A
custom property's name is 1 to 75 letters, digits, `_`, `-`, `$`, or `#`, as
GitHub allows.

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

A rule's parameters are checked against the values GitHub documents for its
type, such as a `pull_request` rule's `allowed_merge_methods`, which needs at
least one of `merge`, `squash`, and `rebase`, and a `merge_queue` rule's
`merge_method`. Other parameters, and other rule types, are sent as written.

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

## Repository settings that name the repository

`description`, `homepage`, `visibility`, `topics`, the Pages `cname`, and the
`languages` of code scanning and code quality describe one repository, so
`capture` leaves them out and a profile that sets
them suits few repositories. A plan that changes `visibility` warns what the
change does beyond the setting: making a repository public shows its history
to everyone, and making it private detaches public forks.

Repotted doesn't manage a repository's name or whether it's archived. Renaming
moves the repository, and an archived repository takes no other changes, so
both belong to one repository at one moment rather than to a profile.

## Security settings

`security_and_analysis` turns GitHub Advanced Security features on and off,
each as `{ status: enabled }` or `{ status: disabled }`. GitHub reports it only
to repository admins, so a plan skips it with a warning otherwise.

`vulnerability_alerts` is Dependabot alerts, and `automated_security_fixes` is
Dependabot security updates, which need the alerts. A plan that turns the
alerts off turns the updates off first, and skips a profile that turns the
updates on with the alerts off.

Some settings only hold together. With standard Dependabot runners, GitHub
keeps no runner labels or group, so a plan skips them with a warning. Code
scanning and code quality use a `runner_label` only with labeled runners, and
`runner_label: null` means no label. Naming OIDC `include_claim_keys` stops
using the default subject, and claim keys next to `use_default: true` are
skipped, since GitHub ignores them.

## Autolinks and Pages

Autolinks match by `key_prefix`. GitHub can't change an autolink, so one that
differs from the profile is deleted and made again; the plan shows both.

A `pages` section that describes a site the repository doesn't have creates
it, then sets the custom domain and HTTPS, which creating a site can't. A new
site built from a branch needs `source.branch`. GitHub may refuse HTTPS until
the new site has a certificate, so a second apply can be needed for it. A
`source` the profile names part of keeps the rest of the live source.

## Merge settings

Repotted checks merge settings against what GitHub accepts, first in the
profile alone and again when it plans, with the profile laid over the
repository's settings:

- At least one merge method stays on.
- Each commit title and message pair is one that the repository settings page
  offers. When planning, a pair is checked only when the profile names its
  title or its message, since Repotted sends neither otherwise.

A profile that breaks either rule stops at planning, before anything is
written.

## Extend a base profile

`extends` names a base profile, as a path relative to the profile's file. A
profile that extends a base gets everything the base sets and changes only
what it sets itself:

- Settings merge key by key, and so do the keys of an object of settings,
  such as `selected_actions` or `code_scanning_default_setup`.
- `pages: { absent: true }` replaces a base's site, and a site replaces a
  base's `absent`.
- A ruleset, environment, or autolink replaces the base's entry of the same
  name or prefix whole. Entries with new names go after the base's.
- Drafts merge the same way, but only with drafts: a draft replaces the base's
  draft of the same key, name or prefix, and never an entry or setting that
  applies.

Repotted checks a profile after it merges it with its bases, so a base may
leave out something that each profile extending it adds.

[`examples/base.yaml`](../../examples/base.yaml) is a base profile, and
[`examples/repotted.yaml`](../../examples/repotted.yaml) extends it.

## How changes apply

A plan lists its changes in the order they apply: repository and merge
settings, then security settings, then Actions settings, custom properties,
Pages, and autolinks, then rulesets, then environments. Within
each, Repotted orders the writes so the repository stays protected throughout.
For example, a new ruleset exists before a ruleset it replaces is deleted.
[Plan and apply](cli.md#plan-and-apply) describes how to review and apply a
plan.
