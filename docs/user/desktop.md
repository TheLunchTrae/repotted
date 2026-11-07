# The desktop app

The Repotted desktop app lets you write profiles and compare them with your
repositories without the command line. It runs on macOS and Windows.

## Install

Download the app from the
[repository's releases](https://github.com/TheLunchTrae/repotted/releases).
Desktop releases are named `desktop-v` and a version, such as
`desktop-v0.1.0`.

- **macOS**: download `Repotted-<version>-macos-arm64.dmg` for a Mac with
  Apple silicon, or `Repotted-<version>-macos-x64.dmg` for an Intel Mac. Open
  the DMG and drag Repotted to Applications.
- **Windows**: download `Repotted-<version>-windows-x64-setup.exe` and run it.
  It installs Repotted for your user account only. The installer is not
  signed yet, so Windows SmartScreen warns about it: click **More info**,
  then **Run anyway**.

`SHA256SUMS.txt` in the same release lists each file's checksum, so you can
check a download.

The app includes its own copy of the Repotted CLI, so you don't need Node or
npm to use it.

## Sign in

The first time the app opens, click **Sign in with GitHub** and enter the code
it shows on GitHub. [Sign in](sign-in.md) explains the steps, the permissions
the Repotted App asks for, and how to use a token instead.

## Repositories

The **Repositories** page lists the repositories that the Repotted App is
installed on and that you administer. With a token instead of the App, it
lists every repository your account administers. Press <kbd>Ctrl</kbd>+<kbd>K</kbd>, or
<kbd>⌘</kbd>+<kbd>K</kbd> on macOS, to search them from anywhere in the app.
To add repositories to the list, click **Add repositories**, which opens the
Repotted App's install page on GitHub.

Select a repository to open its panel. From there you can open it on GitHub,
compare it with a profile, or capture it as a new profile.

## Profiles

A profile is a YAML file that describes how a repository should be set up. The
app keeps your profiles in a folder: `Documents/Repotted` at first, which the
app creates. To use another folder, such as a clone of a repository where you
keep your profiles, click **Change folder** on the **Profiles** page.

### Make a profile

Click **New profile** and choose what it starts from:

- **Nothing**: an empty profile, which manages nothing until you set
  something.
- **Another profile**: the new profile extends the one you pick, so it gets
  every setting the other one sets, and you change only what differs.
- **A repository**: Repotted reads the repository's settings, rulesets, and
  environments as they are on GitHub now, and saves them as a profile.
  Capturing only reads from GitHub.

The app never overwrites a file that is already in the folder.

### Edit a profile

Open a profile to edit it. Its tabs follow the parts of a repository's setup:
repository settings, merge settings, Actions, rulesets, and environments.

A profile manages only what it names. A setting you leave unset keeps whatever
value each repository has. To stop managing a setting, click
**Leave it to GitHub**. When a profile extends another, each setting shows
which profile it comes from, and setting it here overrides the base profile.

Rulesets and environments open in their own editor. The editor changes only
what you edit, so anything it doesn't show stays as the YAML has it. For each
ruleset or environment, choose **Manage it**, or
**Remove it from the repository** to delete it from each repository that
follows the profile. **Take out of profile** stops the profile from managing
it at all; **Put it back** undoes that before you save.

GitHub knows rulesets and environments by name. If you rename one, applying
the profile creates a new one with the new name and leaves the old one on the
repository. The app warns you when you rename one.

Click **Save profile** to write your changes to the file. Saving writes each
edited ruleset or environment whole, so if you edited the same entry in the
YAML file in another editor since you opened it in the app, the app's version
replaces yours.

## Compare a repository with a profile

On the **Repositories** page, select a repository, pick a profile under
**Compare with a profile**, and click **Compare**. The app shows each
difference by section, with what GitHub has now and what the profile sets.
Settings that already match are folded away; click **Show everything** to see
them. Comparing only reads from GitHub.

The app doesn't apply profiles yet. To make the changes a comparison shows, use
[`repotted plan` and `repotted apply`](cli.md#plan-and-apply) on the command
line.

## Where the app keeps its settings

The app keeps its own settings, such as which profiles folder you chose, in
`settings.json` in your user's app data folder:

- macOS: `~/Library/Application Support/Repotted`
- Windows: `%APPDATA%\Repotted`
