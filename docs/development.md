# Development

## Layout

- `packages/core`: the engine, private to the workspace. `schema.ts` defines
  profiles, `sections/` holds one adapter per section, `profile.ts` loads and
  merges profiles, and `plan.ts` plans and applies.
- `packages/cli`: the published `repotted` package, the CLI and the MCP
  server. Its build bundles core into one file.
- `examples/`: example profiles that the tests also load.

## Setup

[mise](https://mise.jdx.dev/) pins the tools: Bun, gitleaks, and Python for
the hygiene task. `.config/mise/` holds the config, the tasks, and the
lockfile.

```sh
mise install
mise run ts:install
mise run standards:check
```

`ts:node:check` needs Node 22 or later on `PATH`, because it runs the built
CLI the way `npx` does. CI installs Node 22, the oldest version `engines` allows.

## Build and run

`mise run ts:build` (or `bun run build`) writes `packages/cli/dist/repotted.js`
with `Bun.build`, targeted at Node. The published dependencies stay external;
`@repotted/core` is bundled. To try the CLI from source:

```sh
bun packages/cli/src/main.ts --help
```

## Publishing

Publishing a GitHub release runs `.github/workflows/publish.yml`. The release
tag must be `v` followed by the version in `packages/cli/package.json`, such as
`v0.2.0`, and must point at a commit on `main`. The workflow runs the gate on
that commit, packs `packages/cli` with `bun pm pack`, which builds the bundle
and replaces the `workspace:` range, then publishes the tarball to npm with
trusted publishing and provenance. Prereleases do not publish.

The publish job runs in the `npm` environment, and npm accepts it only when
the package has a trusted publisher for this repository, `publish.yml`, and
that environment. Publishing needs the owner's yes, so the owner publishes the
release.

To bump the version, change `version` in `packages/cli/package.json` in the
same pull request as the change it releases.
