# Reusable environments

A reusable environment keeps one deployment environment's protection settings
in its own YAML file. Several profiles can reference it, or you can compare
and apply it directly. It lives beside profiles in browser storage, a config
repository, or a supported local folder, and uses the same sync and import/export
flows.

For example, save this as `production.yaml`:

```yaml
kind: environment
environments:
  - name: production
    wait_timer: 15
    reviewers:
      - type: User
        id: 123
    prevent_self_review: true
    deployment_branch_policy:
      protected_branches: false
      custom_branch_policies: true
    branch_policies:
      - name: release/*
        type: branch
```

The file contains exactly one environment. Its `name` identifies the target
on GitHub; the filename identifies the reusable definition. Environment names
match without regard to case, so `production` updates an existing `Production`
environment instead of creating another one. Changing the target name starts
managing the new target; it does not delete the old environment.

## Reference an environment

Add relative paths under `references.environments`:

```yaml
references:
  environments:
    - ./production.yaml
    - ./release.yaml
repository:
  delete_branch_on_merge: true
```

Each reference supplies one environment. References apply after the profiles
applied before this one and before inline environments in the referencing profile. An inline
environment with the same name, in any case, replaces the whole referenced
entry. Later profiles in an ordered combination and staged one-off edits use
the same replacement rule. Two references in one profile must not supply the
same target name.

Editing a consumer keeps its references intact. The resolved environment shows
the file that supplies it. A missing file, a file of the wrong kind, invalid
protection settings, or incompatible owner types blocks resolution. For example,
a personal-account profile cannot use a referenced environment with team
reviewers.

## Apply and maintain the definition

Capture one environment from a repository with the CLI:

```sh
repotted capture lunch/service --kind environment --name production --output production.yaml
```

The target name is required. A missing target or unreadable protection settings
fails the capture instead of saving an empty definition. The MCP `capture` tool
takes the same choice as `kind: environment` and `name: production`. In the web
app, open **Environments**, choose **New environment**, and enter the
**Target name** when creating or capturing a definition. Its editor uses the existing environment
controls.

Use the definition wherever you choose a profile for a one-time staged apply or
a saved repository assignment. Compare, review changes, and apply as usual.
Editing a shared definition affects each consumer on its next resolution and
marks its dependent assignments as changed. Saving the file does not write to
GitHub, and a changed effective plan must be reviewed again.

Partial management is the default. Omitted wait timers, reviewers, self-review
prevention, and deployment policies keep their live values. Specifying
`reviewers` replaces that list; specifying `branch_policies` manages the whole
pattern list. See [Environments](profiles.md#environments) for these fields.
Unrelated environments and other repository sections stay untouched. Environment
secrets and variables are not part of a reusable definition and stay untouched.

Removing a reference or deleting a definition stops management; it does not
delete a live environment. Resolve known dependent profiles and assignments
before deleting their definition. Moving or renaming the definition must preserve
its references. To delete a live environment, use an explicit reviewed deletion;
GitHub also deletes that environment's secrets and variables.
