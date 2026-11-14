# The web app

The Repotted web app runs at <https://repotted.dev>. It needs nothing
installed: it runs in your browser and talks to GitHub from there.

The web app signs in, lists your repositories, and makes, captures, edits,
and deletes profiles. It compares a repository with a profile and applies
the changes you review, to one repository or several. The
[command line](cli.md) does the same from a terminal or a script.

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
says so and offers **Show all**. Repotted remembers which owners you hid,
and an owner that's new to the list shows.

To set aside a repository you no longer use, open its panel and click
**Hide from list**, or tick several and click **Hide from list** in the
panel for the ticked repositories. Hiding unticks them, and **Undo** in the
note above the list brings them back. **Show hidden**, beside the count,
shows the hidden repositories among the rest, marked **Hidden**; open one
and click **Show in list** to bring it back for good. If a search matches
only hidden repositories, or every repository is hidden, the list says so
and offers **Show hidden**.

To keep repositories together, put them in folders. Click **New folder**
beside the count, name it, and leave the box that puts the ticked
repositories in it ticked to fill it at once. To move repositories later,
tick them, pick a folder under **Move to a folder** in the panel and click
**Move**, or open one repository and pick its **Folder**. A repository is in
one folder at most, and **No folder** takes it out. Folders show above the owners, in name order;
click a folder's name to close or open it, and use its **Edit** menu to
rename or delete it. Deleting a folder puts its repositories back under their
owners, and nothing changes on GitHub. A search looks in folders too, and a
folder whose name matches shows everything in it.

When your profiles are kept in a GitHub repository, the owners and
repositories you hid, and your folders, are kept there too, in
`.repotted-preferences.json` beside the profiles, so they follow you to any
browser you sign in on. Each change is committed straight to the repository,
and **Refresh** picks up changes made in another browser. When your profiles
are kept in this browser or a folder on this computer, this browser remembers
them instead. Choices made in one place don't move to the other. Which
folders are closed is always remembered by this browser alone, so opening or
closing one commits nothing.

Click a repository to open its panel. **Open on GitHub** opens it there, and
**Capture as a new profile** starts [a profile](#make-a-profile) that
describes it. Click the repository again to close the panel.

### Compare a repository with a profile

Select a repository, pick a profile under **Compare with a profile**, and
click **Compare**. The page shows each difference by section, with what
GitHub has now and what the profile sets. What needs no change is folded
away, and the page says how much does: turn off **Differs from GitHub** to
see each such setting and entry under the differences, marked **No change**.
Nearly always that is a setting GitHub already has as the profile sets it.
It can also be one that doesn't apply with the options chosen, such as a
runner for a code scanning setup that is not configured. What the comparison
couldn't read or left out is listed apart, and is in neither group. The
profile's draft is left out too, and the page names it. To find something in
a long comparison, type in **Search this comparison**. Comparing only reads
from GitHub. It compares the profile as saved, so save your changes to
the profile first. **Compare again** reads both again, such as after you
save the profile or change the repository.

Each difference Repotted can't change says what it needs, such as **Needs
Actions write**. The Repotted App's installation may not have been granted
that permission, or you may not be an admin on the repository. **Review App
access** opens the installation's settings on GitHub, where its owner can
grant what's missing, or **Install the App** when it isn't installed on the
repository. **Can't change**, beside the search, shows only those
differences. Limits of the repository's GitHub plan or its owner's policies
don't show here; GitHub reports them only when a change is made.

A profile for organizations can't compare with a repository that a personal
account owns, nor a personal profile with an organization's repository. The
page says so, and to use the profile's settings there, copy the profile and
change the copy's type.

### Apply changes to a repository

An apply is its own step: it shows what it would change, lets you adjust
that, and writes nothing to GitHub until you confirm.

To start one, select a repository and either:

- pick a profile and click **Apply**, to make the repository match the
  profile
- click **Change settings once**, to change settings without a profile

An apply has two steps, and opens on the first.

The first step shows the one-off edits, in the same editor as a profile.
They apply on top of the profile for this apply only, and can't be drafts.
From there you can:

- Click **Review changes** to go on. Edits you haven't saved are saved to the
  apply first, never to the profile, so the review shows what the edits say.
  It waits while an edit isn't valid.
- Click **Save edits to profile** to write the one-off edits into the
  profile, which then sets them itself.
- Click **Discard apply** to throw the apply away. The profile stays as it
  is.

What the apply leaves out is listed above the edits with **Put back**, since
a change can't be both left out and edited.

The second step shows each change by section, with what GitHub has now and
what it will have after the apply. From there you can:

- **Leave out** a change, for this apply only. The profile keeps it, and it
  shows under **Left out of this apply** with **Put back**.
- Click **Back to edits** to change the edits again. A change that comes from
  a one-off edit is marked **One-off edit**; change or undo it there.
- Click **Review again** to read the profile and GitHub again.

A change GitHub would refuse says what it needs, as on a comparison.
**Apply** waits until no such change is left: leave it out, or click
**Review App access**, grant what it needs, and click **Review again**.
Otherwise the apply would stop at that change and leave the ones after it
unwritten.

Click **Apply** and then **Apply now** to write the changes. Repotted checks
GitHub first: if the repository changed since you reviewed it, nothing is
written, and the page shows what the apply needs now. If GitHub refuses a
change partway, the changes before it stay written and nothing after it is,
and the page shows what is left.

An apply you leave before it finishes is kept in this browser, with the
edits that could be saved. The repository's panel says **An apply here is
not finished** with **Resume**. Starting another apply there offers to pick
the unfinished one up or start over.

### Apply a profile to several repositories

A batch apply applies one profile to several repositories, with each
repository's changes reviewed on its own first. Nothing is written to GitHub
until you confirm.

To start one, tick the repositories on the **Repositories** page, pick a
profile in the panel, and click **Review apply**. Ticks stay while you
search, so you can find repositories one search at a time. A repository that
already has an apply in progress joins the batch as it is, one-off edits and
all. When that apply starts from another profile, or from none, the batch
page says so on that repository. One batch is in progress at a time: while a
batch is unfinished, **Review apply** waits until you resume it and apply or
discard it.

The page starts with **All repositories**, which lists each change that can
be left out with how many repositories it reaches. **Leave out
everywhere** leaves a change out of every repository's apply; the profile
keeps it, and **Put back everywhere** undoes it. A repository whose one-off
edits set that change keeps them, and the page says which.

Under it, each repository shows its status: how many changes, **Already in
line**, **Needs access** for a change GitHub would refuse, or **Couldn't
compare** with why, and then its changes, each with **Leave out**. Untick
**In this batch** to leave a repository out; its apply stays, and ticking it
puts it back. **Remove from batch**, on a repository that is left out or
couldn't be compared, takes it out for good: an apply the batch started for
it is discarded, and one that joined the batch stays.

Click **Apply to N repositories** and then **Apply now** to write them, one
repository at a time. Repotted checks each on GitHub first, and writes
nothing to one that changed since you reviewed it. A repository with a
change GitHub would refuse waits, as do those you left out.

Then the page lists the repositories that didn't finish first, with why, and
**Review again** plans them again. Those that finished, or needed nothing,
have left the batch, and the batch ends with the last of them. A batch you
leave before it finishes is kept in this browser: the **Repositories** page
says **A batch apply is not finished** with **Resume**. **Discard batch**
throws it away; an apply that joined it stays, to resume on its own.

To change one repository's one-off edits, open its own apply from the
**Repositories** page.

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

### Edit a profile

Open a profile to edit it. Its tabs follow the parts of a repository's
setup: **Repository**, **Merge**, **Actions**, **Security**, **Pages**,
**Rulesets**, **Environments**, and **Labels**. A
setting's own options sit indented under it. Names and numbers are typed in a
box; until what you type is valid, the page says what's wrong and won't save,
and **Reset** beside the setting puts it back.

Under the profile's name, the page says who it is for: personal accounts,
organizations, or any owner. A profile for personal accounts hides the
settings and choices only organizations have, and says how many. A profile
for any owner shows them all and marks each one that only organizations, or
only organizations on GitHub Enterprise Cloud, have; a profile for
organizations marks the Enterprise Cloud ones. **Change** beside it
picks another [owner type](profiles.md#owner-type). Before anything is
written, it lists what the profile sets that the new type doesn't have, since
changing the type stops the profile managing those. It waits until you have
saved or reset your changes. When the type comes from a base profile, change
it in that profile.

**Find a setting** above the tabs searches every settings tab at once. Type
part of a setting's name, its key in a profile such as `allow_squash_merge`,
or a word people know it by, such as "dco" for sign-off. **Managed** shows
only the settings that have a value once you save, from the profile or a
base profile, **Not saved yet** only those with a change you haven't saved,
and **Drafts**, on a profile with a draft, only those in it. The settings
found show in place of the tabs, each under its tab's and group's name, and
stay while you edit them, until you save or search again. **Show every
setting** goes back to the tabs. Rulesets, environments, and labels are not
searched; they stay on their own tabs.

A profile manages only what it names. A setting that says **Not managed**
keeps whatever value each repository has. When a profile extends another,
each setting says which profile it comes from, and setting it here overrides
the base profile. To stop setting a value in this profile, click **Remove**
beside it; if a base profile sets it, the base's value applies again.

Options that GitHub only offers with a certain value of the setting above
them follow that setting. Where GitHub hides them, the tab does too, and the
setting above says how many hidden ones the profile still names. Where GitHub
greys them out, they stay in place and are off. Either way the profile keeps
their values.

On the **Actions** tab, with **Allowed actions** set to **Selected**,
**Allowed action patterns** takes one pattern a line, such as `octo-org/*`,
and a pattern that starts with `!` blocks what it matches. Under the box,
each pattern has what it matches on GitHub beside it, a moment after you stop
typing: the repository, with the folder and the tag, branch, or commit the
pattern names, or the owner for a pattern such as `octo-org/*`. A line is
marked when the repository has no such tag or branch, has no such folder, or
isn't one you can see, which is how a misspelled name shows. A pattern with a
wildcard in the owner can't be checked. The line under them counts how they
came out. The checks only inform: a profile saves and applies with any
pattern GitHub accepts. When GitHub can't be reached, or its limit is
reached, the line says so. **Check again** asks GitHub about every line
again, such as after you make the repository or push the tag.

**Find an action on GitHub**, under the patterns, searches GitHub for
repositories by name or description, a moment after you stop typing or when
you press Enter. Each one found says how many stars it has and whether it has
an action file at its top. **Add** puts `owner/name@*` on a new line of the
list, which allows every action in that repository at any version; edit the
line to narrow it. Escape puts the results away.

On the **Pages** tab, **Take the site down** deletes the Pages site on each
repository that follows the profile. Choosing it takes out the profile's
other Pages settings, and setting any of them takes it out again.

The bar under the settings saves them. **Save** writes your changes to the
profile. When profiles are kept on GitHub, it first brings in what changed
there and then commits yours; only the settings you changed are written, so
a change made elsewhere to another setting stays. If the changes can't make a valid profile, such as one with every
merge method off, the bar says why and **Save** waits. **Reset** in the bar
puts the whole profile back as it was saved.

**Save as draft** keeps your changes in the profile without applying them:
a [draft](profiles.md#drafts) is saved, and synced when profiles are kept on
GitHub, but plans leave it out. A draft can be unfinished, so **Save as
draft** needs only that each new ruleset, environment, or label has a name
of its own. A profile with a draft says so above its tabs, with how many
changes the draft holds and what stops any of them from applying. The
profile opens on its draft: each setting, ruleset, environment, and label in
it is marked **Draft**, and a setting says what applies now.

**Save** applies the whole draft together with your unsaved changes, so it
waits until the draft is valid. **Preview** shows what saving would change
first: the profile as it applies now against the profile as it would apply,
with a minus beside each line that goes and a plus beside each that comes in. You can save from there. The preview closes if the profile changes under it, as when a sync brings in a change. To take one change out of a draft, set it
back to what applies and save either way. **Discard draft** takes the whole
draft out and leaves what applies; it asks first, and waits until you have
saved or reset any other changes.

Changes you haven't saved stay while you look at another profile, which is
marked **Not saved** in the list. Moving your profiles to another place waits
until you save or reset them, and the browser asks before a reload or a
closed tab discards them. Deleting a profile discards its unsaved changes,
and so does a sync that finds the profile deleted or renamed on GitHub.

**Rulesets**, **Environments**, and **Labels** each list what the profile
names, with **New ruleset**, **New environment**, or **New label**. Click
one to open it. Its form changes only what you edit, so anything it doesn't
show, such as the merge methods a pull request rule allows or a rule the form
has no box for, stays as the profile's file has it. Bypass actors and
required reviewers can be kept as the file has them or cleared. **Leave it to GitHub** clears a choice, so each
repository keeps its own. Choose **Manage it**, or **Remove it from the
repository** to delete it from each repository that follows the profile.
Removing keeps what the entry had, in case you choose **Manage it** again
before saving. **Take out of profile** stops the profile from managing it at
all; **Put it back** in the list undoes that before you save.

A ruleset with no rule ticked leaves each repository's rules as they are.
Once any rule is ticked, the ruleset has exactly the ticked rules, and
applying removes every other rule it has on a repository; the form says
which holds. **Leave its rules to GitHub** goes back to leaving them alone.

An environment that deploys from **Chosen branches and tags** takes
**Branch patterns** and **Tag patterns**, one a line.

A ruleset, environment, or label is saved whole. If it changed elsewhere
since you edited it, such as in a sync with GitHub, the page says so and
doesn't save over that change: **Keep mine** saves your version over it, and
**Reset** shows the new one.

GitHub knows rulesets and environments by name. If you rename one, applying
the profile creates a new one with the new name and leaves the old one on the
repository, and the form says so. You can rename only an entry that this
profile names on its own; one from a base profile keeps its name, and
changing it here overrides the base profile's.

In a label's form, pick one of GitHub's colors or type six hex digits; an
empty color leaves each repository's own. An empty description clears each
repository's description, and **Leave each repository's own description**
leaves it alone. **Renamed from** lists old names, one per line: a repository
that has one of them and not the label has it renamed, so issues and pull
requests keep the label. When you rename a label, **Rename it on GitHub too**
adds its old name there. See [Labels](profiles.md#labels) for what apply does
with renames.

Topics, custom properties, and autolinks are not edited here yet.

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

### Keep profiles in a folder on this computer

In Chrome, Edge, and other Chromium browsers, profiles can be files in a
folder on your computer, where other tools, such as the `repotted` command
or Git, can read and change them. In [Settings](#settings), click **Choose a
folder…** and pick the folder; tick the box first to add the profiles kept
now beside the folder's own. Pick a folder that holds only profiles: Repotted
reads every `.yaml` and `.yml` file in it and its subfolders as a profile.
Other browsers can't give a site a folder, and Settings says so in place of
the button.

Repotted syncs with the folder when it opens, when you click **Sync**, and
each time you save, make, or delete a profile. A profile changed in the
folder shows up in Repotted, and one changed in both since the last sync
asks which version to keep: **Keep mine** or **Use the folder's**. Only
profile files sync, those ending in `.yaml` or `.yml`; Repotted leaves
hidden files and folders and every other file alone.

A profile whose name differs only in case from a file in the folder, such
as `team.yaml` beside `Team.yaml`, is never written there, since some
computers take the two names for one file. It shows as changed in both
places until you click **Use the folder's**, which removes yours.

The browser may ask again on a later visit before a site uses a folder.
Until you click **Allow access** and agree, Repotted shows the profiles as
they were at the last sync and changes nothing in the folder. What you save
meanwhile stays in the browser and goes to the folder at the next sync. If
you choose the folder again, or another one, those changes go with you: a
profile that differs from the folder's asks which version to keep.

**Use this browser** in Settings goes back to profiles kept in the browser
alone; the folder keeps every profile it has. It waits, as does moving to a
GitHub repository, while the folder lacks changes made here.

## Settings

**Settings**, at the top right and in the account menu, holds what applies to
the whole app in this browser.

**Account** shows who you're signed in as, with **Add repositories** and
**Sign out**. When a profile has unsaved changes, **Sign out** asks first: **Save and
sign out**, **Discard and sign out**, or **Stay signed in**, since signing
out discards changes that aren't saved. A profile with a draft, or with a
value that isn't valid, is saved from its own page, so the question stays
and says so. If the changes are saved but a sync didn't finish, it asks once
more before signing out. While an apply to one repository or
several is writing to GitHub, **Sign out** does nothing but say so; press it
again once the apply has finished. **Profiles** shows where your profiles are kept and how the
last sync went, with **Sync now** (or **Refresh** for profiles in the
browser), and the buttons that move them to a GitHub repository or back to
the browser.
