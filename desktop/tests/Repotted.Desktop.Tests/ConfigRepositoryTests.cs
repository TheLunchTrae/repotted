using System.Text.Json;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>Profiles kept in a GitHub repository: connecting one, syncing it, and settling conflicts.</summary>
public sealed class ConfigRepositoryTests : IDisposable
{
    private readonly Folders folders = new();

    public void Dispose() => folders.Dispose();

    private string WorkingCopy(string path = "") => folders.Settings.ConfigFolder("lunch/config", path);

    private static string Sync(
        string path = "",
        IReadOnlyList<string>? pulled = null,
        IReadOnlyList<string>? pushed = null,
        IReadOnlyList<string>? conflicts = null) =>
        JsonSerializer.Serialize(new
        {
            repository = "lunch/config",
            path,
            branch = "main",
            commit = "abc123",
            pulled = pulled ?? [],
            pushed = pushed ?? [],
            conflicts = conflicts ?? [],
        });

    private static string Command(string folder, string extra = "") => $"sync {folder}{extra} --json";

    /// <summary>A working copy that has synced once, as the CLI leaves it.</summary>
    private string Synced(string path = "")
    {
        var folder = WorkingCopy(path);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, ".repotted-sync.json"), "{}");
        return folder;
    }

    /// <summary>Records <paramref name="files"/> as the last sync left them, by their git blob ids.</summary>
    private static void Record(string copy, params string[] files)
    {
        static string Blob(string file)
        {
            var content = File.ReadAllBytes(file);
#pragma warning disable CA5350 // Git names a blob by its SHA-1.
            return Convert.ToHexStringLower(System.Security.Cryptography.SHA1.HashData([.. System.Text.Encoding.ASCII.GetBytes($"blob {content.Length}\0"), .. content]));
#pragma warning restore CA5350
        }
        File.WriteAllText(
            Path.Combine(copy, ".repotted-sync.json"),
            JsonSerializer.Serialize(new { files = files.ToDictionary(file => Path.GetFileName(file), Blob) }));
    }

    private ProfilesViewModel Profiles(FakeCli cli, FakeDesktop? desktop = null) =>
        new(new RepottedClient(cli), desktop ?? new FakeDesktop(), folders.Settings, () => ["lunch/config", "lunch/app"]);

    private static string Listing(params string[] files) =>
        JsonSerializer.Serialize(new
        {
            profiles = files.Select(file => new { name = Path.GetFileNameWithoutExtension(file), file, extends = (string?)null, problem = (string?)null }),
        });

    [Fact]
    public async Task The_client_reads_a_sync_that_leaves_conflicts()
    {
        var cli = new FakeCli()
            .On("sync /p --repository=lunch/config --path=profiles --json", Sync("profiles", pulled: ["a.yaml"], conflicts: ["b.yaml"]), exitCode: 1)
            .On("sync /p --prefer=local --only=a.yaml --only=b.yaml --json", """{"error":{"kind":"error","message":"GitHub refused the commit to main in lunch/config: Repository rule violations found."}}""", exitCode: 1);
        var client = new RepottedClient(cli);

        var result = await client.SyncAsync("/p", "lunch/config", "profiles", null, null, CancellationToken.None);
        var refused = await Assert.ThrowsAsync<CliException>(() => client.SyncAsync("/p", null, null, "local", ["a.yaml", "b.yaml"], CancellationToken.None));
        cli.On("sync /p --json", Sync("profiles"));
        // No files to settle is a plain sync, not a choice for every file.
        await client.SyncAsync("/p", null, null, "local", [], CancellationToken.None);
        Assert.Equal("sync /p --json", cli.Calls[^1]);

        Assert.Equal(("lunch/config", "profiles", "main"), (result.Repository, result.Path, result.Branch));
        Assert.Equal(["a.yaml"], result.Pulled);
        Assert.Equal(["b.yaml"], result.Conflicts);
        Assert.StartsWith("GitHub refused the commit", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("lunch/config", true)]
    [InlineData("Lunch-Trae/repotted.config", true)]
    [InlineData("lunch", false)]
    [InlineData("lunch/config/extra", false)]
    [InlineData("../config", false)]
    [InlineData("lunch/..", false)]
    [InlineData("lunch/.", false)]
    [InlineData("lunch/con fig", false)]
    public void Only_a_repository_name_makes_a_working_copy(string name, bool valid)
    {
        Assert.Equal(valid, AppSettings.IsRepositoryName(name));
        if (valid)
        {
            Assert.StartsWith(Path.Combine(folders.SettingsFolder, "config"), folders.Settings.ConfigFolder(name, ""), StringComparison.Ordinal);
        }
        else
        {
            Assert.Throws<ArgumentException>(() => folders.Settings.ConfigFolder(name, ""));
        }
    }

    [Fact]
    public void Each_folder_of_a_repository_gets_a_working_copy_of_its_own()
    {
        Assert.NotEqual(WorkingCopy(), WorkingCopy("profiles"));
        Assert.NotEqual(WorkingCopy("profiles"), WorkingCopy("team"));
        Assert.Equal(WorkingCopy(), folders.Settings.ConfigFolder("LUNCH/Config", ""));
    }

    [AvaloniaFact]
    public async Task Connecting_syncs_first_then_remembers_the_repository()
    {
        var local = folders.Write("base.yaml", "repository: { has_wiki: false }\n");
        var copy = WorkingCopy("profiles");
        var copied = "";
        var cli = new FakeCli()
            .On(folders.List(), Listing(local))
            .On($"profile {local} --json", Documents.ResolvedBase(local))
            .On(Command(copy, " --repository=lunch/config --path=profiles"), () =>
            {
                copied = File.ReadAllText(Path.Combine(copy, "base.yaml"));
                File.WriteAllText(Path.Combine(copy, ".repotted-sync.json"), "{}");
                return Sync("profiles", pushed: ["base.yaml"]);
            })
            .On(folders.List(copy), Listing(Path.Combine(copy, "base.yaml")))
            .On($"profile {Path.Combine(copy, "base.yaml")} --json", Documents.ResolvedBase(Path.Combine(copy, "base.yaml")));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.StartConnectCommand.Execute(null);
        var form = Assert.IsType<ConfigRepositoryViewModel>(profiles.Connecting);
        Assert.False(form.ConnectCommand.CanExecute(null));
        Assert.True(form.CanCopyLocal);
        form.Repository = " lunch/config ";
        form.Path = "/profiles/";
        await form.ConnectCommand.ExecuteAsync(null);

        Assert.Equal("repository: { has_wiki: false }\n", copied);
        Assert.Null(profiles.Connecting);
        Assert.Equal(("lunch/config", "profiles"), (folders.Settings.Load().ConfigRepository, folders.Settings.Load().ConfigPath));
        Assert.Equal(copy, profiles.Folder.Path);
        Assert.Equal("GitHub repository:", profiles.Folder.SourceLabel);
        Assert.Equal("lunch/config/profiles", profiles.Folder.SourceText);
        Assert.Equal("Sync now", profiles.Folder.RefreshLabel);
        Assert.Equal("Committed base.yaml to main.", profiles.Folder.SyncNote);
        Assert.Equal(["base"], profiles.Items.Select(item => item.Name));
        // The first sync is the one that connected; loading the copy does not sync again.
        Assert.Single(cli.Calls, call => call.StartsWith("sync ", StringComparison.Ordinal));
        // The local folder is left as it was.
        Assert.True(File.Exists(local));
    }

    [AvaloniaFact]
    public async Task A_repository_that_cannot_be_reached_changes_nothing()
    {
        folders.Write("base.yaml", "repository: { has_wiki: false }\n");
        var copy = WorkingCopy();
        var cli = new FakeCli()
            .On(folders.List(), Listing(Path.Combine(folders.Profiles, "base.yaml")))
            .On($"profile {Path.Combine(folders.Profiles, "base.yaml")} --json", Documents.ResolvedBase(Path.Combine(folders.Profiles, "base.yaml")))
            .On(
                Command(copy, " --repository=lunch/config"),
                """{"error":{"kind":"error","message":"Repotted cannot reach the profiles in lunch/config: Not Found. The repository must exist, the Repotted App must be installed on it, and it needs the Contents permission, read and write."}}""",
                exitCode: 1);
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var before = File.ReadAllText(Path.Combine(folders.SettingsFolder, "settings.json"));

        profiles.StartConnectCommand.Execute(null);
        var form = profiles.Connecting!;
        form.Repository = "lunch/config";
        await form.ConnectCommand.ExecuteAsync(null);

        Assert.Same(form, profiles.Connecting);
        Assert.StartsWith("Repotted cannot reach the profiles in lunch/config", form.Error, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllText(Path.Combine(folders.SettingsFolder, "settings.json")));
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        // The copies of the local profiles go too, so a later connect does not commit them by surprise.
        Assert.False(Directory.Exists(copy));

        form.CancelCommand.Execute(null);
        Assert.Null(profiles.Connecting);
        Assert.Equal("base", profiles.Current?.Name);
    }

    [AvaloniaFact]
    public async Task Each_refresh_syncs_and_a_failed_sync_keeps_the_profiles_open()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository: { has_wiki: false }\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync(pulled: ["base.yaml"]))
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);

        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Equal(copy, profiles.Folder.Path);
        Assert.Equal("In sync with main on GitHub.", profiles.Folder.SyncNote);
        Assert.False(profiles.Folder.SyncFailed);

        cli.On(Command(copy), """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.True(profiles.ShowSyncProblem);
        Assert.Equal("Not synced with GitHub. Saves stay on this computer until a sync works. fetch failed", profiles.Folder.SyncNote);
        Assert.Null(profiles.Error);
        Assert.Equal(["base"], profiles.Items.Select(item => item.Name));
    }

    [AvaloniaFact]
    public async Task A_working_copy_that_never_synced_is_an_error_not_an_empty_list()
    {
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var copy = WorkingCopy();
        var cli = new FakeCli()
            .On(Command(copy), """{"error":{"kind":"error","message":"Bad credentials"}}""", exitCode: 1)
            .On(folders.List(copy), Documents.NoProfiles);
        Directory.CreateDirectory(copy);
        var profiles = Profiles(cli);

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.False(profiles.ShowEmpty);
        Assert.Contains("Bad credentials", profiles.Error, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_save_commits_and_a_conflict_waits_for_a_side()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        cli.Calls.Clear();
        cli.On(Command(copy), Sync(conflicts: ["base.yaml"]), exitCode: 1);

        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Equal([$"profile {file} --set repository.has_wiki=false --json", Command(copy)], cli.Calls);
        Assert.True(profiles.Folder.HasConflicts);
        Assert.Equal("base.yaml changed here and on GitHub since the last sync. Keep which version?", profiles.Folder.ConflictMessage);

        // Only the file the banner named is settled.
        cli.On(Command(copy, " --prefer=local --only=base.yaml"), Sync(pushed: ["base.yaml"]));
        await profiles.KeepMineCommand.ExecuteAsync(null);

        Assert.Contains(Command(copy, " --prefer=local --only=base.yaml"), cli.Calls);
        Assert.False(profiles.Folder.HasConflicts);
        Assert.Equal("Committed base.yaml to main.", profiles.Folder.SyncNote);
    }

    [AvaloniaFact]
    public async Task Deleting_a_profile_commits_the_deletion_and_a_change_on_github_waits_for_a_side()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        Record(copy, file);
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.Items.Single().DeleteCommand.Execute(null);
        Assert.Equal("This deletes base.yaml here and commits the deletion to lunch/config, whose history keeps it.", profiles.DeleteDetail);
        cli.Calls.Clear();
        cli.On(Command(copy), Sync(conflicts: ["base.yaml"]), exitCode: 1).On(folders.List(copy), Documents.NoProfiles);
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.False(File.Exists(file));
        Assert.Equal([Command(copy), folders.List(copy)], cli.Calls);
        Assert.Equal(
            "base.yaml was deleted here and changed on GitHub since the last sync. Keep mine keeps it deleted, and Use GitHub's brings it back.",
            profiles.Folder.ConflictMessage);

        cli.On(Command(copy, " --prefer=local --only=base.yaml"), Sync(pushed: ["base.yaml"]));
        await profiles.KeepMineCommand.ExecuteAsync(null);

        Assert.False(profiles.Folder.HasConflicts);
        Assert.Equal("Committed the deletion of base.yaml to main.", profiles.Folder.SyncNote);
    }

    [AvaloniaFact]
    public async Task A_delete_waits_for_a_running_sync_and_closes_the_profile_until_its_own_sync_ends()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        profiles.Items.Single().DeleteCommand.Execute(null);
        var running = new TaskCompletionSource();
        cli.OnceReady(Command(copy), Sync(), running.Task);

        var refresh = profiles.RefreshAsync();
        var delete = profiles.ConfirmDeleteCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        // The delete waits its turn behind the sync already running.
        Assert.True(File.Exists(file));
        Assert.True(profiles.Busy);
        Assert.False(profiles.Items.Single().DeleteCommand.CanExecute(null));
        var committing = new TaskCompletionSource();
        cli.OnceReady(Command(copy), Sync(pushed: ["base.yaml"]), committing.Task).On(folders.List(copy), Documents.NoProfiles);
        running.SetResult();
        await refresh;
        Dispatcher.UIThread.RunJobs();

        // Gone, and closed while its own sync commits it, so nothing can edit or save it back.
        Assert.False(File.Exists(file));
        Assert.True(profiles.DeleteRunning);
        Assert.Null(profiles.Current);
        Assert.NotSame(editor, profiles.Current);
        Assert.False(profiles.AskingDelete);
        Assert.False(profiles.CancelDeleteCommand.CanExecute(null));
        committing.SetResult();
        await delete;

        Assert.False(profiles.DeleteRunning);
        Assert.Equal("Committed the deletion of base.yaml to main.", profiles.Folder.SyncNote);
        Assert.Empty(profiles.Items);
    }

    [AvaloniaFact]
    public async Task The_question_says_what_github_keeps_from_the_last_sync()
    {
        var copy = Synced();
        var synced = Path.Combine(copy, "synced.yaml");
        var changed = Path.Combine(copy, "changed.yaml");
        var fresh = Path.Combine(copy, "fresh.yaml");
        File.WriteAllText(synced, "repository: { has_issues: true }\n");
        File.WriteAllText(changed, "repository: { has_issues: true }\n");
        Record(copy, synced, changed);
        File.WriteAllText(changed, "repository: { has_issues: false }\n");
        File.WriteAllText(fresh, "repository: { has_wiki: true }\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(changed, fresh, synced))
            .On($"profile {changed} --json", Documents.ResolvedBase(changed));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        string Detail(string name)
        {
            profiles.Items.Single(item => item.Name == name).DeleteCommand.Execute(null);
            return profiles.DeleteDetail;
        }

        Assert.Equal("This deletes synced.yaml here and commits the deletion to lunch/config, whose history keeps it.", Detail("synced"));
        Assert.Equal(
            "This deletes changed.yaml here and commits the deletion to lunch/config. Its history keeps the last synced version, and changes since then can't be brought back.",
            Detail("changed"));
        Assert.Equal("This deletes fresh.yaml here, and it can't be undone, since it hasn't reached lunch/config yet.", Detail("fresh"));
    }

    [AvaloniaFact]
    public async Task Several_conflicts_name_the_ones_deleted_here()
    {
        var copy = Synced();
        var kept = Path.Combine(copy, "kept.yaml");
        var gone = Path.Combine(copy, "gone.yaml");
        File.WriteAllText(kept, "repository: { has_issues: true }\n");
        File.WriteAllText(gone, "repository: { has_issues: true }\n");
        Record(copy, kept, gone);
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(gone, kept))
            .On($"profile {gone} --json", Documents.ResolvedBase(gone));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.Items.Single(item => item.Name == "gone").DeleteCommand.Execute(null);
        cli.On(Command(copy), Sync(conflicts: ["gone.yaml", "kept.yaml"]), exitCode: 1).On(folders.List(copy), Listing(kept));
        await profiles.ConfirmDeleteCommand.ExecuteAsync(null);

        Assert.Equal(
            "These files changed here and on GitHub since the last sync: gone.yaml, kept.yaml. gone.yaml was deleted here: Keep mine keeps it deleted, and Use GitHub's brings it back. Keep which versions?",
            profiles.Folder.ConflictMessage);
    }

    [AvaloniaFact]
    public async Task Choosing_a_folder_stops_using_the_repository()
    {
        Synced();
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(WorkingCopy()), Sync())
            .On(folders.List(WorkingCopy()), Documents.NoProfiles)
            .On(folders.List(), Documents.NoProfiles);
        var profiles = Profiles(cli, new FakeDesktop { Folder = folders.Profiles });
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Equal("Change repository", profiles.Folder.RepositoryLabel);

        await profiles.ChangeFolderCommand.ExecuteAsync(null);

        Assert.Null(folders.Settings.Load().ConfigRepository);
        Assert.Equal(folders.Profiles, profiles.Folder.Path);
        Assert.Equal("Profiles folder:", profiles.Folder.SourceLabel);
        Assert.Equal("Use a GitHub repository", profiles.Folder.RepositoryLabel);
        Assert.Null(profiles.Folder.SyncNote);
    }

    [Fact]
    public void Settings_with_a_repository_that_is_not_a_name_fall_back_to_the_folder()
    {
        File.WriteAllText(
            Path.Combine(folders.SettingsFolder, "settings.json"),
            JsonSerializer.Serialize(new { profiles_folder = folders.Profiles, config_repository = "../..", config_path = "" }));

        var saved = folders.Settings.Load();

        Assert.Null(saved.ConfigRepository);
        Assert.Equal(folders.Profiles, saved.ProfilesFolder);
    }

    [AvaloniaFact]
    public async Task A_save_waits_for_a_sync_that_is_running()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        var slow = new TaskCompletionSource();
        cli.OnceReady(Command(copy), Sync(), slow.Task);
        cli.Calls.Clear();

        var refresh = profiles.RefreshAsync();
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        var save = editor.SaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([Command(copy)], cli.Calls);
        slow.SetResult();
        await refresh;
        await save;

        Assert.Equal(Command(copy), cli.Calls[0]);
        Assert.Contains($"profile {file} --set repository.has_wiki=false --json", cli.Calls);
        Assert.True(cli.Calls.IndexOf($"profile {file} --set repository.has_wiki=false --json") > 0);
    }

    [AvaloniaFact]
    public async Task Discarding_a_removed_profile_lists_again_once_a_running_sync_ends()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        File.Delete(file);
        cli.On(Command(copy), Sync(pulled: ["base.yaml"])).On(folders.List(copy), Listing());
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor.Removed);
        var slow = new TaskCompletionSource();
        cli.OnceReady(Command(copy), Sync(), slow.Task);
        cli.Calls.Clear();

        var refresh = profiles.RefreshAsync();
        editor.DiscardCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([Command(copy)], cli.Calls);
        slow.SetResult();
        await refresh;
        Dispatcher.UIThread.RunJobs();
        Assert.Empty(profiles.Items);
        Assert.All(cli.Calls.Skip(1), call => Assert.Equal(folders.List(copy), call));
    }

    [AvaloniaFact]
    public async Task A_stopped_list_finishes_a_save_but_starts_no_sync()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var written = new TaskCompletionSource();
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .OnceReady($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file), written.Task);
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        cli.Calls.Clear();
        var save = editor.SaveCommand.ExecuteAsync(null);

        var stopping = profiles.Stop();
        // The write can't be stopped partway, so stopping waits for it.
        Assert.False(stopping.IsCompleted);
        written.SetResult();
        await save;
        await stopping;

        Assert.Null(editor.SaveError);
        Assert.Contains($"profile {file} --set repository.has_wiki=false --json", cli.Calls);
        Assert.DoesNotContain(Command(copy), cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_stopped_list_puts_back_a_removed_profile_it_saves_but_starts_no_sync()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var written = new TaskCompletionSource();
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .OnceReady($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file), written.Task);
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var editor = profiles.Current!;
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        File.Delete(file);
        cli.On(Command(copy), Sync(pulled: ["base.yaml"])).On(folders.List(copy), Listing());
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.True(editor is { Removed: true, HasChanges: true });
        cli.On(folders.List(copy), Listing(file));
        cli.Calls.Clear();
        var save = editor.SaveCommand.ExecuteAsync(null);

        var stopping = profiles.Stop();
        Assert.True(profiles.Busy);
        // Putting the file back and saving can't be stopped partway, so stopping waits for both.
        Assert.False(stopping.IsCompleted);
        written.SetResult();
        await save;
        await stopping;
        Dispatcher.UIThread.RunJobs();

        Assert.Null(editor.SaveError);
        Assert.True(File.Exists(file));
        Assert.False(profiles.Busy);
        Assert.DoesNotContain(Command(copy), cli.Calls);
    }

    [AvaloniaFact]
    public async Task Save_on_closing_a_profile_closes_it_after_a_sync_that_pulls_a_file()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var save = $"profile {file} --set repository.has_wiki=false --json";
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On(save, Documents.ResolvedBase(file));
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.Selected = profiles.Items.Single();
        var editor = profiles.Current!;
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        // The sync after the save pulls another file, so the listing after it
        // opens a new editor for the saved profile while the question waits.
        cli.On(Command(copy), Sync(pulled: ["other.yaml"]));

        var close = editor.CloseCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await close.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Contains(save, cli.Calls);
        Assert.Null(profiles.Current);
        Assert.True(profiles.ShowNoneOpen);
    }

    [AvaloniaFact]
    public async Task Sign_out_comes_back_after_a_save_whose_sync_pulls_a_file()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository:\n  has_issues: true\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file));
        var shell = new ShellViewModel(
            new Account.SignedIn("TheLunchTrae", null, null, Documents.InstallUrl),
            new RepottedClient(cli),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);
        await shell.RefreshAsync();
        shell.Profiles.Selected = shell.Profiles.Items.Single();
        var editor = shell.Profiles.Current!;
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        bool? lastRead = null;
        shell.SignOutCommand.CanExecuteChanged += (_, _) => lastRead = shell.SignOutCommand.CanExecute(null);
        // The sync after the save pulls another file, so the listing after it
        // drops the saved editor from the cache while its save still runs.
        cli.On(Command(copy), Sync(pulled: ["other.yaml"]));

        await editor.SaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.False(editor.Saving);
        // The button shows what it read at the last change it heard of.
        Assert.True(lastRead);
    }

    [AvaloniaFact]
    public async Task A_sync_during_a_capture_finds_nothing_of_it_to_commit()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository: { has_wiki: false }\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        // A sync leaves out files whose names start with a dot, so these are the files it reads.
        var synced = new List<string[]>();
        var finish = new TaskCompletionSource();
        var cli = new FakeCli()
            .On(Command(copy), () =>
            {
                synced.Add([.. Directory.EnumerateFiles(copy).Select(Path.GetFileName).OfType<string>().Where(name => !name.StartsWith('.')).Order()]);
                return Sync();
            })
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .OnCapture("lunch/app", async (output, _) =>
            {
                File.WriteAllText(output, "repository:\n");
                await finish.Task;
                return """{"error":{"kind":"error","message":"Not Found"}}""";
            });
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        var before = Directory.EnumerateFileSystemEntries(copy).Order().ToList();
        profiles.StartNew("lunch/app");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);

        await profiles.RefreshCommand.ExecuteAsync(null);
        finish.SetResult();
        await capturing;
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Equal("Not Found", form.Error);
        Assert.Equal([["base.yaml"], ["base.yaml"], ["base.yaml"]], synced);
        // The failed capture leaves the copy as it found it, so the next sync has nothing to delete.
        Assert.Equal(before, Directory.EnumerateFileSystemEntries(copy).Order());
    }

    [AvaloniaFact]
    public async Task A_finished_capture_waits_for_a_sync_under_way_before_it_takes_its_name()
    {
        var copy = Synced();
        var file = Path.Combine(copy, "base.yaml");
        File.WriteAllText(file, "repository: { has_wiki: false }\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var made = Path.Combine(copy, "app.yaml");
        var captured = new TaskCompletionSource();
        var pulling = new TaskCompletionSource();
        var cli = new FakeCli()
            .On(Command(copy), Sync())
            .On(folders.List(copy), Listing(file))
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .OnCapture("lunch/app", async (output, _) =>
            {
                await captured.Task;
                File.WriteAllText(output, "repository:\n  has_wiki: true\n");
                return """{"repository":"lunch/app","profile":{},"warnings":[]}""";
            });
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.StartNew("lunch/app");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);
        // A sync that pulls a profile of the same name, and is still running when the capture ends.
        cli.On(Command(copy), async _ =>
        {
            await pulling.Task;
            File.WriteAllText(made, "repository: { has_issues: true }\n");
            return Sync(pulled: ["app.yaml"]);
        });
        var syncing = profiles.RefreshAsync();

        captured.SetResult();
        Dispatcher.UIThread.RunJobs();

        Assert.False(File.Exists(made));
        Assert.True(form.Working);
        pulling.SetResult();
        await syncing;
        await capturing;

        Assert.Equal("app.yaml is already in this folder.", form.Error);
        Assert.Equal("repository: { has_issues: true }\n", File.ReadAllText(made));
        Assert.Empty(Directory.EnumerateFiles(copy, "*.repotted-capture"));
    }

    [AvaloniaFact]
    public async Task Reconnecting_adds_the_local_profiles_the_repository_does_not_have()
    {
        var copy = Synced();
        File.WriteAllText(Path.Combine(copy, "base.yaml"), "# from GitHub\n");
        var local = folders.Write("base.yaml", "# mine\n");
        var added = folders.Write("app.yaml", "# new\n");
        var copied = new List<string>();
        var cli = new FakeCli()
            .On(folders.List(), Listing(added, local))
            .On($"profile {added} --json", Documents.ResolvedBase(added))
            .On($"profile {local} --json", Documents.ResolvedBase(local))
            .On(Command(copy, " --repository=lunch/config"), () =>
            {
                copied.AddRange(Directory.GetFiles(copy, "*.yaml").Select(Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal));
                return Sync(pushed: ["app.yaml"]);
            })
            .On(folders.List(copy), Documents.NoProfiles);
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.StartConnectCommand.Execute(null);
        profiles.Connecting!.Repository = "lunch/config";
        await profiles.Connecting.ConnectCommand.ExecuteAsync(null);

        Assert.Equal(["app.yaml", "base.yaml"], copied);
        Assert.Equal("# from GitHub\n", File.ReadAllText(Path.Combine(copy, "base.yaml")));
        Assert.Equal("Did not add base.yaml from the profiles folder, because lunch/config already had a file of that name.", profiles.Notice);
    }

    [AvaloniaFact]
    public async Task A_failed_reconnect_takes_back_only_the_copies_it_made()
    {
        var copy = Synced();
        File.WriteAllText(Path.Combine(copy, "base.yaml"), "# from GitHub\n");
        var added = folders.Write("app.yaml", "# new\n");
        var cli = new FakeCli()
            .On(folders.List(), Listing(added))
            .On($"profile {added} --json", Documents.ResolvedBase(added))
            .On(Command(copy, " --repository=lunch/config"), """{"error":{"kind":"error","message":"offline"}}""", exitCode: 1);
        var profiles = Profiles(cli);
        await profiles.RefreshCommand.ExecuteAsync(null);

        profiles.StartConnectCommand.Execute(null);
        profiles.Connecting!.Repository = "lunch/config";
        await profiles.Connecting.ConnectCommand.ExecuteAsync(null);

        Assert.Equal("offline", profiles.Connecting.Error);
        Assert.Equal(["base.yaml"], Directory.GetFiles(copy, "*.yaml").Select(Path.GetFileName));
        Assert.True(File.Exists(Path.Combine(copy, ".repotted-sync.json")));
    }
}
