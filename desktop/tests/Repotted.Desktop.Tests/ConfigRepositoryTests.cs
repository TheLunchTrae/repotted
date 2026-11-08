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
        Assert.Equal(copy, profiles.Folder);
        Assert.Equal("GitHub repository:", profiles.SourceLabel);
        Assert.Equal("lunch/config/profiles", profiles.SourceText);
        Assert.Equal("Sync now", profiles.RefreshLabel);
        Assert.Equal("Committed base.yaml to main.", profiles.SyncNote);
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
        Assert.Equal(folders.Profiles, profiles.Folder);
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
        Assert.Equal(copy, profiles.Folder);
        Assert.Equal("In sync with main on GitHub.", profiles.SyncNote);
        Assert.False(profiles.SyncFailed);

        cli.On(Command(copy), """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.True(profiles.ShowSyncProblem);
        Assert.Equal("Not synced with GitHub. Saves stay on this computer until a sync works. fetch failed", profiles.SyncNote);
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
        Assert.True(profiles.HasConflicts);
        Assert.Equal("base.yaml changed here and on GitHub since the last sync. Keep which version?", profiles.ConflictMessage);

        // Only the file the banner named is settled.
        cli.On(Command(copy, " --prefer=local --only=base.yaml"), Sync(pushed: ["base.yaml"]));
        await profiles.KeepMineCommand.ExecuteAsync(null);

        Assert.Contains(Command(copy, " --prefer=local --only=base.yaml"), cli.Calls);
        Assert.False(profiles.HasConflicts);
        Assert.Equal("Committed base.yaml to main.", profiles.SyncNote);
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
        Assert.Equal("Change repository", profiles.RepositoryLabel);

        await profiles.ChangeFolderCommand.ExecuteAsync(null);

        Assert.Null(folders.Settings.Load().ConfigRepository);
        Assert.Equal(folders.Profiles, profiles.Folder);
        Assert.Equal("Profiles folder:", profiles.SourceLabel);
        Assert.Equal("Use a GitHub repository", profiles.RepositoryLabel);
        Assert.Null(profiles.SyncNote);
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
