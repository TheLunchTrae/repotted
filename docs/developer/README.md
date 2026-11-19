# Repotted developer guide

These pages explain how Repotted works and why, for anyone changing it. To
use Repotted, see the [user guide](../user/README.md).
[CONTEXT.md](../../CONTEXT.md) defines the domain vocabulary these pages use.

- [Architecture](architecture.md): the packages, how a profile becomes a
  plan and a plan becomes writes, and the design decisions behind them.
- [Development](development.md): local setup, building, running, and testing.
- [State machines](state-machines.md): the states that sign-in, plan and
  apply, sync, the profile editor, and releases move through, and the
  failure states each can reach.
- [Settings coverage](settings-coverage.md): how a profile's settings reach
  GitHub's API and the permissions they need, what Repotted leaves out and
  why, and the settings-page options GitHub offers no API for.
- [The GitHub App](github-app.md): how Repotted signs in, and the Repotted
  App's registration settings.
- [The web app](web-app.md): the Cloudflare Worker that serves repotted.dev
  and its GitHub sign-in, running it locally, and deploying it.
- [Releasing](releasing.md): publishing the CLI to npm.

## Layout

- `packages/core`: the engine, private to the workspace. `src/index.ts` is
  its only public API. Its folders group the engine by domain:
  - `github/`: the GitHub client, the permission each request needs and the
    changes an account can't make, and the repositories an account reaches.
  - `profiles/`: the profile schema, loading, merging, and editing profiles,
    owner types, action pattern checks, syncing a profile folder with a
    config repository, and reading what a branch of it changes.
  - `plan/`: separate modules for planning, capture, saved-plan parsing,
    applying, and text output; what a change is and what counts as drift;
    settings at endpoints of their own; and `sections/`, one adapter per
    section. [Plans](architecture.md#plans) describes the dependency direction.
  - `staging/`: staged applies and batches.
  - `shared/`: hashing and base64, deep equality, and safe file writes.

  `tests/` mirrors `src/`, and `tests/support/` holds the in-memory GitHub and
  git the tests run on.

- `packages/cli`: the published `repotted` package: the CLI and the MCP
  server over the engine. Its build bundles core into one file, since core is
  never published on its own. `src/main.ts` and `src/commands.ts` run the
  commands, `src/auth/` signs in and keeps the token, and `src/mcp/` is the
  MCP server. `tests/` mirrors `src/`.
- `packages/web`: the web app at repotted.dev: a Cloudflare Worker that serves
  the site and its GitHub sign-in, and the page. Private to the workspace.
  [The web app](web-app.md#layout) lists its folders.
- `examples/`: example profiles that the tests also load.
- `.config/mise/`: the pinned tools, the tasks, and the lockfile.
- `.github/workflows/`: Quality, the gate on every pull request; Release
  CLI, which publishes the CLI; and Deploy Web, which deploys the web app.
  All three run the gate, or a task of it, through `.github/actions/gate`.
