using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>The profiles page: its folder, removed files, and questions about unsaved changes.</summary>
public sealed class ProfilesTests : ViewModelTests
{
    private static string OnlyBase(string @base) =>
        $$$"""{"profiles":[{"name":"base","file":{{{Json(@base)}}},"extends":null,"problem":null}]}""";

    [AvaloniaFact]
    public async Task Edits_to_a_profile_whose_file_is_removed_stay_and_a_save_puts_it_back()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var text = File.ReadAllText(files.Own);
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Same(editor, profiles.Current);
        Assert.True(editor.Removed);
        Assert.True(editor.HasChanges);
        Assert.False(editor.ReloadCommand.CanExecute(null));
        var item = profiles.Items.Single(item => item.Name == "orgs");
        Assert.Equal("Removed, edits not saved", item.Note);
        Assert.DoesNotContain(profiles.Usable, usable => usable.Name == "orgs");

        // The save writes the file back as it was read, then applies the edits to it.
        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        string? restored = null;
        cli.On(save, () =>
        {
            restored = File.ReadAllText(files.Own);
            return Documents.Resolved(files.Own, files.Base, wiki: true);
        });
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Equal(text, restored);
        Assert.Null(editor.SaveError);
        Assert.False(editor.Removed);
        Assert.Equal("extends base", profiles.Items.Single(item => item.Name == "orgs").Note);
    }

    [AvaloniaFact]
    public async Task Discarding_the_edits_to_a_removed_profile_lets_it_go()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.Removed);

        editor.ResetCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["base"], profiles.Items.Select(item => item.Name));
        Assert.NotSame(editor, profiles.Current);
    }

    [AvaloniaFact]
    public async Task A_save_to_a_file_removed_since_the_last_refresh_says_so_before_it_puts_it_back()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        cli.Calls.Clear();

        await editor.SaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(editor.Removed);
        Assert.DoesNotContain(cli.Calls, call => call.StartsWith($"profile {files.Own}", StringComparison.Ordinal));
        Assert.False(File.Exists(files.Own));
        Assert.Equal("Removed, edits not saved", profiles.Items.Single(item => item.Name == "orgs").Note);

        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.True(File.Exists(files.Own));
        Assert.False(editor.Removed);
    }

    [AvaloniaFact]
    public async Task A_save_that_fails_after_putting_a_removed_file_back_takes_it_away_again()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        cli.On(
            $"profile {files.Own} --set repository.has_wiki=true --json",
            """{"error":{"kind":"error","message":"The file could not be written"}}""",
            exitCode: 1);

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);
        Assert.False(File.Exists(files.Own));
        Assert.True(editor.Removed);
    }

    [AvaloniaFact]
    public async Task A_save_that_fails_keeps_a_removed_file_that_came_back_before_a_refresh()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var text = File.ReadAllText(files.Own);
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        File.WriteAllText(files.Own, text);
        cli.On(
            $"profile {files.Own} --set repository.has_wiki=true --json",
            """{"error":{"kind":"error","message":"The file could not be written"}}""",
            exitCode: 1);

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);
        Assert.Equal(text, File.ReadAllText(files.Own));
        Assert.False(editor.Removed);
    }

    [AvaloniaFact]
    public async Task A_removed_file_that_came_back_as_something_else_before_a_refresh_asks_before_a_save()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        File.WriteAllText(files.Own, "repository: {}\n");
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.DoesNotContain(save, cli.Calls);
        Assert.Equal("repository: {}\n", File.ReadAllText(files.Own));
        Assert.False(editor.Removed);
        Assert.StartsWith("orgs.yaml is back in the folder, but not as you opened it", editor.OutOfDateMessage, StringComparison.Ordinal);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("extends base", profiles.Items.Single(item => item.Name == "orgs").Note);

        // Keep mine saves over it only once the user has seen the question.
        await editor.KeepMineCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task A_change_to_the_base_stops_a_save_of_a_removed_profile_with_only_keep_mine()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var text = File.ReadAllText(files.Own);
        var rulesets = editor.Tab("Rulesets");
        rulesets.Entries[0].OpenCommand.Execute(null);
        ((RulesetEditorViewModel)rulesets.Entries[0].Editor).Enforcement.Options[1].ChooseCommand.Execute(null);
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        File.AppendAllText(files.Base, "# changed by a sync\n");
        cli.Calls.Clear();

        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Empty(cli.Calls);
        Assert.False(File.Exists(files.Own));
        Assert.True(editor.Removed);
        Assert.True(editor.OutOfDate);
        Assert.False(editor.ReloadCommand.CanExecute(null));
        Assert.DoesNotContain("Reload", editor.OutOfDateMessage, StringComparison.Ordinal);
        Assert.True(editor.KeepMineCommand.CanExecute(null));

        // Once the file is listed again, the message offers Reload, and says so to the view.
        File.WriteAllText(files.Own, text);
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        var told = new List<string?>();
        editor.PropertyChanged += (_, e) => told.Add(e.PropertyName);
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.False(editor.Removed);
        Assert.Contains(nameof(ProfileViewModel.OutOfDateMessage), told);
        Assert.Contains("Reload", editor.OutOfDateMessage, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Keep_mine_on_a_removed_profile_asks_again_when_the_file_came_back_as_something_else()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var rulesets = editor.Tab("Rulesets");
        rulesets.Entries[0].OpenCommand.Execute(null);
        ((RulesetEditorViewModel)rulesets.Entries[0].Editor).Enforcement.Options[1].ChooseCommand.Execute(null);
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        File.AppendAllText(files.Base, "# changed by a sync\n");
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.True(editor is { Removed: true, OutOfDate: true });
        File.WriteAllText(files.Own, "repository: {}\n");
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        cli.Calls.Clear();

        await editor.KeepMineCommand.ExecuteAsync(null);

        Assert.DoesNotContain(cli.Calls, call => call.StartsWith($"profile {files.Own} --", StringComparison.Ordinal));
        Assert.Equal("repository: {}\n", File.ReadAllText(files.Own));
        Assert.StartsWith("orgs.yaml is back in the folder, but not as you opened it", editor.OutOfDateMessage, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_removed_file_that_comes_back_as_something_else_asks_before_any_save()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.Removed);

        // Such as a new profile of the same name.
        File.WriteAllText(files.Own, "repository: {}\n");
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.False(editor.Removed);
        Assert.True(editor.OutOfDate);
        Assert.StartsWith("orgs.yaml is back in the folder, but not as you opened it", editor.OutOfDateMessage, StringComparison.Ordinal);

        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        await editor.SaveCommand.ExecuteAsync(null);
        Assert.DoesNotContain(save, cli.Calls);
        Assert.True(editor.OutOfDate);

        await editor.KeepMineCommand.ExecuteAsync(null);
        Assert.Contains(save, cli.Calls);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task A_removed_file_that_comes_back_as_it_was_keeps_the_edits_without_asking()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var text = File.ReadAllText(files.Own);
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);

        File.WriteAllText(files.Own, text);
        cli.On(folders.List(), Documents.Profiles(files.Own, files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Same(editor, profiles.Current);
        Assert.False(editor.Removed);
        Assert.False(editor.OutOfDate);
        Assert.True(editor.HasChanges);
        Assert.Equal("extends base", profiles.Items.Single(item => item.Name == "orgs").Note);
    }

    [AvaloniaFact]
    public async Task A_removed_profile_shows_only_that_it_is_removed()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        File.AppendAllText(files.Own, "# pulled by a sync\n");
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.OutOfDate);

        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.True(editor.Removed);
        Assert.False(editor.OutOfDate);
    }

    [AvaloniaFact]
    public async Task Another_folder_starts_without_the_editors_of_the_last()
    {
        var (profiles, cli, files) = await OpenOrgs();
        Choose(profiles.Current!, "has_wiki", "On");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await change.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Empty(profiles.Items);
        Assert.Null(profiles.Current);
        Assert.True(File.Exists(files.Own));
    }

    [AvaloniaFact]
    public async Task Changing_the_folder_asks_about_unsaved_changes_first()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        // Cancel stays in the folder with the change kept.
        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        Assert.Equal("orgs has unsaved changes. Save them before you change the folder?", profiles.LeavingMessage);
        profiles.StayHereCommand.Execute(null);
        await change;
        Assert.False(profiles.HasLeaving);
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        Assert.True(editor.HasChanges);

        // Discard drops the change and goes on.
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await change;
        Assert.Equal(other, profiles.Folder.Path);
        Assert.False(editor.HasChanges);
        Assert.Equal((Path.GetFileName(other), Path.GetDirectoryName(other)), (profiles.Folder.SourceName, profiles.Folder.SourceDetail));
        Assert.Equal("extends: base.yaml\nrepository: { has_wiki: false }\n", File.ReadAllText(files.Own));
    }

    [AvaloniaFact]
    public async Task Save_settles_the_changes_before_the_folder_changes_and_a_failed_save_stays()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);
        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, """{"error":{"kind":"error","message":"The file could not be written"}}""", exitCode: 1);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);
        Assert.Same(editor, profiles.Current);

        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Contains(save, cli.Calls);
        Assert.Equal(other, profiles.Folder.Path);
    }

    [AvaloniaFact]
    public async Task Connecting_a_repository_asks_about_unsaved_changes_first()
    {
        var (profiles, _, _) = await OpenOrgs();
        Choose(profiles.Current!, "has_wiki", "On");

        var start = profiles.StartConnectCommand.ExecuteAsync(null);
        Assert.Null(profiles.Connecting);
        Assert.Equal("orgs has unsaved changes. Save them before you connect a repository?", profiles.LeavingMessage);
        profiles.StayHereCommand.Execute(null);
        await start;
        Assert.Null(profiles.Connecting);

        start = profiles.StartConnectCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await start;
        Assert.NotNull(profiles.Connecting);
    }

    [AvaloniaFact]
    public async Task A_second_way_out_takes_over_the_question_and_the_first_stays()
    {
        var (profiles, cli, _) = await OpenOrgs();
        Choose(profiles.Current!, "has_wiki", "On");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        var start = profiles.StartConnectCommand.ExecuteAsync(null);

        await change.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        Assert.Equal("orgs has unsaved changes. Save them before you connect a repository?", profiles.LeavingMessage);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await start;
        Assert.NotNull(profiles.Connecting);
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
    }

    [AvaloniaTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_removed_profile_with_edits_is_asked_about_before_the_folder_changes(bool save)
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.Removed);
        cli.On($"profile {files.Own} --set repository.has_wiki=true --json", Documents.Resolved(files.Own, files.Base, wiki: true));
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.Equal("orgs has unsaved changes. Save them before you change the folder?", profiles.LeavingMessage);
        if (save)
        {
            await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        }
        else
        {
            profiles.DiscardAndLeaveCommand.Execute(null);
        }
        await change.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(other, profiles.Folder.Path);
        // Save puts the file back with the edits; Discard lets it go.
        Assert.Equal(save, File.Exists(files.Own));
    }

    [AvaloniaFact]
    public async Task The_question_waits_while_its_save_runs()
    {
        var (profiles, cli, files) = await OpenOrgs();
        Choose(profiles.Current!, "has_wiki", "On");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);
        var written = new TaskCompletionSource<string>();
        cli.On($"profile {files.Own} --set repository.has_wiki=true --json", _ => written.Task);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        var save = profiles.SaveAndLeaveCommand.ExecuteAsync(null);

        Assert.False(profiles.SaveAndLeaveCommand.CanExecute(null));
        Assert.False(profiles.DiscardAndLeaveCommand.CanExecute(null));
        Assert.False(profiles.StayHereCommand.CanExecute(null));
        written.SetResult(Documents.Resolved(files.Own, files.Base, wiki: true));
        await save;
        await change;
        Assert.Equal(other, profiles.Folder.Path);
        Assert.True(profiles.StayHereCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_failed_save_opens_the_profile_it_could_not_save_even_under_a_search()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        cli.On(
            $"profile {files.Own} --set repository.has_wiki=true --json",
            """{"error":{"kind":"error","message":"The file could not be written"}}""",
            exitCode: 1);
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        // Another profile is open.
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Same(editor, profiles.Current);
        Assert.Equal("orgs", profiles.Selected?.Name);

        // The search hides it.
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        profiles.Filter = "base";
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Same(editor, profiles.Current);
        Assert.True(profiles.ShowProfile);
        Assert.Equal(folders.Profiles, profiles.Folder.Path);

        // Over a new profile form, it still comes into view.
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        profiles.StartNew(null);
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Same(editor, profiles.Current);
        Assert.False(profiles.ShowCreating);
        Assert.True(profiles.ShowProfile);
    }

    [AvaloniaFact]
    public async Task Discard_stays_while_a_profile_is_still_loading()
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
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);

        await change;
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        resolve.SetResult(Documents.Resolved(files.Own, files.Base));
        await reload;
    }

    [AvaloniaFact]
    public async Task Cancelling_a_quit_keeps_a_new_profile_form()
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => Task.CompletedTask);
        await shell.RefreshAsync();
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        Choose(shell.Profiles.Current!, "has_wiki", "On");
        shell.Profiles.StartNew(null);
        var form = shell.Profiles.Creating!;
        form.Name = "half typed";

        var quit = shell.ConfirmQuitAsync();
        Assert.Same(form, shell.Profiles.Creating);
        shell.Profiles.StayHereCommand.Execute(null);

        Assert.False(await quit);
        Assert.Same(form, shell.Profiles.Creating);
        Assert.Equal("half typed", form.Name);
    }

    [AvaloniaFact]
    public async Task Discarding_puts_rulesets_and_environments_back()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        var (rulesets, environments) = (editor.Tab("Rulesets"), editor.Tab("Environments"));
        rulesets.Entries[1].OpenCommand.Execute(null);
        rulesets.Entries[1].Editor.Name = "Retired tags";
        environments.Entries[0].DropCommand.Execute(null);
        environments.NewCommand.Execute(null);

        editor.ResetCommand.Execute(null);

        Assert.False(editor.HasChanges);
        Assert.Null(rulesets.Editing);
        Assert.Null(environments.Editing);
        Assert.Equal(["Protect main", "Old tags"], rulesets.Entries.Select(entry => entry.Name));
        Assert.False(rulesets.Entries[1].Opened);
        Assert.Equal(["npm: Set here"], environments.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
    }

    [AvaloniaFact]
    public async Task A_save_the_command_line_refuses_keeps_the_edits()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        cli.On(
            $"profile {files.Own} --set merge.allow_rebase_merge=false --json",
            """{"error":{"kind":"error","message":"Every merge method is off"}}""",
            exitCode: 1);

        Choose(editor, "allow_rebase_merge", "Off");
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains("Every merge method is off", editor.SaveError, StringComparison.Ordinal);
        Assert.Equal(1, editor.ChangeCount);

        editor.ResetCommand.Execute(null);
        Assert.False(editor.HasChanges);
        Assert.Null(editor.SaveError);
    }

    [AvaloniaFact]
    public async Task Refreshing_keeps_unsaved_edits_and_reloads_the_rest()
    {
        var (profiles, _, _) = await OpenOrgs();
        Choose(profiles.Current!, "has_wiki", "On");
        var edited = profiles.Current;
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var untouched = profiles.Current;

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Equal("base", profiles.Selected?.Name);
        Assert.NotSame(untouched, profiles.Current);
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        Assert.Same(edited, profiles.Current);
        Assert.True(profiles.Current!.HasChanges);
    }

    [AvaloniaFact]
    public async Task Changing_the_folder_is_remembered()
    {
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        var desktop = new FakeDesktop { Folder = other };
        var cli = new FakeCli().On(folders.List(), Documents.NoProfiles).On(folders.List(other), Documents.NoProfiles);
        var profiles = new ProfilesViewModel(new RepottedClient(cli), desktop, folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);

        await profiles.ChangeFolderCommand.ExecuteAsync(null);

        Assert.Equal(other, profiles.Folder.Path);
        Assert.Equal(other, folders.Settings.Load().ProfilesFolder);
        Assert.True(profiles.ShowEmpty);
        Assert.Equal($"No profiles in {other} yet.", profiles.Folder.EmptyMessage);
    }

    [AvaloniaFact]
    public async Task Choosing_after_a_removal_shows_the_new_value()
    {
        var (profiles, _, _) = await OpenOrgs();
        var wiki = Find(profiles.Current!, "has_wiki");
        wiki.ResetCommand.Execute(null);
        // Base leaves the wiki out, so removing it leaves it unmanaged.
        Assert.Equal("Removed when saved", wiki.Note);
        Assert.False(wiki.Managed);
        var raised = new List<string?>();
        wiki.PropertyChanged += (_, e) => raised.Add(e.PropertyName);

        wiki.Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);

        // The row tells its view that everything changed, its note and where its value comes from included.
        Assert.Contains(string.Empty, raised);
        Assert.True(wiki.OwnAfterSave);
        Assert.Equal("Changed", wiki.Note);
    }

    [AvaloniaFact]
    public async Task A_file_listed_under_two_names_opens_once()
    {
        var file = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var listing = $$"""{"profiles":[{"name":"alias","file":{{Json(file)}},"extends":null,"problem":null},{"name":"base","file":{{Json(file)}},"extends":null,"problem":null}]}""";
        var cli = new FakeCli().On(folders.List(), listing).On($"profile {file} --json", Documents.ResolvedBase(file));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Null(profiles.Error);
        Assert.Equal(["alias", "base"], profiles.Items.Select(item => item.Name));
        Assert.Equal(file, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task A_slow_listing_of_the_old_folder_does_not_replace_the_new_one()
    {
        var own = folders.Write("orgs.yaml", "repository: { has_wiki: false }\n");
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        var slow = new TaskCompletionSource();
        var cli = new FakeCli()
            .OnceReady(folders.List(), $$"""{"profiles":[{"name":"orgs","file":{{Json(own)}},"extends":null,"problem":null}]}""", slow.Task)
            .On(folders.List(other), Documents.NoProfiles);
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop { Folder = other }, folders.Settings, () => []);

        var first = profiles.RefreshAsync();
        await profiles.ChangeFolderCommand.ExecuteAsync(null);
        slow.SetResult();
        await first;

        Assert.Equal(other, profiles.Folder.Path);
        Assert.Empty(profiles.Items);
        Assert.False(profiles.Loading);
    }

    [AvaloniaFact]
    public async Task Closing_a_profile_without_changes_leaves_none_open_through_a_refresh()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        Assert.True(editor.CanClose);

        await editor.CloseCommand.ExecuteAsync(null);

        Assert.False(profiles.HasLeaving);
        Assert.Null(profiles.Current);
        Assert.Null(profiles.Selected);
        Assert.True(profiles.ShowNoneOpen);
        Assert.False(profiles.ShowProfile);

        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);

        // Choosing a profile opens it, and a refresh then keeps it open.
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        Assert.Equal("base", profiles.Current?.Name);
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Equal("base", profiles.Current?.Name);
    }

    [AvaloniaFact]
    public async Task Closing_a_profile_with_changes_asks_about_it_alone_and_cancel_keeps_it_open()
    {
        var (profiles, _, _) = await OpenOrgs();
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var other = profiles.Current!;
        Choose(other, "has_issues", "Off");
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        var close = editor.CloseCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        Assert.Equal("orgs has unsaved changes. Save them before you close it?", profiles.LeavingMessage);
        profiles.StayHereCommand.Execute(null);
        await close;

        Assert.False(profiles.HasLeaving);
        Assert.Same(editor, profiles.Current);
        Assert.True(editor.HasChanges);
        Assert.True(other.HasChanges);
    }

    [AvaloniaFact]
    public async Task Discard_on_closing_drops_only_that_profiles_changes()
    {
        var (profiles, _, files) = await OpenOrgs();
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var other = profiles.Current!;
        Choose(other, "has_issues", "Off");
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        var close = editor.CloseCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await close;

        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
        Assert.False(editor.HasChanges);
        Assert.True(other.HasChanges);
        Assert.Equal("extends: base.yaml\nrepository: { has_wiki: false }\n", File.ReadAllText(files.Own));
    }

    [AvaloniaFact]
    public async Task Save_on_closing_closes_once_saved_and_a_failed_save_stays_open()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        var save = $"profile {files.Own} --set repository.has_wiki=true --json";
        cli.On(save, """{"error":{"kind":"error","message":"The file could not be written"}}""", exitCode: 1);

        var close = editor.CloseCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await close;
        Assert.Same(editor, profiles.Current);
        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);

        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        close = editor.CloseCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await close;
        Assert.Contains(save, cli.Calls);
        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
    }

    [AvaloniaFact]
    public async Task Opening_another_profile_takes_back_the_question_about_closing()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        var close = editor.CloseCommand.ExecuteAsync(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        await close.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(profiles.HasLeaving);
        Assert.Equal("base", profiles.Current?.Name);
        Assert.True(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task A_way_out_while_closing_asks_about_every_profile()
    {
        var (profiles, cli, files) = await OpenOrgs();
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var other = profiles.Current!;
        Choose(other, "has_issues", "Off");
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        var folder = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(folder);
        orgsDesktop.Folder = folder;
        cli.On(folders.List(folder), Documents.NoProfiles);

        var close = editor.CloseCommand.ExecuteAsync(null);
        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await close.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Same(editor, profiles.Current);
        Assert.Equal("base and orgs have unsaved changes. Save them before you change the folder?", profiles.LeavingMessage);

        profiles.DiscardAndLeaveCommand.Execute(null);
        await change;
        Assert.False(other.HasChanges);
        Assert.False(editor.HasChanges);
        Assert.Equal(folder, profiles.Folder.Path);
        Assert.True(File.Exists(files.Own));
    }

    [AvaloniaFact]
    public async Task The_new_profile_form_takes_back_the_question_about_closing()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        var close = editor.CloseCommand.ExecuteAsync(null);
        profiles.StartNew(null);
        await close.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(profiles.HasLeaving);
        Assert.True(profiles.ShowCreating);
        Assert.True(editor.HasChanges);
    }

    [AvaloniaFact]
    public async Task A_refresh_while_closing_keeps_the_profile_and_the_question()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        var close = editor.CloseCommand.ExecuteAsync(null);
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        Assert.Same(editor, profiles.Current);

        profiles.DiscardAndLeaveCommand.Execute(null);
        await close;
        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
    }

    [AvaloniaFact]
    public async Task Discard_on_closing_a_removed_profile_leaves_none_open()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), OnlyBase(files.Base));
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.Removed);

        var close = editor.CloseCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await close.WaitAsync(TimeSpan.FromSeconds(5));
        // Discarding a removed profile's edits lists the folder again, which opens nothing in its place.
        await Until(() => !profiles.Loading && profiles.Items.All(item => item.Name != "orgs"));

        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
    }

    [AvaloniaFact]
    public async Task Choosing_a_folder_after_closing_opens_its_first_profile()
    {
        var (profiles, _, _) = await OpenOrgs();
        await profiles.Current!.CloseCommand.ExecuteAsync(null);
        orgsDesktop.Folder = folders.Profiles;

        await profiles.ChangeFolderCommand.ExecuteAsync(null);

        Assert.NotNull(profiles.Current);
        Assert.False(profiles.ShowNoneOpen);
    }

    /// <summary>base in the folder, oss in team over base, and web in team/apps over oss.</summary>
    private (FakeCli Cli, string Base, string Oss, string Web) Nested()
    {
        Directory.CreateDirectory(Path.Combine(folders.Profiles, "team", "apps"));
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var oss = folders.Write(Path.Combine("team", "oss.yaml"), "extends: ../base.yaml\n");
        var web = folders.Write(Path.Combine("team", "apps", "web.yaml"), "extends: ../oss.yaml\n");
        var cli = new FakeCli()
            .On(folders.List(), $$$"""
                {"profiles":[
                  {"name":"base","folder":"","file":{{{Json(@base)}}},"extends":null,"problem":null},
                  {"name":"oss","folder":"team","file":{{{Json(oss)}}},"extends":{{{Json(@base)}}},"problem":null},
                  {"name":"web","folder":"team/apps","file":{{{Json(web)}}},"extends":{{{Json(oss)}}},"problem":null}
                ]}
                """)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base))
            .On($"profile {oss} --json", Documents.ResolvedBase(oss))
            .On($"profile {web} --json", Documents.ResolvedBase(web));
        return (cli, @base, oss, web);
    }

    [AvaloniaFact]
    public async Task Profiles_in_subfolders_show_under_their_folders_after_the_folders_own_profiles()
    {
        var (cli, _, _, _) = Nested();
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Equal(["base", "team/oss", "team/apps/web"], profiles.Items.Select(item => item.Label));
        Assert.Equal("base", Assert.IsType<ProfileItemViewModel>(profiles.Tree[0]).Name);
        var team = Assert.IsType<ProfileFolderNode>(Assert.Single(profiles.Tree.Skip(1)));
        Assert.Equal(("team", "team", 2, true), (team.Name, team.Path, team.Count, team.IsExpanded));
        Assert.Equal("oss", Assert.IsType<ProfileItemViewModel>(team.Children[0]).Name);
        var apps = Assert.IsType<ProfileFolderNode>(team.Children[1]);
        Assert.Equal(("apps", "team/apps", 1), (apps.Name, apps.Path, apps.Count));
        var web = Assert.IsType<ProfileItemViewModel>(Assert.Single(apps.Children));
        Assert.Equal("extends team/oss", web.Note);
        Assert.Equal("extends base", profiles.Items.Single(item => item.Name == "oss").Note);
        Assert.Same(profiles.Selected, profiles.SelectedNode);
    }

    [AvaloniaFact]
    public async Task A_closed_subfolder_stays_closed_until_a_profile_in_it_is_chosen()
    {
        var (cli, _, _, _) = Nested();
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);

        ((ProfileFolderNode)profiles.Tree[1]).IsExpanded = false;
        await profiles.RefreshCommand.ExecuteAsync(null);

        var team = (ProfileFolderNode)profiles.Tree[1];
        Assert.False(team.IsExpanded);

        // Choosing a subfolder leaves the open profile open.
        var open = profiles.Selected;
        profiles.SelectedNode = team;
        Assert.Same(open, profiles.Selected);

        profiles.Selected = profiles.Items.Single(item => item.Name == "web");

        Assert.True(team.IsExpanded);
        Assert.True(((ProfileFolderNode)team.Children[1]).IsExpanded);
        Assert.Same(profiles.Selected, profiles.SelectedNode);
        Assert.Equal("web", profiles.Current?.Name);
    }

    [AvaloniaFact]
    public async Task The_filter_matches_subfolders_and_opens_them_without_remembering_it()
    {
        var (cli, _, _, _) = Nested();
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);
        ((ProfileFolderNode)profiles.Tree[1]).IsExpanded = false;

        profiles.Filter = "apps";

        Assert.Equal(["team/apps/web"], profiles.Items.Select(item => item.Label));
        var team = Assert.IsType<ProfileFolderNode>(Assert.Single(profiles.Tree));
        Assert.True(team.IsExpanded);
        // base was open, and the filter hides it, so nothing in the tree is selected.
        Assert.Null(profiles.Selected);
        Assert.Equal("base", profiles.Current?.Name);

        team.IsExpanded = false;
        profiles.Filter = "";

        Assert.False(((ProfileFolderNode)profiles.Tree[1]).IsExpanded);
    }

    [AvaloniaFact]
    public async Task Another_folder_starts_with_its_subfolders_open()
    {
        var (cli, _, _, _) = Nested();
        var other = Path.Combine(Path.GetDirectoryName(folders.Profiles)!, "other");
        Directory.CreateDirectory(Path.Combine(other, "team"));
        var mine = Path.Combine(other, "team", "mine.yaml");
        File.WriteAllText(mine, "repository: { has_issues: true }\n");
        cli.On(folders.List(other), $$$"""{"profiles":[{"name":"mine","folder":"team","file":{{{Json(mine)}}},"extends":null,"problem":null}]}""")
            .On($"profile {mine} --json", Documents.ResolvedBase(mine));
        var desktop = new FakeDesktop { Folder = other };
        var profiles = new ProfilesViewModel(new RepottedClient(cli), desktop, folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);
        ((ProfileFolderNode)profiles.Tree[1]).IsExpanded = false;

        await profiles.ChangeFolderCommand.ExecuteAsync(null);

        var team = Assert.IsType<ProfileFolderNode>(Assert.Single(profiles.Tree));
        Assert.True(team.IsExpanded);
    }

    [AvaloniaFact]
    public async Task A_refresh_leaves_closed_the_subfolder_of_the_open_profile()
    {
        var (cli, _, oss, web) = Nested();
        cli.On($"profile {web} --json", Documents.Resolved(web, oss));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "web");
        ((ProfileFolderNode)profiles.Tree[1]).IsExpanded = false;

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.False(((ProfileFolderNode)profiles.Tree[1]).IsExpanded);
        Assert.Equal("team/apps/web", profiles.Selected?.Label);
        // The editor names its base the way the sidebar does.
        Assert.Equal("team/oss", profiles.Current?.BaseName);

        // Leaving the new profile form chooses it again, and leaves the folder closed too.
        profiles.StartNew(null);
        profiles.CancelNew();

        Assert.Equal("team/apps/web", profiles.Selected?.Label);
        Assert.False(((ProfileFolderNode)profiles.Tree[1]).IsExpanded);
    }

    [AvaloniaFact]
    public async Task A_new_profile_can_go_in_a_subfolder_that_has_no_profiles_yet()
    {
        var (cli, _, _, _) = Nested();
        Directory.CreateDirectory(Path.Combine(folders.Profiles, "infra"));
        Directory.CreateDirectory(Path.Combine(folders.Profiles, ".git", "hooks"));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.StartNew(null);

        Assert.Equal(["Profiles folder", "infra", "team", "team/apps"], profiles.Creating!.Places.Select(place => place.Label));
    }

    [AvaloniaFact]
    public async Task Deleting_a_profile_in_a_subfolder_deletes_that_file_and_names_it_by_its_subfolder()
    {
        var (cli, @base, oss, web) = Nested();
        // A profile of the same name in the folder itself stays.
        var other = folders.Write("oss.yaml", "");
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.Items.Single(item => item.Label == "team/oss").DeleteCommand.Execute(null);

        Assert.Equal("Delete team/oss?", profiles.DeleteQuestion);
        Assert.Equal(
            "This deletes team/oss.yaml from the profiles folder, and it can't be undone. team/apps/web extends it, so it stops loading until it extends another profile.",
            profiles.DeleteDetail);
        cli.On(folders.List(), $$$"""
            {"profiles":[
              {"name":"base","folder":"","file":{{{Json(@base)}}},"extends":null,"problem":null},
              {"name":"web","folder":"team/apps","file":{{{Json(web)}}},"extends":null,"problem":"It extends ../oss.yaml, which is missing"}
            ]}
            """);
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.False(File.Exists(oss));
        Assert.True(File.Exists(other));
        Assert.Equal(["base", "team/apps/web"], profiles.Items.Select(item => item.Label));
    }

    [AvaloniaFact]
    public async Task A_file_linked_into_two_folders_keeps_the_row_asked_about_after_a_refresh()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Making a link on Windows needs Developer Mode.");
        Directory.CreateDirectory(Path.Combine(folders.Profiles, "team"));
        var oss = folders.Write(Path.Combine("team", "oss.yaml"), "repository: { has_issues: true }\n");
        var link = Path.Combine(folders.Profiles, "oss.yaml");
        File.CreateSymbolicLink(link, oss);
        // The CLI lists the real path, so both rows have the same file.
        var cli = new FakeCli()
            .On(folders.List(), $$$"""
                {"profiles":[
                  {"name":"oss","folder":"","file":{{{Json(oss)}}},"extends":null,"problem":null},
                  {"name":"oss","folder":"team","file":{{{Json(oss)}}},"extends":null,"problem":null}
                ]}
                """)
            .On($"profile {oss} --json", Documents.ResolvedBase(oss));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.Items.Single(item => item.Label == "team/oss").DeleteCommand.Execute(null);
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Equal("Delete team/oss?", profiles.DeleteQuestion);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"oss","folder":"","file":{{{Json(link)}}},"extends":null,"problem":"It is a link to a missing file"}]}""");
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.False(File.Exists(oss));
        Assert.NotNull(new FileInfo(link).LinkTarget);
    }
}

