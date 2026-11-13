# JSON output

`--json` on `capture`, `plan`, `apply`, `profile`, `profiles`, `schema`, `stage`, `sync`,
`repos`, `status` and `logout` prints exactly one JSON document on stdout, for scripts
and programs such as the desktop app. Repotted writes nothing to stderr in this mode;
anything that appears there, such as a deprecation notice from the GitHub client, is
diagnostic and not a failure. `--help` and `--version` still print text.

- `capture` prints `{ repository, profile, warnings }`, where `profile` is the
  profile the YAML holds, and `warnings` lists what it left out, as
  [warnings](#warnings) describes. With `--output`, it also writes the YAML
  to that file.
- `plan` prints the plan, the same document `--out` saves:
  `{ repository, desired, changes, skipped, warnings, access, locks }`.
  Each change is `{ section, action, target, fields, request }`: `action` is
  `create`, `update` or `delete`, `target` names what it writes for people to
  read, `fields` lists what it changes as `{ field, from, to }`, and `request`
  is the write it makes. A change to an autolink, ruleset, environment or
  label also has `entry`, `{ name }`, the entry it acts on as the profile
  writes it: an autolink's key prefix, or the entry's name. A change to one
  of an environment's branch policies names the environment there, with
  `branch_policy` as `{ name, type }`. Find a change's entry by `entry` rather
  than by `target`, since two targets can read the same. GitHub can't edit an
  autolink, so a plan changes one with a `delete` and a `create` of the same
  `entry`, and the `create`'s `fields` say what differs.
  `warnings` lists what the plan left out and what a change does beyond its
  fields, as [warnings](#warnings) describes. `skipped` lists the profile's
  drafts as `{ section, target }`, where `target` is a draft setting's key,
  a draft autolink's key prefix, or a draft entry's name. `access` is
  `{ role, app }`: `role` is your role on the
  repository (`admin`, `maintain`, `write`, `triage` or `read`), or null when
  GitHub doesn't say. `app` is `{ status: installed, permissions,
  settings_url }` when the Repotted App is installed on the repository, with
  the permissions its installation was granted, by GitHub's key, and the
  installation's settings page, or null when GitHub gives none;
  `{ status: not_installed }` when it isn't;
  and `{ status: unknown }` with a token that can't read installations, such
  as `GITHUB_TOKEN`. `locks` lists `{ change, reason }`, where `change` is an
  index into `changes` and `reason` says what the change needs, such as
  `Needs Pages write`. Unknown access locks nothing. `apply` ignores `access`
  and `locks`.
  With `--staged`, the document also has `staged`, as
  `{ file, repository, base, exclude }` from `stage` below, and
  `exclusions`, which says what leaves each change out of the staged apply.
  Each exclusion is `{ change, field, key, edited }`: `change` is the
  change's index in `changes`, `field` is the field it leaves out, or
  null for a whole ruleset, environment, label, autolink or Pages site, and `key`
  is what `stage --exclude` takes. A field inside an object of settings gives
  the whole object, which GitHub writes at once. `edited` is true when the
  value is a one-off edit, which you undo rather than exclude. The file
  `--out` saves leaves `staged` and `exclusions` out.
  With `--staged` and a batch folder, `plan` prints
  `{ batch, id, profile, plans, left_out, failures }`, the same document
  `--out` saves. `batch` is the folder's real path, `id` tells the batch from
  one started again in the same folder, and `profile` is the profile new
  repositories start from, or null. Each of `plans` is one repository's
  staged plan, as above, with `file`, its staged apply, and `digest`, that
  file's SHA-256 when it was planned. `left_out` lists `{ repository, file }`
  for each repository left out of the batch, and `failures` lists
  `{ repository, file, error }` for each one that could not be planned, where
  `error` is `{ kind, message, status }`: `kind` as for any failure below,
  and `status` the HTTP status GitHub answered with, or null. `plan` exits 1
  when any repository could not be planned, and still prints and saves the
  rest.
- `apply` needs `--yes`, since a program has no terminal to confirm in, and
  prints `{ repository, applied }` with the changes it made.
  For a batch's plan, it prints `{ batch, results }`, one result for each
  repository it was asked to apply, in order, as `{ repository, status,
  ended }`. `ended` is true when the repository's staged apply ended and it
  left the batch. `status` is `applied`, with `applied`, the changes made;
  `in_line`, when the plan had no changes and planning again still finds
  none; `locked`, with `locks`, not tried; `left_out`, when the batch no
  longer holds it as reviewed, since it was left out or taken out, or the
  batch ended or started again, not tried; `changed`, when its staged apply
  changed after the review, not tried;
  `stopped`, after an earlier failure with `--stop-on-failure`, not tried;
  `stale`, with `message` and `current`, as for a stale plan; `apply_failed`,
  with `message`, `applied`, `failed` and `reason`, as for a write that fails
  partway; or `failed`, with `error` as in a batch plan's `failures`. It exits
  1 when any repository is `locked`, `changed`, `stopped`, `stale`,
  `apply_failed` or `failed`.
- `profile` prints `{ chain, profile, drafts, warnings, sources }`. `chain` is
  the profile file, then each one it extends, as real paths, with links
  resolved. `profile` is the resolved profile without its
  [drafts](profiles.md#drafts): what a plan applies. `drafts` holds them, as
  `repository`, `merge`, `actions`, `security`, `custom_properties` and
  `pages` objects of draft settings and `autolinks`, `rulesets`,
  `environments` and `labels` lists of draft entries, each with `draft: true`; a member
  with no drafts is left out. `warnings` says what stops each draft from
  applying as it stands. `sources` names the file that sets each value:
  `repository`, `merge`, `actions`, `security`, `custom_properties` and
  `pages` by key, with the keys inside an object of settings as
  `<object>.<key>`, such as `selected_actions.verified_allowed` under
  `actions`, `autolinks` by key prefix, `rulesets`, `environments` and
  `labels` by name, and `drafts` the same way for drafts. A value whose file is
  `chain[0]` is set in the profile itself.
- `stage` prints
  `{ file, repository, base, exclude, chain, profile, drafts, warnings, sources }`.
  `file` is the staged apply's real path, first in `chain`, and `repository`
  is the one it applies to. `base` is the real path of the profile it starts
  from, or null when it starts from the repository as it is. `exclude` lists
  what it leaves out, as the file holds it. `profile` is what its plan brings
  the repository to: the profile with the one-off edits laid over it and the
  excluded values left out. `drafts` and `warnings` are the drafts of the
  profile it starts from, which its plan leaves out, as in `profile`; a
  staged apply holds no drafts of its own. `warnings` also names each
  exclusion that leaves nothing out, as when the profile stops setting what
  it names, and a staged plan's `warnings` do too, each with `exclusion`.
  `sources` is as in `profile`, without the excluded values, so a value
  whose file is `chain[0]` is a one-off edit. With `--discard`, it prints
  `{ discarded }`, the file's path.
  On a batch folder, `stage` prints `{ folder, id, profile, members }`:
  `folder` is the batch's real path, `id` as in its plan, `profile` the
  profile its new repositories start from, or null, and each member is `{ repository, file, left_out, joined }`,
  where `joined` is true for a staged apply that joined the batch as it was.
  With `--everywhere`, the document also has `changed`, the repositories whose
  staged apply changed, and `refused`, as `{ repository, message }`, those
  that kept theirs. With `--repo`, it prints that repository's staged apply,
  as above; with `--repo` and `--discard`,
  `{ repository, file, kept, batch }`, where `kept` is true for a staged
  apply that joined the batch, which stays, and `batch` is the batch as it is now, or
  null when it ended; and with `--discard` alone, `{ discarded }`, the
  folder's path.
- `profiles` prints `{ profiles }`, each as `{ name, folder, file, extends, problem }`,
  for the `.yaml` and `.yml` files in the folder and its subfolders: a folder's
  own profiles by file name, then each subfolder's, by name. Subfolders whose
  names start with a dot, and links to folders, are left out. `folder` is the
  subfolder, with `/` separators, such as `team/apps`, or `""` for the folder itself.
  `file` is a real path, with links resolved, as in `profile`'s `chain`.
  `extends` is the real path of the profile it extends, or null, and
  `problem` says why the profile cannot be used, or is null.
- `schema` prints the JSON Schema of a profile file, in Draft 7: the same
  document as without `--json`, on one line.
  [The command line](cli.md#edit-profiles-with-completion) says how an editor
  uses it.
- `sync` prints `{ repository, path, branch, commit, pulled, pushed,
  conflicts }`, where the last three list files by their path in the folder,
  and `commit` is the branch's commit after the sync, or null for an empty
  repository. It exits 1 when `conflicts` is not empty.
- `repos` prints `{ source, repositories }`, each repository as
  `{ full_name, private, archived }`, sorted by name: the repositories your
  account administers. With a Repotted App sign-in, `source` is
  `installations` and the list holds those the App is installed on. GitHub
  refuses the installation list to any other token, which gets `admin` and
  every repository the account administers; the token itself may not be
  allowed to change them (see [Sign in](sign-in.md#use-a-token-instead)).
- `status` prints `{ signed_in: true, login, name, token_variable,
  install_url }`, where `token_variable` names `GITHUB_TOKEN` or `GH_TOKEN`
  when one is set and used before the sign-in, and is null otherwise, and
  `install_url` is the Repotted App's install page, or null when another App's
  client ID is in use. Signed out, or with a token GitHub rejects, it prints
  `{ signed_in: false, reason, message, problems, token_variable, install_url }`
  and exits 1. `reason` is `not_signed_in` or `rejected`; a rejected token
  that came from a variable is the only case where `token_variable` is set
  while signed out. `problems` says why a sign-in could not be used, such as
  an unreadable keychain or an expired sign-in that could not be refreshed.
- `login` prints JSON Lines, one document per line: first
  `{ event: code, verification_uri, user_code, expires_at }` for the user to
  enter, then `{ event: signed_in, install_url, token_variable }` once they
  have. `install_url` is null when another App's client ID is in use. If the
  sign-in fails after the code, such as when the code expires, the second line
  is `{ event: error, error: { kind, message } }` and `login` exits 1.
- `logout` prints `{ removed }`, which is false when there was no sign-in to
  remove. It removes only the `repotted login` sign-in, not a token variable
  or the GitHub CLI's sign-in.

## Warnings

`capture` and `plan` give each warning as an object. A warning that left
something out has `section`, `key` when it is about a setting or an entry,
by the setting's key or the entry's name, `field` when it is about one
field of that setting, and `cause`, which says why:

- `refused`: GitHub refused to show it, as for want of a permission or of
  the admin role.
- `unavailable`: the repository doesn't offer it, as on a GitHub plan
  without the feature. `capture` leaves these out without a warning.
- `not_applicable`: it doesn't apply with the other settings, such as
  selected actions while Actions is off.
- `unloadable`: in `capture` only, a profile can't hold the value GitHub
  reports, such as an option newer than Repotted.

Its `message` gives the reason in words. A warning without `cause` leaves
nothing out, such as one about what changing visibility does, and its
`message` is the whole warning; it has `section` and `key` when it is about
one setting or entry, or, in a staged plan, `exclusion`, an exclusion that
leaves nothing out, as the staged apply lists it. A member that doesn't
apply is left out. Text output prints each warning as a line, such as this
one for a warning with `section: actions`, `key: allowed_actions` and
`cause: not_applicable`:

```text
Skipped actions.allowed_actions: it only applies while Actions is enabled
```

## Failures

A failure prints `{ error: { kind, message } }` and exits 1, or 2 for misuse,
which has `kind: usage`. A stale plan has `kind: stale_plan` and `current`, the
plan the repository needs now. A plan saved before changes carried `entry` is
stale if it changes an autolink, ruleset, environment or label. A write that fails partway has
`kind: apply_failed`, with the changes in `applied` and the one in `failed`,
and `reason`: what GitHub refused it for, when GitHub refused it for good with
a `403` or `422`, such as `Needs Pages write` or the repository's plan not
supporting the setting, and null otherwise, as for a rate limit.
A command that finds no sign-in, or whose sign-in or token GitHub rejects,
has `kind: signed_out`; `status` says which. Anything else, such as an invalid
profile, a network error, or a keychain that would not open, has
`kind: error`.
