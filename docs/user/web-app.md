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

Successful saves, moves, connections, and explicit refreshes show a brief
confirmation. It closes after five seconds; hovering it or focusing its
**Dismiss** button pauses the countdown. Errors, sync conflicts, capture
omissions, and apply results stay with the action that produced them.
Batch actions show one confirmation for the whole action. A successful batch
apply confirms once every included repository and its profile records have
finished, with the number of repositories applied to.

The links to the app's pages, at the top or in the menu, open each page at
its top: **Profiles** opens the list rather than the profile you last had
open, and **Repositories** opens with no repository open. That includes the
link to the page you're on. Leaving a page asks first, with **Stay** and
**Leave**, when leaving would lose work: an apply or a batch with one-off
edits, a capture still reading from GitHub, or a new profile with something
entered. The browser's back and forward buttons ask too. Queued applies never
ask, since they carry on wherever you go.

When a search finds no matches, **Clear search** restores results and returns
the keyboard to the search field. Repository filters remain as chosen;
**Clear filters** changes those separately. Empty profile lists offer
**New profile**, and hidden repository lists offer their relevant show action.

While a page or lookup reads from GitHub, a spinner names the work under way.
An initial repository or profile list uses placeholder rows until the read
finishes. Refreshing keeps the current results visible. A batch apply shows
how many repositories have finished.

Buttons that wait for work keep their label and show a spinner beside it.
They keep their width and keyboard focus while waiting, block another
submission, and become available again when their other requirements allow
it. Refresh cooldowns remain separate from an active request.

## On a phone

In a window 760 pixels wide or less, such as a phone's, the app lays itself
out for the narrow screen:

- The header is one row: **Repotted**, then your avatar with a menu icon.
  That menu holds **Repositories**, **Profiles**, **Actions policies**,
  **Rulesets**, **Environments**, and **Settings**, then your
  account, **Add repositories** and **Sign out**.
- A repository's details open as a screen of their own; **Repositories**, at
  its top, or the browser's back returns to the list.
- With repositories selected, their panel follows the list rather than
  sitting beside it.
- With profiles selected, their panel follows the list rather than sitting
  beside it.
- A page's bar of actions, as when applying changes or editing a profile,
  keeps its main action in view and puts the rest under **More**.

## Sign in

Click **Sign in with GitHub** and approve the Repotted App on GitHub. The
sign-in lasts in that browser until you sign out, and each browser signs in
on its own. If GitHub stops accepting the sign-in while the app is open, the
app returns to this page and says so. If the sign-in can't be checked, the
page says what failed, such as Repotted's sign-in service, GitHub's rate
limit, or GitHub itself, and **Try again** checks again. If the sign-in
itself fails, the page says what came back from GitHub where it can, or that
Cloudflare couldn't connect to GitHub.

To sign out, click your account at the top right, or the menu on a phone,
and choose **Sign out**.
[Sign in](sign-in.md#give-the-app-your-repositories) says how to choose the
repositories the Repotted App reaches.

## Repositories

The **Repositories** page lists the repositories that the Repotted App is
installed on and that you administer. To add repositories to the list, click
**Add repositories**, which opens the Repotted App's install page on GitHub,
then **Refresh**.

When the Repotted App's installation on an account or organization hasn't
been given every permission the App asks for, the page names that owner and
the missing permissions. **Review on GitHub** opens the installation's
settings, where an owner of that account accepts them; then click
**Refresh**. Until then, Repotted can't read or change what needs them on
that owner's repositories, and turns those settings off when you edit an
apply. An owner you hide shows no such notice.

After a refresh, **Refresh** waits 15 seconds before it can read the list
again, and counts down on the button while it waits, so that pressing it
repeatedly doesn't use up your GitHub requests. When GitHub answers with its
rate limit, the button waits until GitHub says the next request can go
through, or a minute when GitHub doesn't say.

To find a repository, type in **Find a repository**, or press <kbd>/</kbd> to
go to it. Escape clears it.

The list is grouped by owner: your own repositories first, then each
organization, or other account, in name order. When there's more than one
owner, the button beside the count, **All owners** until you change it,
chooses whose repositories show. Deselect an owner to hide its repositories, or
click **Only personal** or **Show all**. If every owner is hidden, the list
says so and offers **Show all**. Repotted remembers which owners you hid,
and an owner that's new to the list shows.

To set aside a repository you no longer use, open its panel and click
**Hide from list**, or select several and click **Hide from list** in the
panel for the selected repositories. Hiding deselects them, and **Undo** in the
note above the list brings them back. **Show hidden**, beside the count,
shows the hidden repositories among the rest, marked **Hidden**; open one
and click **Show in list** to bring it back for good. If a search matches
only hidden repositories, or every repository is hidden, the list says so
and offers **Show hidden**.

The **Sort** button, beside **Filter** and named for the order in use,
orders the repositories in each folder and under each owner by **Name, A to
Z**, **Name, Z to A**, **Last pushed, newest first** or **Last pushed, oldest
first**. The owners keep their order. Sorting by last push shows when each
repository was last pushed to, under its name, and a repository GitHub gives
no push time for goes last either way.

**Filter**, after the count and the owners button, narrows the list to
**Public** or **Private** repositories, to those that are **Archived** or
**Not archived**, and to those with any of the topics you select. Each
choice adds a chip under the search box; click a chip to remove that filter,
or click **Clear filters**, in the menu or beside the chips. The button
counts how many filters are on. Filters and a search work together, and a
repository has to pass both to show. While a filter is on, the count counts
only the repositories that pass, folders with nothing in them don't show,
and if nothing passes the list says so and offers **Clear filters**. A panel
you had open closes while its repository is filtered out, and the selection
stays as it was.

To keep repositories together, put them in folders. Click **New folder**
beside the count, name it, and leave the box that puts the selected
repositories in it checked to fill it at once. To move repositories later,
select them, choose a folder under **Move to a folder** in the panel and
click **Move**, or open one repository and pick its **Folder**. Selected
repositories are deselected once they are in the folder; a repository's own
**Folder** leaves the selection as it is. Each open folder with repositories
in it has **Select all** beside its name, which turns into **Deselect all**
once everything in it is selected, and **Deselect all**, beside **New
folder** and in the panel, clears the whole selection. A repository is in
one folder at most, and **No folder** takes it out. Folders show above the
owners, in name order; click a folder's name to close or open it, and use
its **Edit** menu to rename or delete it. Deleting a folder puts its
repositories back under their owners, and nothing changes on GitHub. A
search looks in folders too, and a folder whose name matches shows
everything in it.

Choose **Profiles** in a folder's **Edit** menu to give it profiles in the
order they apply. Each repository in the folder starts with those profiles,
then its own; later profiles override earlier ones, and a profile reached
more than once counts once. Its panel marks the inherited profiles
**From folder**. Change them in the folder's **Profiles** dialog; **Edit** in the
repository's **Profiles** section changes only its own profiles. Folders are
flat, and a repository inherits every profile of its folder.

A folder's header shows its profiles as short tags, in the order they apply.
Click the tags to edit that list. Click **+** beside them to pick a profile
and add it immediately, without opening the dialog. This saves the folder's
list and applies nothing to its repositories. **Manage profiles…** in the
picker opens the same dialog to reorder or remove profiles.
Desktop shows up to three tags; a longer list shows a count.

On a phone, the tags and **+** sit on the right of the folder's name, on
the same row. When the tags don't fit, one badge gives the count, such as
**4 profiles**; tap it to open the full ordered list. More space shows the
tags again. Long folder names shorten with an ellipsis. **⋯** holds the
folder's **Edit** actions and **Select all in folder**, which becomes
**Deselect all in folder** when all its shown repositories are selected.
When the layout changes while you are using a folder menu, it closes and
returns keyboard focus to its button.
The selection button also returns focus there when it moves into the phone menu.

**Save** keeps the folder's profile list and settings without applying them.
**Save and apply** saves the settings, then opens a review for every
repository already in the folder, including those hidden by the list's
search or filters. With no unsaved changes, **Apply** opens the same review
using the saved profiles. One repository opens a single review; several
open one batch review, with each repository's own profiles after the
folder's. Neither apply action changes GitHub until you review and apply.
An empty folder or one with no profiles can still be saved, but its apply
actions are unavailable. A failed save keeps the dialog open for a retry
and opens no review.

**Apply profiles to repositories moved here** is off by default. With it on
and profiles chosen for the folder, moving a repository into it opens a
review of its folder and own profiles. Moving several opens one batch
review, with each repository's own profiles after the folder's. Nothing is
written until you review and apply. A repository already in that folder is
not reviewed again by the move.

Moving out or deleting a folder removes its inherited profiles from future
applies; it does not undo settings on GitHub. A move read from another
browser updates the repository's profile status without opening a review
here. Missing profiles or a failed comparison are reported in the review;
the repository stays in its chosen folder. If another apply is writing, a
notice asks you to review the moved repositories from their panels after
that apply finishes.

When your profiles are kept in a GitHub repository, the owners and
repositories you hid, and your folders, are kept there too, in
`.repotted-preferences.json` beside the profiles, so they follow you to any
browser you sign in on. Each change is committed straight to the repository,
with a message that says what changed, such as `Hide repository: octo/app`,
`Move repositories to folder Work: octo/app, octo/api` or
`Apply profile base to repositories: octo/app, octo/api`, and **Refresh**
picks up changes made in another browser. When your profiles are kept in
this browser or a folder on this computer, this browser remembers them
instead. Choices made in one place don't move to the other. Which
folders are closed, the sort order and the filters are always remembered by
this browser alone, so changing them commits nothing.

Click a repository to open its panel. **Open on GitHub** opens it there, and
**Capture as a new profile** starts [a profile](#make-a-profile) that
describes it. Click the repository again to close the panel.

### Compare a repository with a profile

Open a repository, pick a profile under **Compare with a profile**, and
click **Compare**. The page shows each difference by section, with what
GitHub has now and what the profile sets. What needs no change is folded
away, and the page says how much does: turn off **Differs from GitHub** to
see each such setting and entry under the differences, marked **No change**.
Nearly always that is a setting GitHub already has as the profile sets it.
It can also be one that doesn't apply with the options chosen, such as a
runner for a code scanning setup that is not configured. What the comparison
couldn't read or left out is listed apart, and is in neither group. The
profile's draft is left out too, and the page names it. Both lists name each
setting as the profile editor labels it. To find something in
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

To start one, open a repository and either:

- pick a profile and click **Apply**, to make the repository match the
  profile
- click **Change settings once**, to change settings without a profile

An apply has two steps, and opens on the first.

The first step shows the one-off edits, in the same editor as a profile.
They apply on top of the profile for this apply only, and can't be drafts.
From there you can:

- Click **Review changes** to review the current one-off edits without
  changing the profile. It waits while an edit isn't valid.
- Click **Save edits to profile** to write the one-off edits into the
  profile, which then sets them itself. An apply of the
  [built-in protection](#protect-the-config-repository) has no profile to
  save to, so it doesn't offer this.
- Click **Discard apply** to throw the apply away. The profile stays as it
  is.

What the apply leaves out is listed above the edits with **Put back**, since
a change can't be both left out and edited.

Settings that need a permission the Repotted App's installation hasn't been
given are turned off, with a note that names it and **Review on GitHub**.
A permission every setting on a tab needs is named once at the top of the
tab, one every setting in a group needs under the group's heading, and any
other on the setting itself. A list of rulesets, environments or labels that
needs one can't take a new entry, and its entries open read-only, though
**Put it back**, **Reset** and **Take out of profile** still work. The
editor opens before Repotted has read the installation, so they turn off a
moment later.

The second step shows each change by section, with what GitHub has now and
what it will have after the apply. From there you can:

- **Leave out** a change, for this apply only. The profile keeps it, and it
  shows under **Left out of this apply** with **Put back**.
- Click **Back to edits** to change the edits again. A change that comes from
  a one-off edit is marked **One-off edit**; change or undo it there.
- Click **Edit** beside a review note that names a setting or an entry to go
  back to the edits at it, as **Go to it** does. A setting that another
  setting hides goes to the one that hides it.

- Click **Review again** to read the profile and GitHub again.

A setting the profile sets that the apply skips, because another setting
turns it off on GitHub, shows greyed out in its section with the value it
would have had and why it isn't applied. It sits under the setting that turns
it off when the apply changes that one, and last in its section otherwise,
as when the repository's own value turns it off. Click its **Edit** to go
back to the edits at it.

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

Once you click **Apply now**, the apply is [queued](#queued-applies): it
goes on if you leave the page, and carries on if the tab closes.

An in-progress apply lasts only while this flow is open. Leaving the page
or reloading discards its one-off edits and exclusions; starting again
opens a fresh apply. Profile changes you explicitly saved to the profile
stay saved. Writes already under way finish even if you leave the page.

### Queued applies

**Apply now** adds each repository to a queue, which writes to one
repository at a time. The apply's page shows how far it is. Once everything is
written, it returns you to the repositories, or to Settings for an apply
started there, with a confirmation. If
something wasn't written, the page stays and says why.

You can keep working while the queue runs. On any other page, a card in the
header shows how far the queue is, as in **Applying 2 of 5**. Click the card
to see each repository and what it waits for. You can also start another
apply: it joins the end of the queue, and its page says how many earlier
applies it waits for. The earlier ones carry on, and the card or a
confirmation says how they end.

The queue is kept in this browser. If the tab closes or reloads partway,
open Repotted again and it carries on from where it stopped. Repotted checks
each repository on GitHub first, as it does for any apply, and writes only
the changes you reviewed that are still needed. If a repository needs
anything else by then, nothing more is written to it.

When more than an hour has passed since you clicked **Apply now**, Repotted
writes nothing by itself. The header shows **Continue with N changes**
instead, or **N waiting** on a phone: click it to see the repositories and
when you queued them, and then **Continue** to write them or **Discard** to
drop them and leave the repositories as they are.

A repository that couldn't be finished after a reload stays in the card,
with why, and the card turns red. **Open repository** goes to it, where you
can review an apply again. **Try again** writes what is left of a change
GitHub refused or couldn't be reached for, and **Dismiss** removes the entry
and leaves the repository as it is. Applying to the repository again
replaces the entry.

Signing out discards the queue. If GitHub stops accepting your sign-in
while the queue runs, what is left waits, and the header offers to continue
once you sign in again. The card then says that the sign-in stopped the
queue.

### Keep a repository's profiles

A repository can keep a list of the profiles it uses, applied in order, with
later profiles overriding earlier ones. Each one shows as a short tag on the
repository's row. With more than three, or two on a phone, the row says how
many, such as **5 profiles**, and lists them when you hover over it; on a
phone, tap the repository to see them in its panel.

When you apply a profile the repository doesn't use, the review has a
selected box to add it to the repository's profiles when it applies.
Deselect it for a one-time apply, which leaves no record on the repository.
A batch apply of one profile has the same box, for every repository in the
batch that doesn't use the profile yet.
An apply that leaves a change out, has one-off edits, or skips a setting
GitHub refused to show doesn't count as
applying the profiles, so the repository still shows them as not applied or
changed.

The repository's panel lists its profiles under **Profiles**. Click
**Edit** to reorder them, remove one or add one, then **Save**. Saving
changes only the list: nothing is applied until you review an apply. Click
**Review apply** to apply them all together, in their order.

Repotted remembers which version of each profile was last applied. When a
profile changes, or one is added, removed or moved, the row says
**Profile changed** and the panel says what changed, with **Review apply**.
When a review finds nothing to write, click **Record as applied** to mark the
current versions as applied. When the profiles of repositories in your list changed, the top
of the list says how many, with **Review apply to N repositories** to review
them all together: one review for one repository, one batch for more. Hidden
repositories aren't counted. A profile that was deleted or can't be read
shows as **Missing profile**; remove it or put it back before applying.

In **Edit**, choose **Full section ownership** to keep ownership for this
repository. It applies to the complete combination of folder profiles,
repository profiles, and reusable definitions. Folders supply profiles but
never ownership defaults. Two repositories using the same profiles can own
different sections. An owned empty section deliberately removes every
repository-owned entry in that section; leaving ownership off preserves
unlisted entries. You can own Actions policies, rulesets, environments, and
labels, and each choice says what it deletes. Autolinks can be owned only from
the [CLI](cli.md#choose-full-section-ownership), because the web app doesn't
edit them; the web app ignores autolink ownership saved for a repository and
leaves its autolinks alone. See [Full section ownership](profiles.md#full-section-ownership)
for what ownership keeps and removes.

**Review apply** starts with the saved ownership, and batch reviews use each
repository's own choices. Changes made in the apply's ownership controls are
for that apply only. Use **Edit**, then **Save** on the repository to keep a
choice. Saving, disabling ownership, or removing an assignment writes no
repository settings. Disabling ownership stops future enforcement; it does
not restore resources deleted by an earlier apply.

A changed ownership choice appears as **Assignment changed**. Source status
records the configuration last applied, including referenced definitions;
it does not claim that GitHub is still in line. Review again to compare live
state: unexpected resources appear as removals even when no source changed.
An assignment changed during review or revalidation cannot apply the old
review. Review a single repository again, or start a fresh batch review.
Missing sources and refused reads block full ownership rather than imply
an empty section.

The list and ownership choices are kept with your hidden repositories and
folders, so they follow your profiles to their GitHub repository.

### Apply a profile to several repositories

A batch apply applies one profile to several repositories, with each
repository's changes reviewed on its own first. Nothing is written to GitHub
until you confirm.

To start one, select the repositories on the **Repositories** page, pick a
profile in the panel, and click **Review apply**. The selection stays while you
search, so you can find repositories one search at a time. Each repository
starts from the selected profile.

The page names the repositories with changes that can be written. **All
repositories** lists each change by its label and names the repositories it
affects, marking those that need access and must wait. **Leave out
everywhere** leaves a change out of every repository's apply; the profile
keeps it, and **Put back everywhere** undoes it.

Under it, each repository shows its status: how many changes, **Already in
line**, **Needs access** for a change GitHub would refuse, or **Couldn't
compare** with why, and then its changes, each with **Leave out**. Deselect
**In this batch** to leave a repository out; its apply stays, and selecting it
puts it back. **Remove from batch**, on a repository that is left out or
couldn't be compared, takes it and its pending apply out of the batch.

Click **Apply to N repositories** to confirm the list of repositories that
will change, and then **Apply now** to write them, one repository at a time.
Repotted checks each on GitHub first, and writes nothing to one that changed
since you reviewed it. A repository with a
change GitHub would refuse waits, as do those you left out.

Then the page lists the repositories that didn't finish first, with why, and
**Review again** plans them again. Those that finished, or needed nothing,
have left the batch, and the batch ends with the last of them. Leaving the
page, reloading, or clicking **Discard batch** discards the pending batch.
The repositories you clicked **Apply now** for are [queued](#queued-applies):
they are written even if you leave the page, and the rest carry on if the tab
closes.

### Change settings once on several repositories

To make the same change to several repositories without a profile, select
them on the **Repositories** page and click **Change settings once** in the
panel. Like [a change to one repository](#apply-changes-to-a-repository),
it has two steps.

The first step shows the one-off edits, in the same editor as a profile.
Every repository in the batch gets the same edits, and nothing else on them
is touched. Click **Review changes** to review them; it waits while an edit
isn't valid. Settings the Repotted App's installation can't change aren't
turned off here, since the repositories can differ; the review marks them
instead.

The second step is the batch review described above, with each change
marked **One-off edit**. A repository whose apply can't take the edits is
named and left out of the batch. Click **Back to edits** to change the edits for
every repository, then **Review changes** again. Apply works as for any
batch, and the repositories keep no record of the change.

## Profiles

A profile is a YAML file that describes how a repository should be set up.
The **Profiles** page lists every profile, under where they are kept, with
what owns the repositories each is for. Type in
**Find a profile** to narrow the list. Folders show above the profiles that
are in none, with the number of profiles in each, and a folder inside
another shows under it; click a folder's name to close or open it. Folders
open again when you reload the page. A profile Repotted
can't use is marked **Problem**, and opening it says why. One with changes
that aren't saved is marked **Not saved**.

Click a profile to open it. It takes the whole page, and **All profiles**
above it returns to the list where you left it. The
page says what owns the repositories it is for.
**Show YAML** shows the profile's file as it is saved; it starts hidden.

### Organize profiles

Select profiles with the box beside each to work on several at once. A panel
beside the list, or under it on a phone, names them. **Select all** beside
the count selects every profile the list shows, leaving out those in closed
folders, and each open folder has its own **Select all**, which takes in the
open folders inside it; each turns into **Deselect all** once everything it
covers is selected. **Deselect all** in the panel clears the selection. The
selection stays in this tab, while you open profiles or other pages, until
you reload the page.

To move the selected profiles into a folder, choose it under **Move to a
folder** in the panel and click **Move**. **No folder** takes them out of
every folder, and **New folder…** asks for a name first; give a path such as
`apps/desktop` for a folder inside another. The list shows a folder only
while a profile is in it, so a new folder starts with the profiles you move
into it. To rename a folder, use its **Edit** menu; every profile in it, and
in the folders inside it, moves with it.

A move changes where the profiles' files are. Every reference to a moved
reusable definition, and every reference a moved profile makes, is pointed at
the new place in the same change, so nothing stops loading. When your
profiles are kept on GitHub, the move is one commit, and the files keep their
names and the rest of their text. Repotted says why and moves nothing when a
profile doesn't load, since what it references is unknown; when a profile
that would move or be pointed elsewhere has changes that aren't saved; when a profile of
the same name, in any case, is already where one would go; when a folder's
name matches a profile's file in any case, or another folder's in another
case; or when a rename would land on a folder that's already there. A
rename that only changes a folder's case is refused too, since some
computers take the two for one folder. If a write fails partway, what was
written is taken back.

### Shared definitions

Open **Actions policies**, **Rulesets**, or **Environments** from the main
navigation to create and edit shared definitions independently of profiles.
In windows where those links need more room, they appear in the account
menu. Each library lists its definitions; opening one shows its settings,
**Used by** profiles, and assigned repositories.

In a profile's **Actions policies**, **Rulesets**, or **Environments** tab, use
**Use a reusable Actions policy**, **Use a reusable ruleset**, or
**Use a reusable environment** to select an existing definition. The selector
is separate from **New Actions policy**, **New ruleset**, and **New environment**,
which create named items in the profile. A profile can reference several
Actions policies, rulesets, and environments. **Edit shared definition** opens the original in
its library. **Remove** detaches the reference, and **Save** keeps reference
edits with the profile's other changes. In an apply's edits, references that come
from a listed profile are changed in that profile. Inline entries replace shared entries of the same name.

Reference changes preview the resolved entries before saving. Save those
changes before editing the entries. Create a profile first, then choose
shared definitions in its related tabs. Duplicating or importing a profile
keeps its existing references.

When creating an Actions policy, ruleset, or environment, select
**Also save as a reusable Actions policy**, **Also save as a reusable ruleset**,
or **Also save as a reusable environment** and enter a **Reusable
definition name** to create a separate definition and link it to the profile.
General Actions settings, such as workflow permissions and retention, stay
in the **Actions** tab. **Save** creates the definition in its library and saves the
profile's reference together; the profile keeps no inline copy. Leave the
option clear to keep the configuration in this profile. These choices stay
with unsaved edits when navigating away, and **Reset** clears them. Reusable
definitions require **Save**, rather than **Save as draft**. If a name is
already used or saving fails, the choices stay available to correct and
retry.

Saving a definition updates linked profiles on their next resolution and
refreshes cached editors while preserving unsaved changes. It does not
apply changes to GitHub repositories. Known consumers must remove their
references and assignments before a definition can be deleted. See
[Manage reusable definitions](profiles.md#manage-reusable-definitions-in-the-web-app)
for creation, capture, duplication, import, export, and storage.
Select definitions in a library to move them to another folder. Their
references are updated, and selections on other pages stay separate.

### Make a profile

Click **New profile** above the list, name it, and choose what it starts
from:

- **Nothing**: an empty profile, which manages nothing until you set
  something.
- **A repository**: Repotted reads the repository's settings, rulesets,
  environments, and labels as they are on GitHub now, and saves them as a
  profile. Capturing only reads from GitHub. The profile appears only once
  the capture finishes; one that fails, or whose form you leave, makes
  nothing. If GitHub refused to show the capture some settings, the new
  profile's page says how many; **Show** lists them and what would let
  Repotted read them, such as a permission of the Repotted App or a payment
  method on file. When a permission of the App would, **Review on GitHub**
  opens the App's installation settings, where an owner accepts it.

When there are folders, **Folder** chooses where the profile goes. Under
**For repositories owned by**, choose **Personal accounts**,
**Organizations**, or **Any owner**. A captured profile has the repository's
owner type.
[Owner type](profiles.md#owner-type) describes what each type takes.

Repotted never replaces a profile that is already there, whatever the case of
its name.

### Edit a profile

A profile with valid YAML syntax opens in the settings, even if its
configuration is invalid. Errors appear on the affected fields or areas and
in the save problems list. The notice above the settings lists each error by
the setting or entry it is in, as **Wiki in Repository**, and each name goes
to that setting, as **Go to it** does. Correct the values in the forms, or use **Remove
invalid configuration** for a malformed area, such as an `extends` line,
which a profile can't have. Errors in a reusable definition it references
name the file to open. Unknown keys are ignored on load and removed from this file
when saving. Saving also sets a ruleset bypass actor ID that GitHub ignores,
such as an organization owner's, to the one GitHub keeps, and the preview
names each ruleset this changes. **Save** is available for removing unknown
keys alone; loading changes no files. **Save** checks the corrected profile
and what it references before writing.

If the YAML syntax is invalid, the page offers **Profile YAML** under **Fix
the profile**. Correct the syntax there; **Save** stays off until the YAML
can be read. Saving removes unknown keys, sets bypass actor IDs GitHub ignores
to the ones it keeps, keeps known invalid values for correction, and opens its
settings, where configuration errors can be corrected. If the saved file changes before your
save, Repotted refuses to replace it and keeps your corrections. Copy them
before using **Reload**, which discards unsaved changes and reads the saved
file again.

Corrections stay in this tab while you visit another profile or page, and
the profile is marked **Not saved**. They count as unsaved when changing
where profiles are kept or signing out. Reloading or closing the browser tab
loses corrections you haven't saved. Setting changes made before a profile
became invalid stay unsaved too and return to its settings after repair.

Open a profile to edit it. Its tabs follow the parts of a repository's
setup: **Repository**, **Merge**, **Actions**, **Security**, **Pages**,
**Rulesets**, **Environments**, and **Labels**. A
setting's own options sit indented under it. Names and numbers are typed in a
box; until what you type is valid, the page says what's wrong and won't save,
and **Reset** beside the setting puts it back. A box checks what you type by
the same rules a profile file follows, so a branch name with a space in it, or
two dots in a row, is refused as you type, as are an environment's branch and
tag patterns that git wouldn't take.

While something holds Save back, the bar says how many things, as **2 things
to fix**, and each tab with one shows a count. The count opens a list of each
thing, with where it is and why. **Go to it** opens its tab, or its ruleset,
environment, or label, and puts you in the box, which pulses twice so you can
find it. With reduced motion turned on in your system settings, it is
outlined for a moment instead. **Reset** puts that one back,
and **Reset all**, with more than one, puts them all back. A setting hidden
because of the one above it, such as **Open pull requests allowed** with
**Pull requests** set to **Off**, can't be gone to, so the list offers only
**Reset** for it, and the setting that hides it says so too. When the changes
together can't make a valid profile, the list says why, and **Reset** in the
bar puts the profile back as it was saved.

Under the profile's name, the page says who it is for: personal accounts,
organizations, or any owner. A profile for personal accounts hides the
settings and choices only organizations have, and says how many. A profile
for any owner shows them all and marks each one that only organizations, or
only organizations on GitHub Enterprise Cloud, have; a profile for
organizations marks the Enterprise Cloud ones. **Change** beside it
picks another [owner type](profiles.md#owner-type). Before anything is
written, it lists what the profile sets that the new type doesn't have, since
changing the type stops the profile managing those. It waits until you have
saved or reset your changes. When the type comes from a reusable definition
the profile references, change it in that definition.

**Find a setting** above the tabs searches every settings tab at once. Type
part of a setting's name, its key in a profile such as `allow_squash_merge`,
or a word people know it by, such as "dco" for sign-off. **Managed** shows
only the settings that have a value once you save, from the file or, in an
apply's edits, from a profile it starts from, **Not saved yet** only those with a change you haven't saved,
and **Drafts**, on a profile with a draft, only those in it. The settings
found show in place of the tabs, each under its tab's and group's name, and
stay while you edit them, until you save or search again. **Show every
setting** goes back to the tabs. Rulesets, environments, and labels are not
searched; they stay on their own tabs.

A profile manages only what it names. A setting that says **Not managed**
keeps whatever value each repository has. In an apply's edits, each setting
says which profile it comes from, and setting it here overrides that profile
for the apply. To stop setting a value here, click **Remove** beside it; in
an apply's edits, the profile's value applies again.

Each group of settings, such as **Code scanning**, has **Reset all** beside
its heading while any of its settings has a change you haven't saved, and
**Remove all** while the profile itself sets any of them. Each says how many
settings it changes. **Remove all** also counts the settings GitHub hides
for the value of one above them, which have no **Remove** of their own;
settings a profile an apply starts from sets aren't counted. Neither saves anything, and
**Undo** under the heading brings back exactly what was there, until you
change anything else, save, reset, or the profile is read again after a
sync. On a phone the actions sit beside the group's heading and wrap when
needed, above its description. Among the settings **Find a setting** finds,
**Reset all** and **Remove all** sit above the groups instead and change only
the settings found, not one shown only for an option found under it.

**Reset** in the save bar puts the whole profile back as saved, and says how
many unsaved changes it discarded, with **Undo** to bring them back, until
you change anything else, save, or the profile is read again after a sync.

Options that GitHub only offers with a certain value of the setting above
them follow that setting, and so do the options under them. Where GitHub
hides them, the tab does too. With **Actions** set to **Off**, for example,
**Allowed actions** and the options under it are hidden. Where GitHub greys
them out, they stay in place, can't be changed, and say which setting turns
them off. Applying skips these settings, and saving removes them from the
edited file.

Choosing a value that turns off settings the profile sets asks first. A
question opens under the setting, such as **Remove 2 settings?**, and lists
the settings it turns off, which are highlighted below it. Click **Remove**
to choose the value, or **Cancel** to keep the one it had. Any other change
withdraws the question. Afterwards the setting lists the ones that saving
removes, with **Undo** while the change isn't saved. Only settings the open
profile's own file names count. In an apply's edits, the question is **Skip**, and it counts every
setting with a value, since the apply skips them.

On the **Actions** tab, with **Allowed actions** set to **Selected**,
**Allowed action patterns** takes one pattern a line, such as `octo-org/*`,
and a pattern that starts with `!` blocks what it matches. Under the box,
each pattern has what it matches on GitHub beside it, a moment after you stop
typing: the repository, with the folder and the tag, branch, or commit the
pattern names, or the owner for a pattern such as `octo-org/*`. A line is
marked when the repository has no such tag or branch, has no such folder, or
isn't one you can see, which is how a misspelled name shows. A pattern with a
wildcard in the owner can't be checked. Each pattern whose repository or
owner GitHub found is a link to it, which opens in a new tab. The line under
them counts how they came out. The checks only inform: a profile saves and
applies with any pattern GitHub accepts. When GitHub can't be reached, or its
limit is reached, the line says so. **Check again** asks GitHub about every line
again, such as after you make the repository or push the tag. Once some
patterns match nothing, because GitHub found no such owner or repository that
you can see, or refuses the pattern, **Remove those matching nothing** takes
them off the list together, with **Undo**. A private repository you can't see
counts as matching nothing, so check those lines before you save. The list
it leaves has no blank lines, and each pattern is trimmed.

**Find an action on GitHub**, under the patterns, searches GitHub for
repositories by name or description, a moment after you stop typing or when
you press Enter. Each one found is a link to its repository, which opens in a
new tab, and says how many stars it has and whether it has an action file at
its top. **Add** puts `owner/name@*` on a new line of the list, which allows
every action in that repository at any version; edit the line to narrow it.
Escape puts the results away.

On the **Pages** tab, **Take the site down** deletes the Pages site on each
repository that follows the profile. Choosing it takes out the profile's
other Pages settings, and setting any of them takes it out again.

The bar under the settings saves them. **Save** writes your changes to the
profile. When profiles are kept on GitHub, it first brings in what changed
there and then commits yours; only the settings you changed are written, so
a change made elsewhere to another setting stays. If the changes can't make a valid profile, such as one with every
merge method off, the bar's list of things to fix says why and **Save** waits. **Reset** in the bar
puts the whole profile back as it was saved.

Once **Save** or **Save as draft** goes through, the profile closes and the
list comes back, or the library's list for a shared definition. A save that
repairs the profile, saves changed references, or makes a new reusable
definition keeps it open, since the editing goes on from there.

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
The browser also asks in the moment after any change to your profiles,
while it is still storing that change.

**Rulesets**, **Environments**, and **Labels** each list what the profile
names, with **New ruleset**, **New environment**, or **New label**. Click
one to open it. Its form changes only what you edit, so anything it doesn't
show, such as the merge methods a pull request rule allows or a rule the form
has no box for, stays as the profile's file has it. Required reviewers can
be kept as the file has them or cleared. **Leave it to GitHub** clears a choice, so each
repository keeps its own. Choose **Manage it**, or **Remove it from the
repository** to delete it from each repository that follows the profile.
Removing keeps what the entry had, in case you choose **Manage it** again
before saving. **Take out of profile** stops the profile from managing it at
all; **Put it back** in the list undoes that before you save.

Under **New Actions policy**, **New ruleset**, **New environment**, or **New label**, **Reset all**
puts every entry in the list with a change you haven't saved back as it was,
**Take out all** takes out every entry the profile names, along with new
ones, and **Put all back** puts back every entry that is taken out. An entry
from a reusable definition, or from a profile an apply starts from, can't be
taken out. As with a group of settings, each
says how many it changes, and **Undo** brings the list back as it was.
Select entries with the box beside each, or **Select all**, and the actions
change only those: **Reset**, **Take out**, and **Put back**. **Deselect
all** brings back the actions for the whole list. Selecting changes nothing
in the profile, and a save or a fresh read after a sync clears it.

A ruleset's **Bypass list** says who can skip its rules. Until you choose
**Manage the bypass list**, each repository keeps its own. Once it is
managed, each repository has exactly the listed ones, and an empty list means
nobody bypasses. **Add bypass** adds the **Repository admin**, **Maintain**,
or **Write** role, **Deploy keys**, or a **GitHub App** by the name in its
address, such as `dependabot` for `github.com/apps/dependabot`, or by its ID.
Applying to one repository takes an app by its ID only. Unless the profile is
for personal repositories, the menu also offers **Organization admin**, and a
team or a custom role by its ID. Each one bypasses **Always** or on **Pull
requests only**, and GitHub records each bypass, or is **Exempt**, which skips
the rules without recording one. Pull requests only works in a branch ruleset
and not for deploy keys, and a profile that sets it there can't be saved
until you choose another mode. When the profile leaves the ruleset's target
to each repository, it works only where that repository's ruleset targets
branches. A list that names someone twice can't be saved either. Select
several to set their mode or remove them together, or choose **Remove all**.
**Leave it to GitHub** stops managing the list.

A ruleset with no rule selected leaves each repository's rules as they are.
Once any rule is selected, the ruleset has exactly the selected rules, and
applying removes every other rule it has on a repository; the form says
which holds. **Leave its rules to GitHub** goes back to leaving them alone.

A ruleset's **Include** and **Exclude** are options you can select together.
**Include** offers **Default branch** (each repository's own default),
**All branches** (or **All tags** in a tag ruleset), and **Branches by
pattern** (or **Tags by pattern**), which shows a box for the patterns, one a
line. **Exclude** offers **Default branch** and the patterns. A pattern
starts with `refs/heads/` for a branch or `refs/tags/` for a tag, as in
`refs/heads/release/*`. When GitHub would refuse a pattern or it would match
nothing, the form says why, and the ruleset can't be saved until you correct
it. Deselecting the pattern option clears its patterns. A push ruleset has no
branch or tag targets, so its form shows none. An option the ruleset doesn't
offer, such as the default branch in a tag ruleset, still shows while the
ruleset names it, so you can deselect it.

An environment that deploys from **Chosen branches and tags** takes
**Branch patterns** and **Tag patterns**, one a line.

A ruleset, environment, or label is saved whole. If it changed elsewhere
since you edited it, such as in a sync with GitHub, the page says so and
doesn't save over that change: **Keep mine** saves your version over it, and
**Reset** shows the new one.

GitHub knows rulesets and environments by name. If you rename one, applying
the profile creates a new one with the new name and leaves the old one on the
repository, and the form says so. You can rename only an entry that this
file names on its own; one from a reusable definition, or from a profile an
apply starts from, keeps its name, and changing it here overrides that one.

In a label's form, pick one of GitHub's colors or type six hex digits; an
empty color leaves each repository's own. An empty description clears each
repository's description, and **Leave each repository's own description**
leaves it alone. **Renamed from** lists old names, one per line: a repository
that has one of them and not the label has it renamed, so issues and pull
requests keep the label. When you rename a label, **Rename it on GitHub too**
adds its old name there. See [Labels](profiles.md#labels) for what apply does
with renames.

Topics, custom properties, and autolinks are not edited here yet.

A problem already saved in a draft offers **Go to it**. **Reset** only
resets unsaved edits; edit that draft entry or use **Discard draft**.

### Delete a profile

Open the profile and click **Delete profile**, or select profiles in the list
and click **Delete** in the panel. Repotted asks first, naming the files. A profile in the browser can't be brought
back. When your profiles are kept on GitHub, the deletion is one commit, so
the repository's history keeps the files as they were at the last sync.

### Keep profiles on GitHub

Profiles are kept in your browser at first, where only that browser has
them, and clearing the site's data deletes them. To have them follow you to
any browser, keep them in a GitHub repository instead. In
[Settings](#settings), click **Use a GitHub repository…**, name the
repository, and optionally a folder in it. An empty repository works: select
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

### Find your config repository from a new browser

While profiles are kept in a repository, Repotted marks it as your config
repository: it adds the `repotted-config` topic, keeping the repository's
other topics, and commits a `.repotted.json` file at its root that names the
profiles folder, such as `{ "folder": "profiles" }`. Moving the profiles to
the browser, a folder on this computer, or another repository takes the
topic off the old one; its `.repotted.json` stays and does nothing without
the topic. If GitHub refuses the topic or the file, Settings says why, and a
new browser won't find the repository by itself.

A browser that has never chosen where to keep profiles looks for the topic
when your repository list first loads:

- **One repository has it, and the browser holds no profiles:** Repotted
  uses it straight away, in the folder `.repotted.json` names, and a notice
  above the page says so.
- **The browser already holds profiles, or several repositories have it:**
  the notice asks which repository to use. Pick one, select the box to add
  the browser's profiles to it if you like, and click **Use this
  repository**. **Keep profiles in this browser** answers for good, so later
  visits don't ask; **Not now** hides the notice until your next visit.
- **Its `.repotted.json` is missing, can't be read, or names no folder
  Repotted can use:** the notice asks for the folder, as **Use a GitHub
  repository…** does.
- **No repository has it:** nothing changes.

A browser that has chosen, even to keep profiles in itself, never moves them
by the topic. An archived repository isn't offered. A profile that sets
`repository.topics` replaces every topic when it is applied, so a profile
applied to your config repository should list `repotted-config` too.

### Protect the config repository

Repotted has a built-in protection for a personal repository that keeps
your profiles. It stops the default branch from being deleted or force
pushed, keeps the token that workflows get read-only, and stops workflows
from approving pull requests. It never requires pull requests, so syncs
still commit straight to the branch. Nothing is applied until you review it.

Right after you pick a personal repository in **Use a GitHub repository…**,
Settings offers it above the list, when the repository doesn't already have
it all. Click **Review protection…** to see each change and apply it as you
would a profile, or **Not now** to hide the offer.

While profiles are kept in a personal repository, the **Protect this
repository** row in Settings says whether it has the protection: **Protected**,
or how many changes are left to review, with **Review protection…**. If the
check fails, it says why, with **Check again**. A newer Repotted can add to
the protection, and the row then shows what is left to review.

A private repository on GitHub's free plan can't have rulesets, so there the
protection keeps only the workflow settings, and the row says so. A
repository owned by an organization is offered no protection yet, and
neither is one you aren't an admin of, since only an admin can change these
settings.

The built-in protection isn't one of your profiles. One-off edits to its
apply stay with that apply, so its apply has no **Save edits to profile**.

### Preview a branch

When your profiles are kept on GitHub, you can see what a branch of the
repository would change before it is merged, such as a branch an agent pushed
for a pull request. Click **Preview** above the profile list and pick a
branch, or type its name. The address of a preview is
`/profiles?preview=<branch>`, so a link to it opens the same preview.

The preview lays the branch's changes over your profiles and lists each
profile that would apply something different: one the branch adds, deletes,
moves, or changes, and one whose own file is the same but a reusable
definition it references changes, marked **Changed by a shared definition**.
Each row shows the value on the default branch and on the branch, and names
the definition it comes from. **Show YAML** shows the
file's own lines that change, and **Compare with a repository** compares
the branch's version of a profile with a repository, as
[Compare a repository with a profile](#compare-a-repository-with-a-profile)
does.

Previewing only reads from GitHub: nothing is saved, synced, or kept in the
browser. **Refresh** reads the branch again, and **Exit preview** goes back
to your profiles. Only what the branch itself changes counts, as in a pull
request, and it is laid over the profiles in your browser. So a banner says
when those differ from the default branch: when profiles have changes that
aren't synced, which the preview would show as undone by the branch, and
when the profiles are older than the default branch. Sync, then refresh, to
leave both out. A banner also says when the branch is behind the default
branch, where a profile both changed shows as the branch has it. A profile on
the branch that references a file outside the profiles folder doesn't load.
Changes the branch makes to hidden repositories and folders aren't shown.

### Keep profiles in a folder on this computer

In Chrome, Edge, and other Chromium browsers, profiles can be files in a
folder on your computer, where other tools, such as the `repotted` command
or Git, can read and change them. In [Settings](#settings), click **Choose a
folder…** and pick the folder; select the box first to add the profiles kept
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

**Settings**, at the top right and in the account menu, or in the menu on a
phone, holds what applies to the whole app in this browser.

**Account** shows who you're signed in as, with **Add repositories** and
**Sign out**. When a profile has unsaved changes, **Sign out** asks first: **Save and
sign out**, **Discard and sign out**, or **Stay signed in**, since signing
out discards changes that aren't saved. A profile with a draft, or with a
value that isn't valid, is saved from its own page, so the question stays
and says so. If the changes are saved but a sync didn't finish, it asks once
more before signing out. While the [queue](#queued-applies) is writing to
GitHub, **Sign out** does nothing but say so; press it again once it has
finished. **Profiles** shows where your profiles are kept and how the
last sync went, with **Sync now** (or **Refresh** for profiles in the
browser), and the buttons that move them to a GitHub repository or back to
the browser. When they're kept in a GitHub repository, **Open on GitHub**
opens that repository in a new tab. While they are kept in a personal repository, it also says
whether that repository has the
[built-in protection](#protect-the-config-repository).

**About Repotted**, below **Profiles**, links to Repotted's source repository.
**View on GitHub** opens it in a new tab, where you can browse the code,
report an issue, or contribute.
