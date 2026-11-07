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
`--unset`, which keep the rest of the file; rulesets and environments are
edited in the YAML.

The app keeps its own settings, such as the chosen folder, in `settings.json`
in the per-user app data folder: `~/Library/Application Support/Repotted` on
macOS and `%APPDATA%\Repotted` on Windows. It never writes beside itself.

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
