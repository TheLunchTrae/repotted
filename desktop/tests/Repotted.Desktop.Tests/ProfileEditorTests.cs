using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>Editing one profile: its settings, entries, search and saves.</summary>
public sealed class ProfileEditorTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task A_profile_shows_each_setting_as_set_here_inherited_or_not_managed()
    {
        var (profiles, _, _) = await OpenOrgs();

        var editor = Assert.IsType<ProfileViewModel>(profiles.Current);
        Assert.Equal("Extends base. Saved to orgs.yaml.", editor.Summary);
        Assert.Equal("extends base", profiles.Selected?.Note);
        Assert.Equal(
            ["Repository", "Merge", "Actions", "Security", "Pages", "Rulesets", "Environments"],
            editor.Tabs.Select(tab => tab.Name));
        Assert.Equal([2, 2, 0, 0, 0, 2, 1], editor.Tabs.Select(tab => tab.Count));

        Assert.Equal((SettingOrigin.Own, "Set here"), Origin(editor, "has_wiki"));
        Assert.Equal((SettingOrigin.Inherited, "From base"), Origin(editor, "has_issues"));
        Assert.Equal((SettingOrigin.NotManaged, "Not managed"), Origin(editor, "has_projects"));
        Assert.Equal(
            ["Protect main: From base", "Old tags: Removed from GitHub here"],
            editor.Tab("Rulesets").Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.StartsWith("extends: base.yaml", editor.Yaml, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Saving_sends_only_the_changed_settings_and_shows_the_saved_profile()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        // In the order the editor lists the settings.
        var save = $"profile {files.Own} --set repository.has_projects=false --set repository.has_wiki=true --unset merge.allow_squash_merge --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));

        Choose(editor, "has_wiki", "On");
        Find(editor, "allow_squash_merge").ResetCommand.Execute(null);
        Choose(editor, "has_projects", "Off");
        // Picking the saved value of a profile's own setting is no change.
        Choose(editor, "allow_squash_merge", "Off");
        Find(editor, "allow_squash_merge").ResetCommand.Execute(null);

        Assert.Equal("3 unsaved changes", editor.ChangesLabel);
        // Without orgs' value, base's applies, so removing it turns squash merges on.
        Assert.Equal("From base when saved", Find(editor, "allow_squash_merge").Note);
        Assert.Equal("On", Find(editor, "allow_squash_merge").Options.Single(option => option.Selected).Label);
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Single(cli.Calls, call => call.Contains("--set", StringComparison.Ordinal) || call.Contains("--unset", StringComparison.Ordinal));
        Assert.Contains(save, cli.Calls);
        Assert.False(editor.HasChanges);
        Assert.Equal("On", Find(editor, "has_wiki").Options.Single(option => option.Selected).Label);
    }

    [AvaloniaFact]
    public async Task Drafts_show_where_they_are_saved_and_a_draft_and_an_entry_can_share_a_name()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);
        var (rulesets, environments) = (editor.Tab("Rulesets"), editor.Tab("Environments"));

        // A base's draft shows, but only this profile's own drafts can be finished or discarded here.
        var projects = Find(editor, "has_projects");
        Assert.Equal(("On", false, "Saved in base, not applied."), (projects.DraftLabel, projects.OwnDraft, projects.DraftNote));
        Assert.False(projects.FinishDraftCommand.CanExecute(null));
        Assert.Equal(
            ["Protect main: From base", "Old tags: Removed from GitHub here", "Later: Draft, left out of compare and apply", "Protect main: Draft, left out of compare and apply"],
            rulesets.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal("NPM: Draft in base, left out of compare and apply", $"{environments.Entries[1].Name}: {environments.Entries[1].Note}");
        Assert.Equal([2, 2, 0, 0, 0, 2, 1], editor.Tabs.Select(tab => tab.Count));

        // A draft can take an entry's name, but not another draft's.
        rulesets.NewCommand.Execute(null);
        var extra = rulesets.Editing!.Editor;
        extra.IsDraft = true;
        extra.Name = "Old tags";
        Assert.Null(extra.Problem);
        extra.Name = "Later";
        Assert.Equal("The profile already has a draft ruleset named Later.", extra.Problem);
        rulesets.Editing!.DropCommand.Execute(null);

        // Finishing the draft of a base's ruleset replaces the base's, as an override does.
        var draft = rulesets.Entries[3];
        draft.Editor.IsDraft = false;
        Assert.Null(draft.Editor.Problem);
        Assert.Equal("Finished, applies once saved", draft.Note);
        Assert.Equal("Replaced by its finished draft once saved", rulesets.Entries[0].Note);
        Assert.Equal(2, rulesets.Count);

        // Saving a change as a draft puts the value back, and an undo takes the draft out.
        Choose(editor, "has_wiki", "On");
        var wiki = Find(editor, "has_wiki");
        wiki.SaveAsDraftCommand.Execute(null);
        Assert.Equal((false, true, "Off"), (wiki.Changed, wiki.DraftChanged, wiki.Options.Single(option => option.Selected).Label));
        Assert.Equal("2 unsaved changes", editor.ChangesLabel);
        wiki.ResetCommand.Execute(null);
        Assert.False(wiki.HasDraft);
        Assert.Equal("1 unsaved change", editor.ChangesLabel);

        Choose(editor, "has_wiki", "On");
        wiki.SaveAsDraftCommand.Execute(null);
        var save = $$"""profile {{files.Own}} --set drafts.repository.has_wiki=true --drop-draft-ruleset=Protect main --ruleset={"name":"Protect main","enforcement":"evaluate"} --json""";
        cli.On(save, Documents.ResolvedWithDrafts(files.Own, files.Base));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.Null(editor.SaveError);
    }

    [AvaloniaFact]
    public async Task The_settings_search_finds_names_keys_notes_synonyms_and_sub_options_on_every_tab()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;

        editor.Query = "squash";
        Assert.True(editor.Filtering);
        Assert.Equal(
            ["Merge / Merge methods: Allow squash merging, Squash commit title, Squash commit message"],
            Found(editor));
        Assert.Equal("3 settings found.", editor.ResultsSummary);

        // A key as the profile writes it, in any case.
        editor.Query = "WEB_COMMIT_SIGNOFF";
        Assert.Equal(["Repository / Pull requests: Require sign-off on web commits"], Found(editor));
        // A synonym GitHub's label doesn't use.
        editor.Query = "dco";
        Assert.Equal(["Repository / Pull requests: Require sign-off on web commits"], Found(editor));
        // A note under the label.
        editor.Query = "restricting editing";
        Assert.Equal(["Repository / Features: Wiki"], Found(editor));
        // A sub-option shows under the setting it belongs to.
        editor.Query = "draft pull";
        Assert.Equal(["Repository / Features: Pull requests, Count draft pull requests"], Found(editor));
        // Searching a setting finds its sub-options too.
        editor.Query = "secret protection";
        Assert.Equal(
            ["Security / Secret scanning: Secret Protection, Push protection, AI detection, Non-provider patterns, Validity checks, Delegated alert dismissal, Delegated bypass"],
            Found(editor));

        editor.Query = "nothing like this";
        Assert.False(editor.HasResults);
        Assert.Equal("No settings match \u201cnothing like this\u201d.", editor.ResultsSummary);

        editor.Query = "  ";
        Assert.False(editor.Filtering);
        Assert.False(editor.HasResults);
    }

    [AvaloniaFact]
    public async Task The_settings_filters_narrow_the_search_and_keep_a_row_while_it_is_edited()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;

        editor.OnlyManaged = true;
        Assert.Equal(
            ["Repository / Features: Issues, Wiki", "Merge / Merge methods: Allow squash merging, Allow rebase merging"],
            Found(editor));
        editor.Query = "wiki";
        Assert.Equal(["Repository / Features: Wiki"], Found(editor));
        // The result rows are made once, and a search that finds the same changes nothing.
        var made = editor.Results;
        var wiki = made.SelectMany(group => group.Rows).Single(row => row.Shown);
        editor.Query = "Wiki ";
        Assert.Same(made, editor.Results);
        Assert.True(wiki.Shown);
        editor.Query = "wik";
        Assert.Same(made, editor.Results);
        Assert.Same(wiki, made.SelectMany(group => group.Rows).Single(row => row.Shown));

        editor.ClearFiltersCommand.Execute(null);
        Choose(editor, "has_projects", "Off");
        editor.OnlyUnsaved = true;
        Assert.Equal(["Repository / Features: Projects"], Found(editor));
        // Undoing the change leaves the row where it is, so it doesn't vanish under the pointer.
        Find(editor, "has_projects").Undo();
        Assert.Equal(["Repository / Features: Projects"], Found(editor));
        editor.OnlyUnsaved = false;
        editor.OnlyUnsaved = true;
        Assert.Equal("No settings match these filters.", editor.ResultsSummary);

        // A save shows the saved profile's rows, and the search finds those.
        editor.OnlyUnsaved = false;
        editor.Query = "wiki";
        cli.On($"profile {files.Own} --set repository.has_wiki=true --json", Documents.Resolved(files.Own, files.Base, wiki: true));
        Choose(editor, "has_wiki", "On");
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Same(Find(editor, "has_wiki"), Assert.Single(Assert.Single(editor.Results, group => group.Shown).Settings));

        editor.ClearFiltersCommand.Execute(null);
        Assert.False(editor.Filtering);
        Assert.Equal("", editor.Query);
    }

    [AvaloniaFact]
    public async Task The_drafts_filter_shows_settings_with_a_draft_and_points_to_drafted_entries()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);

        editor.OnlyDrafts = true;
        Assert.Equal(["Repository / Features: Projects"], Found(editor));
        editor.Query = "wiki";
        Assert.False(editor.HasResults);
        Assert.Equal("No settings match \u201cwiki\u201d.", editor.ResultsSummary);
        editor.Query = "";
        editor.OnlyManaged = true;
        // Projects has only a draft, which doesn't apply, so the profile doesn't manage it yet.
        Assert.Equal(
            "No settings match these filters. Drafts of rulesets and environments are on their own tabs.",
            editor.ResultsSummary);

        // Saving a draft is a change waiting to be saved, so Not saved yet shows it.
        editor.ClearFiltersCommand.Execute(null);
        Choose(editor, "has_wiki", "On");
        Find(editor, "has_wiki").SaveAsDraftCommand.Execute(null);
        editor.OnlyUnsaved = true;
        Assert.Equal(["Repository / Features: Wiki"], Found(editor));
    }

    /// <summary>What the search and filters found, as "Tab / Group: Setting, Setting".</summary>
    private static List<string> Found(ProfileViewModel editor) =>
        [.. editor.Results.Where(group => group.Shown)
            .Select(group => $"{group.Tab} / {group.Title}: {string.Join(", ", group.Settings.Select(setting => setting.Label))}")];

    [AvaloniaFact]
    public async Task Numbers_and_text_save_once_they_are_valid()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var save = $"profile {files.Own} --set repository.default_branch=\"trunk\" --set actions.max_cache_size_gb=5 --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base));
        var size = Find(editor, "max_cache_size_gb");
        var branch = Find(editor, "default_branch");
        var description = Find(editor, "description");

        Assert.True(size.IsTyped);
        Assert.Equal("", size.Typed);
        // Text that isn't a value waits to be fixed, and holds back the save.
        size.Typed = "0";
        Assert.Equal("Enter a whole number of 1 or more.", size.TypedProblem);
        Assert.Equal((false, true, true), (size.Changed, size.Invalid, size.Pending));
        Assert.Equal(("Not valid yet", "Undo"), (size.Note, size.ResetLabel));
        Assert.Equal("Enter a whole number of 1 or more.", size.TypedHelp);
        Assert.Equal($"{size.Label}: Enter a whole number of 1 or more.", editor.Problem);
        Assert.Equal("1 unsaved change", editor.ChangesLabel);
        Assert.False(editor.SaveCommand.CanExecute(null));
        size.Typed = "5";
        Assert.Null(size.TypedProblem);
        Assert.Equal("Changed", size.Note);
        Assert.Null(editor.Problem);

        branch.Typed = "trunk";
        Assert.True(branch.Changed);
        // Typing back what the box started with is no change at all.
        description.Typed = "x";
        Assert.True(description.Changed);
        description.Typed = "";
        Assert.False(description.Pending);
        branch.Typed = "";
        Assert.False(branch.Pending);
        branch.Typed = "trunk";

        Assert.Equal("2 unsaved changes", editor.ChangesLabel);
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_value_the_profile_sets_must_stay_valid_to_save()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"repository":{"default_branch":"main"}}""", """{"repository":{"default_branch":OWN}}""");
        var branch = Find(editor, "default_branch");
        Assert.Equal((SettingOrigin.Own, "main"), (branch.Origin, branch.Typed));

        // Clearing a value the profile would set is invalid, and Undo puts the box back as it started.
        branch.Typed = "";
        Assert.Equal("Enter a value, or remove the setting from this profile.", branch.TypedProblem);
        Assert.True(branch.Invalid);
        Assert.False(branch.Changed);
        branch.ResetCommand.Execute(null);
        Assert.Equal(("main", false), (branch.Typed, branch.Pending));
        Assert.False(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task The_saved_number_spelled_another_way_is_no_change()
    {
        var (editor, _, _, _) = await OpenOwn("""{"actions":{"max_cache_size_gb":30}}""", """{"actions":{"max_cache_size_gb":OWN}}""");
        var size = Find(editor, "max_cache_size_gb");

        size.Typed = "030";
        Assert.False(size.Pending);
        Assert.False(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task Undo_and_discard_put_a_typed_value_back()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        var size = Find(editor, "max_cache_size_gb");

        size.Typed = "abc";
        Assert.True(size.CanReset);
        size.ResetCommand.Execute(null);
        Assert.Equal("", size.Typed);
        Assert.Null(size.TypedProblem);
        size.Typed = "7";
        size.ResetCommand.Execute(null);
        Assert.False(size.Pending);
        Assert.Equal("", size.Typed);
        Assert.False(editor.HasChanges);

        size.Typed = "abc";
        Assert.True(editor.HasChanges);
        editor.DiscardCommand.Execute(null);
        Assert.Equal(("", false, false), (size.Typed, size.Pending, editor.HasChanges));
    }

    [AvaloniaFact]
    public async Task The_base_is_resolved_again_only_once_a_file_it_reads_changes()
    {
        var (editor, cli, own, resolved) = await OpenOwn("""{"repository":{"has_wiki":false}}""", """{"repository":{"has_wiki":OWN}}""");
        var @base = Path.Combine(folders.Profiles, "base.yaml");
        var save = $"profile {own} --set repository.has_wiki=true --json";
        cli.On(save, resolved);
        cli.Calls.Clear();

        // A save writes only this profile, so neither it nor a load after resolves the base again.
        Choose(editor, "has_wiki", "On");
        await editor.SaveCommand.ExecuteAsync(null);
        await editor.LoadCommand.ExecuteAsync(null);
        Assert.Equal([save, $"profile {own} --json"], cli.Calls);

        // Once its file changes, as by a sync, the next load resolves it again.
        File.WriteAllText(@base, "repository: { has_issues: true }\n");
        cli.Calls.Clear();
        await editor.LoadCommand.ExecuteAsync(null);
        Assert.Equal([$"profile {own} --json", $"profile {@base} --json"], cli.Calls);
    }

    [AvaloniaFact]
    public async Task Taking_the_Pages_site_down_stands_alone_in_the_profile()
    {
        var (editor, cli, own, resolved) = await OpenOwn("""{"pages":{"absent":true}}""", """{"pages":{"absent":OWN}}""");
        var save = $"profile {own} --unset pages.absent --set pages.build_type=\"workflow\" --json";
        cli.On(save, resolved);
        var absent = Find(editor, "absent");

        Assert.Equal((SettingOrigin.Own, "Set here"), Origin(editor, "absent"));
        Assert.Equal(1, editor.Tab("Pages").Count);
        // Describing a site takes the profile's "take it down" out, since the two can't be saved together.
        Choose(editor, "build_type", "GitHub Actions");
        Assert.Equal("Removed when saved", absent.Note);
        Assert.True(Find(editor, "build_type").OwnAfterSave);
        // Taking it down again drops the site's settings.
        Choose(editor, "absent", "Yes");
        Assert.False(absent.Pending);
        Assert.False(Find(editor, "build_type").Pending);
        Assert.False(editor.HasChanges);

        // Text that would never be saved goes too, so it doesn't hold back the save.
        Find(editor, "cname").Typed = "x";
        Assert.True(editor.HasChanges);
        Find(editor, "cname").Typed = "";
        Find(editor, "cname").Typed = "x";
        Choose(editor, "absent", "Yes");
        Assert.True(absent.OwnAfterSave);
        Assert.False(Find(editor, "cname").Pending);
        Assert.False(editor.HasChanges);

        Choose(editor, "build_type", "GitHub Actions");
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
    }

    [AvaloniaFact]
    public async Task Sub_options_sit_under_their_setting_and_notes_say_what_GitHub_alone_sets()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;

        var features = editor.Tabs[0].Groups.Single(group => group.Title == "Features").Settings;
        Assert.Equal(
            [("has_issues", false), ("has_projects", false), ("has_wiki", false), ("has_discussions", false),
             ("has_pull_requests", false), ("pull_request_creation_policy", true), ("pull_request_creation_cap.enabled", true),
             ("pull_request_creation_cap.max_open_pull_requests", true), ("pull_request_creation_cap.include_drafts", true)],
            features.Select(setting => (setting.Key, setting.Nested)));
        Assert.Equal(
            "Restricting editing to collaborators has no API, so it is set on GitHub only.",
            Find(editor, "has_wiki").FieldNote);
        Assert.False(Find(editor, "has_projects").HasFieldNote);
    }

    [AvaloniaFact]
    public async Task A_security_feature_saves_as_the_status_GitHub_takes()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var save = $"profile {files.Own} --set security.security_and_analysis.secret_scanning={{\"status\":\"enabled\"}} --set pages.public=false --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base));

        Choose(editor, "security_and_analysis.secret_scanning", "On");
        Choose(editor, "public", "People with access");
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
    }

    [AvaloniaFact]
    public async Task Rulesets_and_environments_save_by_name_and_a_rename_takes_the_old_one_out()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var (rulesets, environments) = (editor.Tab("Rulesets"), editor.Tab("Environments"));

        // A base's ruleset keeps its name, and an edit sets it here over the base's.
        var main = rulesets.Entries[0];
        main.OpenCommand.Execute(null);
        Assert.Same(main, rulesets.Editing);
        Assert.False(main.Editor.Renamable);
        Assert.False(main.Changed);
        ((RulesetEditorViewModel)main.Editor).Enforcement.Options[1].ChooseCommand.Execute(null);
        rulesets.BackCommand.Execute(null);

        rulesets.Entries[1].Editor.Name = "Retired tags";
        // The old name stays taken until the rename is saved, and a new entry can go before it is saved.
        rulesets.NewCommand.Execute(null);
        var extra = rulesets.Editing!;
        extra.Editor.Name = "Old tags";
        Assert.Equal("The profile already has a ruleset named Old tags.", editor.Problem);
        extra.DropCommand.Execute(null);
        Assert.Null(rulesets.Editing);
        Assert.Equal(2, rulesets.Entries.Count);
        environments.Entries[0].DropCommand.Execute(null);
        environments.NewCommand.Execute(null);
        var staging = environments.Editing!;

        // A new entry needs a name, and one the profile has not used in this save.
        Assert.Equal("An environment needs a name.", editor.Problem);
        Assert.False(editor.SaveCommand.CanExecute(null));
        staging.Editor.Name = "NPM";
        Assert.Equal("The profile already has an environment named NPM.", editor.Problem);
        staging.Editor.Name = "staging";
        ((EnvironmentEditorViewModel)staging.Editor).WaitTimer = "10";
        Assert.True(editor.SaveCommand.CanExecute(null));

        Assert.Equal("4 unsaved changes", editor.ChangesLabel);
        Assert.Equal(
            ["Protect main: Changed, not saved yet", "Retired tags: Changed, not saved yet"],
            rulesets.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal(
            ["npm: Taken out of this profile, so the profile stops managing it", "staging: New, not saved yet"],
            environments.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal(1, environments.Count);

        // Plain writes and drops go first, so only a rename's write follows its drop.
        var save = $$"""profile {{files.Own}} --ruleset={"name":"Protect main","enforcement":"evaluate"} --environment={"name":"staging","wait_timer":10} --drop-environment=npm --drop-ruleset=Old tags --ruleset={"name":"Retired tags","absent":true} --json""";
        cli.On(save, Documents.Resolved(files.Own, files.Base));
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
        Assert.Null(editor.SaveError);
        Assert.False(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task An_entry_that_a_base_also_names_keeps_its_name_and_one_taken_out_can_be_put_back()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var (rulesets, environments) = (editor.Tab("Rulesets"), editor.Tab("Environments"));
        var shared = new EntryViewModel(rulesets, new JsonObject { ["name"] = "Shared" }, SettingOrigin.Own, null, inBase: true);
        Assert.True(shared.CanDrop);
        Assert.False(shared.Renamable);
        Assert.False(shared.Editor.Renamable);

        // A name one entry gives up is free for the others at once.
        rulesets.NewCommand.Execute(null);
        var first = rulesets.Editing!;
        first.Editor.Name = "Same";
        rulesets.NewCommand.Execute(null);
        var second = rulesets.Editing!;
        second.Editor.Name = "Same";
        Assert.Equal("The profile already has a ruleset named Same.", first.Note);
        List<string?> told = [];
        first.PropertyChanged += (_, e) => told.Add(e.PropertyName);
        second.Editor.Name = "Other";
        Assert.Equal("New, not saved yet", first.Note);
        Assert.Contains(nameof(EntryViewModel.Note), told);
        first.DropCommand.Execute(null);
        second.DropCommand.Execute(null);

        // A change of case renames an environment in place, by its write alone.
        environments.Entries[0].Editor.Name = "NPM";
        var save = $$"""profile {{files.Own}} --environment={"name":"NPM"} --json""";
        cli.On(save, Documents.Resolved(files.Own, files.Base));

        // Taking out an entry closes its editor, and putting it back keeps it as saved.
        var old = rulesets.Entries[1];
        old.OpenCommand.Execute(null);
        old.DropCommand.Execute(null);
        Assert.False(old.Editable);
        Assert.True(old.PutBackCommand.CanExecute(null));
        old.PutBackCommand.Execute(null);
        Assert.Equal("Old tags: Removed from GitHub here", $"{old.Name}: {old.Note}");
        Assert.Equal("1 unsaved change", editor.ChangesLabel);

        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_save_waits_for_a_side_when_the_file_changed_under_an_edited_entry()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var rulesets = editor.Tab("Rulesets");
        rulesets.Entries[1].OpenCommand.Execute(null);
        rulesets.Entries[1].Editor.Name = "Retired tags";
        File.AppendAllText(files.Own, "# changed outside the app\n");
        cli.Calls.Clear();

        // Saving would write the entry from the copy the editor read, over the change.
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.True(editor.OutOfDate);
        Assert.Empty(cli.Calls);
        Assert.True(editor.HasChanges);
        Assert.StartsWith("orgs.yaml changed since you opened it", editor.OutOfDateMessage, StringComparison.Ordinal);

        var save = $$"""profile {{files.Own}} --drop-ruleset=Old tags --ruleset={"name":"Retired tags","absent":true} --json""";
        cli.On(save, Documents.Resolved(files.Own, files.Base));
        await editor.KeepMineCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.False(editor.OutOfDate);
        Assert.False(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task A_refresh_marks_an_edited_profile_whose_file_changed_and_reload_starts_over()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Same(editor, profiles.Current);
        Assert.False(editor.OutOfDate);

        File.AppendAllText(files.Own, "# pulled by a sync\n");
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Same(editor, profiles.Current);
        Assert.True(editor.OutOfDate);

        await editor.ReloadCommand.ExecuteAsync(null);
        Assert.False(editor.OutOfDate);
        Assert.False(editor.HasChanges);
        Assert.Equal("npm", editor.Tab("Environments").Entries[0].Name);
        Assert.EndsWith("# pulled by a sync\n", editor.Yaml, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_change_to_the_base_stops_a_save_of_an_edited_inherited_entry_only()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var rulesets = editor.Tab("Rulesets");
        File.AppendAllText(files.Base, "# changed by a sync\n");

        // An entry this profile sets is written from this profile alone.
        rulesets.Entries[1].OpenCommand.Execute(null);
        rulesets.Entries[1].Editor.Name = "Retired tags";
        var own = $$"""profile {{files.Own}} --drop-ruleset=Old tags --ruleset={"name":"Retired tags","absent":true} --json""";
        cli.On(own, Documents.Resolved(files.Own, files.Base));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(own, cli.Calls);
        Assert.False(editor.OutOfDate);

        // An inherited entry is saved whole as an override, from the base as the editor read it.
        File.AppendAllText(files.Base, "# changed again\n");
        rulesets = editor.Tab("Rulesets");
        rulesets.Entries[0].OpenCommand.Execute(null);
        ((RulesetEditorViewModel)rulesets.Entries[0].Editor).Enforcement.Options[1].ChooseCommand.Execute(null);
        cli.Calls.Clear();
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.True(editor.OutOfDate);
        Assert.Empty(cli.Calls);
        Assert.StartsWith("base.yaml changed since you opened this profile", editor.OutOfDateMessage, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_save_checks_the_file_after_a_sync_ahead_of_it()
    {
        var own = folders.Write("orgs.yaml", "environments: [{ name: npm }]\n");
        var cli = new FakeCli().On($"profile {own} --json", Documents.Resolved(own, own));
        // The sync ahead of the save changes the file before the save's turn comes.
        var editor = new ProfileViewModel(
            new RepottedClient(cli),
            new ProfileListingDocument("orgs", own, null, null),
            exclusive: write =>
            {
                File.AppendAllText(own, "# pulled by a sync\n");
                return write();
            });
        await editor.LoadCommand.ExecuteAsync(null);
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        cli.Calls.Clear();

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.True(editor.OutOfDate);
        Assert.Empty(cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_save_reads_the_file_it_wrote_so_the_next_save_goes_through()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var environments = editor.Tab("Environments");
        string Saved(string name)
        {
            File.WriteAllText(files.Own, $"extends: base.yaml\nenvironments: [{{ name: {name} }}]\n");
            return Documents.Resolved(files.Own, files.Base);
        }
        var first = $$"""profile {{files.Own}} --drop-environment=npm --environment={"name":"pages"} --json""";
        cli.On(first, () => Saved("pages"));
        environments.Entries[0].Editor.Name = "pages";
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(first, cli.Calls);

        // The fixture resolves npm again, so the second save renames npm once more.
        environments = editor.Tab("Environments");
        environments.Entries[0].Editor.Name = "staging";
        var second = $$"""profile {{files.Own}} --drop-environment=npm --environment={"name":"staging"} --json""";
        cli.On(second, () => Saved("staging"));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(second, cli.Calls);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task Nothing_saves_or_discards_while_a_reload_runs()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        File.AppendAllText(files.Own, "# pulled by a sync\n");
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.True(editor.OutOfDate);
        var resolve = new TaskCompletionSource<string>();
        cli.On($"profile {files.Own} --json", _ => resolve.Task);

        var reload = editor.ReloadCommand.ExecuteAsync(null);

        Assert.True(editor.Loading);
        Assert.False(editor.SaveCommand.CanExecute(null));
        Assert.False(editor.KeepMineCommand.CanExecute(null));
        Assert.False(editor.DiscardCommand.CanExecute(null));
        Assert.False(editor.ReloadCommand.CanExecute(null));
        resolve.SetResult(Documents.Resolved(files.Own, files.Base));
        await reload;
        Assert.False(editor.HasChanges);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task A_reload_that_fails_shows_the_error_without_the_choice()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        File.AppendAllText(files.Own, "# pulled by a sync\n");
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.True(editor.OutOfDate);
        cli.On(
            $"profile {files.Own} --json",
            """{"error":{"kind":"error","message":"orgs.yaml is not valid YAML"}}""",
            exitCode: 1);

        await editor.ReloadCommand.ExecuteAsync(null);

        Assert.Contains("not valid YAML", editor.Error, StringComparison.Ordinal);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task Settings_save_key_by_key_over_a_change_to_the_file()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.AppendAllText(files.Own, "# changed outside the app\n");
        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
        Assert.False(editor.OutOfDate);
    }

    /// <summary>
    /// Opens orgs.yaml as it resolves to <paramref name="profile"/>, with each
    /// section's sources as <paramref name="sources"/> gives them, where OWN
    /// stands for orgs.yaml. It extends base.yaml, which sets nothing it shows.
    /// </summary>
    private async Task<(ProfileViewModel Editor, FakeCli Cli, string Own, string Resolved)> OpenOwn(string profile, string sources)
    {
        var @base = folders.Write("base.yaml", "repository: {}\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        var given = JsonNode.Parse(sources.Replace("OWN", Json(own), StringComparison.Ordinal))!.AsObject();
        var all = new JsonObject();
        var drafts = new JsonObject();
        foreach (var section in (string[])["repository", "merge", "actions", "security", "custom_properties", "pages", "autolinks", "rulesets", "environments"])
        {
            all[section] = given[section]?.DeepClone() ?? new JsonObject();
            drafts[section] = new JsonObject();
        }
        all["drafts"] = drafts;
        var resolved = new JsonObject
        {
            ["chain"] = new JsonArray(own, @base),
            ["profile"] = JsonNode.Parse(profile),
            ["drafts"] = new JsonObject(),
            ["warnings"] = new JsonArray(),
            ["sources"] = all,
        }.ToJsonString();
        var cli = new FakeCli()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), orgsDesktop, folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        return (profiles.Current!, cli, own, resolved);
    }

    private static (SettingOrigin, string) Origin(ProfileViewModel editor, string key) =>
        (Find(editor, key).Origin, Find(editor, key).Note);
}
