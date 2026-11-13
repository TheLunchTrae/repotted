# The web app

The Repotted web app runs at <https://repotted.dev>. It needs nothing
installed: it runs in your browser and talks to GitHub from there.

The web app signs in, lists your repositories, and shows your profiles. To
write profiles, compare, and apply, use the [desktop app](desktop.md) or the
[command line](cli.md).

## Sign in

Click **Sign in with GitHub** and approve the Repotted App on GitHub. The
sign-in lasts in that browser until you sign out, and each browser signs in
on its own. If GitHub stops accepting the sign-in while the app is open, the
app returns to this page and says so.

To sign out, click your account at the top right and choose **Sign out**.
[Sign in](sign-in.md#give-the-app-your-repositories) says how to choose the
repositories the Repotted App reaches.

## Repositories

The **Repositories** page lists the repositories that the Repotted App is
installed on and that you administer. To add repositories to the list, click
**Add repositories**, which opens the Repotted App's install page on GitHub,
then **Refresh**.

To find a repository, type in **Find a repository**, or press <kbd>/</kbd> to
go to it. Escape clears it.

The list is grouped by owner: your own repositories first, then each
organization, or other account, in name order. When there's more than one
owner, the button beside the count, **All owners** until you change it,
chooses whose repositories show. Untick an owner to hide its repositories, or
click **Only personal** or **Show all**. If every owner is hidden, the list
says so and offers **Show all**. The browser remembers which owners you hid,
and an owner that's new to the list shows.

Click a repository to open its panel, where **Open on GitHub** opens it
there. Click it again to close the panel.

## Profiles

A profile is a YAML file that describes how a repository should be set up.
The **Profiles** page lists your profiles down the side, under where they are
kept. Type in **Find a profile** to narrow the list. Folders show with the
number of profiles in each; click a folder to close or open it. A profile
Repotted can't use is marked **Problem**, and opening it says why.

Click a profile to open it. The page says what owns the repositories it is
for and which profile it extends. **Show YAML** shows the profile's file as
it is saved; it starts hidden.

### Keep profiles on GitHub

Profiles are kept in your browser at first, where only that browser has
them, and clearing the site's data deletes them. To have them follow you to
any browser, keep them in a GitHub repository instead. In
[Settings](#settings), click **Use a GitHub repository…**, name the
repository, and optionally a folder in it. An empty repository works: tick
**Add the profiles from this browser** to start it with them. The Repotted
App must be installed on the repository with the Contents permission.

From then on, **Sync now** in Settings, or **Sync** above the profile list,
brings in changes made elsewhere and commits yours to the repository's
default branch. If a profile changed both in the browser and on GitHub since
the last sync, a banner asks which version to keep: **Keep mine** commits
yours, and **Use GitHub's** takes the repository's. If a sync fails, a banner
on the **Profiles** page says why, and Settings says so too. A ruleset that
requires pull requests on that branch, for example, refuses the commit unless
you or the Repotted App can bypass it.

The browser keeps a copy of the repository's profiles, so they are there when
you come back. **Use this browser** in Settings goes back to profiles kept in
the browser alone; the repository keeps every profile it has.

## Settings

**Settings**, at the top right and in the account menu, holds what applies to
the whole app in this browser.

**Account** shows who you're signed in as, with **Add repositories** and
**Sign out**. **Profiles** shows where your profiles are kept and how the
last sync went, with **Sync now** (or **Refresh** for profiles in the
browser), and the buttons that move them to a GitHub repository or back to
the browser.
