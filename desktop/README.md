# Repotted desktop

A desktop app for managing repository setups by hand, built with
[Avalonia](https://avaloniaui.net/) on .NET 10. It runs on macOS and Windows.
Linux builds work for development but are not supported yet.

The app does no GitHub work itself. It runs the Repotted CLI with `--json` and
shows what the CLI prints (see [JSON output](../docs/profiles.md#json-output)),
so the CLI's sign-in, keychain and plan checks apply unchanged.

## Profiles and settings

The app edits profiles in a folder of YAML files. The folder starts as
`Documents/Repotted`, which the app creates, and the user can pick any other
folder, such as a clone of their setup repository. The profile editor changes
repository, merge and Actions settings through `repotted profile --set` and
`--unset`, which keep the rest of the file.

Rulesets and environments open in an editor of their own, saved through
`repotted profile --ruleset`, `--environment` and their `--drop-` forms. The
editor starts from the entry as the profile resolves it and changes only what
is edited, so keys and rules it does not show stay as they are. A choice left
unset leaves that key to GitHub. Editing a base profile's entry sets the whole
entry in this profile, over the base's, under the same name. Renaming an
entry, or taking it out of the profile, frees its old name only once the
profile is saved. While a capture runs, the profiles list leaves out the file
it holds.

A new profile starts empty, extends another profile in the folder, or is
captured from a repository with `repotted capture --output`, which only reads
from GitHub. The app never replaces a file that is already in the folder: it
creates the new file first, and a capture that fails or is cancelled removes
it. A profile that extends another names that file as the folder lists it, so
the reference still works when the folder is reached through a link.

The app keeps its own settings, such as the chosen folder, in `settings.json`
in the per-user app data folder: `~/Library/Application Support/Repotted` on
macOS and `%APPDATA%\Repotted` on Windows. It never writes beside itself.

## Compare

A repository can be compared with a profile from its panel on the
Repositories page. The app runs `repotted plan --json`, which only reads from
GitHub, and shows each difference by section: what GitHub has now and what the
profile sets. A ruleset change names the part that differs, such as
`rules[pull_request].parameters.allowed_merge_methods`. Matching settings are
counted and shown on request. The app does not apply plans.

## Run it

`mise install` installs the pinned .NET SDK; `global.json` only sets the
oldest SDK that builds the app outside mise. Point the app
at the CLI with `REPOTTED_CLI`: a `.ts` file runs with Bun, a `.js` file with
Node, and anything else runs directly.

```sh
REPOTTED_CLI="$PWD/packages/cli/src/main.ts" dotnet run --project desktop/src/Repotted.Desktop
```

Without `REPOTTED_CLI`, the app looks for `repotted` (`repotted.exe` on
Windows) next to itself, then on `PATH`.

## Test it

```sh
mise run csharp:standards:check
```

That checks formatting, builds with the analyzers, and runs the tests,
including a contract test that runs the CLI from source and reads what it
prints. The view tests draw each page headlessly in light and dark. Set
`REPOTTED_SCREENSHOTS` to a folder to save those drawings as PNGs.

## Layout

- `src/Repotted.Desktop/Services`: runs the CLI (`RepottedCli`) and reads its
  JSON (`RepottedClient`).
- `src/Repotted.Desktop/ViewModels`: one view model per page, with
  CommunityToolkit.Mvvm.
- `src/Repotted.Desktop/Views`: the pages in XAML, bound with compiled bindings.
- `src/Repotted.Desktop/Theme`: the custom theme. `Colors.axaml` holds the
  light and dark colors, and `Controls.axaml` styles the controls over
  Fluent.
- `src/Repotted.Desktop/Assets/Fonts`: Atkinson Hyperlegible Next and Mono,
  under the SIL Open Font License.
