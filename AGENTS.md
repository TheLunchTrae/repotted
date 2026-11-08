# Agent Guide

Read `CONTEXT.md` first if it exists. Then read the docs that own the change
before changing architecture or domain language.

## Project

Repotted captures, plans, and applies GitHub repository setups: repository
settings, merge methods, Actions policy, rulesets, and environments. `README.md` stays
minimal; put context that agents need in this file. Docs live in `docs/`, in
two sets for two readers:

- `docs/user/`: how to install and use the desktop app, the CLI, and the MCP
  server, the profile format, and the JSON output scripts read. No
  implementation detail: no source paths, internal names, or design rationale.
- `docs/developer/`: how Repotted works and why: the architecture and design
  decisions, local setup, the GitHub App, and releasing.

When a change affects both, update the user page for what changes for users
and the developer page for how and why.

- [CONTEXT.md](CONTEXT.md): the domain vocabulary.
- [docs/user/README.md](docs/user/README.md): the user guide's index.
- [docs/developer/README.md](docs/developer/README.md): the developer guide's
  index and the repository layout.
- [docs/developer/architecture.md](docs/developer/architecture.md): how
  profiles, plans, apply, the CLI, the MCP server, and the desktop app work.

`packages/core` is the engine: the profile schema, one adapter per section,
and the plan engine. `packages/cli` is the published `repotted` package: the
CLI and the MCP server over that engine.

### Safety

- Apply writes only what a reviewed plan lists. It plans again and refuses
  when the result differs; it never executes requests read from a saved plan.
  Keep that property when you change the plan format or the engine.
- A profile manages only what it names. Settings, rulesets, and environments
  it leaves out stay as they are; a ruleset or environment is deleted only by
  an `absent: true` entry.
- Tests use the in-memory GitHub in `packages/core/tests/fake-github.ts`.
  Never run `apply` against a real repository, and never change a real
  repository's settings, rulesets, or branch protection, without the owner's
  explicit yes for that repository and that plan.
- Do not publish to npm, push a release tag, or publish a release without the
  owner's explicit yes.

## Commands

`mise run` is the entry point for project workflows; tasks wrap the toolchain.
Run `mise tasks` and read the definitions of the tasks you use. Extend an
existing task before you add one.

- `mise install` installs the pinned tools. When an install needs network, run
  it and report that.
- `mise run standards` applies the available autofixes.
- `mise run standards:check` is the CI gate; run it before handoff. Every
  workflow runs it through `.github/actions/gate`, so change the gate's setup
  there and its environment in the mise config, not in a workflow.

Run `git`, `rg`, `tokei`, and standalone scripts directly. Use native commands
for focused diagnosis and the mise gate for final verification. Use
`mise exec -- <command>` only when a command needs a pinned tool or environment
and no task covers it.

## Leave It Current

The repository holds current contracts: the code, the tests that defend it, and
the docs that explain it. Git holds history. Unless the project has released
users or a documented external contract, it makes no compatibility promise: no
shims, aliases, deprecations, dual code paths, format migrations, or
version-numbered names.

- Supersede rather than accumulate. Rename in place, replace a format, and
  delete the old reader with its fixtures and tests in the same change.
- A change that makes something obsolete removes it: functions and exports
  nothing calls, config keys nothing reads, tests of retired behavior, and docs
  that describe it. Finishing a feature includes removing the scaffolding that
  built it.
- Shipped code has no test-only branches, alternate rules, or test-only
  diagnostic surfaces. Narrow test-build instrumentation and fault injection,
  such as `#[cfg(test)]` code, are fine when they leave production semantics
  unchanged, and so is a seam that production also uses, such as a seed or an
  event log that feeds replays.
- Proof lives in the gate. Back each lasting claim with a test in
  `standards:check` or a task that checks a stated target. A one-off
  diagnostic leaves with the question it answered, and its result goes in the
  commit message. Do not build evidence scaffolding, such as bundles,
  manifests, or checks that repeat a guarantee the gate or toolchain already
  gives. Keep focused tests for the scripts and measurements the workflow
  relies on.
- Prefer native toolchain guarantees, remove duplicate checks, and measure the
  gate's routine cost before you add verification.
- Keep task notes in `.scratch/` and run output in `artifacts/`. Both stay
  untracked and never become a second policy source. Do not commit briefs,
  plans, handoffs, research, reports, or dated audits.
- `mise run hygiene` enforces the mechanical part and prints the tree's size by
  category, so growth shows in every handoff. Explain growth that the change
  does not account for.

## Principles

- Complexity is the enemy; see [grugbrain.dev](https://grugbrain.dev/). Prefer
  boring, obvious code with local state, explicit side effects, and direct
  data flow. Add structure after the shape is visible: small duplication beats
  premature indirection. Keep ecosystem-idiomatic strictness where it prevents
  concrete failures. Judge each tool, rule, test, abstraction, service, and doc
  by the uncertainty, defects, or manual work it removes, including its runtime
  and maintenance cost, and remove ceremony that cannot justify that cost.
- Build deep modules with small interfaces. Change a feature's behavior,
  state, and tests together, and put tests where the ecosystem expects them.
  Split a module that holds more than one cohesive responsibility. Fold
  shallow wrappers and forwarding helpers into their callers. Import through
  the owning module's intended interface, and delete re-exports that only
  preserve obsolete paths.
- Respect Chesterton fences. Understand why code exists before deleting or
  replacing it; once it serves no current contract, delete it.
- Name things for what they do in the domain, in `CONTEXT.md` vocabulary.
- Comments explain a current invariant, a non-obvious algorithm, a trust
  boundary, or a public interface. Delete prose that retells an old
  implementation or narrates what names and types already say.
- Write good-enough idiomatic code that is easy to reason about, and optimize
  only what a measurement shows matters. Measure before a choice that is
  expensive to reverse.

## Editing

- Repair the cause of a failure; a retry does not turn an unexplained
  divergence into a pass.
- Suppress a lint only on the smallest item, with a stated reason. If the
  language supports it, use a suppression that fails when it becomes
  unnecessary.
- Paths that `.gitignore` ignores are generated or local. When generated output
  is wrong or stale, fix its source or task and regenerate.

## Documentation

- Docs explain current behavior and design constraints. Update the owning page
  when the contract changes. State each policy once and link to it elsewhere.
- Executable config is the source of truth; docs point at it rather than
  restate it.
- Quote a desktop app label in bold, as written in the app, which is how
  Windows shows it.
- Keep the workflows, contracts, and current state discoverable from local
  files, so a fresh agent can find them.
- Write in the present tense. Do not date text or narrate history, as in "now
  uses", "no longer", "previously", or "the new parser".
- `docs/` holds current pages and their images. Record owner decisions on one
  current page and replace a decision when it changes.
- Follow the
  [Google developer documentation style guide](https://developers.google.com/style)
  for docs and commit prose.

## Testing

- A test earns its place by defending behavior, an invariant, a failure mode,
  or a trust boundary that types and the gate do not already enforce. Do not
  test trivial getters, constructors, enum declarations, framework behavior,
  config values copied onto objects, or incidental numbers.
- A meaningful assertion fails for a concrete production defect and stays
  valid through behavior-preserving refactors. Show that a new or changed
  assertion can fail: for a bug, reproduce it with a failing regression test
  before the fix when practical; otherwise inject a fault for its claim.
  Mechanical moves need no new evidence.
- Prefer one focused test at the narrowest stable interface over duplicated
  examples. Keep test setup smaller than the behavior it protects.
- Test counts and coverage percentages are not goals.

## State machines

[State machines](docs/developer/state-machines.md) lists the flows whose state
no type names, in the engine, the CLI, the desktop app, and releases: sign-in,
sync, the profile editor and its cache, captures, and the rest. Each flow has
a table of its states, the events they meet, and what comes next. Implicit
state includes flags, nullable fields, caches, files on disk, and the order of
asynchronous work.

- When a change adds, removes, or changes a state or a transition, update the
  owning table in the same change. A new flow gets its own section.
- Test each transition, failure transitions included, at the narrowest stable
  interface, such as a view model over `FakeCli`. A transition that needs
  overlapping work, such as a save queued behind a sync or a command pressed
  while a load runs, needs a test that holds that work open.
- A known defect, a failure that leaves the user worse off than where they
  started, keeps its **Failure:** note and the link to its issue. A change
  that fixes one starts with a failing test, removes the note, and updates the
  table.

## TypeScript, Node, and pnpm

`package.json`, `pnpm-lock.yaml`, and the mise tasks own the tested versions
and commands. mise pins Node and pnpm; pnpm installs the workspace, Vitest runs
the tests, and esbuild builds the CLI. The published package runs under Node
through `npx`, so shipped code uses only `node:` APIs, and `ts:node:check` runs
the built CLI under the oldest supported Node. The desktop app ships the CLI as
a Node single executable that `packages/cli/sea.ts` builds.

Select checks for the change:

| Change                  | First checks                                     |
| ----------------------- | ------------------------------------------------ |
| Source or tests         | `ts:lint`, `ts:type`, `ts:test`                  |
| CLI, build, or runtime  | `ts:build`, `ts:node:check`, `ts:sea:check`      |
| Dependencies or exports | `ts:audit`, `ts:knip`                            |
| Formatting              | `ts:fmt:check`; `ts:standards` applies autofixes |

`ts:sea:check` builds the single executable, on Linux in CI, and checks its
startup snapshot, so the gate catches a CLI or core change that breaks it. A
change to the desktop packaging, or to what `sea.ts` does on macOS or Windows,
such as signing or picking the keychain module, also needs a manual Build
Desktop run, since only its macOS and Windows runners package the app.

Before handoff, run `mise run standards:check`. Run `mise run ts:lock` after
changing declared dependencies and commit `pnpm-lock.yaml`.
`pnpm-workspace.yaml` pins new dependencies exactly, holds back versions younger
than three days, and allows no dependency install scripts; an exception goes in
`minimumReleaseAgeExclude` or `allowBuilds` and needs the owner's approval.

Source uses `.ts`, with `.js` extensions on relative imports. Use named
exports and keep module bindings immutable. Tests live in each package's
`tests/` and use Vitest, imported from `vitest`.

### Exceptions

- Lint exceptions use `// eslint-disable-next-line <rule> -- <reason>`. Type
  exceptions use `// @ts-expect-error -- <reason>`.
  `scripts/check-directives.mjs` enforces the forms, and Oxlint rejects stale
  exceptions. A reason names the invariant and why restructuring loses.
- Review changes to `.oxlintrc.json`, `tsconfig.json`, the scripts, and the
  mise tasks for lost coverage, and justify every relaxation.
- A behavior change needs a test that fails without it.

## C# and the desktop app

`desktop/` is the desktop app: C# on .NET 10 with Avalonia. The `csharp:*`
mise tasks run from there, and `csharp:standards:check` is part of
`standards:check`. mise pins the exact SDK, so the analyzers and
`dotnet format` match CI; `desktop/global.json` only sets the floor for
builds outside mise.

- `Directory.Build.props` holds the compiler and analyzer contract: warnings
  are errors under `AnalysisMode=Recommended`, with code style enforced in the
  build. Fix the cause of a diagnostic; an exception is a per-site
  `[SuppressMessage]` with a real `Justification`.
- Package versions live in `Directory.Packages.props`. Run
  `mise run csharp:lock` after changing them and commit the lock files; CI
  restores in locked mode.
- The app does no GitHub work itself: it runs the CLI with `--json`.
  `csharp:test` runs the contract test against the CLI's source, so a change
  to the documents it covers fails there; see
  [the architecture](docs/developer/architecture.md#the-desktop-app).
- Keep asynchronous work owned and cancellable, and avoid `async void`. A CLI
  run must not outlive what started it.
- View tests draw pages headlessly in light and dark. Set
  `REPOTTED_SCREENSHOTS` to a folder to save them for review.
- Write all text the app shows or reads aloud in sentence case: capitalize
  the first word and proper names, and nothing else. That covers buttons,
  links, menu items, tabs, segmented options, window and page titles,
  headings, field labels, placeholders, tooltips, accessible names, and
  messages: "Keep mine" and "Back to rulesets", not "Keep Mine".
  - The proper names are product and brand names: Repotted, Repotted App,
    GitHub, GitHub App, macOS, and Windows, plus GitHub's own names for its
    features and permissions, such as Actions and Contents. Acronyms,
    identifiers, and key names keep their own form, such as YAML, SHA,
    `GITHUB_TOKEN`, and Ctrl.
  - App concepts stay lowercase, however central they are: repository,
    profile, ruleset, environment, and the other terms in `CONTEXT.md`.
    Write "New profile" and "New ruleset", not "New Profile". This is
    deliberate, so that no one has to judge which nouns are important
    enough.
  - A word inserted into a label stays lowercase unless it is a proper name.
    Text that names another control uses that control's label as written,
    as in "Reload discards your unsaved changes."
- Each platform shows labels in its own casing. `Theme/ControlLabel.cs`
  turns a label into Apple's title style on macOS, as in "Sign In with
  GitHub", and leaves it as written on Windows. It applies to buttons,
  segmented options, tabs, and page titles, and a button's accessible name
  follows its shown label unless the view sets one. Everything else stays
  in sentence case on both.
  - A button's or toggle button's string content gets it from
    `ControlLabel.ApplyToButtons`, which the app calls at startup. Show a
    name or other data inside a button in a `TextBlock`, so it keeps its own
    casing. Don't set a `ContentTemplate` on every button in a style: any
    template shows a button's control content as its type name.
  - A tab's or page title's `TextBlock` needs it written in: bind with
    `Converter={x:Static theme:ControlLabel.Converter}`, or use
    `{theme:Label 'New profile'}` for a fixed title.
  - View tests compare a label through `ControlLabel.For`, so they pass on
    both platforms. CI runs them on Linux, so run them on a Mac after
    changing how labels are cased.

## Git

- Keep generated and local-only files out of commits.
- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/#specification)
  for all git commit messages.
- Write commit messages for future maintainers. Use
  [Tim Pope's note](https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html)
  and [Chris Beams' guide](https://cbea.ms/git-commit/) as the Git-specific
  references.
- Keep the Conventional Commit subject concise. Write its description in the
  imperative mood, use the repository's lowercase style, and omit ending
  punctuation. Aim for 50 characters and do not exceed 72 characters.
- Add a body only when it provides useful context. Separate it from the subject
  with a blank line, wrap it at 72 characters, and explain the problem, the
  reason for the change, and material consequences. Let the diff explain the
  implementation.
- Use short, direct sentences, active voice, and consistent terminology. Avoid
  idioms, filler, vague wording, and unnecessary jargon.
- One writer owns one worktree, and reviewers stay read-only. Serialize
  lockfiles, shared configuration, formatters, and integration. Give each
  worktree its own build directory.

## Handoff

- Get an independent read-only agent review of the actual diff for
  non-trivial behavior and architecture changes. The author does not approve
  their own change. Verify material findings before acting on them.
- Report the checked revision, behavior proved, commands run and their
  results, skipped checks and why, remaining findings, and tree growth the
  change does not explain. Write it so the human can judge the outcome without
  reconstructing the implementation.
- Bots advise, gates block, and humans merge.
