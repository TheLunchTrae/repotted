# Releasing

The repository releases two things, told apart by the tag: the CLI on npm
from `v` releases, and the desktop app from `desktop-v` tags. Create CLI
releases with **Set as the latest release** cleared, so the latest release
stays the desktop app, which is the one people download.

## The CLI

Publishing a GitHub release with a `v` tag runs the Publish NPM workflow,
`.github/workflows/publish.yml`. The release tag must be `v` followed by the
version in `packages/cli/package.json`, such as `v0.2.0`, and must point at a
commit on `main`. Create it as a full release:
prereleases do not publish, and promoting one later does not start the
workflow. The workflow runs the gate on that commit, as Quality does but
without mise's tool cache, packs `packages/cli` with `pnpm pack`, which builds
the bundle and replaces the `workspace:` range, and publishes the tarball to
npm with trusted publishing and provenance. Each run waits for the one before
it to finish, including its wait for the `npm` approval, so CLI releases
publish in the order they're published.

npm accepts the publish only from a trusted publisher: this repository,
`publish.yml`, and the `npm` environment. npm adds a trusted publisher only to
a package that exists, so the first version is published by hand:

1. On an up-to-date `main`, run `mise run standards:check`, then from
   `packages/cli` run `pnpm publish` while signed in to npm. Releases start
   from the next version, since npm already has this one.
2. On npmjs.com, add the trusted publisher to the `repotted` package, then in
   its publishing access settings require two-factor authentication and
   disallow tokens.
3. In the repository settings, give the `npm` environment the owner as a
   required reviewer and a `v*` tag rule, so only an approved release
   publishes.

To release a change, bump `version` in `packages/cli/package.json` in the same
pull request.

## The desktop app

Pushing a `desktop-v` tag runs the Build Desktop workflow,
`.github/workflows/desktop.yml`. The tag must be `desktop-v` followed by
`Version` in
`desktop/src/Repotted.Desktop/Repotted.Desktop.csproj`, such as
`desktop-v0.1.0`, and must point at a commit on `main`:

```sh
git tag desktop-v0.1.0 origin/main
git push origin desktop-v0.1.0
```

The workflow runs the gate on that commit, as the CLI release does, builds the
app on macOS for Apple silicon and Intel and on Windows for x64, and attaches
these files to a draft release for the tag:

- `Repotted-<version>-macos-arm64.dmg` and `Repotted-<version>-macos-x64.dmg`,
  signed with a Developer ID, notarized, and stapled.
- `Repotted-<version>-windows-x64-setup.exe`, an unsigned installer that
  installs for the current user. Windows SmartScreen warns about it until it
  is signed.
- `SHA256SUMS.txt`, the checksums of the three.

Before the upload, the attest job records a build provenance attestation for
each package with [`actions/attest`](https://github.com/actions/attest), which
[the user guide](../user/desktop.md#install) shows how to verify. It attests
the packages after signing, notarization, and stapling, since each of those
changes the file, so the attested digest is that of the file the release
offers. The upload job runs only after the attestations succeed, so a draft
never holds an unattested package. The attest job holds the workflow's only
permission to sign attestations, and it neither checks out the repository nor
builds anything, so that identity never shares a job with the build steps or
the Apple secrets.

Build provenance shows which workflow, commit, and tag built a file. It
differs from the release attestation that GitHub records when it publishes an
immutable release, which `gh release verify-asset` checks: that one shows a
file belongs to the release, `SHA256SUMS.txt` included, but a file uploaded by
hand passes it too.

Each build ships the CLI beside the app as `repotted-cli`, a Node single
executable, with its keychain module as `repotted-keyring.node`.
`mise run desktop:package` makes the same package on a Mac or in Git Bash on
Windows, in `artifacts/desktop`.

To build test installers from any branch, run Build Desktop from the Actions
tab. The run uses no Developer ID, notarizes nothing, attests nothing, and
makes no release, so a test build has no record that could pass for a
release's. It checks that the packages build, that the CLI starts under the
hardened runtime, and that the macOS app launches, then keeps the packages as
run artifacts for 3 days. A newer test build of the same branch cancels the
one still running. The macOS app in such a package is signed ad hoc, so
Gatekeeper refuses it until it is allowed in System Settings. Pull requests
don't run Build Desktop. Quality builds and tests the app on each one, on
Linux, macOS and Windows, and builds and checks the compiled CLI on Linux, but
doesn't package it, so run Build Desktop on the branch of a pull request that
changes the packaging or what `sea.ts` does on macOS or Windows.

The repository's releases are immutable, so files can't be added once a
release is published. The owner reviews the draft, sets it as a prerelease
or the latest release, and publishes it. A draft also lets the owner try a
first signed build without publishing it. Re-running a failed run's jobs
retries the same commit; a fix on `main` needs the next version, since the tag
rulesets keep a tag from moving.

Signing runs only in the `macos-release` environment, which holds:

| Name                                    | Kind     | Value                                                                                                                                                                                |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEVELOPER_ID_APPLICATION_P12`          | Secret   | The Developer ID Application certificate from Certificates, Identifiers & Profiles on developer.apple.com, exported with its private key from Keychain Access as a `.p12`, in base64 |
| `DEVELOPER_ID_APPLICATION_P12_PASSWORD` | Secret   | The password set when exporting that `.p12`                                                                                                                                          |
| `APP_STORE_CONNECT_API_KEY_P8`          | Secret   | The `.p8` file of an App Store Connect API team key, from Users and Access > Integrations > App Store Connect API, in base64; Apple offers the download only once                    |
| `APPLE_TEAM_ID`                         | Variable | The Team ID in the Apple Developer account's membership details                                                                                                                      |
| `APP_STORE_CONNECT_API_KEY_ID`          | Variable | The Key ID shown beside that API key                                                                                                                                                 |
| `APP_STORE_CONNECT_API_ISSUER_ID`       | Variable | The Issuer ID shown above the team keys                                                                                                                                              |

Limit the environment's deployment branches and tags to the `desktop-v*` tag
rule, so that only a release run reaches the secrets, and give it the owner as
a required reviewer, so that each signing run waits for approval. A release
run without these fails rather than attach an unsigned Mac app.

Tag rulesets must let the owner push `desktop-v*` tags. A ruleset that blocks
creating every tag except `v*` needs `desktop-v*` excluded as well, and a
ruleset that limits who creates `v*` tags needs `desktop-v*` included.

To release the app, bump `Version` in the project file in the same pull
request.
