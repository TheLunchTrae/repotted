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
release build that made it. To check that a download came from a release
build, run this with the
[GitHub CLI](https://cli.github.com/), signed in to any GitHub account, with
the file's version in place of `<version>`:

```sh
gh attestation verify Repotted-<version>-macos-arm64.dmg \
  --repo TheLunchTrae/repotted \
  --signer-workflow TheLunchTrae/repotted/.github/workflows/release-desktop.yml \
  --source-ref refs/heads/main
```

The command fails unless a release build on `main` made that exact file.

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
compare it with a profile, or capture it as a new profile. Tick several
repositories, or <kbd>Shift</kbd>-click or <kbd>Ctrl</kbd>-click them
(<kbd>⌘</kbd>-click on macOS), to [apply a profile to all of
them](#apply-a-profile-to-several-repositories).

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
- **A repository**: Repotted reads the repository's settings, rulesets,
  environments, and labels as they are on GitHub now, and saves them as a
  profile.
  Capturing only reads from GitHub. The profile appears in the list, and in
  a GitHub repository that keeps your profiles, only once the capture
  finishes. A capture that fails or that you cancel leaves nothing behind.
  If the app quits during a capture, the folder can keep a file whose name
  starts with a dot and ends in `.repotted-capture`. It is safe to delete.

The app never overwrites a file that is already in the folder.

### Edit a profile

Open a profile to edit it. Its tabs follow the parts of a repository's setup:
repository settings, merge settings, Actions, security, GitHub Pages,
rulesets, environments, and labels. A setting's own options sit indented under it,
such as who can create pull requests under **Pull requests**. Names and
numbers, such as a branch or a pull request limit, are typed in a box. Until
what you type is valid, the app says what's wrong and won't save the profile;
**Undo** puts the box back. A box that goes with one choice of the setting
above it, such as **Runner label** with a **Runner type** of **Labeled**, is
off while another choice applies, and keeps its value. Leave a runner label
empty for no label.
Topics, custom properties, autolinks, and a few lists, such as the actions a
repository allows, are edited in the YAML.

Some options on GitHub's settings pages have no API, so no profile can set
them. Where one belongs to a setting, a note under that setting says so, such
as wiki's "Restrict editing to collaborators only" option under **Wiki**. Set
those on GitHub itself.

On the **Pages** tab, **Take the site down** deletes the Pages site on each
repository that follows the profile. A profile that takes the site down sets
nothing else for Pages, so choosing it takes out the profile's other Pages
settings, and setting any of them takes it out again.

A profile manages only what it names. A setting you leave unset keeps whatever
value each repository has. When a profile extends another, each setting shows
which profile it comes from, and setting it here overrides the base profile.
To stop setting a value in this profile, click **Remove** beside it; if a base
profile sets it, the base's value applies again. **Undo** reverts a change you
haven't saved, and **Discard** reverts them all. **Show YAML** shows the profile's
file as it is saved.

To find a setting, type in **Search settings** above the tabs, or press
<kbd>Ctrl</kbd>+<kbd>F</kbd>, or <kbd>⌘</kbd>+<kbd>F</kbd> on macOS. The search
looks across every settings tab at once and matches a setting's name, its
description and notes, the names of its choices, its profile key such as
`allow_squash_merge`, its tab and section, and common words for it such as
"CodeQL" or "DCO". Searching a setting also finds the options under it, and an
option that matches shows under its setting. Rulesets, environments, and
labels aren't searched. **Managed** shows only the settings this profile or a profile it
extends sets, **Not saved yet** shows only the settings you've changed and not
saved, drafts included, and **Drafts** shows only the settings with a draft.
Each works with or without a search. A setting you edit stays in the list until
you change the search or a filter. Escape clears the search, and **Clear**
clears the search and turns the filters off, which brings the tabs back.

Rulesets, environments, and labels open in their own editor. The editor
changes only what you edit, so anything it doesn't show stays as the YAML has
it. **Leave it to GitHub** clears a choice, so each repository keeps its own.
For each ruleset, environment, or label, choose **Manage it**, or
**Remove it from the repository** to delete it from each repository that
follows the profile. **Take out of profile** stops the profile from managing
it at all; **Put it back** undoes that before you save.

GitHub knows rulesets and environments by name. If you rename one, applying
the profile creates a new one with the new name and leaves the old one on the
repository. The app warns you when you rename one. You can rename only an
entry that this profile names on its own; one from a base profile keeps its
name.

The **Labels** tab shows each label on its own color, with its description.
In a label's editor, pick one of GitHub's colors or type six hex digits; an
empty color leaves each repository's own. An empty description clears each
repository's description, and **Leave each repository's own description**
leaves it alone. **Renamed from** lists old names, one per line: a repository
that has one of them and not the label has it renamed, so issues and pull
requests keep the label. When you rename a label, **Rename it on GitHub too**
adds its old name there; without it, applying creates the new label and
leaves the old one. The preview shows the label with dark or light text,
whichever reads on its color. See [Labels](profiles.md#labels) for what apply
does with renames.

Any setting, ruleset, environment or label can be saved as a draft, which keeps it
in the profile, finished or not, without applying it. Compare leaves drafts
out and names them, and so do `repotted plan` and `apply`. After you pick a
setting's new value, **Save as draft** keeps that value as a draft and puts
the setting back. The draft shows under the setting with a **Draft** badge:
**Finish draft** makes it the value, so it applies once you save, and
**Discard draft** takes it out, and a base profile's draft of the setting, if
it has one, shows again. A draft from a base profile shows too, but you finish
it in that profile. A ruleset, environment or label this profile sets has
**Save as a draft** in its editor, and a **Draft** badge in the list; for one a base
profile sets, the box is off, and you make the draft in that profile. Its
fields aren't checked while it's a draft; turn the box off to finish it, and
the editor then checks them. What each draft still needs shows under the
profile's heading. A draft can share its name with a ruleset, environment or
label that applies, which is how you draft a change to one: finishing the draft
replaces that one once you save. Drafting a ruleset that overrides a base
profile's leaves the base's applying until you finish it. See
[Drafts](profiles.md#drafts) for how drafts sit in the YAML.

Click **Save profile** to write your changes to the file. Saving writes each
edited ruleset, environment or label whole. So when you edited one and the file
changed since you opened it, such as in another editor or by a sync with
GitHub, the app doesn't save over that change. The same goes for a change to
the profile it extends when you edited a ruleset, environment or label that
comes from there. A banner asks what to do, when you save or as soon as a sync
brings the change in: **Keep mine** saves your version over the change, and
**Reload** shows the new version and discards your unsaved changes. Edits to
settings alone save over a change to the file, since only the settings you
changed are written.

If the file is removed while you have unsaved changes, such as by a sync with
GitHub, the profile stays in the list with the note **Removed, edits not
saved**. **Save profile** puts the file back with your changes, and
**Discard** lets the profile go. If the profile was renamed on GitHub, saving
brings it back under its old name, beside the renamed one.

**Close profile** above the profile's name closes it, as does
<kbd>Ctrl</kbd>+<kbd>W</kbd>, or <kbd>⌘</kbd>+<kbd>W</kbd> on macOS, and
leaves no profile open until you choose one from the list. If the profile has
unsaved changes, a banner asks first: **Save** saves them and closes it,
**Discard** drops them and closes it, and **Cancel** keeps it open with your
changes.

Unsaved changes stay with the app until you save or discard them. If you
click **Change folder**, **Use a GitHub repository**, **Change repository** or
**Sign out**, or quit, while a profile has unsaved changes, a banner on the
**Profiles** page asks first: **Save** saves them and goes on, **Discard**
drops them and goes on, and **Cancel** stays where you are. If a save fails,
the profile opens with the error and nothing else changes. While a new profile
is being captured, the profile that could not be saved stays closed, since
opening it would stop the capture. A note names it instead, and you can open it
once the capture finishes. The banner also asks before a sign-in that stopped
working takes you back to the sign-in page, since saving needs no sign-in.

## Compare a repository with a profile

On the **Repositories** page, select a repository, pick a profile under
**Compare with a profile**, and click **Compare**. The app shows each
difference by section, with what GitHub has now and what the profile sets.
**Differs from GitHub** is on at first, so only what differs shows; turn it
off to see the settings and entries that already match. To find something in a
long comparison, type in **Search this compare**, or press
<kbd>Ctrl</kbd>+<kbd>F</kbd>, or <kbd>⌘</kbd>+<kbd>F</kbd> on macOS. It matches a
setting the way the profile editor's search does, and a ruleset, environment,
or label by its name. Escape clears the search, and a section Repotted couldn't read
stays in view when you search for its name. Comparing only reads from GitHub.

A padlock marks each difference the app can't change, with what it needs,
such as **Needs Actions write**. The Repotted App's installation may not
have been granted that permission, or you may not be an admin on the
repository. **Review App access**, above the differences, opens the
installation's settings on GitHub, where its owner can grant what's missing,
or **Install the App** when it isn't installed on the repository.
**Can't change**, beside the search, shows only those differences.
Limits of the repository's GitHub plan or its owner's policies don't show
here; GitHub reports them only when a change is made.

To make those changes, click **Apply** on the comparison, or beside
**Compare** on the Repositories page.

## Apply changes to a repository

An apply is its own step: it shows what it would change, lets you adjust that,
and writes nothing to GitHub until you confirm.

To start one, select a repository on the **Repositories** page and either:

- pick a profile and click **Apply**, to make the repository match the profile
- click **Change settings once**, to change settings without a profile

The **Changes** tab shows each change by section, with what GitHub has now and
what it will have after the apply. From there you can:

- **Leave out** a change, for this apply only. The profile keeps it, and it
  shows under **Left out of this apply** with **Put back**.
- Make one-off edits on the **One-off edits** tab, in the same editor as a
  profile, and click **Save edits**. They apply on top of the profile for this
  apply only, and the changes are compared again. A change that comes from a
  one-off edit is marked **One-off edit**; change or undo it on that tab.
  One-off edits can't be drafts, since they are for this apply only.
- Click **Save edits to profile** to write the one-off edits into the profile,
  which then sets them itself.

Beside the one-off edits, **Diff** shows the whole apply as the profile's YAML:
each line GitHub loses is red and struck through, and each line it gets is
green, under what GitHub has now. Runs of unchanged lines fold away behind a
link that counts them, such as **Show 4 unchanged lines**. A line from a
one-off edit is marked **One-off edit**, a change GitHub will refuse has a
padlock under it, and a setting Repotted couldn't check says why. Left-out
changes and drafts are not in the diff; a note under it counts them. The diff
shows saved edits, so save to see the rest. **File** shows the file as saved.

A padlock marks each change GitHub will refuse, with what it needs, as on the
comparison. **Apply** waits until no such change is left: leave it out, or
click **Review App access**, grant what it needs, and click **Review again**.
Otherwise the apply would stop at that change and leave the ones after it
unwritten.

Click **Apply** and then **Apply now** to write the changes. Repotted checks
GitHub first: if the repository changed since you reviewed it, nothing is
written, and **Review again** shows what the apply needs now. If GitHub refuses
a change partway, the changes before it stay written and nothing after it is;
**Review again** shows what is left.

An apply you leave before it finishes is kept. The repository shows "An apply
here is not finished." with **Resume**, which offers to pick it up or start
over. **Discard apply** throws an apply away with its one-off edits; the
profile stays as it is. The app keeps unfinished applies in a `staged` folder
in its app data folder, below, and a batch in a `batch` folder beside it.

One-off edits you haven't saved keep the apply open. If you quit or sign out
then, the apply asks you to save or undo them first, and goes on once you do;
**Stay here** keeps them as they are. While Repotted is still working on the
apply, such as comparing or writing, closing the window or signing out says so
and leaves you on the apply; try again once it is done.

The command line does the same with [`repotted stage`](cli.md#stage-an-apply), if you prefer
it or want to script it.

## Apply a profile to several repositories

A batch apply applies one profile to several repositories, with each
repository's changes reviewed on its own first. Nothing is written to GitHub
until you confirm.

To start one, tick the repositories on the **Repositories** page, pick a
profile in the panel and click **Review apply**. A repository that already has
an apply in progress joins the batch as it is, one-off edits and all, and the
batch says so.

The list down the side starts with **All repositories**, which counts the
changes and lists each one the profile makes with how many repositories it
reaches. **Leave out everywhere** leaves a change out of every repository's
apply; the profile keeps it. What repositories leave out is listed under
**Left out**, with **Put back everywhere**. A repository whose one-off edits
set that change keeps them, and the batch says which.

Under it, each repository shows its status: how many changes, **Already in
line**, **Needs access** for a change GitHub will refuse, or **Couldn't
compare** with why. Select one to see its **Changes** and **One-off edits**
tabs, which work as they do in an apply to one repository, with **Previous**
and **Next** to go through them. Untick a repository to leave it out of the
batch; its staged apply stays, and ticking it puts it back. Any change plans
every repository again, and **Apply** waits while one-off edits are unsaved.

Click **Apply to N repositories** and then **Apply now** to write them, one
repository at a time. Repotted checks each on GitHub first, and writes nothing
to one that changed since you reviewed it. A repository with a change GitHub
will refuse waits, as do those you left out. **Stop after this repository**
finishes the one it writes to and leaves the rest.

Then the page lists the repositories that didn't finish first, with why, and
**Review again** plans them again, along with any you left out. Those that
finished, or needed nothing, have left the batch, and the batch ends with the
last of them. If you lose your sign-in partway, the apply stops there. A batch you leave
before it finishes is kept: the **Repositories** page shows "A batch apply is
not finished." with **Resume**, and starting an apply to one of its
repositories opens the batch. **Discard batch** throws it away; a staged apply
that joined it stays, to resume on its own. A batch Repotted can't read can
still be discarded or started over; any apply it started then stays on its own.

The command line does the same with
[`repotted stage --batch`](cli.md#apply-a-profile-to-several-repositories).

## Where the app keeps its settings

The app keeps its own settings, such as which profiles folder or repository you
chose, in `settings.json` in your user's app data folder:

- macOS: `~/Library/Application Support/Repotted`
- Windows: `%APPDATA%\Repotted`
