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
CLI the way `npx` does. CI installs Node 24.

## Build and run

`mise run ts:build` (or `bun run build`) writes `packages/cli/dist/repotted.js`
with `Bun.build`, targeted at Node. The published dependencies stay external;
`@repotted/core` is bundled. To try the CLI from source:

```sh
bun packages/cli/src/main.ts --help
```

## Publishing

The package is not published yet. When it is, publish from `packages/cli`
with `bun publish`, which runs `prepack` to build and replaces the
`workspace:` range. Publishing needs the owner's yes.
