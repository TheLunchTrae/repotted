# Settings coverage

Repotted aims to manage every repository setting that GitHub's REST API can
both read and set. This page explains how a profile's settings reach
GitHub's API and which GitHub App permissions they need, what Repotted
leaves out on purpose, and the options on GitHub's settings pages that have
no API at all.

The inventory was made from GitHub's OpenAPI descriptions for api.github.com
and GitHub Enterprise Cloud, in
[github/rest-api-description](https://github.com/github/rest-api-description),
and GitHub's docs. When GitHub adds a setting, add it to
`schema.ts`, the adapter for its section, `permissions.ts` when it needs a
permission other than Administration, the desktop app's
`ViewModels/ProfileFields.cs` (or, for a setting the app leaves to the YAML,
the list of those in its `ContractTests.cs`), and this page.

## How a setting is wired

Most repository settings are fields of `GET` and `PATCH /repos/{owner}/{repo}`.
The rest each live at an endpoint of their own under the repository.
`packages/core/src/endpoints.ts` describes those endpoints once, as data, and
reads and plans them all the same way:

- A `toggle` is on while a `GET` finds it on. `PUT` turns it on and `DELETE`
  turns it off. A `presence` toggle, `vulnerability_alerts`, is on whenever
  a `GET` finds it, so a `404` reads as off. The others say so in their
  `enabled` field. GitHub answers `404` while `immutable_releases` is off,
  and `automated_security_fixes` while Dependabot alerts are off, so those
  read a `404` as off too (`missingIsOff`). For the rest, a `404` means the
  repository doesn't have the feature.
- A `field` is one field of an endpoint, kept in the profile under its name.
  A field GitHub leaves out of its answer is unset, so a plan sets it.
- An `object` is several fields of an endpoint, kept together in the profile
  under the endpoint's key, such as `code_scanning_default_setup`. Its
  `schema` is its object in `schema.ts`, which names its fields. GitHub sends
  `null` for a field it leaves unset, so a `null` reads as unset unless the
  schema takes `null` there. A write sends the fields the profile names, plus
  the `carries` fields from the live value: every field for a `PUT`, which
  replaces what it's sent, and none for a `PATCH`, unless the endpoint lists
  its own. A carried `null` stays out. Three optional hooks keep a plan in
  line with what GitHub keeps:
  `fromGitHub` puts what GitHub reports in the form a write takes, `adjust`
  fills in fields GitHub ties to the ones a profile names and leaves out,
  with a warning, fields GitHub drops with the option chosen, and
  `identifying` names fields that a capture leaves out.

These hooks are why a plan settles after one apply:

- Dependabot runner labels and a runner group are dropped with standard
  runners, except the empty ones GitHub reports there, and labeled runners
  without exactly one label are skipped. An empty runner group stays out of
  a write.
- Code quality can report `rust`, which its write doesn't take, so a profile
  that names code quality `languages` on such a repository keeps showing the
  difference.
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
Administration. The same tables let `lockChanges` mark a planned change the
App's installation wasn't granted, so a new endpoint that needs another
permission gets its row there.

## What a profile covers

`schema.ts` holds every key a profile takes, and
[Profiles](../user/profiles.md#sections) lists them by section. The
repository and merge settings are fields of `PATCH /repos/{owner}/{repo}`,
except those at endpoints of their own, which `repositoryEndpoints` in
`packages/core/src/sections/repository.ts` lists with their paths.
`securityEndpoints` in `security.ts` lists the security settings outside
`security_and_analysis`, and `actionsEndpoints` in `actions.ts` the Actions
settings outside the policy. The adapters in that folder read and write the
rest: the Actions policy (`/actions/permissions`, its `/selected-actions`
list and `/workflow` token permissions), topics, custom properties, Pages,
autolinks, rulesets and environments. `permissions.ts` gives the permission
each endpoint needs. The notes below are what the code doesn't say.

### `repository` and `merge`

`capture` leaves out `description`, `homepage`, `visibility` and `topics`,
because they describe one repository. It keeps `default_branch`, so a
captured profile applied to a repository without that branch fails there
with GitHub's `422`. A plan that changes `visibility` warns what the change
does beyond the setting.

### `actions`

`access_level` and `fork_pr_workflows_private_repos` apply to private
repositories only.

### `security`

`security_and_analysis` is a field of the repository, which GitHub reports
to admins only. Its `secret_scanning_validity_checks` exists on GitHub
Enterprise Cloud only. GitHub reports
`security_and_analysis.dependabot_security_updates` too, but sets it only
through `automated_security_fixes`, so the profile has only the latter.
Security updates need Dependabot alerts: a plan turns the updates off before
the alerts, and skips turning the updates on while the profile turns the
alerts off.

### `custom_properties`, `pages`, `autolinks`

Custom properties are defined by the organization, so a profile can set any
property name, and a personal repository has none. Pages `public` exists only
on GitHub Enterprise Cloud. `capture` leaves out the custom domain and `public`,
which follow one repository. A new site built from a branch needs
`source.branch`; a plan skips one without it. A new site has no certificate
at first, so GitHub may refuse `https_enforced` in the update that follows
the create, and a second apply sets it. GitHub can't change an autolink, so
the plan deletes and makes again one that differs.

### `rulesets` and `environments`

Rulesets cover branch, tag and push protection. Environments include their
deployment branch policies.

## Permissions the Repotted App needs

The Repotted App asks for Administration read and write, which most settings
need, Metadata read, which GitHub requires, and the permissions below, which
[The GitHub App](github-app.md) also lists. A setting that needs a
permission the App doesn't have yet needs it added to the App and to
`permissions.ts`, and the owner of each installation must accept it:

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
at the repository's level sets them, so no profile can. In the desktop app,
each one that belongs to a setting the app shows is a note under that
setting, not a control. "Config only" means
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
