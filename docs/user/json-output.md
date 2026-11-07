# JSON output

`--json` on `capture`, `plan`, `apply`, `profile`, `profiles`, `repos` and
`status` prints exactly one JSON document on stdout, for scripts and programs
such as the desktop app. Repotted writes nothing to stderr in this mode;
anything that appears there, such as a deprecation notice from the GitHub client, is
diagnostic and not a failure. `--help` and `--version` still print text.

- `capture` prints `{ repository, profile, warnings }`, where `profile` is the
  profile the YAML holds. With `--output`, it also writes the YAML to that
  file.
- `plan` prints the plan, the same document `--out` saves.
- `apply` needs `--yes`, since a program has no terminal to confirm in, and
  prints `{ repository, applied }` with the changes it made.
- `profile` prints `{ chain, profile, sources }`. `chain` is the profile
  file, then each one it extends, as real paths, with links resolved. `profile` is the
  resolved profile, and `sources` names the file that sets each value:
  `repository`, `merge` and `actions` by key, with `selected_actions` keys as
  `selected_actions.<key>` under `actions`, and `rulesets` and `environments`
  by name. A value whose file is `chain[0]` is set in the profile itself.
- `profiles` prints `{ profiles }`, each as `{ name, file, extends, problem }`,
  sorted by file name: the `.yaml` and `.yml` files directly in the folder.
  `file` is a real path, with links resolved, as in `profile`'s `chain`.
  `extends` is the real path of the profile it extends, or null, and
  `problem` says why the profile cannot be used, or is null.
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

A failure prints `{ error: { kind, message } }` and exits 1, or 2 for misuse,
which has `kind: usage`. A stale plan has `kind: stale_plan` and `current`, the
plan the repository needs now. A write that fails partway has
`kind: apply_failed`, with the changes in `applied` and the one in `failed`.
Anything else, such as a missing token, an invalid profile or a network error,
has `kind: error`.
