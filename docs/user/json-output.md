# JSON output

`--json` on `capture`, `plan`, `apply`, `profile`, `profiles`, `stage`, `sync`,
`repos`, `status` and `logout` prints exactly one JSON document on stdout, for scripts
and programs such as the desktop app. Repotted writes nothing to stderr in this mode;
anything that appears there, such as a deprecation notice from the GitHub client, is
diagnostic and not a failure. `--help` and `--version` still print text.

- `capture` prints `{ repository, profile, warnings }`, where `profile` is the
  profile the YAML holds. With `--output`, it also writes the YAML to that
  file.
- `plan` prints the plan, the same document `--out` saves:
  `{ repository, desired, changes, skipped, warnings, access, locks }`.
  `skipped` lists the profile's drafts as `{ section, target }`, where
  `target` is a draft setting's key, a draft autolink's key prefix, or a
  draft entry's name. `access` is `{ role, app }`: `role` is your role on the
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
  null for a whole ruleset, environment, autolink or Pages site, and `key`
  is what `stage --exclude` takes. A field inside an object of settings gives
  the whole object, which GitHub writes at once. `edited` is true when the
  value is a one-off edit, which you undo rather than exclude. The file
  `--out` saves leaves `staged` and `exclusions` out.
- `apply` needs `--yes`, since a program has no terminal to confirm in, and
  prints `{ repository, applied }` with the changes it made.
- `profile` prints `{ chain, profile, drafts, warnings, sources }`. `chain` is
  the profile file, then each one it extends, as real paths, with links
  resolved. `profile` is the resolved profile without its
  [drafts](profiles.md#drafts): what a plan applies. `drafts` holds them, as
  `repository`, `merge`, `actions`, `security`, `custom_properties` and
  `pages` objects of draft settings and `autolinks`, `rulesets` and
  `environments` lists of draft entries, each with `draft: true`; a member
  with no drafts is left out. `warnings` says what stops each draft from
  applying as it stands. `sources` names the file that sets each value:
  `repository`, `merge`, `actions`, `security`, `custom_properties` and
  `pages` by key, with the keys inside an object of settings as
  `<object>.<key>`, such as `selected_actions.verified_allowed` under
  `actions`, `autolinks` by key prefix, `rulesets` and `environments` by
  name, and `drafts` the same way for drafts. A value whose file is
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
  it names, and a staged plan's `warnings` do too. `sources` is as in `profile`,
  without the excluded values, so a value whose file is `chain[0]` is a
  one-off edit. With `--discard`, it prints `{ discarded }`, the file's path.
- `profiles` prints `{ profiles }`, each as `{ name, file, extends, problem }`,
  sorted by file name: the `.yaml` and `.yml` files directly in the folder.
  `file` is a real path, with links resolved, as in `profile`'s `chain`.
  `extends` is the real path of the profile it extends, or null, and
  `problem` says why the profile cannot be used, or is null.
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

A failure prints `{ error: { kind, message } }` and exits 1, or 2 for misuse,
which has `kind: usage`. A stale plan has `kind: stale_plan` and `current`, the
plan the repository needs now. A write that fails partway has
`kind: apply_failed`, with the changes in `applied` and the one in `failed`,
and `reason`: what GitHub refused it for, when GitHub refused it for good with
a `403` or `422`, such as `Needs Pages write` or the repository's plan not
supporting the setting, and null otherwise, as for a rate limit.
A command that finds no sign-in, or whose sign-in or token GitHub rejects,
has `kind: signed_out`; `status` says which. Anything else, such as an invalid
profile, a network error, or a keychain that would not open, has
`kind: error`.
