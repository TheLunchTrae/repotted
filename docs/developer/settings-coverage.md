# Settings coverage

Repotted aims to manage every repository setting that GitHub's REST API can
both read and set. This page lists what a profile covers, the endpoint and
GitHub App permission behind each setting, what Repotted leaves out on
purpose, and the options on GitHub's settings pages that have no API at all.

The inventory was made from GitHub's OpenAPI descriptions for api.github.com
and GitHub Enterprise Cloud, in
[github/rest-api-description](https://github.com/github/rest-api-description),
and GitHub's docs. When GitHub adds a setting, add it to
`schema.ts`, the adapter for its section, `permissions.ts` when it needs a
permission other than Administration, and this page.

## How a setting is wired

Most repository settings are fields of `GET` and `PATCH /repos/{owner}/{repo}`.
The rest each live at an endpoint of their own under the repository.
`packages/core/src/endpoints.ts` describes those endpoints once, as data, and
reads and plans them all the same way:

- A `toggle` is on while a `GET` finds it on. `PUT` turns it on and `DELETE`
  turns it off. GitHub answers `404` while `vulnerability_alerts` and
  `immutable_releases` are off, and `automated_security_fixes` while
  Dependabot alerts are off, so those read as off (`missingIsOff`). For the
  others, a `404` means the repository doesn't have the feature.
- A `field` is one field of an endpoint, kept in the profile under its name.
  A field GitHub leaves out of its answer is unset, so a plan sets it.
- An `object` is several fields of an endpoint, kept together in the profile
  under the endpoint's key, such as `code_scanning_default_setup`. A write
  sends the fields the profile names, plus the `carries` fields from the live
  value, for endpoints that replace what they're sent. A carried `null`
  stays out. Three optional hooks keep a plan in line with what GitHub keeps:
  `fromGitHub` puts what GitHub reports in the form a write takes, `adjust`
  fills in fields GitHub ties to the ones a profile names and leaves out,
  with a warning, fields GitHub drops with the option chosen, and
  `identifying` names fields that a capture leaves out.

These hooks are why a plan settles after one apply:

- Dependabot runner labels and a runner group are dropped with standard
  runners.
- Naming `include_claim_keys` for the OIDC subject claim sets
  `use_default: false`, and claim keys alongside `use_default: true` are
  dropped, because GitHub ignores them then.
- Code scanning reports `javascript` and `typescript` apart but takes
  `javascript-typescript`, so the two read as the one. `languages` describe
  one repository's code, so `capture` leaves them out of code scanning and
  code quality.

A setting the repository doesn't have, because of its plan, its owner or its
visibility, reads as unavailable. A plan skips it with a warning that gives
GitHub's reason, and `capture` leaves it out silently. A setting GitHub
refuses to show, with a `403`, is skipped with a warning in both, and the
warning names the permission it needs. A `403` on a write stops apply, and
`describeFailure` names the permission too. Both come from
`requiredPermission` in `packages/core/src/permissions.ts`, which records the
permission GitHub's docs give for each endpoint that needs more than
Administration.

## What a profile covers

### `repository`

| Keys                                                                                                                                                                                                                                                                                                            | Endpoint                                       | Permission                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `description`, `homepage`, `visibility`, `default_branch`, `is_template`, `allow_forking`, `has_issues`, `has_projects`, `has_wiki`, `has_discussions`, `has_pull_requests`, `pull_request_creation_policy`, `allow_auto_merge`, `allow_update_branch`, `delete_branch_on_merge`, `web_commit_signoff_required` | `PATCH /repos/{owner}/{repo}`                  | Administration write                         |
| `topics`                                                                                                                                                                                                                                                                                                        | `PUT /repos/{owner}/{repo}/topics`             | Administration write; reading needs Metadata |
| `immutable_releases`                                                                                                                                                                                                                                                                                            | `/immutable-releases`, a toggle                | Administration                               |
| `pull_request_creation_cap`: `enabled`, `max_open_pull_requests`, `include_drafts`                                                                                                                                                                                                                              | `PATCH /interaction-limits/pulls/creation-cap` | Administration write, to read it too         |

`capture` leaves out `description`, `homepage`, `visibility` and `topics`,
because they describe one repository. It keeps `default_branch`, so a
captured profile applied to a repository without that branch fails there
with GitHub's `422`. A plan that changes `visibility` warns
what the change does beyond the setting.

### `merge`

`allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`, and the four
commit title and message settings, all on `PATCH /repos/{owner}/{repo}`, with
Administration write.

### `actions`

| Keys                                                                                   | Endpoint                                                   | Permission                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `enabled`, `allowed_actions`, `sha_pinning_required`                                   | `PUT /actions/permissions`                                 | Administration                                   |
| `selected_actions`                                                                     | `PUT /actions/permissions/selected-actions`                | Administration                                   |
| `default_workflow_permissions`, `can_approve_pull_request_reviews`                     | `PUT /actions/permissions/workflow`                        | Administration                                   |
| `access_level`                                                                         | `PUT /actions/permissions/access`, private repositories    | Administration                                   |
| `approval_policy`                                                                      | `PUT /actions/permissions/fork-pr-contributor-approval`    | Administration                                   |
| `fork_pr_workflows_private_repos`                                                      | `PUT /actions/permissions/fork-pr-workflows-private-repos` | Administration                                   |
| `artifact_and_log_retention`: `days`                                                   | `PUT /actions/permissions/artifact-and-log-retention`      | Administration                                   |
| `max_cache_retention_days`                                                             | `PUT /actions/cache/retention-limit`                       | Administration                                   |
| `max_cache_size_gb`                                                                    | `PUT /actions/cache/storage-limit`                         | Administration write; reading needs Actions read |
| `oidc_customization_sub`: `use_default`, `include_claim_keys`, `use_immutable_subject` | `PUT /actions/oidc/customization/sub`                      | Actions                                          |

### `security`

| Keys                                                                                                                                                                                                                                                                                                                                                                                 | Endpoint                                     | Permission                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| `security_and_analysis`: `advanced_security`, `code_security`, `secret_scanning`, `secret_scanning_push_protection`, `secret_scanning_ai_detection`, `secret_scanning_non_provider_patterns`, `secret_scanning_delegated_alert_dismissal`, `secret_scanning_delegated_bypass`, `secret_scanning_delegated_bypass_options`, `secret_scanning_validity_checks` (Enterprise Cloud only) | `PATCH /repos/{owner}/{repo}`                | Administration write; GitHub reports it to admins only        |
| `vulnerability_alerts`                                                                                                                                                                                                                                                                                                                                                               | `/vulnerability-alerts`, a toggle            | Administration                                                |
| `automated_security_fixes`                                                                                                                                                                                                                                                                                                                                                           | `/automated-security-fixes`, a toggle        | Administration                                                |
| `private_vulnerability_reporting`                                                                                                                                                                                                                                                                                                                                                    | `/private-vulnerability-reporting`, a toggle | Administration write; reading needs Metadata                  |
| `code_scanning_default_setup`: `state`, `runner_type`, `runner_label`, `query_suite`, `threat_model`, `languages`                                                                                                                                                                                                                                                                    | `PATCH /code-scanning/default-setup`         | Administration                                                |
| `code_scanning_ai_scan`: `pr_scan`                                                                                                                                                                                                                                                                                                                                                   | `PATCH /code-scanning/ai-scan`               | Administration write; reading needs Code scanning alerts read |
| `code_quality_setup`: `state`, `runner_type`, `runner_label`, `languages`, `ai_findings_option`                                                                                                                                                                                                                                                                                      | `PATCH /code-quality/setup`                  | Administration write, to read it too                          |
| `dependabot_runner_settings`: `runner_type`, `runner_labels`, `runner_group`                                                                                                                                                                                                                                                                                                         | `PUT /dependabot/runner-settings`            | Administration                                                |

GitHub reports `security_and_analysis.dependabot_security_updates` too, but
sets it only through `automated_security_fixes`, so the profile has only the
latter. Security updates need Dependabot alerts: a plan turns the updates off
before the alerts, and skips turning the updates on while the profile turns
the alerts off.

### `custom_properties`, `pages`, `autolinks`

| Section             | Endpoint                                       | Permission                                      |
| ------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `custom_properties` | `PATCH /properties/values`                     | Custom properties write; reading needs Metadata |
| `pages`             | `POST`, `PUT`, and `DELETE /pages`             | Administration write and Pages write            |
| `autolinks`         | `POST /autolinks` and `DELETE /autolinks/{id}` | Administration                                  |

Custom properties are defined by the organization, so a profile can set any
property name, and a personal repository has none. Pages `public` exists only
on GitHub Enterprise Cloud. `capture` leaves out the custom domain and `public`,
which follow one repository. A new site built from a branch needs
`source.branch`; a plan skips one without it. A new site has no certificate
at first, so GitHub may refuse `https_enforced` in the update that follows
the create, and a second apply sets it. GitHub can't change an autolink, so
the plan deletes and makes again one that differs.

### `rulesets` and `environments`

Rulesets cover branch and tag protection, through `/rulesets`, with
Administration. Environments use `/environments` and their deployment branch
policies; listing them needs Actions read.

## Permissions the Repotted App needs

The Repotted App asks for Administration read and write and Metadata read.
Every setting above that names another permission needs it added, and the
owner of each installation must accept it:

- Actions: read, to list environments, read the cache storage limit, and read
  the OIDC subject claim; write, to set the OIDC subject claim.
- Contents: read and write, to sync profiles with a config repository.
- Pages: read and write.
- Custom properties: read and write.
- Code scanning alerts: read, to read the code scanning AI Scan setting.

Without one, Repotted still plans everything else, and says which permission
the skipped setting needs.

## Left out on purpose

These have an API, but don't fit a profile:

- `name`: renaming moves the repository, so it belongs to one repository.
- `archived`: an archived repository takes no other change, so archiving
  belongs to one moment, not a description a plan keeps in line.
- `use_squash_pr_title_as_default`: GitHub is closing it down in favour of
  `squash_merge_commit_title`.
- Interaction limits (`/interaction-limits`): temporary by design, with an
  expiry.
- The pull request creation cap's bypass list: GitHub documents no way to read
  it back.
- Collaborators, team access, deploy keys, webhooks, secrets, variables,
  runners and labels: access, credentials and content rather than settings,
  and some hold secrets a profile file must never carry.
- Classic branch protection: rulesets cover it and can do more.
- Copilot code review settings: GitHub doesn't offer that endpoint to GitHub
  Apps or fine-grained tokens.
- Check suite preferences: kept per GitHub App, not per repository.
- The repository subscription: kept per user.
- Git LFS on or off (`PUT` and `DELETE /lfs`, Enterprise Cloud only): GitHub
  offers no way to read it, so Repotted can't plan it.

Lists that a later change could add: Actions policies, and secret scanning
custom patterns, whose delete removes their alerts unless told otherwise.

## Settings with no API

These options appear on a repository's settings pages, but no REST endpoint
at the repository's level sets them, so no profile can. "Config only" means
they can be set only through an organization's or enterprise's code security
configurations. "Read only" means the API reports them but can't set them.

General:

- Social preview image.
- Wikis: **Restrict editing to collaborators only**, under `has_wiki`.
- Issues: **Collaborators only**, under `has_issues`. Pull requests have
  `pull_request_creation_policy`, but issues have nothing like it.
- **Sponsorships**. The button's content comes from `.github/FUNDING.yml`.
- **Preserve this repository**, for the GitHub Archive Program.
- **Auto-close issues with merged linked pull requests**.
- **Include Git LFS objects in archives**.
- Pushes: **Limit how many branches and tags can be updated in a single push**.
- **Leave fork network**.
- **Enable anonymous Git read access**, GitHub Enterprise Server only: read
  only.

Moderation:

- Code review limits: **Limit to users explicitly granted read or higher
  access**.
- Reported content: read only, as a yes or no in the community profile.
- Pull request limits: the exemptions by account age and by merged pull
  requests, under `pull_request_creation_cap`.

Rules and environments:

- The ruleset rule **Require secret scanning alerts are resolved**, in public
  preview.
- Environments: **Allow administrators to bypass configured protection
  rules**.

Code security:

- Config only: **Dependency graph**, **Automatic dependency submission**,
  **Reachability analysis**, Dependabot's and code scanning's **Prevent direct
  alert dismissals**, **Extended metadata**, **Push protection for AI-detected
  secrets**, and on api.github.com **Validity checks**.
- No API: **Dependabot malware alerts**, **Dependabot rules**, **Grouped
  security updates** (use `groups` in `dependabot.yml`), **Copilot Autofix**,
  **Agentic Autofix**, and **Access to alerts**.
- Kept in files rather than settings: Dependabot version updates
  (`.github/dependabot.yml`) and secret scanning `paths-ignore`
  (`.github/secret_scanning.yml`).

Copilot:

- Code review: **Maximum review effort**, the auto-approval options, **Block
  reviews requested with an external Copilot license**, and the internet
  access allowlist.
- Cloud agent settings: read only, through a preview endpoint.
- Content exclusion: set per organization only.
- The cloud agent's plugins, runner and setup steps, kept in files under
  `.github/`.

Other pages:

- Planning: **Agent suggestions for issues**.
- Codespaces: prebuild configurations.
- Email notifications.
