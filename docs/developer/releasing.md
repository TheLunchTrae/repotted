# Releasing

The repository releases two things: the CLI on npm with `v` tags, and the
desktop app with `desktop-v` tags. Each has one workflow that the owner runs
from the Actions tab with **Run workflow** on `main`, and that run does the
whole release: it checks, builds, attests, publishes, creates the tag, and
publishes the GitHub release with its files. No other event starts either
workflow, and nothing else creates their tags.

Both workflows take the version from a file on `main`, which a pull request
bumps before the release. A run refuses a version whose tag already exists.

Both take one input, **Dry run**. A dry run does everything a release does up
to the release itself, and attests, publishes, tags, and releases nothing. On
`main` it reports what a release would refuse as warnings and goes on; on
another branch it builds test packages. A dry run makes no attestation, so
test builds leave no record that could pass for a release's.

Only the job that creates the release can write to the repository; every
other job can at most read it. The tag and release are created with the
workflow's own token, so they show as made by github-actions.

## The CLI

The Release CLI workflow, `.github/workflows/release-cli.yml`, releases the
version in `packages/cli/package.json`, such as `0.3.0` as `v0.3.0`. It
refuses the version when the `v` tag exists or npm already has it. Then it
runs the gate on that commit, as Quality does but without Quality's caches,
and packs `packages/cli` with `pnpm pack`, which builds the bundle and
replaces the `workspace:` range. A dry run stops there.

A release then records a build provenance attestation for the tarball with
[`actions/attest`](https://github.com/actions/attest), publishes it to npm
with trusted publishing and provenance, and only after npm accepts it creates
the `v` tag and a release with the tarball and `SHA256SUMS.txt`, with notes
generated since the last `v` tag. The release is never set as the latest, so
the latest release stays the desktop app, which is the one people download.

The publish job skips the upload when npm already has this exact tarball, as
after an attempt that timed out once npm had it, so re-running it goes on to
the release. The release job attaches the tarball that npm serves rather than
the run's artifact, so it can be re-run after that artifact expires.

npm accepts the publish only from a trusted publisher: this repository,
`release-cli.yml`, and the `release-cli` environment, which holds nothing.
Both the publish and the release jobs run in that environment.

To release a change, bump `version` in `packages/cli/package.json`.

## The desktop app

The Release Desktop workflow, `.github/workflows/release-desktop.yml`,
releases `Version` in `desktop/src/Repotted.Desktop/Repotted.Desktop.csproj`,
such as `0.1.0` as `desktop-v0.1.0`. It refuses the version when the
`desktop-v` tag exists, runs the gate, and builds the app on macOS for Apple
silicon and Intel and on Windows for x64:

- `Repotted-<version>-macos-arm64.dmg` and `Repotted-<version>-macos-x64.dmg`,
  signed with a Developer ID, notarized, and stapled.
- `Repotted-<version>-windows-x64-setup.exe`, an unsigned installer that
  installs for the current user. Windows SmartScreen warns about it until it
  is signed.

A dry run on `main` signs and notarizes the Mac builds too, so it shows that a
release would, then keeps the packages as run artifacts for 3 days.

A release then records a build provenance attestation for each package with
`actions/attest`, which [the user guide](../user/desktop.md#install) shows how
to verify. It attests the packages after signing, notarization, and stapling,
since each of those changes the file, so the attested digest is that of the
file the release offers. The attest job holds the workflow's only permission
to sign attestations, and it neither checks out the repository nor builds
anything, so that identity never shares a job with the build steps or the
Apple secrets. The release job runs only after the attestations succeed and
creates the `desktop-v` tag and a release titled Repotted and the version,
with the packages, `SHA256SUMS.txt` with their checksums, and notes generated
since the last `desktop-v` tag. It is set as the latest release.

Build provenance shows which workflow and commit built a file. It differs from
the release attestation that GitHub records when it publishes an immutable
release, which `gh release verify-asset` checks: that one shows a file belongs
to the release, `SHA256SUMS.txt` included, but a file uploaded by hand passes
it too.

Each build ships the CLI beside the app as `repotted-cli`, a Node single
executable, with its keychain module as `repotted-keyring.node`.
`mise run desktop:package` makes the same package on a Mac or in Git Bash on
Windows, in `artifacts/desktop`.

To build test installers from a branch, run Release Desktop on it with
**Dry run** selected. The run uses no Developer ID and notarizes nothing. It
checks that the packages build, that the CLI starts, and that the macOS app
launches, then keeps the packages as run artifacts for 3 days. The macOS app in
such a package is signed ad hoc and without the hardened runtime, since the
hardened runtime refuses to load ad hoc libraries, so only a run on `main`
builds the app under it, as notarization requires. Gatekeeper refuses the ad
hoc app until it is allowed in System Settings. Pull requests don't package the
app. Quality builds and tests it on each one, on Linux, macOS and Windows, and
builds and checks the compiled CLI on Linux, so run a dry run on the branch of
a pull request that changes the packaging or what `sea.ts` does on macOS or
Windows.

Signing runs only in the `release-desktop-macos` environment, which holds:

| Name                                    | Kind     | Value                                                                                                                                                                                |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEVELOPER_ID_APPLICATION_P12`          | Secret   | The Developer ID Application certificate from Certificates, Identifiers & Profiles on developer.apple.com, exported with its private key from Keychain Access as a `.p12`, in base64 |
| `DEVELOPER_ID_APPLICATION_P12_PASSWORD` | Secret   | The password set when exporting that `.p12`                                                                                                                                          |
| `APP_STORE_CONNECT_API_KEY_P8`          | Secret   | The `.p8` file of an App Store Connect API team key, from Users and Access > Integrations > App Store Connect API, in base64; Apple offers the download only once                    |
| `APPLE_TEAM_ID`                         | Variable | The Team ID in the Apple Developer account's membership details                                                                                                                      |
| `APP_STORE_CONNECT_API_KEY_ID`          | Variable | The Key ID shown beside that API key                                                                                                                                                 |
| `APP_STORE_CONNECT_API_ISSUER_ID`       | Variable | The Issuer ID shown above the team keys                                                                                                                                              |

Only the macOS package jobs request that environment, and only on `main`. A
run on `main` without these values fails rather than release an unsigned Mac
app. The release job, the only one that can write to the repository, runs in
the `release-desktop` environment, which holds nothing, so it never reaches
the Apple secrets.

To release the app, bump `Version` in the project file.

## Repository settings

The workflows rely on these settings, which the owner sets:

- **Who can release**: anyone with write access can run a workflow, so only
  the owner, as the repository's one writer, starts a release. The
  environments can also require the owner's approval for each job that runs
  in them.
- **Environments**: `release-cli`, `release-desktop-macos`, and
  `release-desktop`, each limited to the `main` branch, with the Apple values
  above in `release-desktop-macos` alone.
- **npm**: the `repotted` package's trusted publisher names this repository,
  `release-cli.yml`, and the `release-cli` environment, and its publishing
  access requires two-factor authentication and disallows tokens.
- **Rulesets**: no ruleset blocks creating `v*` or `desktop-v*` tags, since
  the workflow's token can't bypass one, and a tag ruleset blocks updating and
  deleting every tag, so a released version can't move.
- **Releases**: immutable releases lock a published release's tag and files.
  Each release is a draft until its files are attached, then published.

## When a run fails

Re-running a failed job retries the same commit. The release job finishes at
once when its tag already holds the release at that commit, and otherwise
deletes any draft an earlier attempt left for the tag, so each attempt creates
the release afresh at its own run's commit.
[State machines](state-machines.md#releases) lists each failure and what
re-running does.
