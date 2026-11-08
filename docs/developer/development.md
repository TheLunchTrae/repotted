# Development

[Architecture](architecture.md) explains how the pieces fit together. This page
covers working on them locally.

## Setup

[mise](https://mise.jdx.dev/) pins the tools: Node and pnpm, the .NET SDK for
the desktop app, gitleaks, and Python for the hygiene task. `.config/mise/`
holds the config, the tasks, and the lockfile. pnpm installs the workspace from
`pnpm-lock.yaml`, and `pnpm-workspace.yaml` holds its settings.

```sh
mise install
mise run ts:install
mise run standards:check
```

`ts:node:check` runs the built CLI the way `npx` does, under the Node that
`SMOKE_NODE` names, or mise's Node without it. CI points `SMOKE_NODE` at Node 22,
the oldest version `engines` allows.

`mise run standards:check` is the gate that CI runs on every pull request.
[AGENTS.md](../../AGENTS.md) lists the narrower checks to run for each kind of
change.

## Build and run the CLI

`mise run ts:build` (or `pnpm run build`) writes `packages/cli/dist/repotted.js`
with esbuild, targeted at Node. The published dependencies stay external;
`@repotted/core` is bundled. To try the CLI, build it and run the bundle:

```sh
mise run ts:build
node packages/cli/dist/repotted.js --help
```

Vitest runs the tests from source, so `mise run ts:test` needs no build.

## Run the desktop app

`mise install` installs the pinned .NET SDK; `desktop/global.json` only sets
the oldest SDK that builds the app outside mise. Point the app at the CLI with
`REPOTTED_CLI`: a `.js` or `.mjs` file runs with Node, and anything else runs
directly. Build the CLI first, and again after changing it.

```sh
mise run ts:build
REPOTTED_CLI="$PWD/packages/cli/dist/repotted.js" dotnet run --project desktop/src/Repotted.Desktop
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
including the [contract test](architecture.md#the-desktop-app) against the
built CLI. The view tests draw each page headlessly in light and dark. Set
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
