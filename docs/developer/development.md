# Development

[Architecture](architecture.md) explains how the pieces fit together. This page
covers working on them locally.

## Setup

[mise](https://mise.jdx.dev/) pins the tools: Bun, the .NET SDK for the
desktop app, gitleaks, and Python for the hygiene task. `.config/mise/`
holds the config, the tasks, and the lockfile.

```sh
mise install
mise run ts:install
mise run standards:check
```

`ts:node:check` needs Node 22 or later on `PATH`, because it runs the built
CLI the way `npx` does. CI installs Node 22, the oldest version `engines` allows.

`mise run standards:check` is the gate that CI runs on every pull request.
[AGENTS.md](../../AGENTS.md) lists the narrower checks to run for each kind of
change.

## Build and run the CLI

`mise run ts:build` (or `bun run build`) writes `packages/cli/dist/repotted.js`
with `Bun.build`, targeted at Node. The published dependencies stay external;
`@repotted/core` is bundled. To try the CLI from source:

```sh
bun packages/cli/src/main.ts --help
```

Tests use the in-memory GitHub in `packages/core/tests/fake-github.ts`. The
Safety section of AGENTS.md says when a real repository may be touched.

## Run the desktop app

`mise install` installs the pinned .NET SDK; `desktop/global.json` only sets
the oldest SDK that builds the app outside mise. Point the app at the CLI with
`REPOTTED_CLI`: a `.ts` file runs with Bun, a `.js` file with Node, and
anything else runs directly.

```sh
REPOTTED_CLI="$PWD/packages/cli/src/main.ts" dotnet run --project desktop/src/Repotted.Desktop
```

Without `REPOTTED_CLI`, the app looks next to itself for `repotted-cli`
(`repotted-cli.exe` on Windows), the compiled CLI that its packages ship, then
for `repotted` on `PATH`.

Linux builds work for development but aren't supported releases.

## Test the desktop app

```sh
mise run csharp:standards:check
```

That checks formatting, builds with the analyzers, and runs the tests,
including a contract test that runs the CLI from source and reads what it
prints. The view tests draw each page headlessly in light and dark. Set
`REPOTTED_SCREENSHOTS` to a folder to save those drawings as PNGs.

## Package the desktop app

```sh
mise run desktop:package
```

On a Mac that writes `Repotted.app` and a DMG to `artifacts/desktop`, and in
Git Bash on Windows an installer, both for the machine's own architecture. The
Mac app is signed ad hoc unless `MACOS_SIGNING_IDENTITY` names a Developer ID
identity. Releases build the same way; see
[Releasing](releasing.md#the-desktop-app).
