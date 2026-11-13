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
        Assert.NotSame(editor, profiles.Current);
        Assert.False(profiles.HasUnsaved);
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
}
