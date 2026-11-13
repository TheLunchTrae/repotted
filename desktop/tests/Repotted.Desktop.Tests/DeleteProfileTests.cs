using System.Text.Json;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>Deleting a profile: the question, the file it takes, and the sync that commits it.</summary>
public sealed class DeleteProfileTests : ViewModelTests
{
    private static string Listing(params (string Name, string File, string? Extends, string? Problem)[] profiles) =>
        JsonSerializer.Serialize(new { profiles = profiles.Select(profile => new { name = profile.Name, file = profile.File, extends = profile.Extends, problem = profile.Problem }) });

    [AvaloniaFact]
    public async Task Deleting_a_base_names_every_profile_over_it_and_takes_its_file_and_edits()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var team = folders.Write("team.yaml", "extends: orgs.yaml\n");
        cli.On(folders.List(), Listing(("base", files.Base, null, null), ("orgs", files.Own, files.Base, null), ("team", team, files.Own, null)));
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");

        editor.DeleteCommand.Execute(null);

        Assert.True(profiles.AskingDelete);
        Assert.Equal("Delete base?", profiles.DeleteQuestion);
        Assert.Equal(
            "This deletes base.yaml from the profiles folder, and it can't be undone. Your unsaved changes to it are discarded. orgs and team extend it, directly or through another profile, so they stop loading until they extend another profile.",
            profiles.DeleteDetail);
        Assert.True(File.Exists(files.Base));

        cli.On(folders.List(), Listing(("orgs", files.Own, null, "Cannot read base.yaml"), ("team", team, files.Own, null)));
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.False(File.Exists(files.Base));
        Assert.True(File.Exists(files.Own));
        Assert.False(profiles.AskingDelete);
        Assert.Equal(["orgs", "team"], profiles.Items.Select(item => item.Name));
        // The deleted profile was open, so none opens in its place.
        Assert.Null(profiles.Current);
        Assert.False(profiles.HasUnsaved);
    }

    [AvaloniaFact]
    public async Task Deleting_another_profile_leaves_the_open_one_open()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Assert.Equal("orgs", editor.Name);

        profiles.Items.Single(item => item.Name == "base").DeleteCommand.Execute(null);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"orgs","file":{{{Json(files.Own)}}},"extends":null,"problem":"Cannot read base.yaml"}]}""");
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.False(File.Exists(files.Base));
        Assert.Equal("orgs", profiles.Current?.Name);
    }

    [AvaloniaFact]
    public async Task Cancel_keeps_the_profile()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var orgs = profiles.Items.Single(item => item.Name == "orgs");

        orgs.DeleteCommand.Execute(null);
        Assert.Equal("This deletes orgs.yaml from the profiles folder, and it can't be undone.", profiles.DeleteDetail);
        cli.Calls.Clear();
        profiles.CancelDeleteCommand.Execute(null);

        Assert.False(profiles.AskingDelete);
        Assert.False(profiles.ConfirmDeleteCommand.CanExecute(null));
        Assert.True(File.Exists(files.Own));
        Assert.Empty(cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_removed_profile_offers_discard_and_not_delete()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        File.Delete(files.Own);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"base","file":{{{Json(files.Base)}}},"extends":null,"problem":null}]}""");
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.True(editor.Removed);
        Assert.False(editor.DeleteCommand.CanExecute(null));
        Assert.False(profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Deleting_a_linked_profile_takes_the_link_and_leaves_its_file()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Making a link on Windows needs Developer Mode.");
        var elsewhere = Directory.CreateTempSubdirectory("repotted-elsewhere-").FullName;
        try
        {
            var shared = Path.Combine(elsewhere, "shared.yaml");
            File.WriteAllText(shared, "repository: { has_issues: true }\n");
            var link = Path.Combine(folders.Profiles, "linked.yaml");
            File.CreateSymbolicLink(link, shared);
            var cli = new FakeCli()
                .On(folders.List(), Listing(("linked", shared, null, null)))
                .On($"profile {shared} --json", Documents.ResolvedBase(shared));
            var profiles = new ProfilesViewModel(new RepottedClient(cli), orgsDesktop, folders.Settings, () => []);
            await profiles.RefreshCommand.ExecuteAsync(null);

            profiles.Items.Single().DeleteCommand.Execute(null);
            Assert.Equal("This deletes linked.yaml from the profiles folder, and it can't be undone.", profiles.DeleteDetail);
            cli.On(folders.List(), Documents.NoProfiles);
            await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

            Assert.False(File.Exists(link));
            Assert.True(File.Exists(shared));
            Assert.Empty(profiles.Items);
        }
        finally
        {
            Directory.Delete(elsewhere, recursive: true);
        }
    }

    [AvaloniaFact]
    public async Task A_profile_already_gone_is_as_good_as_deleted()
    {
        var (profiles, cli, files) = await OpenOrgs();
        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);
        File.Delete(files.Own);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"base","file":{{{Json(files.Base)}}},"extends":null,"problem":null}]}""");

        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.Null(profiles.Notice);
        Assert.Equal(["base"], profiles.Items.Select(item => item.Name));
    }

    [AvaloniaFact]
    public async Task The_question_waits_while_the_profile_saves()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var slow = new TaskCompletionSource();
        cli.OnceReady($"profile {files.Own} --set repository.has_wiki=true --json", Documents.Resolved(files.Own, files.Base, wiki: true), slow.Task);
        Choose(editor, "has_wiki", "On");
        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);

        var save = editor.SaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.True(editor.Saving);
        Assert.False(editor.DeleteCommand.CanExecute(null));
        Assert.False(profiles.ConfirmDeleteCommand.CanExecute(null));
        slow.SetResult();
        await save;
        Assert.True(profiles.ConfirmDeleteCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task The_question_follows_edits_and_the_list_and_another_question_replaces_it()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);
        Assert.Equal("This deletes orgs.yaml from the profiles folder, and it can't be undone.", profiles.DeleteDetail);

        // An edit made while the question shows is named, and goes from it once undone.
        Choose(editor, "has_wiki", "On");
        Assert.Equal("This deletes orgs.yaml from the profiles folder, and it can't be undone. Your unsaved changes to it are discarded.", profiles.DeleteDetail);
        editor.ResetCommand.Execute(null);
        Assert.Equal("This deletes orgs.yaml from the profiles folder, and it can't be undone.", profiles.DeleteDetail);

        profiles.Items.Single(item => item.Name == "base").DeleteCommand.Execute(null);
        Assert.Equal("Delete base?", profiles.DeleteQuestion);

        // A refresh that no longer lists it takes the question away.
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"orgs","file":{{{Json(files.Own)}}},"extends":null,"problem":"Cannot read base.yaml"}]}""");
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.False(profiles.AskingDelete);
        Assert.True(File.Exists(files.Base));
    }

    [AvaloniaFact]
    public async Task Another_folder_takes_the_question_away()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var other = Directory.CreateTempSubdirectory("repotted-other-").FullName;
        try
        {
            cli.On(folders.List(other), Documents.NoProfiles);
            orgsDesktop.Folder = other;
            profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);

            await profiles.ChangeFolderCommand.ExecuteAsync(null);

            Assert.False(profiles.AskingDelete);
            Assert.False(profiles.ConfirmDeleteCommand.CanExecute(null));
            Assert.True(File.Exists(files.Own));
        }
        finally
        {
            Directory.Delete(other, recursive: true);
        }
    }

    [AvaloniaFact]
    public async Task The_question_waits_while_the_profile_loads()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var slow = new TaskCompletionSource();
        cli.OnceReady($"profile {files.Own} --json", Documents.Resolved(files.Own, files.Base), slow.Task);
        // A refresh reads an editor with no unsaved changes again.
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        Assert.True(editor.Loading);

        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);
        Assert.True(profiles.AskingDelete);
        Assert.False(profiles.ConfirmDeleteCommand.CanExecute(null));

        slow.SetResult();
        await editor.LoadCommand.ExecutionTask!;
        Assert.True(profiles.ConfirmDeleteCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Two_files_that_could_each_be_the_profile_keep_it_and_say_so()
    {
        var one = folders.Write("shared.yaml", "repository: { has_issues: true }\n");
        folders.Write("shared.yml", "repository: { has_issues: false }\n");
        var elsewhere = Path.Combine(Path.GetTempPath(), "elsewhere", "real.yaml");
        var cli = new FakeCli()
            .On(folders.List(), Listing(("shared", elsewhere, null, null)))
            .On($"profile {elsewhere} --json", Documents.ResolvedBase(elsewhere));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), orgsDesktop, folders.Settings, () => []);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current;

        profiles.Items.Single().DeleteCommand.Execute(null);
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.Equal("Repotted could not delete shared: Repotted could not tell which file in the folder is shared.", profiles.Notice);
        Assert.True(File.Exists(one));
        Assert.Same(editor, profiles.Current);
        Assert.False(profiles.AskingDelete);
    }

    [AvaloniaFact]
    public async Task A_file_that_can_not_be_deleted_stays_with_its_edits()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Only Windows keeps an open file from being deleted.");
        var (profiles, _, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);

        using (new FileStream(files.Own, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            await profiles.ConfirmDeleteCommand.ExecuteAsync(null);
        }

        Assert.StartsWith("Repotted could not delete orgs: ", profiles.Notice, StringComparison.Ordinal);
        Assert.True(File.Exists(files.Own));
        Assert.Same(editor, profiles.Current);
        Assert.True(editor.HasChanges);
        Assert.False(profiles.DeleteRunning);
    }

    [AvaloniaFact]
    public async Task Deleting_a_profile_takes_back_the_question_about_closing_it()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        Choose(editor, "has_wiki", "On");
        var close = editor.CloseCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);

        profiles.Items.Single(item => item.Name == "orgs").DeleteCommand.Execute(null);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"base","file":{{{Json(files.Base)}}},"extends":null,"problem":null}]}""");
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);
        await close;

        Assert.False(profiles.HasLeaving);
        Assert.False(File.Exists(files.Own));
        Assert.Equal(["base"], profiles.Items.Select(item => item.Name));
        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
    }
}
