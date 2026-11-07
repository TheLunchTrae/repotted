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

## The GitHub App

`repotted login` signs in with the Repotted GitHub App, named Repotted App on
GitHub and owned by the project's owner. Its client ID and slug are
`app.clientId` and `app.slug` in `packages/cli/src/auth.ts`. The client ID is
public; the App needs no client secret or private key for the device flow. The
gate fails if `app.clientId` is empty.

Its settings, which a replacement App, registered under Settings, Developer
settings, GitHub Apps, New GitHub App, uses too:

- Name: Repotted App. Its slug, the name as GitHub writes it in URLs, must
  match `app.slug`. Homepage: the repository's URL.
- Callback URL: none. Leave **Request user authorization (OAuth) during
  installation** off, turn on **Enable Device Flow**, and leave **Expire user
  authorization tokens** on.
- Webhook: clear **Active**.
- Repository permissions: Administration, read and write. Metadata, read, is
  required. No other permissions and no events.
- Where it can be installed: any account.

Then copy the client ID, not the App ID, into `app.clientId`.

The App's permissions can change later in its settings. GitHub asks each
installation's owner to accept added permissions, and until they do, the App
keeps the old ones on that installation. Removed permissions take effect at
once, so older Repotted versions that still need them stop working.

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
