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
            ["Repository", "Merge", "Actions", "Security", "Pages", "Rulesets", "Environments", "Labels"],
            editor.Tabs.Select(tab => tab.Name));
        Assert.Equal([2, 2, 0, 0, 0, 2, 1, 0], editor.Tabs.Select(tab => tab.Count));

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
    public async Task Rows_start_from_this_profiles_draft_and_save_applies_the_draft()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);
        var (rulesets, environments) = (editor.Tab("Rulesets"), editor.Tab("Environments"));

        // The profile's own draft shows over what applies; a base's draft is that profile's to finish.
        var wiki = Find(editor, "has_wiki");
        Assert.Equal((true, "On", "In the draft. Applies now: Off"), (wiki.InDraft, Selected(wiki), wiki.Note));
        Assert.Equal((true, "In the draft: from base. Applies now: Off"), (Find(editor, "allow_squash_merge").InDraft, Find(editor, "allow_squash_merge").Note));
        Assert.Equal((false, "Not managed"), (Find(editor, "has_projects").InDraft, Find(editor, "has_projects").Note));
        Assert.Equal(
            ["Protect main: Changed in the draft, applies once you save", "Old tags: Removed from GitHub here", "Later: New in the draft, applies once you save"],
            rulesets.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal(["npm: Set here"], environments.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal((true, "Draft: 4 changes", 0), (editor.HasDraft, editor.DraftLabel, editor.ChangeCount));

        // With nothing unsaved, Save still applies the draft, and Reset and Save as draft have nothing to do.
        Assert.False(editor.ResetCommand.CanExecute(null));
        Assert.False(editor.SaveAsDraftCommand.CanExecute(null));
        Assert.True(editor.SaveCommand.CanExecute(null));

        // Save writes what the draft holds as the values, and takes the draft out.
        var save = $$"""profile {{files.Own}} --set repository.has_wiki=true --unset drafts.repository.has_wiki --unset merge.allow_squash_merge --unset drafts.unset --drop-draft-ruleset=Protect main --ruleset={"name":"Protect main","enforcement":"evaluate"} --drop-draft-ruleset=Later --ruleset={"name":"Later"} --json""";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Equal(save, cli.Calls.Last(call => call.StartsWith("profile ", StringComparison.Ordinal) && call != $"profile {files.Own} --json"));
        Assert.Null(editor.SaveError);
        Assert.False(editor.HasDraft);
    }

    [AvaloniaFact]
    public async Task Save_as_draft_keeps_the_changes_without_changing_what_applies()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);
        var rulesets = editor.Tab("Rulesets");

        // A change to what applies is drafted, a draft put back as it applies leaves the draft, and a dropped draft goes.
        Choose(editor, "has_issues", "Off");
        Choose(editor, "has_wiki", "Off");
        var later = rulesets.Entries.Single(entry => entry.Name == "Later");
        later.OpenCommand.Execute(null);
        rulesets.Editing!.DropCommand.Execute(null);
        rulesets.BackCommand.Execute(null);
        Assert.Equal((3, "Draft: 4 changes", "· 3 unsaved changes"), (editor.ChangeCount, editor.DraftLabel, editor.ChangesStatus));

        var draft = $"profile {files.Own} --set drafts.repository.has_issues=false --unset drafts.repository.has_wiki --drop-draft-ruleset=Later --json";
        cli.On(draft, Documents.ResolvedWithDrafts(files.Own, files.Base));
        await editor.SaveAsDraftCommand.ExecuteAsync(null);
        Assert.Contains(draft, cli.Calls);
        Assert.Null(editor.SaveError);

        // A draft can take an applied entry's name, but no entry can take another's.
        rulesets.NewCommand.Execute(null);
        var extra = rulesets.Editing!.Editor;
        extra.Name = "Later";
        Assert.Equal("The profile already has a ruleset named Later.", extra.DraftProblem);
        rulesets.Editing!.DropCommand.Execute(null);
    }

    [AvaloniaFact]
    public async Task Leaving_a_profile_with_a_draft_keeps_its_changes_in_the_draft()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);
        Choose(editor, "has_issues", "Off");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);
        var draft = $"profile {files.Own} --set drafts.repository.has_issues=false --json";
        cli.On(draft, Documents.ResolvedWithDrafts(files.Own, files.Base));

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Contains(draft, cli.Calls);
        Assert.DoesNotContain(cli.Calls, call => call.Contains("--unset drafts.unset", StringComparison.Ordinal));
        Assert.Equal(other, profiles.Folder.Path);
    }

    [AvaloniaFact]
    public async Task Reset_puts_a_group_a_list_or_the_whole_profile_back_as_last_saved()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);

        Choose(editor, "has_issues", "Off");
        Choose(editor, "has_wiki", "Off");
        Choose(editor, "allow_rebase_merge", "Off");
        var features = editor.Tabs[0].Groups.Single(group => group.Settings.Contains(Find(editor, "has_wiki")));
        Assert.True(features.HasChanges);
        Assert.Equal("Reset the Features settings to what was last saved", features.ResetName);
        features.ResetCommand.Execute(null);
        // The draft comes back with the group, and the other group keeps its change.
        Assert.Equal(("On", 1), (Selected(Find(editor, "has_wiki")), editor.ChangeCount));
        Assert.False(features.HasChanges);
        Assert.False(features.ResetCommand.CanExecute(null));

        var rulesets = editor.Tab("Rulesets");
        rulesets.NewCommand.Execute(null);
        rulesets.Editing!.Editor.Name = "Extra";
        rulesets.BackCommand.Execute(null);
        Assert.True(rulesets.ResetCommand.CanExecute(null));
        rulesets.ResetCommand.Execute(null);
        Assert.DoesNotContain(rulesets.Entries, entry => entry.Name == "Extra");

        editor.ResetCommand.Execute(null);
        Assert.Equal(0, editor.ChangeCount);
        Assert.True(editor.HasDraft);
    }

    [AvaloniaFact]
    public async Task Discard_draft_asks_first_and_takes_only_this_profiles_draft_out()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);

        // It writes at once, so it waits until nothing unsaved would go with the reload.
        Choose(editor, "has_issues", "Off");
        Assert.False(editor.DiscardDraftCommand.CanExecute(null));
        editor.ResetCommand.Execute(null);
        editor.DiscardDraftCommand.Execute(null);
        Assert.True(editor.ConfirmingDiscardDraft);
        editor.CancelDiscardDraftCommand.Execute(null);
        Assert.False(editor.ConfirmingDiscardDraft);

        editor.DiscardDraftCommand.Execute(null);
        var discard = $"profile {files.Own} --unset drafts.repository.has_wiki --unset drafts.unset --drop-draft-ruleset=Later --drop-draft-ruleset=Protect main --json";
        cli.On(discard, Documents.Resolved(files.Own, files.Base));
        await editor.ConfirmDiscardDraftCommand.ExecuteAsync(null);
        Assert.Contains(discard, cli.Calls);
        Assert.Null(editor.SaveError);
        Assert.False(editor.HasDraft);
    }

    [AvaloniaFact]
    public async Task Preview_shows_what_applies_now_against_what_applies_once_saved()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);
        // The YAML panel starts hidden for a profile.
        Assert.False(editor.ShowYaml);

        Choose(editor, "has_issues", "Off");
        var preview = $$"""profile {{files.Own}} --set repository.has_issues=false --set repository.has_wiki=true --unset drafts.repository.has_wiki --unset merge.allow_squash_merge --unset drafts.unset --drop-draft-ruleset=Protect main --ruleset={"name":"Protect main","enforcement":"evaluate"} --drop-draft-ruleset=Later --ruleset={"name":"Later"} --preview --json""";
        cli.On(preview, """{"before":"repository:\n  has_issues: true\n  has_wiki: false\n","after":"repository:\n  has_issues: false\n  has_wiki: true\n"}""");
        await editor.PreviewCommand.ExecuteAsync(null);
        Assert.Null(editor.SaveError);
        var sheet = Assert.IsType<ProfilePreviewViewModel>(editor.Preview);
        Assert.Equal(
            ["repository:", "−  has_issues: true", "−  has_wiki: false", "+  has_issues: false", "+  has_wiki: true"],
            sheet.Diff.Items.OfType<DiffLine>().Select(line => line.Sign + line.Text));
        Assert.Equal("Stops applying: has_issues: true", sheet.Diff.Items.OfType<DiffLine>().ElementAt(1).AccessibleName);
        Assert.Equal(
            "What applies now against what applies once you save: the draft, and 1 change not saved yet. Save as draft keeps them all without applying them.",
            sheet.Message);
        // Preview saves nothing.
        Assert.Equal(1, editor.ChangeCount);
        editor.ClosePreviewCommand.Execute(null);
        Assert.False(editor.Previewing);
    }

    private static string Selected(SettingViewModel setting) => setting.Options.Single(option => option.Selected).Label;

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
        Assert.Equal(["Repository / Features: Pull requests, Limit open pull requests per user, Count draft pull requests"], Found(editor));
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
    public async Task The_drafts_filter_shows_settings_in_this_profiles_draft()
    {
        var (profiles, cli, files) = await OpenOrgs();
        cli.On($"profile {files.Own} --json", Documents.ResolvedWithDrafts(files.Own, files.Base));
        var editor = profiles.Current!;
        await editor.LoadCommand.ExecuteAsync(null);

        // Projects has a draft in base only, which is base's to finish.
        editor.OnlyDrafts = true;
        Assert.Equal(["Repository / Features: Wiki", "Merge / Merge methods: Allow squash merging"], Found(editor));
        editor.Query = "projects";
        Assert.Equal("No settings match \u201cprojects\u201d.", editor.ResultsSummary);

        // A change is waiting to be saved, so Not saved yet shows it.
        editor.ClearFiltersCommand.Execute(null);
        Choose(editor, "has_issues", "Off");
        editor.OnlyUnsaved = true;
        Assert.Equal(["Repository / Features: Issues"], Found(editor));
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
        Assert.Equal(("Not valid yet", "Reset"), (size.Note, size.ResetLabel));
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
    public async Task An_empty_runner_label_saves_as_null_and_an_empty_runner_group_as_no_group()
    {
        var (editor, cli, own, resolved) = await OpenOwn(
            """{"security":{"code_scanning_default_setup":{"runner_type":"labeled","runner_label":"gpu"},"dependabot_runner_settings":{"runner_type":"labeled","runner_group":"builders"}}}""",
            """{"security":{"code_scanning_default_setup.runner_type":OWN,"code_scanning_default_setup.runner_label":OWN,"dependabot_runner_settings.runner_type":OWN,"dependabot_runner_settings.runner_group":OWN}}""");
        var save = $"profile {own} --set security.dependabot_runner_settings.runner_group=\"\" --set security.code_scanning_default_setup.runner_label=null --json";
        cli.On(save, resolved);
        var label = Find(editor, "code_scanning_default_setup.runner_label");
        var group = Find(editor, "dependabot_runner_settings.runner_group");
        Assert.Equal(("gpu", "builders"), (label.Typed, group.Typed));

        // The schema takes no empty label, so an empty box means none.
        label.Typed = "";
        group.Typed = "";
        Assert.Null(label.TypedProblem);
        Assert.Equal((true, "Changed"), (label.Changed, label.Note));
        Assert.True(group.Changed);
        // A null draft would not show, so an empty label can't be one.
        Assert.Equal("Runner label: an empty value can't be kept in a draft. Save it, or reset it.", editor.DraftProblem);
        // Save can still apply it, so the editor says why Save as draft can't.
        Assert.Equal(editor.DraftProblem, editor.DraftOnlyProblem);
        Assert.False(editor.SaveAsDraftCommand.CanExecute(null));
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
        Assert.Null(editor.SaveError);
    }

    [AvaloniaFact]
    public async Task A_runner_label_of_null_shows_as_an_empty_box_that_left_empty_is_no_change()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"security":{"code_quality_setup":{"runner_type":"labeled","runner_label":null}}}""",
            """{"security":{"code_quality_setup.runner_type":OWN,"code_quality_setup.runner_label":OWN}}""");
        var label = Find(editor, "code_quality_setup.runner_label");

        Assert.Equal(("", SettingOrigin.Own, "Set here"), (label.Typed, label.Origin, label.Note));
        // The profile sets the label, to null, so it counts as managed.
        Assert.True(label.Managed);
        Assert.Equal(2, editor.Tab("Security").Count);
        label.Typed = "gpu";
        Assert.True(label.Changed);
        label.Typed = "";
        Assert.False(label.Pending);
        Assert.False(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task A_runner_box_is_off_while_its_runner_type_shows_standard()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"security":{"code_scanning_default_setup":{"runner_type":"standard","runner_label":"gpu"},"code_quality_setup":{"runner_type":"labeled"},"dependabot_runner_settings":{"runner_type":"standard"}}}""",
            """{"security":{"code_scanning_default_setup.runner_type":OWN,"code_scanning_default_setup.runner_label":OWN,"code_quality_setup.runner_type":OWN,"dependabot_runner_settings.runner_type":BASE}}""");
        var scanning = Find(editor, "code_scanning_default_setup.runner_label");
        var quality = Find(editor, "code_quality_setup.runner_label");
        var group = Find(editor, "dependabot_runner_settings.runner_group");

        // Standard runners, set here or in the base, turn the box off; it keeps its value and its way back.
        Assert.Equal((false, true, false), (scanning.Enabled, quality.Enabled, group.Enabled));
        // Screen readers hear why a box is off before where its value comes from.
        Assert.Equal($"Off while Runner type is set to Standard. {scanning.Note}", scanning.TypedHelp);
        Assert.Equal(quality.Note, quality.TypedHelp);
        Assert.Equal(("gpu", "Remove"), (scanning.Typed, scanning.ResetLabel));

        // The box follows the runner type as it changes, and tells its view.
        List<string?> told = [];
        scanning.PropertyChanged += (_, e) => told.Add(e.PropertyName);
        Choose(editor, "code_scanning_default_setup.runner_type", "Labeled");
        Assert.True(scanning.Enabled);
        Assert.Contains(string.Empty, told);
        Find(editor, "code_scanning_default_setup.runner_type").Undo();
        Assert.False(scanning.Enabled);
        Choose(editor, "dependabot_runner_settings.runner_type", "Labeled");
        Assert.True(group.Enabled);
        Choose(editor, "code_quality_setup.runner_type", "Standard");
        Assert.False(quality.Enabled);

        // With no runner type at all, the box stays on.
        var type = Find(editor, "code_quality_setup.runner_type");
        type.Undo();
        type.ResetCommand.Execute(null);
        Assert.Equal(("Removed when saved", true), (type.Note, quality.Enabled));
    }

    [AvaloniaFact]
    public async Task Settings_that_depend_on_one_that_is_off_hide_as_GitHub_hides_them_and_keep_their_values()
    {
        var (editor, cli, own, resolved) = await OpenOwn(
            """{"actions":{"enabled":false,"allowed_actions":"selected","selected_actions":{"github_owned_allowed":true}}}""",
            """{"actions":{"enabled":OWN,"allowed_actions":OWN,"selected_actions.github_owned_allowed":OWN}}""");
        var actions = Find(editor, "enabled");
        var allowed = Find(editor, "allowed_actions");
        var byGitHub = Find(editor, "selected_actions.github_owned_allowed");
        var patterns = Find(editor, "selected_actions.patterns_allowed");
        var pinning = Find(editor, "sha_pinning_required");

        // Actions off hides which actions are allowed and what Selected allows, through the setting between.
        Assert.Equal((true, true, true, true), (allowed.Hidden, byGitHub.Hidden, patterns.Hidden, pinning.Hidden));
        Assert.Equal((false, false), (actions.Hidden, Find(editor, "default_workflow_permissions").Hidden));
        Assert.Equal("Hidden while Actions is set to Off.", byGitHub.WhyOff);
        Assert.False(byGitHub.Enabled);
        // The profile keeps them, and the setting that hides them says so.
        Assert.Equal(("Set here", "This profile still names 2 settings hidden under it."), (byGitHub.Note, actions.HiddenNote));
        Assert.Null(allowed.HiddenNote);

        // Turning Actions on shows them again; Selected is what shows its options.
        Choose(editor, "enabled", "On");
        Assert.Equal((false, false, false, false), (allowed.Hidden, byGitHub.Hidden, patterns.Hidden, pinning.Hidden));
        Assert.Null(actions.HiddenNote);
        Choose(editor, "allowed_actions", "All");
        Assert.Equal((true, true, false), (byGitHub.Hidden, patterns.Hidden, pinning.Hidden));
        Assert.Equal("Hidden while Allowed actions is set to All.", patterns.WhyOff);
        Assert.Equal("This profile still names 1 setting hidden under it.", allowed.HiddenNote);
        Assert.Null(actions.HiddenNote);

        // A hidden setting's own change still saves, as the YAML would keep it.
        Choose(editor, "allowed_actions", "Selected");
        patterns.Typed = "octo-org/*";
        Choose(editor, "enabled", "Off");
        Assert.Equal("This profile still names 3 settings hidden under it.", actions.HiddenNote);
        var save = $"profile {own} --set actions.enabled=true --set actions.selected_actions.patterns_allowed=[\"octo-org/*\"] --json";
        Choose(editor, "enabled", "On");
        cli.On(save, resolved);
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
    }

    [Fact]
    public void Each_dependency_names_a_setting_above_it_in_its_group_and_values_that_setting_takes()
    {
        foreach (var group in ProfileFields.Sections.SelectMany(tab => tab.Groups))
        {
            foreach (var (field, index) in group.Fields.Select((field, index) => (field, index)))
            {
                if (field.DependsOn is not { } condition)
                {
                    continue;
                }
                // Above it in its group, so it shows under what hides it, and a value a misspelling would never match.
                var parent = Assert.Single(group.Fields.Take(index), other => other.Section == field.Section && other.Key == condition.Key);
                Assert.All(condition.Values, value => Assert.Contains(parent.Options, option => JsonNode.DeepEquals(option.Value, value)));
                // A setting GitHub hides sits under one that is hidden too, or under none: under one GitHub only
                // greys out, it would show off rather than hidden while that is off.
                Assert.True(!condition.Hides || parent.DependsOn is null or { Hides: true }, $"{field.Key} hides under {parent.Key}, which only turns off.");
            }
        }
    }

    [AvaloniaFact]
    public async Task Search_and_filters_find_a_hidden_setting_and_show_it_off()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"merge":{"allow_squash_merge":false,"squash_merge_commit_title":"PR_TITLE"}}""",
            """{"merge":{"allow_squash_merge":OWN,"squash_merge_commit_title":OWN}}""");
        var title = Find(editor, "squash_merge_commit_title");

        editor.OnlyManaged = true;
        Assert.Equal(["Merge / Merge methods: Allow squash merging, Squash commit title"], Found(editor));
        Assert.Equal((true, false), (title.Hidden, title.Enabled));
        Assert.Equal($"Hidden while Allow squash merging is set to Off. {title.Note}", title.OptionHelp);
    }

    [AvaloniaFact]
    public async Task A_hidden_setting_removed_from_the_profile_is_no_longer_counted_as_named()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"merge":{"allow_squash_merge":false,"squash_merge_commit_title":"PR_TITLE"}}""",
            """{"merge":{"allow_squash_merge":OWN,"squash_merge_commit_title":OWN}}""");
        var squash = Find(editor, "allow_squash_merge");
        Assert.Equal("This profile still names 1 setting hidden under it.", squash.HiddenNote);

        Find(editor, "squash_merge_commit_title").ResetCommand.Execute(null);
        Assert.Null(squash.HiddenNote);
    }

    [AvaloniaFact]
    public async Task Search_shows_the_setting_that_hides_or_turns_off_what_it_finds()
    {
        var (editor, _, _, _) = await OpenOwn("""{"actions":{"enabled":true,"allowed_actions":"all"}}""",
            """{"actions":{"enabled":OWN,"allowed_actions":OWN}}""");

        editor.Query = "patterns_allowed";
        Assert.Equal(["Actions / Policy: Actions, Allowed actions, Allowed action patterns"], Found(editor));
        editor.Query = "include_drafts";
        Assert.Equal(["Repository / Features: Pull requests, Limit open pull requests per user, Count draft pull requests"], Found(editor));
    }

    [AvaloniaFact]
    public async Task A_choice_tells_screen_readers_when_the_setting_above_turns_it_off_and_back_on()
    {
        var (editor, _, _, _) = await OpenOwn("""{"merge":{"allow_squash_merge":true}}""", """{"merge":{"allow_squash_merge":OWN}}""");
        var title = Find(editor, "squash_merge_commit_title");
        var option = title.Options[0];
        var told = 0;
        option.PropertyChanged += (_, args) => told += args.PropertyName is nameof(OptionViewModel.Help) or null or "" ? 1 : 0;

        Choose(editor, "allow_squash_merge", "Off");
        Assert.StartsWith("Hidden while Allow squash merging is set to Off.", option.Help, StringComparison.Ordinal);
        Assert.True(told > 0);
        var before = told;
        Find(editor, "allow_squash_merge").ResetCommand.Execute(null);
        Assert.DoesNotContain("while", option.Help, StringComparison.Ordinal);
        Assert.True(told > before);
        Assert.False(title.Hidden);
    }

    [AvaloniaFact]
    public async Task The_pattern_box_tells_screen_readers_how_to_fill_it()
    {
        var (editor, _, _, _) = await OpenOwn("""{"actions":{"allowed_actions":"selected"}}""", """{"actions":{"allowed_actions":OWN}}""");
        var patterns = Find(editor, "selected_actions.patterns_allowed");
        Assert.Equal($"{patterns.FieldNote} {patterns.Note}", patterns.TypedHelp);
    }

    [AvaloniaFact]
    public async Task A_setting_GitHub_turns_off_shows_off_and_follows_what_turns_it_off()
    {
        var (editor, _, _, _) = await OpenOwn(
            """{"security":{"vulnerability_alerts":false,"automated_security_fixes":true}}""",
            """{"security":{"vulnerability_alerts":BASE,"automated_security_fixes":OWN}}""");
        var updates = Find(editor, "automated_security_fixes");

        // Off, inherited from the base, still turns it off; it shows, unlike a hidden one.
        Assert.Equal((false, false), (updates.Enabled, updates.Hidden));
        Assert.Equal("Off while Dependabot alerts is set to Off.", updates.WhyOff);
        Choose(editor, "vulnerability_alerts", "On");
        Assert.True(updates.Enabled);
        Assert.Null(updates.WhyOff);
    }

    [AvaloniaFact]
    public async Task Allowed_action_patterns_are_typed_one_a_line_and_save_as_a_list()
    {
        var (editor, cli, own, resolved) = await OpenOwn(
            """{"actions":{"allowed_actions":"selected","selected_actions":{"patterns_allowed":["octo-org/*","!octo-org/old@*"]}}}""",
            """{"actions":{"allowed_actions":OWN,"selected_actions.patterns_allowed":OWN}}""");
        var patterns = Find(editor, "selected_actions.patterns_allowed");
        Assert.Equal(("octo-org/*\n!octo-org/old@*", true), (patterns.Typed, patterns.IsList));

        // Blank lines and spaces around a pattern change nothing.
        patterns.Typed = " octo-org/*\n\n!octo-org/old@* \n";
        Assert.False(patterns.Pending);
        // Commas separate patterns too, as GitHub's box writes them.
        patterns.Typed = "octo-org/*, actions/checkout@v5\n!octo-org/old@*";
        Assert.Equal("Changed", patterns.Note);
        // More patterns than GitHub takes is held back until fixed.
        var many = string.Join('\n', Enumerable.Range(0, 1001).Select(index => $"octo-org/a{index}"));
        patterns.Typed = many;
        Assert.Equal(("GitHub takes at most 1000 patterns.", false), (patterns.TypedProblem, editor.SaveCommand.CanExecute(null)));
        patterns.Typed = "octo-org/*, actions/checkout@v5\n!octo-org/old@*";
        Assert.Null(patterns.TypedProblem);

        var save = $"profile {own} --set actions.selected_actions.patterns_allowed=[\"octo-org/*\",\"actions/checkout@v5\",\"!octo-org/old@*\"] --json";
        cli.On(save, resolved);
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.Null(editor.SaveError);
    }

    [AvaloniaFact]
    public async Task Emptying_the_pattern_list_allows_none_and_a_draft_of_patterns_reads_with_commas()
    {
        var (editor, cli, own, resolved) = await OpenOwn(
            """{"actions":{"allowed_actions":"selected","selected_actions":{"patterns_allowed":["a/*","c/*"]}}}""",
            """{"actions":{"allowed_actions":OWN,"selected_actions.patterns_allowed":OWN}}""");
        var patterns = Find(editor, "selected_actions.patterns_allowed");

        // An emptied box is a list of none, which differs from leaving the patterns out.
        patterns.Typed = "";
        Assert.Equal("Changed", patterns.Note);
        var empty = $"profile {own} --set actions.selected_actions.patterns_allowed=[] --json";
        cli.On(empty, resolved);
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(empty, cli.Calls);

        // A drafted list says what applies now with commas, not line breaks.
        cli.On($"profile {own} --json", $$$"""
            {"chain":[{{{Json(own)}}}],
             "profile":{"actions":{"allowed_actions":"selected","selected_actions":{"patterns_allowed":["a/*","c/*"]} } },
             "drafts":{"actions":{"selected_actions":{"patterns_allowed":["a/*","b/*"]} } },
             "warnings":[],
             "sources":{"repository":{},"merge":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},
               "rulesets":{},"environments":{},"labels":{},
               "actions":{"allowed_actions":{{{Json(own)}}},"selected_actions.patterns_allowed":{{{Json(own)}}} },
               "drafts":{"repository":{},"merge":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},
                 "rulesets":{},"environments":{},"labels":{},
                 "actions":{"selected_actions.patterns_allowed":{{{Json(own)}}} } } } }
            """);
        await editor.LoadCommand.ExecuteAsync(null);
        patterns = Find(editor, "selected_actions.patterns_allowed");
        Assert.Equal(("a/*\nb/*", "In the draft. Applies now: a/*, c/*"), (patterns.Typed, patterns.Note));
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
        editor.ResetCommand.Execute(null);
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
        // The entry tells its view that everything changed, its note included.
        Assert.Contains(string.Empty, told);
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
        var client = new RepottedClient(cli);
        var editor = new ProfileViewModel(
            client,
            new ProfileListingDocument("orgs", own, null, null),
            ProfileStore.Profile(client, new ProfileFolder(client, folders.Settings)) with
            {
                Write = write =>
                {
                    File.AppendAllText(own, "# pulled by a sync\n");
                    return write();
                },
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
        Assert.False(editor.ResetCommand.CanExecute(null));
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

    [AvaloniaFact]
    public async Task The_labels_tab_shows_each_label_on_its_color_and_saves_renames()
    {
        var (editor, cli, own, resolved) = await OpenOwn(
            """
            {"labels":[
              {"name":"type: bug","color":"D73A4A","description":"Something isn't working","renamed_from":["bug"]},
              {"name":"help","color":"fef2c0"},
              {"name":"wontfix","absent":true},
              {"name":"good first issue","description":"Good for newcomers"}]}
            """,
            """{"labels":{"type: bug":OWN,"help":OWN,"wontfix":OWN,"good first issue":BASE}}""");
        var labels = editor.Tab("Labels");

        Assert.Equal(4, labels.Count);
        Assert.Equal(
            [
                "type: bug d73a4a #ffffff Something isn't working: Renames bug where a repository still has it",
                "help fef2c0 #14281a : Set here",
                "wontfix  #14281a : Removed from GitHub here",
                "good first issue  #14281a Good for newcomers: From base",
            ],
            labels.Entries.Select(entry => $"{entry.Name} {entry.Hex} {entry.Ink} {entry.Description}: {entry.Note}"));

        // An old name one label lists can't be another's, and a name GitHub matches without case is taken.
        var help = (LabelEditorViewModel)labels.Entries[1].Editor;
        help.RenamedFrom = "BUG";
        Assert.Equal("type: bug already lists BUG in Renamed from.", labels.Entries[1].Note);
        help.RenamedFrom = "";
        help.Name = "WONTFIX";
        Assert.Equal("The profile already has a label named WONTFIX.", labels.Entries[1].Note);

        // A removed label's name counts too, and each label hears when another claims its name.
        var wontfix = labels.Entries[2].Editor;
        var rechecked = 0;
        wontfix.PropertyChanged += (_, e) => rechecked += e.PropertyName == nameof(EntryEditorViewModel.Problem) ? 1 : 0;
        help.Name = "help";
        help.RenamedFrom = "wontfix";
        Assert.Equal("The profile has a label named wontfix, so it can't be an old name.", labels.Entries[1].Note);
        Assert.Equal("help lists wontfix in Renamed from, so no label can be named that.", wontfix.Problem);
        Assert.True(rechecked > 0);
        help.RenamedFrom = "";
        Assert.Null(wontfix.Problem);

        // Renaming offers to rename on GitHub too, which the save writes after dropping the old name.
        help.Name = "needs help";
        help.AddOldNameCommand.Execute(null);
        Assert.Equal(("Changed, not saved yet", "Renames help where a repository still has it"), (labels.Entries[1].Note, labels.Entries[1].Renaming));
        labels.NewCommand.Execute(null);
        var priority = (LabelEditorViewModel)labels.Editing!.Editor;
        priority.Name = "priority: high";
        priority.PickCommand.Execute("b60205");
        var save = $$"""profile {{own}} --label={"name":"priority: high","color":"b60205"} --drop-label=help --label={"name":"needs help","color":"fef2c0","renamed_from":["help"]} --json""";
        cli.On(save, resolved);
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
        Assert.Null(editor.SaveError);
    }

    /// <summary>
    /// Opens orgs.yaml as it resolves to <paramref name="profile"/>, with each
    /// section's sources as <paramref name="sources"/> gives them, where OWN
    /// stands for orgs.yaml and BASE for base.yaml. It extends base.yaml, which
    /// resolved alone sets nothing it shows.
    /// </summary>
    private async Task<(ProfileViewModel Editor, FakeCli Cli, string Own, string Resolved)> OpenOwn(string profile, string sources)
    {
        var @base = folders.Write("base.yaml", "repository: {}\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        var given = JsonNode.Parse(sources
            .Replace("OWN", Json(own), StringComparison.Ordinal)
            .Replace("BASE", Json(@base), StringComparison.Ordinal))!.AsObject();
        var all = new JsonObject();
        var drafts = new JsonObject();
        foreach (var section in (string[])["repository", "merge", "actions", "security", "custom_properties", "pages", "autolinks", "rulesets", "environments", "labels"])
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
