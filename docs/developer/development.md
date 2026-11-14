# Development

[Architecture](architecture.md) explains how the pieces fit together. This page
covers working on them locally.

## Setup

[mise](https://mise.jdx.dev/) pins the tools: Node and pnpm, gitleaks, and
Python for the hygiene task. `.config/mise/` holds the config, the tasks,
and the lockfile. pnpm installs the workspace from `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` holds its settings.

```sh
mise install
mise run ts:install
mise run standards:check
```

`ts:node:check` runs the built CLI the way `npx` does, under Node 22, the
oldest version `engines` allows. The task pins that Node for itself alone, so
everything else runs mise's newer Node, and it fails when `engines` names
another major version. A local run checks the same Node as CI.

`mise run standards:check` is the gate that CI runs on every pull request.
Quality, Release CLI, and Deploy Web run it through one composite action,
`.github/actions/gate`, which installs the pinned tools first; the task graph
installs the locked dependencies where a task first needs them. Only Quality
caches mise's tools; a release builds from the locked, checksummed downloads
alone.
[AGENTS.md](../../AGENTS.md) lists the narrower checks to run for each kind of
change.

## Versions

Manifests and tool configs state version ranges, and lockfiles pin the exact
versions, so CI and a fresh install get what the lockfiles name while a newer
tool on your machine still works.

- mise names each workspace tool's major version, and
  `.config/mise/mise.lock` pins the exact release. `mise lock --bump` moves the
  lockfile to the newest release in each range. Tools that a single task
  declares, such as the oldest Node for `ts:node:check`, stay exact, since
  `mise lock` resolves a task's range again rather than keep its locked
  release.
- `devEngines` in `package.json` accepts newer pnpm releases of the same major
  version and fails on another major version, whose lockfile format can
  differ.
- Dev dependencies use caret ranges, and `savePrefix` in `pnpm-workspace.yaml`
  gives new dependencies one. TypeScript uses a tilde range, since its minor
  releases change type checking.
- The published CLI's dependencies, and core's copies of them, use tilde
  ranges; add one with a tilde by hand. `npx` installs them without a
  lockfile or the three-day release hold, so users get new patch releases as
  soon as they're published, though not a new minor version until a change
  raises the range and the gate tests it.
- Actions stay pinned to commit SHAs, and the gate pins mise's own version,
  since a change to either runs code that no review has seen.

## Build and run the CLI

`mise run ts:build` (or `pnpm run build`) writes `packages/cli/dist/repotted.js`
with esbuild, targeted at Node. The published dependencies stay external;
`@repotted/core` is bundled. To try the CLI, build it and run the bundle:

```sh
mise run ts:build
node packages/cli/dist/repotted.js --help
```

Vitest runs the tests from source, so `mise run ts:test` needs no build.
