# The web app

The Repotted web app runs at <https://repotted.dev>. It needs nothing
installed: it runs in your browser and talks to GitHub from there.

The web app signs in, lists your repositories, and makes, captures, shows,
and deletes profiles. To edit a profile's settings, compare, and apply, use
the [desktop app](desktop.md) or the [command line](cli.md).

Use Repotted in one tab at a time. A second tab says that Repotted is open
in another one, so that two tabs can't save over each other's profiles;
close the first and click **Reload**.

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

Click a repository to open its panel. **Open on GitHub** opens it there, and
**Capture as a new profile** starts [a profile](#make-a-profile) that
describes it. Click the repository again to close the panel.

## Profiles

A profile is a YAML file that describes how a repository should be set up.
The **Profiles** page lists your profiles down the side, under where they are
kept. Type in **Find a profile** to narrow the list. Folders show with the
number of profiles in each; click a folder to close or open it. A profile
Repotted can't use is marked **Problem**, and opening it says why.

Click a profile to open it. The page says what owns the repositories it is
for and which profile it extends. **Show YAML** shows the profile's file as
it is saved; it starts hidden.

### Make a profile

Click **New profile** above the list, name it, and choose what it starts
from:

- **Nothing**: an empty profile, which manages nothing until you set
  something.
- **Another profile**: the new profile extends the one you pick, so it gets
  every setting the other one sets.
- **A repository**: Repotted reads the repository's settings, rulesets,
  environments, and labels as they are on GitHub now, and saves them as a
  profile. Capturing only reads from GitHub. The profile appears only once
  the capture finishes; one that fails, or whose form you leave, makes
  nothing. If the capture had to leave something out, the new profile's page
  lists what.

When there are folders, **Folder** chooses where the profile goes. Under
**For repositories owned by**, choose **Personal accounts**,
**Organizations**, or **Any owner**. A profile that extends one with a type
has that type, and a captured profile has the repository's owner type.
[Owner type](profiles.md#owner-type) describes what each type takes.

Repotted never replaces a profile that is already there, whatever the case of
its name.

### Delete a profile

Open the profile and click **Delete profile**. Repotted asks first, naming
the file. If other profiles extend it, directly or through another profile,
the question names them: they stop loading until you point them at another
profile, but nothing stops you. A profile in the browser can't be brought
back. When your profiles are kept on GitHub, the deletion is a commit, so the
repository's history keeps the file as it was at the last sync.

### Keep profiles on GitHub

Profiles are kept in your browser at first, where only that browser has
them, and clearing the site's data deletes them. To have them follow you to
any browser, keep them in a GitHub repository instead. In
[Settings](#settings), click **Use a GitHub repository…**, name the
repository, and optionally a folder in it. An empty repository works: tick
the box that adds the profiles from this browser to start it with them. The Repotted
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
you come back. Profiles belong to the browser, so anyone who signs in to
Repotted on it sees them; on a shared computer, use a private window or keep
none there. **Use this browser** in Settings goes back to profiles kept in
the browser alone; the repository keeps every profile it has.

## Settings

**Settings**, at the top right and in the account menu, holds what applies to
the whole app in this browser.

**Account** shows who you're signed in as, with **Add repositories** and
**Sign out**. **Profiles** shows where your profiles are kept and how the
last sync went, with **Sync now** (or **Refresh** for profiles in the
browser), and the buttons that move them to a GitHub repository or back to
the browser.
