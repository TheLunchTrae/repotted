using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

public sealed class ViewModelTests : IDisposable
{
    private readonly Folders folders = new();

    public void Dispose() => folders.Dispose();

    private MainViewModel App(FakeCli cli, FakeDesktop? desktop = null) =>
        new(new RepottedClient(cli.Answers(folders.List()) ? cli : cli.On(folders.List(), Documents.NoProfiles)),
            desktop ?? new FakeDesktop(),
            folders.Settings);

    [AvaloniaFact]
    public async Task Signed_in_opens_the_repository_list()
    {
        var main = App(new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));

        await main.StartAsync();

        var shell = Assert.IsType<ShellViewModel>(main.Page);
        Assert.Equal("TheLunchTrae", shell.Account.Login);
        Assert.Equal("TR", shell.Initials);
        Assert.Equal(3, shell.Repositories.Count);
        Assert.Equal("TheLunchTrae/github-setup", shell.Repositories.Selected?.FullName);
        Assert.True(shell.Repositories.ShowTable);
    }

    [AvaloniaFact]
    public async Task Signed_out_opens_the_sign_in()
    {
        var main = App(new FakeCli().On("status --json", Documents.SignedOut, exitCode: 1));

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.False(signIn.HasNotice);
    }

    [AvaloniaFact]
    public async Task A_rejected_sign_in_says_to_sign_in_again()
    {
        var main = App(new FakeCli().On("status --json", Documents.Rejected, exitCode: 1));

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.Equal("GitHub no longer accepts your last sign-in. Sign in again.", signIn.Notice);
    }

    [AvaloniaFact]
    public async Task A_sign_in_that_could_not_be_read_says_why()
    {
        var main = App(new FakeCli().On(
            "status --json",
            """{"signed_in":false,"reason":"not_signed_in","message":"…","problems":["Could not read the OS keychain: locked."],"token_variable":null,"install_url":"https://github.com/apps/repotted-app/installations/new"}""",
            exitCode: 1));

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.Equal("Could not read the OS keychain: locked.", signIn.Notice);
    }

    [AvaloniaFact]
    public async Task A_rejected_token_variable_says_to_replace_it_and_reopen()
    {
        var cli = new FakeCli().On(
            "status --json",
            """{"signed_in":false,"reason":"rejected","message":"GitHub rejected the token in GH_TOKEN.","problems":[],"token_variable":"GH_TOKEN","install_url":"https://github.com/apps/repotted-app/installations/new"}""",
            exitCode: 1);
        var main = App(cli);

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.StartsWith("GitHub rejected the token in GH_TOKEN.", signIn.Notice, StringComparison.Ordinal);
        Assert.EndsWith("replace or remove GH_TOKEN, then reopen Repotted.", signIn.Notice, StringComparison.Ordinal);
        // Signing in would change nothing while the variable comes first.
        Assert.False(signIn.CanSignIn);
    }

    [AvaloniaFact]
    public async Task A_rejected_sign_in_without_a_variable_can_sign_in_again()
    {
        var main = App(new FakeCli().On("status --json", Documents.Rejected, exitCode: 1));

        await main.StartAsync();

        Assert.True(Assert.IsType<SignInViewModel>(main.Page).CanSignIn);
    }

    [AvaloniaFact]
    public async Task A_missing_command_line_says_so_and_can_try_again()
    {
        var cli = new FakeCli().Missing("status --json");
        var main = App(cli);

        await main.StartAsync();

        var problem = Assert.IsType<ProblemViewModel>(main.Page);
        Assert.Contains("Could not start the Repotted command line", problem.Message, StringComparison.Ordinal);

        cli.On("status --json", Documents.SignedOut, exitCode: 1);
        await problem.TryAgainCommand.ExecuteAsync(null);
        Assert.IsType<SignInViewModel>(main.Page);
    }

    [AvaloniaFact]
    public async Task An_unexpected_failure_shows_instead_of_the_loading_page()
    {
        // The fake throws for a command it has no answer for.
        var main = App(new FakeCli());

        await main.StartAsync();

        var problem = Assert.IsType<ProblemViewModel>(main.Page);
        Assert.StartsWith("Something unexpected went wrong: No answer for: status --json", problem.Message, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Sign_in_shows_the_code_then_opens_the_app()
    {
        var entered = new TaskCompletionSource();
        var desktop = new FakeDesktop();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json", [Documents.Code, Documents.Done], entered.Task)
            .On("repos --json", Documents.Repositories);
        var main = App(cli, desktop);
        await main.StartAsync();
        var signIn = Assert.IsType<SignInViewModel>(main.Page);

        var signingIn = signIn.SignInCommand.ExecuteAsync(null);
        // Until the code reaches the page, it shows that the sign-in started.
        Assert.True(signIn.Starting);
        Assert.False(signIn.ShowStart);
        Dispatcher.UIThread.RunJobs();

        Assert.False(signIn.Starting);
        Assert.True(signIn.HasCode);
        Assert.Equal("ABCD-1234", signIn.Code?.UserCode);
        signIn.OpenGitHubCommand.Execute(null);
        await signIn.CopyCodeCommand.ExecuteAsync(null);
        Assert.Equal([new Uri("https://github.com/login/device")], desktop.Opened);
        Assert.Equal(["ABCD-1234"], desktop.Copied);
        Assert.True(signIn.CodeCopied);

        cli.On("status --json", Documents.SignedIn);
        entered.SetResult();
        await signingIn;

        Assert.IsType<ShellViewModel>(main.Page);
    }

    [AvaloniaFact]
    public async Task Cancelling_the_sign_in_goes_back_to_the_start()
    {
        var never = new TaskCompletionSource();
        var main = App(new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json", [Documents.Code, Documents.Done], never.Task));
        await main.StartAsync();
        var signIn = Assert.IsType<SignInViewModel>(main.Page);

        var signingIn = signIn.SignInCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(signIn.HasCode);
        signIn.SignInCancelCommand.Execute(null);
        await signingIn;

        Assert.False(signIn.HasCode);
        Assert.True(signIn.ShowStart);
        Assert.Null(signIn.Error);
        Assert.Same(signIn, main.Page);
    }

    [AvaloniaFact]
    public async Task Closing_the_app_stops_a_waiting_sign_in()
    {
        var never = new TaskCompletionSource();
        var main = App(new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json", [Documents.Code, Documents.Done], never.Task));
        await main.StartAsync();
        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        var signingIn = signIn.SignInCommand.ExecuteAsync(null);

        main.Stop();
        await signingIn;

        Assert.False(signIn.SignInCommand.IsRunning);
        Assert.Null(signIn.Error);
    }

    [AvaloniaFact]
    public async Task A_failed_sign_in_shows_why()
    {
        var main = App(new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json",
                [Documents.Code, """{"event":"error","error":{"kind":"error","message":"The code expired."}}"""],
                exitCode: 1));
        await main.StartAsync();
        var signIn = Assert.IsType<SignInViewModel>(main.Page);

        await signIn.SignInCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("The code expired.", signIn.Error);
        Assert.False(signIn.HasCode);
    }

    [AvaloniaFact]
    public async Task Search_filters_the_list_and_keeps_the_selection()
    {
        var main = App(new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Repositories.Selected = shell.Repositories.Rows[1];

        shell.Search = "REPO";

        Assert.Equal(["TheLunchTrae/repotted", "TheLunchTrae/test-repo"], shell.Repositories.Rows.Select(row => row.FullName));
        Assert.Equal("TheLunchTrae/repotted", shell.Repositories.Selected?.FullName);

        shell.Search = "nothing like it";
        Assert.Empty(shell.Repositories.Rows);
        Assert.False(shell.Repositories.HasSelection);
        Assert.Equal(3, shell.Repositories.Count);
    }

    [AvaloniaFact]
    public async Task An_empty_list_says_why_for_each_source()
    {
        var desktop = new FakeDesktop();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", """{"source":"installations","repositories":[]}""");
        var main = App(cli, desktop);
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.True(repositories.ShowEmpty);
        Assert.Contains("not installed", repositories.EmptyMessage, StringComparison.Ordinal);
        Assert.True(repositories.CanAddRepositories);
        // The empty list offers it, so the heading does not as well.
        Assert.False(repositories.ShowAddInHeading);
        await repositories.AddRepositoriesCommand.ExecuteAsync(null);
        Assert.Equal([Documents.InstallUrl], desktop.Opened);

        cli.On("repos --json", """{"source":"admin","repositories":[]}""");
        await repositories.RefreshCommand.ExecuteAsync(null);
        Assert.False(repositories.FromInstallations);
        Assert.False(repositories.CanAddRepositories);
        Assert.Equal("This token administers no repositories.", repositories.EmptyMessage);
    }

    [AvaloniaFact]
    public async Task A_failed_load_shows_the_error_and_tries_again()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        var main = App(cli);
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.Equal("fetch failed", repositories.Error);
        Assert.False(repositories.ShowTable);
        Assert.False(repositories.ShowEmpty);

        cli.On("repos --json", Documents.Repositories);
        await repositories.RefreshCommand.ExecuteAsync(null);
        Assert.Null(repositories.Error);
        Assert.True(repositories.ShowTable);
    }

    [AvaloniaFact]
    public async Task Refresh_waits_for_the_read_under_way()
    {
        var answer = new TaskCompletionSource();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .OnLines("repos --json", ["", Documents.Repositories], answer.Task);
        var main = App(cli);

        var starting = main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.True(repositories.Loading);
        Assert.False(repositories.RefreshCommand.CanExecute(null));
        answer.SetResult();
        await starting;
        Assert.True(repositories.RefreshCommand.CanExecute(null));
    }

    [AvaloniaTheory]
    [InlineData("installations", null, "Signed in with the Repotted App.")]
    [InlineData("admin", null, "Signed in with a GitHub token.")]
    [InlineData("admin", "GITHUB_TOKEN", "Signed in with GITHUB_TOKEN.")]
    public async Task Signed_in_with_says_what_the_token_is(string source, string? variable, string expected)
    {
        var shell = Shell("lunch", null, variable, source);
        // Without a variable, only the list tells an App sign-in from another token.
        Assert.Equal(variable is null ? null : expected, shell.SignedInWith);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);

        Assert.Equal(expected, shell.SignedInWith);
    }

    [AvaloniaFact]
    public async Task Another_App_has_no_install_page_to_offer()
    {
        var shell = new ShellViewModel(
            new Account.SignedIn("lunch", null, null, null),
            new RepottedClient(new FakeCli().On("repos --json", """{"source":"installations","repositories":[]}""")),
            new FakeDesktop(),
            folders.Settings);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);

        Assert.Equal("Signed in with your GitHub App.", shell.SignedInWith);
        Assert.False(shell.Repositories.CanAddRepositories);
        Assert.StartsWith("Your GitHub App is not installed", shell.Repositories.EmptyMessage, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_profile_shows_each_setting_as_set_here_inherited_or_not_managed()
    {
        var (profiles, _, _) = await OpenOrgs();

        var editor = Assert.IsType<ProfileViewModel>(profiles.Current);
        Assert.Equal("Extends base. Saved to orgs.yaml.", editor.Summary);
        Assert.Equal("extends base", profiles.Selected?.Note);
        Assert.Equal(["Repository", "Merge", "Actions", "Rulesets", "Environments"], editor.Tabs.Select(tab => tab.Name));
        Assert.Equal([2, 2, 0, 2, 1], editor.Tabs.Select(tab => tab.Count));

        Assert.Equal((SettingOrigin.Own, "Set here"), Origin(editor, "has_wiki"));
        Assert.Equal((SettingOrigin.Inherited, "From base"), Origin(editor, "has_issues"));
        Assert.Equal((SettingOrigin.NotManaged, "Not managed"), Origin(editor, "has_projects"));
        Assert.Equal(
            ["Protect main: From base", "Old tags: Removed from GitHub here"],
            editor.Tabs[3].Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
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
    public async Task Rulesets_and_environments_save_by_name_and_a_rename_takes_the_old_one_out()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var (rulesets, environments) = (editor.Tabs[3], editor.Tabs[4]);

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
        var (rulesets, environments) = (editor.Tabs[3], editor.Tabs[4]);
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
        var rulesets = editor.Tabs[3];
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
        editor.Tabs[4].Entries[0].Editor.Name = "pages";
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
        Assert.Equal("npm", editor.Tabs[4].Entries[0].Name);
        Assert.EndsWith("# pulled by a sync\n", editor.Yaml, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task A_change_to_the_base_stops_a_save_of_an_edited_inherited_entry_only()
    {
        var (profiles, cli, files) = await OpenOrgs();
        var editor = profiles.Current!;
        var rulesets = editor.Tabs[3];
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
        rulesets = editor.Tabs[3];
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
        editor.Tabs[4].Entries[0].Editor.Name = "pages";
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
        var environments = editor.Tabs[4];
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
        environments = editor.Tabs[4];
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
        editor.Tabs[4].Entries[0].Editor.Name = "pages";
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
        editor.Tabs[4].Entries[0].Editor.Name = "pages";
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
    public async Task Discarding_puts_rulesets_and_environments_back()
    {
        var (profiles, _, _) = await OpenOrgs();
        var editor = profiles.Current!;
        var (rulesets, environments) = (editor.Tabs[3], editor.Tabs[4]);
        rulesets.Entries[1].OpenCommand.Execute(null);
        rulesets.Entries[1].Editor.Name = "Retired tags";
        environments.Entries[0].DropCommand.Execute(null);
        environments.NewCommand.Execute(null);

        editor.DiscardCommand.Execute(null);

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

        editor.DiscardCommand.Execute(null);
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

        Assert.Equal(other, profiles.Folder);
        Assert.Equal(other, folders.Settings.Load().ProfilesFolder);
        Assert.True(profiles.ShowEmpty);
        Assert.Equal($"No profiles in {other} yet.", profiles.EmptyMessage);
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

        Assert.Contains(nameof(SettingViewModel.Note), raised);
        Assert.Contains(nameof(SettingViewModel.OwnAfterSave), raised);
        Assert.Equal("Changed", wiki.Note);
    }

    [AvaloniaFact]
    public async Task A_file_listed_under_two_names_opens_once()
    {
        var file = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var listing = $$"""{"profiles":[{"name":"alias","file":{{Quote(file)}},"extends":null,"problem":null},{"name":"base","file":{{Quote(file)}},"extends":null,"problem":null}]}""";
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
            .OnceReady(folders.List(), $$"""{"profiles":[{"name":"orgs","file":{{Quote(own)}},"extends":null,"problem":null}]}""", slow.Task)
            .On(folders.List(other), Documents.NoProfiles);
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop { Folder = other }, folders.Settings, () => []);

        var first = profiles.RefreshAsync();
        await profiles.ChangeFolderCommand.ExecuteAsync(null);
        slow.SetResult();
        await first;

        Assert.Equal(other, profiles.Folder);
        Assert.Empty(profiles.Items);
        Assert.False(profiles.Loading);
    }

    private static string Quote(string text) => $"\"{System.Text.Encodings.Web.JavaScriptEncoder.Default.Encode(text)}\"";

    [AvaloniaFact]
    public async Task A_compare_shows_each_difference_and_counts_what_matches()
    {
        var compare = await Compare(Documents.Plan());

        Assert.Equal("5 differences in 3 sections. Matching settings are folded away.", compare.Summary);
        Assert.Equal(
            [("Repository and merge settings", "1 change", "3 settings match."),
             ("Actions", "1 change", "1 setting matches."),
             ("Rulesets", "3 changes", "1 ruleset matches. 1 removed ruleset is already gone."),
             ("Environments", "In line", "1 environment matches.")],
            compare.Sections.Select(section => (section.Title, section.Status, section.Summary)));
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Allow squash merging", "allow_squash_merge", "On", "Off"),
             new CompareRow(CompareKind.Changes, "Default permissions", "default_workflow_permissions", "Read and write", "Read"),
             // A new ruleset says what each rule sets.
             new CompareRow(CompareKind.Adds, "Main: Require Checks", "new ruleset", "Not on GitHub",
                 "required_status_checks: required_status_checks: context: quality"),
             // A ruleset row names the part that differs, not the whole list of rules.
             new CompareRow(CompareKind.Changes, "Main: Require PR", "rules[pull_request].parameters.allowed_merge_methods", "merge, squash, rebase", "rebase"),
             new CompareRow(CompareKind.Removes, "Main: Block Deletion", "absent: true", "On GitHub", "Deleted")],
            compare.Sections.SelectMany(section => section.Rows));
    }

    [AvaloniaFact]
    public async Task Showing_everything_adds_the_matching_rows()
    {
        var compare = await Compare(Documents.Plan());

        compare.ToggleEverythingCommand.Execute(null);

        var settings = compare.Sections[0].Rows;
        Assert.Equal(
            [("Allow squash merging", CompareKind.Changes), ("Issues", CompareKind.Matches), ("Wiki", CompareKind.Matches),
             ("Allow rebase merging", CompareKind.Matches)],
            settings.Select(row => (row.Label, row.Kind)));
        Assert.Equal(("On", "On"), (settings[1].Now, settings[1].Wanted));
        Assert.Equal("Show differences only", compare.EverythingLabel);
        Assert.Equal("5 differences in 3 sections. Matching settings show below them.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task A_changed_ruleset_shows_a_dropped_rule_and_a_new_order()
    {
        var compare = await Compare(Plan(
            """
            {"rulesets":[{"name":"Main","rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}},
              {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality"}]}}]}]}
            """,
            """
            {"section":"rulesets","action":"update","target":"Main",
             "fields":[{"field":"rules",
               "from":[{"type":"pull_request","parameters":{"allowed_merge_methods":["rebase","squash"]}},{"type":"non_fast_forward"}],
               "to":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}},
                 {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality"}]}}]}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/rulesets/7","body":{}}}
            """));

        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Main", "rules[pull_request].parameters.allowed_merge_methods", "rebase, squash", "squash, rebase"),
             // An added rule says what it sets, not only its type.
             new CompareRow(CompareKind.Adds, "Main", "rules[required_status_checks]", "Not on GitHub",
                 "required_status_checks: required_status_checks: context: quality"),
             new CompareRow(CompareKind.Removes, "Main", "rules[non_fast_forward]", "non_fast_forward", "Removed")],
            compare.Sections.Single().Rows);
    }

    [AvaloniaFact]
    public async Task An_environment_shows_each_setting_and_branch_policy_the_profile_changes()
    {
        // GitHub holds the environment as npm; the profile names it NPM.
        var compare = await Compare(Plan(
            """{"environments":[{"name":"NPM","wait_timer":5,"branch_policies":[{"name":"v*","type":"tag"}]},{"name":"staging"}]}""",
            """
            {"section":"environments","action":"update","target":"npm",
             "fields":[{"field":"wait_timer","from":0,"to":5},
               {"field":"deployment_branch_policy","from":null,"to":{"protected_branches":false,"custom_branch_policies":true}}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/environments/npm","body":{}}},
            {"section":"environments","action":"delete","target":"npm: branch main","fields":[],
             "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/environments/npm/deployment-branch-policies/3"}},
            {"section":"environments","action":"create","target":"npm: tag v*",
             "fields":[{"field":"name","to":"v*"},{"field":"type","to":"tag"}],
             "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/environments/npm/deployment-branch-policies","body":{"name":"v*","type":"tag"}}}
            """));

        var environments = compare.Sections.Single();
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "npm", "wait_timer", "0", "5"),
             // GitHub has the setting, as null, so it is changed rather than added.
             new CompareRow(CompareKind.Changes, "npm", "deployment_branch_policy", "none", "protected_branches: false, custom_branch_policies: true"),
             new CompareRow(CompareKind.Removes, "npm: branch main", "branch_policies", "On GitHub", "Removed"),
             new CompareRow(CompareKind.Adds, "npm: tag v*", "new branch policy", "Not on GitHub", "Created")],
            environments.Rows);
        Assert.Equal("1 environment matches.", environments.Summary);
        Assert.Equal("npm: tag v*, new branch policy: not on GitHub, the profile creates it", environments.Rows[3].AccessibleName);
        environments.ShowEverything = true;
        Assert.Equal("staging, environment: matches the profile", environments.Rows[^1].AccessibleName);
    }

    [AvaloniaFact]
    public async Task What_matches_shows_by_name()
    {
        var compare = await Compare(Plan(
            """
            {"actions":{"allowed_actions":"selected","selected_actions":{"patterns_allowed":["actions/*"]}},
             "rulesets":[{"name":"Main"},{"name":"main"},{"name":"Main: Tags"}]}
            """,
            """
            {"section":"rulesets","action":"update","target":"Main: Tags",
             "fields":[{"field":"enforcement","from":"disabled","to":"active"}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/rulesets/8","body":{}}}
            """));

        compare.ToggleEverythingCommand.Execute(null);

        Assert.Contains(
            new CompareRow(CompareKind.Matches, "Allowed action patterns", "selected_actions.patterns_allowed", "actions/*", "actions/*"),
            compare.Sections[0].Rows);
        // GitHub tells rulesets apart by their exact names.
        Assert.Equal("2 rulesets match.", compare.Sections[1].Summary);
    }

    [AvaloniaFact]
    public async Task A_profile_with_nothing_to_compare_says_so()
    {
        var compare = await Compare(Plan("{}", ""));

        Assert.True(compare.ShowResult);
        Assert.Empty(compare.Sections);
        Assert.Equal("orgs does not set anything Repotted compares.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task What_the_plan_skipped_is_not_called_in_line()
    {
        const string Skipped = "Skipped allowed_actions: it only applies while Actions is enabled";
        var compare = await Compare(Documents.Plan(
            warnings: $"\"Skipped environments: the sign-in cannot read environments\",\"{Skipped}\""));

        var environments = compare.Sections.Single(section => section.Title == "Environments");
        Assert.Equal("Not checked", environments.Status);
        Assert.False(environments.InLine);
        Assert.Equal("Repotted could not read the environments: the sign-in cannot read environments", environments.Summary);
        // A setting the plan skipped is not counted as matching; the warning says why.
        Assert.Equal("", compare.Sections.Single(section => section.Title == "Actions").Summary);
        Assert.Equal([Skipped], compare.Warnings);
    }

    [AvaloniaFact]
    public async Task Comparing_a_repository_opens_the_compare_and_leaving_closes_it()
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base))
            .On($"plan TheLunchTrae/repotted --profile {own} --json", Documents.Plan());
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings);
        await shell.RefreshAsync();
        var repositories = shell.Repositories;
        Assert.Equal("base", repositories.CompareWith?.Name);

        repositories.Selected = repositories.Rows.Single(row => row.Name == "repotted");
        repositories.CompareWith = shell.Profiles.Usable.Single(item => item.Name == "orgs");
        repositories.CompareCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();

        Assert.True(shell.ShowingCompare);
        Assert.False(shell.ShowingRepositories);
        Assert.Equal("Repositories / TheLunchTrae/repotted / Compare", shell.Crumb);
        Assert.Equal("orgs compared with TheLunchTrae/repotted", shell.Compare?.Heading);
        Assert.Equal(4, shell.Compare?.Sections.Count);

        shell.Page = 1;
        shell.Page = 0;

        Assert.Null(shell.Compare);
        Assert.True(shell.ShowingRepositories);
    }

    private static string Plan(string desired, string changes) =>
        $$"""{"repository":"TheLunchTrae/repotted","desired":{{desired}},"changes":[{{changes}}],"warnings":[]}""";

    private static async Task<CompareViewModel> Compare(string plan)
    {
        var compare = new CompareViewModel(
            new RepottedClient(new FakeCli().On("plan TheLunchTrae/repotted --profile orgs.yaml --json", plan)),
            "TheLunchTrae/repotted",
            new ProfileListingDocument("orgs", "orgs.yaml", null, null));
        await compare.LoadCommand.ExecuteAsync(null);
        Assert.Null(compare.Error);
        return compare;
    }

    [AvaloniaFact]
    public async Task A_new_profile_that_extends_another_opens_once_made()
    {
        var (profiles, cli, files) = await OpenOrgs();

        profiles.StartNew(null);

        Assert.True(profiles.ShowCreating);
        Assert.False(profiles.ShowProfile);
        Assert.Null(profiles.Selected);
        var form = profiles.Creating!;
        form.Name = "libraries";
        form.Extends = true;
        form.Base = form.Bases.Single(item => item.Name == "base");
        var made = Path.Combine(folders.Profiles, "libraries.yaml");
        cli.On(folders.List(), Listing(("base", files.Base, null), ("libraries", made, files.Base), ("orgs", files.Own, files.Base)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("extends: \"base.yaml\"\n", File.ReadAllText(made));
        Assert.False(profiles.ShowCreating);
        Assert.Equal("libraries", profiles.Selected?.Name);
        Assert.Equal(made, profiles.Current?.File);
        Assert.Null(profiles.Captured);
    }

    [AvaloniaFact]
    public async Task A_new_profile_never_takes_a_name_in_use()
    {
        var (profiles, _, _) = await OpenOrgs();
        profiles.StartNew(null);
        var form = profiles.Creating!;

        Assert.False(form.CreateCommand.CanExecute(null));
        Assert.Null(form.Problem);
        form.Name = "ORGS";
        Assert.Equal("orgs.yaml is already in this folder.", form.Problem);
        Assert.False(form.CreateCommand.CanExecute(null));
        folders.Write("old.yml", "");
        form.Name = "Old";
        Assert.Equal("old.yml is already in this folder.", form.Problem);
        foreach (var name in new[] { "team/libraries", ".hidden", "nul", "Com1.backup" })
        {
            form.Name = name;
            Assert.NotNull(form.Problem);
            Assert.False(form.CreateCommand.CanExecute(null));
        }
        form.Name = "libraries";
        Assert.True(form.CreateCommand.CanExecute(null));

        // A file made after the name was typed is not replaced.
        folders.Write("libraries.yaml", "merge: { allow_squash_merge: false }\n");
        await form.CreateCommand.ExecuteAsync(null);

        Assert.NotNull(form.Error);
        Assert.True(profiles.ShowCreating);
        Assert.Equal("merge: { allow_squash_merge: false }\n", File.ReadAllText(Path.Combine(folders.Profiles, "libraries.yaml")));
    }

    [AvaloniaFact]
    public void A_profile_extends_another_only_once_one_is_chosen()
    {
        using var form = new NewProfileViewModel(
            new RepottedClient(new FakeCli()), folders.Profiles, [], [], null, (_, _) => Task.CompletedTask, () => { }, () => { })
        {
            Name = "libraries",
            Extends = true,
        };

        Assert.False(form.CreateCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_capture_never_replaces_a_file_and_leaves_none_when_it_fails()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var cli = new FakeCli().On($"capture TheLunchTrae/repotted --output {made} --json", "", exitCode: 1, error: "Not Found");
        var profiles = new ProfilesViewModel(new RepottedClient(cli.On(folders.List(), Documents.NoProfiles)), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;

        await form.CreateCommand.ExecuteAsync(null);

        Assert.NotNull(form.Error);
        Assert.False(File.Exists(made));

        // A file made after the name was typed stops the capture before it reads GitHub.
        cli.Calls.Clear();
        folders.Write("repotted.yaml", "repository: { has_wiki: true }\n");
        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("repotted.yaml is already in this folder.", form.Error);
        Assert.Empty(cli.Calls);
        Assert.Equal("repository: { has_wiki: true }\n", File.ReadAllText(made));
    }

    [AvaloniaFact]
    public async Task Cancelling_a_capture_stops_it_and_keeps_what_the_user_opened_next()
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        var stopped = false;
        cli.On($"capture TheLunchTrae/repotted --output {made} --json", async cancellationToken =>
        {
            cancellationToken.Register(() => stopped = true);
            // A command line that finishes anyway, as one that is slow to stop would.
            await finish.Task;
            File.WriteAllText(made, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":["Skipped rulesets"]}""";
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew(null);
        var next = profiles.Creating;
        finish.SetResult();
        await capturing;

        Assert.True(stopped);
        Assert.False(File.Exists(made));
        Assert.Same(next, profiles.Creating);
        Assert.Null(profiles.Captured);
        Assert.Equal(files.Own, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task A_capture_hides_the_file_it_holds_and_frees_the_name_once_it_stops()
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        cli.On($"capture TheLunchTrae/repotted --output {made} --json", async _ =>
        {
            await finish.Task;
            return """{"error":{"kind":"error","message":"Not Found"}}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)));
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        // The empty file the capture holds is not a profile yet.
        await profiles.RefreshCommand.ExecuteAsync(null);
        Assert.Equal(["base", "orgs"], profiles.Items.Select(item => item.Name));

        // Another form cannot take the name while the closed one holds it, and can once it lets go.
        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew(null);
        var next = profiles.Creating!;
        next.Name = "repotted";
        Assert.Equal("repotted.yaml is already in this folder.", next.Problem);
        finish.SetResult();
        await capturing;

        Assert.False(File.Exists(made));
        Assert.Null(next.Problem);
    }

    [AvaloniaFact]
    public async Task A_capture_still_running_in_the_folder_left_behind_hides_nothing_in_the_new_one()
    {
        // A picker may give the folder with a separator at its end.
        var other = Path.Combine(folders.Profiles, "other") + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(other);
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var held = Path.Combine(other, "held.yaml");
        var finish = new TaskCompletionSource();
        var cli = new FakeCli()
            .On(folders.List(), Documents.NoProfiles)
            .On(folders.List(other), Listing(("held", held, null), ("repotted", Path.Combine(other, "repotted.yaml"), null)));
        foreach (var (repository, file) in new[] { ("TheLunchTrae/repotted", made), ("TheLunchTrae/held", held) })
        {
            cli.On($"capture {repository} --output {file} --json", async _ =>
            {
                await finish.Task;
                return """{"error":{"kind":"error","message":"Not Found"}}""";
            });
        }
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop { Folder = other }, folders.Settings, () => ["TheLunchTrae/repotted", "TheLunchTrae/held"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        await profiles.ChangeFolderCommand.ExecuteAsync(null);
        profiles.StartNew("TheLunchTrae/held");
        var holding = profiles.Creating!.CreateCommand.ExecuteAsync(null);
        await profiles.RefreshCommand.ExecuteAsync(null);

        // The new folder hides only the file its own capture holds.
        Assert.Equal(["repotted"], profiles.Items.Select(item => item.Name));
        finish.SetResult();
        await Task.WhenAll(capturing, holding);
    }

    [AvaloniaFact]
    public async Task A_refresh_keeps_the_form_and_a_new_folder_closes_it()
    {
        var (profiles, cli, files) = await OpenOrgs();
        profiles.StartNew(null);
        var form = profiles.Creating!;
        form.Name = "libraries";

        await profiles.RefreshCommand.ExecuteAsync(null);

        Assert.Same(form, profiles.Creating);
        Assert.Null(profiles.Selected);
        profiles.CancelNew();
        Assert.Equal(files.Own, profiles.Current?.File);

        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        var desktop = new FakeDesktop { Folder = other };
        var moving = new ProfilesViewModel(new RepottedClient(cli.On(folders.List(other), Documents.NoProfiles)), desktop, folders.Settings, () => []);
        await moving.RefreshCommand.ExecuteAsync(null);
        moving.StartNew(null);

        await moving.ChangeFolderCommand.ExecuteAsync(null);

        Assert.Null(moving.Creating);
        Assert.True(moving.ShowEmpty);
    }

    [AvaloniaFact]
    public async Task Leaving_a_new_profile_goes_back_to_the_open_one()
    {
        var (profiles, _, files) = await OpenOrgs();

        profiles.StartNew(null);
        profiles.Creating!.CancelCommand.Execute(null);

        Assert.True(profiles.ShowProfile);
        Assert.Equal("orgs", profiles.Selected?.Name);

        profiles.StartNew(null);
        profiles.Selected = profiles.Items.Single(item => item.Name == "base");

        Assert.False(profiles.ShowCreating);
        Assert.Equal(files.Base, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task Capturing_a_repository_makes_a_profile_and_says_what_it_left_out()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.NoProfiles)
            .On($"capture TheLunchTrae/repotted --output {made} --json", () =>
            {
                File.WriteAllText(made, "repository:\n  has_wiki: false\n");
                return """{"repository":"TheLunchTrae/repotted","profile":{"repository":{"has_wiki":false}},"warnings":["Skipped rulesets: this repository’s plan does not support rulesets","Skipped environments: the app cannot read Actions"]}""";
            });
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings);
        await shell.RefreshAsync();
        shell.Repositories.Selected = shell.Repositories.Rows.Single(row => row.Name == "repotted");

        shell.Repositories.CaptureCommand.Execute(null);

        Assert.True(shell.ShowingProfiles);
        Assert.Equal($"Profiles / {ControlLabel.Native.For("New profile")}", shell.Crumb);
        var form = shell.Profiles.Creating!;
        Assert.True(form.Captures);
        Assert.Equal(("repotted", "TheLunchTrae/repotted"), (form.Name, form.Repository));
        Assert.Equal(["TheLunchTrae/github-setup", "TheLunchTrae/repotted", "TheLunchTrae/test-repo"], form.Repositories);
        var other = folders.Write("other.yaml", "");
        cli.On(folders.List(), Listing(("other", other, null), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made))
            .On($"profile {other} --json", Documents.ResolvedBase(other));

        await form.CreateCommand.ExecuteAsync(null);

        Assert.True(File.Exists(made));
        Assert.Equal("Profiles / repotted", shell.Crumb);
        Assert.Equal(
            "Repotted could not read all of the repository, so this profile leaves out:\nSkipped rulesets: this repository’s plan does not support rulesets\nSkipped environments: the app cannot read Actions",
            shell.Profiles.Captured);

        // The note is about the captured profile, so it goes once another opens.
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "other");
        Assert.Null(shell.Profiles.Captured);
    }

    private static string Listing(params (string Name, string File, string? Extends)[] profiles) =>
        JsonSerializer.Serialize(new { profiles = profiles.Select(profile => new { name = profile.Name, file = profile.File, extends = profile.Extends, problem = (string?)null }) });

    private async Task<(ProfilesViewModel Profiles, FakeCli Cli, (string Own, string Base) Files)> OpenOrgs(params string[] repositories)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => repositories);
        await profiles.RefreshCommand.ExecuteAsync(null);
        // The fake answers at once, so selecting a profile has loaded it.
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        return (profiles, cli, (own, @base));
    }

    private static SettingViewModel Find(ProfileViewModel editor, string key) =>
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == key);

    private static (SettingOrigin, string) Origin(ProfileViewModel editor, string key) =>
        (Find(editor, key).Origin, Find(editor, key).Note);

    private static void Choose(ProfileViewModel editor, string key, string label) =>
        Find(editor, key).Options.Single(option => option.Label == label).ChooseCommand.Execute(null);

    [Fact]
    public void Initials_take_the_first_and_last_words()
    {
        Assert.Equal("TS", Shell("TheLunchTrae", "Trae Smith").Initials);
        Assert.Equal("TH", Shell("TheLunchTrae", null).Initials);
        Assert.Equal("AB", Shell("a-b", null).Initials);
    }

    private ShellViewModel Shell(string login, string? name, string? variable = null, string source = "installations") =>
        new(
            new Account.SignedIn(login, name, variable, Documents.InstallUrl),
            new RepottedClient(new FakeCli().On("repos --json", $$"""{"source":"{{source}}","repositories":[]}""")),
            new FakeDesktop(),
            folders.Settings);
}
