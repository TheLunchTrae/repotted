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
`v0.2.0`, and must point at a commit on `main`. Create it as a full release:
prereleases do not publish, and promoting one later does not start the
workflow. The workflow runs the gate on that commit, packs `packages/cli` with
`bun pm pack`, which builds the bundle and replaces the `workspace:` range, and
publishes the tarball to npm with trusted publishing and provenance.

npm accepts the publish only from a trusted publisher: this repository,
`publish.yml`, and the `npm` environment. npm adds a trusted publisher only to
a package that exists, so the first version is published by hand:

1. On an up-to-date `main`, run `mise run standards:check`, then from
   `packages/cli` run `bun publish` while signed in to npm. Releases start
   from the next version, since npm already has this one.
2. On npmjs.com, add the trusted publisher to the `repotted` package, then in
   its publishing access settings require two-factor authentication and
   disallow tokens.
3. In the repository settings, give the `npm` environment the owner as a
   required reviewer and a `v*` tag rule, so only an approved release
   publishes.

Publishing needs the owner's yes. To release a change, bump `version` in
`packages/cli/package.json` in the same pull request.
