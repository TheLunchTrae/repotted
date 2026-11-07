using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
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
    [InlineData("installations", null, "Signed in with Repotted App.")]
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
            ["Protect main: From base", "Old tags: Removed here"],
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
        var profiles = new ProfilesViewModel(new RepottedClient(cli), desktop, folders.Settings);
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
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings);

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
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop { Folder = other }, folders.Settings);

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
             new CompareRow(CompareKind.Adds, "Main: Require Checks", "new ruleset", "Not on GitHub", "required_status_checks"),
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
            """{"rulesets":[{"name":"Main","rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}}]}]}""",
            """
            {"section":"rulesets","action":"update","target":"Main",
             "fields":[{"field":"rules",
               "from":[{"type":"pull_request","parameters":{"allowed_merge_methods":["rebase","squash"]}},{"type":"non_fast_forward"}],
               "to":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}}]}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/rulesets/7","body":{}}}
            """));

        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Main", "rules[pull_request].parameters.allowed_merge_methods", "rebase, squash", "squash, rebase"),
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

    private async Task<(ProfilesViewModel Profiles, FakeCli Cli, (string Own, string Base) Files)> OpenOrgs()
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings);
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
