# The desktop app

The Repotted desktop app lets you write profiles and compare them with your
repositories without the command line. It runs on macOS and Windows.

Each platform shows labels in its own style. On macOS, buttons (segmented
choices included), tabs, and page titles capitalize each main word, as Mac
apps do, so **Keep mine** reads Keep Mine there. This guide quotes labels as
Windows shows them.

## Install

Download the app from the
[repository's releases](https://github.com/TheLunchTrae/repotted/releases).
Desktop releases are titled Repotted and a version, such as Repotted 0.1.0.

- **macOS**: download `Repotted-<version>-macos-arm64.dmg` for a Mac with
  Apple silicon, or `Repotted-<version>-macos-x64.dmg` for an Intel Mac. Open
  the DMG and drag Repotted to Applications.
- **Windows**: download `Repotted-<version>-windows-x64-setup.exe` and run it.
  It installs Repotted for your user account only. The installer is unsigned,
  so Windows SmartScreen warns about it: click **More info**, then
  **Run anyway**.

`SHA256SUMS.txt` in the same release lists each file's checksum, so you can
check a download.

Each package in a release also has an attestation, a signed record of the
release build that made it. To check that a download came from the release
build for its version, run this with the
[GitHub CLI](https://cli.github.com/), signed in to any GitHub account, with
the file's version in place of both `<version>`s:

```sh
gh attestation verify Repotted-<version>-macos-arm64.dmg \
  --repo TheLunchTrae/repotted \
  --signer-workflow TheLunchTrae/repotted/.github/workflows/desktop.yml \
  --source-ref refs/tags/desktop-v<version>
```

The command fails unless the release build for that version made that exact
file.

The app includes its own copy of the Repotted CLI, so you don't need Node or
npm to use it.

## Sign in

The first time the app opens, click **Sign in with GitHub** and enter the code
it shows on GitHub. If the sign-in stops working while the app is open, the app
returns to this page. To sign out, click **Sign out** under your account in the
sidebar. If the GitHub CLI is also signed in on your computer, signing out
keeps you in the app, signed in with the GitHub CLI's token.
[Sign in](sign-in.md) explains the steps, the permissions the Repotted App asks
for, and how to use a token instead.

## Repositories

The **Repositories** page lists the repositories that the Repotted App is
installed on and that you administer. With a token instead of the App, it
lists every repository your account administers. Press <kbd>Ctrl</kbd>+<kbd>K</kbd>, or
<kbd>⌘</kbd>+<kbd>K</kbd> on macOS, to search the list on the current page.
To add repositories to the list, click **Add repositories**, which opens the
Repotted App's install page on GitHub.

Select a repository to open its panel. From there you can open it on GitHub,
compare it with a profile, or capture it as a new profile.

## Profiles

A profile is a YAML file that describes how a repository should be set up. The
app keeps your profiles in a folder: `Documents/Repotted` at first, which the
app creates. To use another folder, such as a clone of a repository where you
keep your profiles, click **Change folder** on the **Profiles** page.

### Keep profiles on GitHub

To have your profiles follow you to any computer, keep them in a GitHub
repository instead. Click **Use a GitHub repository** on the **Profiles** page,
name the repository, and optionally a folder in it. An empty repository works:
tick **Add the profiles from** your current folder to start it with them. The
Repotted App must be installed on the repository with the Contents permission.

From then on, each save is a commit to the repository's default branch, and
**Sync now** brings in changes made elsewhere. If a profile changed both in
the app and on GitHub since the last sync, a banner asks which version to keep:
**Keep mine** commits yours, and **Use GitHub's** takes the repository's. If a
sync fails, the app says why under the list and keeps your saves until a sync
works. A ruleset that requires pull requests on that branch, for example,
refuses the commit unless you or the Repotted App can bypass it.

The app keeps its copy of the repository's profiles in its app data folder.
**Change folder** goes back to a local folder; the repository keeps every
profile it has.

### Make a profile

Click **New profile** and choose what it starts from:

- **Nothing**: an empty profile, which manages nothing until you set
  something.
- **Another profile**: the new profile extends the one you pick, so it gets
  every setting the other one sets, and you change only what differs.
- **A repository**: Repotted reads the repository's settings, rulesets, and
  environments as they are on GitHub now, and saves them as a profile.
  Capturing only reads from GitHub. The profile appears in the list, and in
  a GitHub repository that keeps your profiles, only once the capture
  finishes. A capture that fails or that you cancel leaves nothing behind.

The app never overwrites a file that is already in the folder.

### Edit a profile

Open a profile to edit it. Its tabs follow the parts of a repository's setup:
repository settings, merge settings, Actions, rulesets, and environments.

A profile manages only what it names. A setting you leave unset keeps whatever
value each repository has. When a profile extends another, each setting shows
which profile it comes from, and setting it here overrides the base profile.
To stop setting a value in this profile, click **Remove** beside it; if a base
profile sets it, the base's value applies again. **Undo** reverts a change you
haven't saved, and **Discard** reverts them all. **Show YAML** shows the profile's
file as it is saved.

Rulesets and environments open in their own editor. The editor changes only
what you edit, so anything it doesn't show stays as the YAML has it.
**Leave it to GitHub** clears a choice, so each repository keeps its own. For
each ruleset or environment, choose **Manage it**, or
**Remove it from the repository** to delete it from each repository that
follows the profile. **Take out of profile** stops the profile from managing
it at all; **Put it back** undoes that before you save.

GitHub knows rulesets and environments by name. If you rename one, applying
the profile creates a new one with the new name and leaves the old one on the
repository. The app warns you when you rename one. You can rename only an
entry that this profile names on its own; one from a base profile keeps its
name.

Click **Save profile** to write your changes to the file. Saving writes each
edited ruleset or environment whole. So when you edited one and the file
changed since you opened it, such as in another editor or by a sync with
GitHub, the app doesn't save over that change. The same goes for a change to
the profile it extends when you edited a ruleset or environment that comes
from there. A banner asks what to do, when you save or as soon as a sync
brings the change in: **Keep mine** saves your version over the change, and
**Reload** shows the new version and discards your unsaved changes. Edits to
settings alone save over a change to the file, since only the settings you
changed are written.

If the file is removed while you have unsaved changes, such as by a sync with
GitHub, the profile stays in the list with the note **Removed, edits not
saved**. **Save profile** puts the file back with your changes, and
**Discard** lets the profile go. If the profile was renamed on GitHub, saving
brings it back under its old name, beside the renamed one.

Unsaved changes stay with the app until you save or discard them. If you
click **Change folder**, **Use a GitHub repository**, **Change repository** or
**Sign out**, or quit, while a profile has unsaved changes, a banner on the
**Profiles** page asks first: **Save** saves them and goes on, **Discard**
drops them and goes on, and **Cancel** stays where you are. If a save fails,
the profile opens with the error and nothing else changes. The banner also asks
before a sign-in that stopped working takes you back to the sign-in page, since
saving needs no sign-in.

## Compare a repository with a profile

On the **Repositories** page, select a repository, pick a profile under
**Compare with a profile**, and click **Compare**. The app shows each
difference by section, with what GitHub has now and what the profile sets.
Settings that already match are folded away; click **Show everything** to see
them. Comparing only reads from GitHub.

The app doesn't apply profiles. To make the changes a comparison shows, use
[`repotted plan` and `repotted apply`](cli.md#plan-and-apply) on the command
line.

## Where the app keeps its settings

The app keeps its own settings, such as which profiles folder or repository you
chose, in `settings.json` in your user's app data folder:

- macOS: `~/Library/Application Support/Repotted`
- Windows: `%APPDATA%\Repotted`
