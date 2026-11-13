# Repotted developer guide

These pages explain how Repotted works and why, for anyone changing it. To
use Repotted, see the [user guide](../user/README.md).
[CONTEXT.md](../../CONTEXT.md) defines the domain vocabulary these pages use.

- [Architecture](architecture.md): the packages and the desktop app, how a
  profile becomes a plan and a plan becomes writes, the design decisions
  behind them, and the contract between the desktop app and the
  [JSON output](../user/json-output.md).
- [Development](development.md): local setup, building, running, and testing
  the CLI and the desktop app.
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
- [Releasing](releasing.md): publishing the CLI to npm and building, signing,
  and releasing the desktop app.

## Layout

- `packages/core`: the engine, private to the workspace. `schema.ts` defines
  profiles, `sections/` holds one adapter per section, `endpoints.ts`
  reads and plans the settings at endpoints of their own, `permissions.ts`
  names the permission each request needs and locks the changes an account
  can't make, `profile.ts` loads, merges, and
  edits profiles, and `plan.ts` plans and applies.
- `packages/cli`: the published `repotted` package: the CLI and the MCP
  server over the engine. Its build bundles core into one file, since core is
  never published on its own.
- `packages/web`: the web app at repotted.dev: a Cloudflare Worker that serves
  the site and its GitHub sign-in, and the page. Private to the workspace.
- `examples/`: example profiles that the tests also load.
- `desktop/`: the desktop app, in C# on .NET 10 with Avalonia. It runs the CLI
  with `--json` for everything it does.
- `.config/mise/`: the pinned tools, the tasks, and the lockfile.
- `.github/workflows/`: Quality, the gate on every pull request; the Release
  CLI and Release Desktop release workflows; and Deploy Web, which deploys the
  web app. All four run the gate, or a task of it, through
  `.github/actions/gate`.
