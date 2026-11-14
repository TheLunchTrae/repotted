# Releasing

The repository releases the CLI on npm, with `v` tags. The web app is not
released but deployed; see [The web app](web-app.md).

The owner runs the Release CLI workflow from the Actions tab with **Run
workflow** on `main` and **Publish** selected, and that run does the whole
release: it checks, builds, attests, publishes, creates the tag, and
publishes the GitHub release with its files. No other event starts the
workflow, and nothing else creates its tags.

The workflow takes the version from a file on `main`, which a pull request
bumps before the release. A release refuses a version whose tag already
exists.

It takes one input, **Publish**, which is not selected by default. Only a
run on `main` with Publish selected is the official release; one with it
selected on another branch fails before it builds anything. A run without it
is a test build: it does everything a release does up to the release itself,
and attests, publishes, tags, and releases nothing. It reports what a release
would refuse as warnings and goes on, so on another branch it builds a test
package. A test build makes no attestation, so it leaves no record that could
pass for a release's.

Only the job that creates the release can write to the repository; every
other job can at most read it. The tag and release are created with the
workflow's own token, so they show as made by github-actions.

## The CLI

The Release CLI workflow, `.github/workflows/release-cli.yml`, releases the
version in `packages/cli/package.json`, such as `0.3.0` as `v0.3.0`. It
refuses the version when the `v` tag exists or npm already has it. Then it
runs the gate on that commit, as Quality does but without Quality's caches,
and packs `packages/cli` with `pnpm pack`, which builds the bundle and
replaces the `workspace:` range. A test build stops there.

A release then records a build provenance attestation for the tarball with
[`actions/attest`](https://github.com/actions/attest), publishes it to npm
with trusted publishing and provenance, and only after npm accepts it creates
the `v` tag and a release with the tarball and `SHA256SUMS.txt`, with notes
generated since the last `v` tag.

The publish job skips the upload when npm already has this exact tarball, as
after an attempt that timed out once npm had it, so re-running it goes on to
the release. The release job attaches the tarball that npm serves rather than
the run's artifact, so it can be re-run after that artifact expires.

npm accepts the publish only from a trusted publisher: this repository,
`release-cli.yml`, and the `release-cli` environment, which holds nothing.
Both the publish and the release jobs run in that environment.

To release a change, bump `version` in `packages/cli/package.json`.

## Repository settings

The workflow relies on these settings, which the owner sets:

- **Who can release**: anyone with write access can run a workflow, so only
  the owner, as the repository's one writer, starts a release. The
  environment can also require the owner's approval for each job that runs
  in it.
- **Environments**: `release-cli`, limited to the `main` branch.
- **npm**: the `repotted` package's trusted publisher names this repository,
  `release-cli.yml`, and the `release-cli` environment, and its publishing
  access requires two-factor authentication and disallows tokens.
- **Rulesets**: no ruleset blocks creating `v*` tags, since
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
