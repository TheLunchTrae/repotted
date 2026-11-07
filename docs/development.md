# Development

## Layout

- `packages/core`: the engine, private to the workspace. `schema.ts` defines
  profiles, `sections/` holds one adapter per section, `profile.ts` loads and
  merges profiles, and `plan.ts` plans and applies.
- `packages/cli`: the published `repotted` package, the CLI and the MCP
  server. Its build bundles core into one file.
- `examples/`: example profiles that the tests also load.
- `desktop/`: the desktop app, in C# with Avalonia. It runs the CLI with
  `--json` for everything it does. See [desktop/README.md](../desktop/README.md).

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
- Repository permissions: Administration, read and write. Actions, read, to
  list environments. Metadata, read, is required. No other permissions and no
  events.
- Where it can be installed: any account.

Then copy the client ID, not the App ID, into `app.clientId`.

The App's permissions can change later in its settings. GitHub asks each
installation's owner to accept added permissions, and until they do, the App
keeps the old ones on that installation. Removed permissions take effect at
once, so older Repotted versions that still need them stop working.

## Publishing

The repository releases two things, told apart by the tag: the CLI on npm
from `v` releases, and the desktop app from `desktop-v` tags. Create CLI
releases with **Set as the latest release** cleared, so the latest release
stays the desktop app, which is the one people download.

### The CLI

Publishing a GitHub release with a `v` tag runs
`.github/workflows/publish.yml`. The release tag must be `v` followed by the
version in `packages/cli/package.json`, such as `v0.2.0`, and must point at a
commit on `main`. Create it as a full release:
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

To release a change, bump `version` in `packages/cli/package.json` in the same
pull request.

### The desktop app

Pushing a `desktop-v` tag runs `.github/workflows/desktop.yml`. The tag must
be `desktop-v` followed by `Version` in
`desktop/src/Repotted.Desktop/Repotted.Desktop.csproj`, such as
`desktop-v0.1.0`, and must point at a commit on `main`:

```sh
git tag desktop-v0.1.0 origin/main
git push origin desktop-v0.1.0
```

The workflow runs the gate on that commit, builds the app on macOS for Apple
silicon and Intel and on Windows for x64, and attaches these files to a draft
release for the tag:

- `Repotted-<version>-macos-arm64.dmg` and `Repotted-<version>-macos-x64.dmg`,
  signed with a Developer ID, notarized, and stapled.
- `Repotted-<version>-windows-x64-setup.exe`, an unsigned installer that
  installs for the current user. Windows SmartScreen warns about it until it
  is signed.
- `SHA256SUMS.txt`, the checksums of the three.

Each build ships the CLI compiled with `bun build --compile` beside the app as
`repotted-cli`. `mise run desktop:package` makes the same package on a Mac or
in Git Bash on Windows, in `artifacts/desktop`. Pull requests that touch the
app, the CLI, or the build run the workflow without signing, so each one
checks that the packages build, the CLI starts under the hardened runtime, and
the macOS app launches.

The repository's releases are immutable, so files can't be added once a
release is published. The owner reviews the draft, sets it as a prerelease
or the latest release, and publishes it. A draft also lets the owner try a
first signed build without publishing it. Re-running a failed run's jobs
retries the same commit; a fix on `main` needs the next version, since the tag
rulesets keep a tag from moving.

Signing runs only in the `macos-release` environment, which holds:

| Name                          | Kind     | Value                                                                                         |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`       | Secret   | The Developer ID Application certificate and its private key, exported as a `.p12`, in base64 |
| `MACOS_CERTIFICATE_PASSWORD`  | Secret   | The password of that `.p12`                                                                   |
| `APP_STORE_CONNECT_KEY_P8`    | Secret   | An App Store Connect API key's `.p8` file, in base64, for `notarytool`                        |
| `APPLE_TEAM_ID`               | Variable | The team ID of the certificate                                                                |
| `APP_STORE_CONNECT_KEY_ID`    | Variable | The API key's ID                                                                              |
| `APP_STORE_CONNECT_ISSUER_ID` | Variable | The issuer ID shown above the API keys                                                        |

Limit the environment's deployment branches and tags to the `desktop-v*` tag
rule, so that only a release run reaches the secrets, and give it the owner as
a required reviewer, so that each signing run waits for approval. A release
run without these fails rather than attach an unsigned Mac app.

Tag rulesets must let the owner push `desktop-v*` tags. A ruleset that blocks
creating every tag except `v*` needs `desktop-v*` excluded as well, and a
ruleset that limits who creates `v*` tags needs `desktop-v*` included.

To release the app, bump `Version` in the project file in the same pull
request.
