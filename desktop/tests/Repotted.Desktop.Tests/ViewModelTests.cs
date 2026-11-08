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

    /// <summary>The desktop the profiles page from OpenOrgs uses, whose folder pick a test can set.</summary>
    private readonly FakeDesktop orgsDesktop = new();

    public void Dispose() => folders.Dispose();

    private MainViewModel App(FakeCli cli, FakeDesktop? desktop = null) =>
        new(cli.Answers(folders.List()) ? cli : cli.On(folders.List(), Documents.NoProfiles),
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
    public async Task A_lost_sign_in_goes_back_to_the_sign_in_once()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories);
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);

        cli.On("status --json", Documents.Rejected, exitCode: 1)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.Equal("GitHub no longer accepts your last sign-in. Sign in again.", signIn.Notice);
        // Two failures, one check.
        Assert.Equal(2, cli.Calls.Count(call => call == "status --json"));
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_read_on_another_thread_changes_the_page_on_this_one()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories);
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        var changedOnThisThread = new List<bool>();
        main.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(MainViewModel.Page))
            {
                changedOnThisThread.Add(Dispatcher.UIThread.CheckAccess());
            }
        };

        cli.On("status --json", Documents.Rejected, exitCode: 1)
            .OnPoolThread("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.IsType<SignInViewModel>(main.Page);
        Assert.NotEmpty(changedOnThisThread);
        Assert.All(changedOnThisThread, Assert.True);
    }

    [AvaloniaFact]
    public async Task Sign_out_removes_the_sign_in_and_goes_back_to_the_sign_in()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On("logout --json", """{"removed":true}""");
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        Assert.True(shell.ShowSignOut);

        cli.On("status --json", Documents.SignedOut, exitCode: 1);
        await shell.SignOutCommand.ExecuteAsync(null);

        Assert.Contains("logout --json", cli.Calls);
        Assert.False(Assert.IsType<SignInViewModel>(main.Page).HasNotice);
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_that_still_works_keeps_the_app_and_what_it_holds()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories);
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Search = "repotted";

        // Another run refreshed the token first, so the sign-in still works.
        cli.On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        cli.On("repos --json", Documents.Repositories);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(2, cli.Calls.Count(call => call == "status --json"));
        Assert.Same(shell, main.Page);
        Assert.Equal("repotted", shell.Search);
        Assert.Equal("Bad credentials", shell.Repositories.Error);
    }

    [AvaloniaFact]
    public async Task Pages_that_lose_the_sign_in_together_check_it_once_and_keep_the_app_meanwhile()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories);
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        var checkedAgain = new TaskCompletionSource();
        cli.OnceReady("status --json", Documents.SignedOut, checkedAgain.Task)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Same(shell, main.Page);
        Assert.Equal(2, cli.Calls.Count(call => call == "status --json"));
        checkedAgain.SetResult();
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_that_finds_another_account_opens_the_app_for_it()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories);
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);

        cli.On("status --json", Documents.SignedInAsOther)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        cli.On("repos --json", Documents.Repositories);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("other", Assert.IsType<ShellViewModel>(main.Page).Account.Login);
    }

    [AvaloniaFact]
    public async Task The_next_app_waits_for_the_last_ones_sync_before_its_own()
    {
        var copy = folders.Settings.ConfigFolder("lunch/config", "");
        Directory.CreateDirectory(copy);
        File.WriteAllText(Path.Combine(copy, ".repotted-sync.json"), "{}");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var sync = $"sync {copy} --json";
        const string synced = """{"repository":"lunch/config","path":"","branch":"main","commit":"abc123","pulled":[],"pushed":[],"conflicts":[]}""";
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(sync, synced)
            .On(folders.List(copy), Documents.NoProfiles);
        var main = App(cli);
        await main.StartAsync();
        var first = Assert.IsType<ShellViewModel>(main.Page);
        var slow = new TaskCompletionSource();
        cli.OnceReady(sync, synced, slow.Task);
        var syncing = first.Profiles.RefreshCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(first.Profiles.Syncing);

        cli.On("status --json", Documents.SignedInAsOther)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await first.Repositories.RefreshCommand.ExecuteAsync(null);
        cli.On("repos --json", Documents.Repositories).On(sync, synced);
        Dispatcher.UIThread.RunJobs();

        // The old app's sync still runs, so the new one has not started its own.
        Assert.IsType<LoadingViewModel>(main.Page);
        Assert.Equal(2, cli.Calls.Count(call => call == sync));
        slow.SetResult();
        await syncing;
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("other", Assert.IsType<ShellViewModel>(main.Page).Account.Login);
        Assert.Equal(3, cli.Calls.Count(call => call == sync));
    }

    /// <summary>The app signed in, with an unsaved edit to its one profile.</summary>
    private async Task<(MainViewModel Main, ShellViewModel Shell, FakeCli Cli, string File)> SignedInWithAnEdit()
    {
        var file = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), $$"""{"profiles":[{"name":"base","file":{{JsonSerializer.Serialize(file)}},"extends":null,"problem":null}]}""")
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On("logout --json", """{"removed":true}""");
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Profiles.Selected = shell.Profiles.Items.Single();
        Choose(shell.Profiles.Current!, "has_wiki", "Off");
        return (main, shell, cli, file);
    }

    /// <summary>Runs the UI thread's work until <paramref name="done"/>, for work that ends off the test's own awaits.</summary>
    private static async Task Until(Func<bool> done)
    {
        for (var tries = 0; tries < 500 && !done(); tries++)
        {
            await Task.Delay(10);
            Dispatcher.UIThread.RunJobs();
        }
        Assert.True(done());
    }

    [AvaloniaTheory]
    [InlineData("cancel")]
    [InlineData("discard")]
    [InlineData("failed save")]
    public async Task Sign_out_asks_about_unsaved_changes_first(string answer)
    {
        var (main, shell, cli, file) = await SignedInWithAnEdit();
        var editor = shell.Profiles.Current!;
        cli.On("status --json", Documents.SignedOut, exitCode: 1)
            .On($"profile {file} --set repository.has_wiki=false --json", """{"error":{"kind":"error","message":"The disk is full."}}""", exitCode: 1);

        var signingOut = shell.SignOutCommand.ExecuteAsync(null);

        Assert.Equal(1, shell.Page);
        Assert.Equal("base has unsaved changes. Save them before you sign out?", shell.Profiles.LeavingMessage);
        Assert.DoesNotContain("logout --json", cli.Calls);
        switch (answer)
        {
            case "cancel":
                shell.Profiles.StayHereCommand.Execute(null);
                break;
            case "discard":
                shell.Profiles.DiscardAndLeaveCommand.Execute(null);
                break;
            default:
                await shell.Profiles.SaveAndLeaveCommand.ExecuteAsync(null);
                break;
        }
        await signingOut.WaitAsync(TimeSpan.FromSeconds(5));

        if (answer == "discard")
        {
            Assert.Contains("logout --json", cli.Calls);
            Assert.IsType<SignInViewModel>(main.Page);
            return;
        }
        Assert.DoesNotContain("logout --json", cli.Calls);
        Assert.Same(shell, main.Page);
        Assert.True(editor.HasChanges);
        Assert.Equal(answer == "failed save", editor.SaveError is not null);
    }

    [AvaloniaTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_lost_sign_in_asks_about_unsaved_changes_before_the_app_goes(bool save)
    {
        var (main, shell, cli, file) = await SignedInWithAnEdit();
        var editor = shell.Profiles.Current!;
        shell.Page = 0;
        cli.On("status --json", Documents.SignedOut, exitCode: 1)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1)
            .On($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file));

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        await Until(() => shell.Profiles.HasLeaving);

        Assert.Same(shell, main.Page);
        Assert.Equal(1, shell.Page);
        Assert.Equal("base has unsaved changes. Save them before you sign in again?", shell.Profiles.LeavingMessage);
        if (!save)
        {
            shell.Profiles.StayHereCommand.Execute(null);
            await Until(() => !shell.Profiles.HasLeaving);
            Assert.Same(shell, main.Page);
            Assert.True(editor.HasChanges);
            // The check ended with the question, so the next failure asks again.
            await shell.Repositories.RefreshCommand.ExecuteAsync(null);
            await Until(() => shell.Profiles.HasLeaving);
            shell.Profiles.StayHereCommand.Execute(null);
            return;
        }
        // A local save needs no sign-in, so the edits keep.
        await shell.Profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await Until(() => main.Page is SignInViewModel);
        Assert.Contains($"profile {file} --set repository.has_wiki=false --json", cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_checks_again_once_the_question_goes_on()
    {
        var (main, shell, cli, _) = await SignedInWithAnEdit();
        cli.On("status --json", Documents.SignedOut, exitCode: 1)
            .On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        await Until(() => shell.Profiles.HasLeaving);

        // While the question waits, the GitHub CLI signs in.
        cli.On("status --json", Documents.SignedInAsOther)
            .On("repos --json", Documents.Repositories);
        shell.Profiles.DiscardAndLeaveCommand.Execute(null);
        await Until(() => main.Page is ShellViewModel { Account.Login: "other" });
    }

    [AvaloniaFact]
    public async Task Sign_out_waits_for_a_save_and_the_sync_after_it()
    {
        var file = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var written = new TaskCompletionSource();
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), $$"""{"profiles":[{"name":"base","file":{{JsonSerializer.Serialize(file)}},"extends":null,"problem":null}]}""")
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .OnceReady($"profile {file} --set repository.has_wiki=false --json", Documents.ResolvedBase(file), written.Task);
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

        var changes = 0;
        shell.SignOutCommand.CanExecuteChanged += (_, _) => changes++;

        var saving = editor.SaveCommand.ExecuteAsync(null);

        // The button reads the command again whenever a save starts or ends.
        Assert.Equal(1, changes);
        Assert.False(shell.SignOutCommand.CanExecute(null));
        written.SetResult();
        await saving;
        Assert.Equal(2, changes);
        Assert.True(shell.SignOutCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Closing_the_app_stops_a_capture_and_removes_its_file()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        var stopped = false;
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
            {
                cancellationToken.Register(() => stopped = true);
                File.WriteAllText(output, "repository:\n");
                await finish.Task;
                return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
            });
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Profiles.StartNew("TheLunchTrae/repotted");
        var capturing = shell.Profiles.Creating!.CreateCommand.ExecuteAsync(null);
        Assert.Single(Leftovers());

        main.Stop();
        finish.SetResult();
        await capturing;

        Assert.True(stopped);
        Assert.False(File.Exists(made));
        Assert.Empty(Leftovers());
    }

    [AvaloniaFact]
    public async Task Signing_out_stops_a_capture_and_removes_its_file()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        var stopped = false;
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On("logout --json", """{"removed":true}""")
            .OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
            {
                cancellationToken.Register(() => stopped = true);
                File.WriteAllText(output, "repository:\n");
                // A command line that finishes anyway, as one that is slow to stop would.
                await finish.Task;
                return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
            });
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Profiles.StartNew("TheLunchTrae/repotted");
        var capturing = shell.Profiles.Creating!.CreateCommand.ExecuteAsync(null);
        Assert.Single(Leftovers());

        cli.On("status --json", Documents.SignedOut, exitCode: 1);
        await shell.SignOutCommand.ExecuteAsync(null);
        finish.SetResult();
        await capturing;

        Assert.IsType<SignInViewModel>(main.Page);
        Assert.True(stopped);
        Assert.False(File.Exists(made));
        Assert.Empty(Leftovers());
    }

    [AvaloniaFact]
    public async Task Sign_out_waits_for_a_sync_to_finish()
    {
        var copy = folders.Settings.ConfigFolder("lunch/config", "");
        Directory.CreateDirectory(copy);
        File.WriteAllText(Path.Combine(copy, ".repotted-sync.json"), "{}");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var synced = new TaskCompletionSource();
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .OnceReady(
                $"sync {copy} --json",
                """{"repository":"lunch/config","path":"","branch":"main","commit":"abc123","pulled":[],"pushed":[],"conflicts":[]}""",
                synced.Task)
            .On(folders.List(copy), Documents.NoProfiles);
        var shell = new ShellViewModel(
            new Account.SignedIn("TheLunchTrae", null, null, Documents.InstallUrl),
            new RepottedClient(cli),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);

        var refreshing = shell.RefreshAsync();
        Dispatcher.UIThread.RunJobs();

        Assert.True(shell.Profiles.Syncing);
        Assert.False(shell.SignOutCommand.CanExecute(null));
        synced.SetResult();
        await refreshing;
        Assert.True(shell.SignOutCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_from_an_app_already_replaced_changes_nothing()
    {
        var late = new TaskCompletionSource();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .OnceReady("repos --json", Documents.SignedOutFailure, late.Task)
            .On("logout --json", """{"removed":true}""");
        var main = App(cli);
        var starting = main.StartAsync();
        var first = Assert.IsType<ShellViewModel>(main.Page);

        // Signing out lands straight back in a new app, as with a GitHub CLI sign-in.
        cli.On("repos --json", Documents.Repositories);
        await first.SignOutCommand.ExecuteAsync(null);
        var second = Assert.IsType<ShellViewModel>(main.Page);
        late.SetResult();
        await starting;
        Dispatcher.UIThread.RunJobs();

        Assert.Same(second, main.Page);
        Assert.Equal(2, cli.Calls.Count(call => call == "status --json"));
    }

    [AvaloniaFact]
    public async Task A_failed_sign_out_says_why_and_checks_again()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On("logout --json", """{"error":{"kind":"error","message":"Could not reach the OS keychain."}}""", exitCode: 1);
        var main = App(cli);
        await main.StartAsync();

        await Assert.IsType<ShellViewModel>(main.Page).SignOutCommand.ExecuteAsync(null);

        var problem = Assert.IsType<ProblemViewModel>(main.Page);
        Assert.Equal("Could not reach the OS keychain.", problem.Message);
        await problem.TryAgainCommand.ExecuteAsync(null);
        Assert.IsType<ShellViewModel>(main.Page);
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
    [InlineData("installations", null, "Signed in with the Repotted App.", true)]
    [InlineData("admin", null, "Signed in with a GitHub token.", false)]
    [InlineData("admin", "GITHUB_TOKEN", "Signed in with GITHUB_TOKEN.", false)]
    [InlineData("installations", "GITHUB_TOKEN", "Signed in with GITHUB_TOKEN.", false)]
    public async Task Signed_in_with_says_what_the_token_is(string source, string? variable, string expected, bool canSignOut)
    {
        var shell = Shell("lunch", null, variable, source);
        // Without a variable, only the list tells an App sign-in from another token.
        Assert.Equal(variable is null ? null : expected, shell.SignedInWith);
        Assert.False(shell.ShowSignOut);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);

        Assert.Equal(expected, shell.SignedInWith);
        // Only the Repotted sign-in goes away on signing out; a variable or
        // the GitHub CLI's sign-in would still apply.
        Assert.Equal(canSignOut, shell.ShowSignOut);
    }

    [AvaloniaFact]
    public async Task Another_App_has_no_install_page_to_offer()
    {
        var shell = new ShellViewModel(
            new Account.SignedIn("lunch", null, null, null),
            new RepottedClient(new FakeCli().On("repos --json", """{"source":"installations","repositories":[]}""")),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);

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

    private static string OnlyBase(string @base) =>
        $$$"""{"profiles":[{"name":"base","file":{{{JsonSerializer.Serialize(@base)}}},"extends":null,"problem":null}]}""";

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

        editor.DiscardCommand.Execute(null);
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
        Assert.Equal(folders.Profiles, profiles.Folder);
        Assert.True(editor.HasChanges);

        // Discard drops the change and goes on.
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await change;
        Assert.Equal(other, profiles.Folder);
        Assert.False(editor.HasChanges);
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
        Assert.Equal(folders.Profiles, profiles.Folder);
        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);
        Assert.Same(editor, profiles.Current);

        cli.On(save, Documents.Resolved(files.Own, files.Base, wiki: true));
        change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        await change;
        Assert.Contains(save, cli.Calls);
        Assert.Equal(other, profiles.Folder);
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
        Assert.Equal(folders.Profiles, profiles.Folder);
        Assert.Equal("orgs has unsaved changes. Save them before you connect a repository?", profiles.LeavingMessage);
        profiles.DiscardAndLeaveCommand.Execute(null);
        await start;
        Assert.NotNull(profiles.Connecting);
        Assert.Equal(folders.Profiles, profiles.Folder);
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

        Assert.Equal(other, profiles.Folder);
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
        Assert.Equal(other, profiles.Folder);
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
        Assert.Equal(folders.Profiles, profiles.Folder);

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
        Assert.Equal(folders.Profiles, profiles.Folder);
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
        Assert.Null(compare.DraftsNote);
    }

    [AvaloniaFact]
    public async Task A_compare_names_the_drafts_it_leaves_out()
    {
        var compare = await Compare(Documents.Plan(skipped: """{"section":"repository","target":"has_wiki"},{"section":"rulesets","target":"Later"}"""));

        Assert.Equal("Left out as drafts: repository.has_wiki, the ruleset Later.", compare.DraftsNote);
        Assert.Equal("5 differences in 3 sections. Matching settings are folded away.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task Showing_everything_adds_the_matching_rows()
    {
        var compare = await Compare(Documents.Plan());

        compare.DifferencesOnly = false;

        var settings = compare.Sections[0].Rows;
        Assert.Equal(
            [("Allow squash merging", CompareKind.Changes), ("Issues", CompareKind.Matches), ("Wiki", CompareKind.Matches),
             ("Allow rebase merging", CompareKind.Matches)],
            settings.Select(row => (row.Label, row.Kind)));
        Assert.Equal(("On", "On"), (settings[1].Now, settings[1].Wanted));
        Assert.Equal("5 differences in 3 sections. Matching settings show below them.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_marks_the_differences_Repotted_cannot_change()
    {
        var desktop = new FakeDesktop();
        var compare = await Compare(
            Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc),
            desktop);

        var actions = compare.Sections.Single(section => section.Title == "Actions").Rows;
        Assert.Equal(
            [("default_workflow_permissions", null), ("oidc_customization_sub.use_default", "Needs Actions write"),
             ("oidc_customization_sub.include_claim_keys", "Needs Actions write")],
            actions.Select(row => (row.Key, row.Lock)));
        Assert.Equal(
            "Use the default subject claim, oidc_customization_sub.use_default: GitHub has On, the profile sets Off. "
                + "Repotted can't change it: Needs Actions write",
            actions[1].AccessibleName);
        Assert.True(compare.HasLocks);
        Assert.Equal("Repotted can't change 2 differences below. Each says what it needs.", compare.LockSummary);
        Assert.True(compare.HasAccessUrl);

        await compare.ReviewAccessCommand.ExecuteAsync(null);

        Assert.Equal([new Uri("https://github.com/settings/installations/7")], desktop.Opened);
    }

    [AvaloniaFact]
    public async Task The_cant_change_filter_shows_only_the_locked_differences_and_works_with_the_search()
    {
        var compare = await Compare(
            Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc));
        List<string> Shown() => [.. compare.Sections.Where(section => section.Shown).SelectMany(section => section.Rows).Select(row => row.Key)];

        compare.LockedOnly = true;
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());
        Assert.All(compare.Sections, section => Assert.False(section.HasSummary));
        // Showing matching settings too adds nothing, since only a difference can be locked.
        compare.DifferencesOnly = false;
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());

        // "Actions" also finds the unlocked default permissions row, which the filter leaves out.
        compare.Query = "actions";
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());
        compare.LockedOnly = false;
        Assert.Contains("default_workflow_permissions", Shown());
        compare.LockedOnly = true;
        compare.Query = "squash";
        Assert.True(compare.NothingFound);
        Assert.Equal("No difference Repotted can't change matches \u201csquash\u201d.", compare.NothingFoundMessage);

        compare.Query = "";
        compare.LockedOnly = false;
        Assert.Contains("allow_squash_merge", Shown());
    }

    [AvaloniaFact]
    public async Task A_compare_turns_the_cant_change_filter_off_when_nothing_is_locked_any_more()
    {
        const string command = "plan TheLunchTrae/repotted --profile orgs.yaml --json";
        var cli = new FakeCli().On(
            command, Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc));
        var compare = new CompareViewModel(
            new RepottedClient(cli), new FakeDesktop(), "TheLunchTrae/repotted",
            new ProfileListingDocument("orgs", "orgs.yaml", null, null), Documents.InstallUrl);
        await compare.LoadCommand.ExecuteAsync(null);
        compare.LockedOnly = true;

        cli.On(command, Documents.Plan(changes: Documents.Oidc));
        await compare.LoadCommand.ExecuteAsync(null);

        Assert.False(compare.HasLocks);
        Assert.False(compare.LockedOnly);
        Assert.All(compare.Sections, section => Assert.True(section.Shown));
    }

    [AvaloniaFact]
    public async Task A_compare_marks_a_locked_change_in_any_section()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"workflow"}},
             "changes":[{"section":"pages","action":"create","target":"GitHub Pages site","fields":[],
               "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/pages","body":{"build_type":"workflow"} } }],
             "skipped":[],"warnings":[],
             "access":{"role":"admin","app":{"status":"installed","permissions":{"administration":"write"},"settings_url":null}},
             "locks":[{"change":0,"reason":"Needs Pages write"}]}
            """;
        var compare = await Compare(plan);

        Assert.Equal("Needs Pages write", compare.Sections.Single().Rows.Single().Lock);
        Assert.Equal("Repotted can't change 1 difference below. It says what it needs.", compare.LockSummary);
        Assert.False(compare.HasAccessUrl);
    }

    [AvaloniaFact]
    public async Task A_compare_offers_the_install_page_when_the_App_is_not_on_the_repository()
    {
        var desktop = new FakeDesktop();
        var compare = await Compare(
            Documents.Plan(
                access: """{"role":"admin","app":{"status":"not_installed"}}""",
                locks: """{"change":0,"reason":"Needs the GitHub App installed on this repository"}"""),
            desktop);

        Assert.Equal("Install the App", compare.AccessLabel);
        await compare.ReviewAccessCommand.ExecuteAsync(null);
        Assert.Equal([Documents.InstallUrl], desktop.Opened);
    }

    [AvaloniaFact]
    public async Task A_compare_locks_nothing_when_the_access_is_unknown_and_links_only_https()
    {
        var unknown = await Compare(Documents.Plan(changes: Documents.Oidc));

        Assert.False(unknown.HasLocks);
        Assert.False(unknown.HasAccessUrl);
        Assert.DoesNotContain(unknown.Sections.SelectMany(section => section.Rows), row => row.IsLocked);

        var elsewhere = await Compare(Documents.Plan(
            access: Documents.ActionsRead.Replace("https://github.com", "http://github.com", StringComparison.Ordinal),
            locks: """{"change":0,"reason":"Needs Administration write"}"""));

        Assert.Equal("Repotted can't change 1 difference below. It says what it needs.", elsewhere.LockSummary);
        Assert.False(elsewhere.HasAccessUrl);
    }

    [AvaloniaFact]
    public async Task Searching_a_compare_finds_rows_by_setting_section_and_entry()
    {
        var compare = await Compare(Documents.Plan());
        List<string> Shown() => [.. compare.Sections.Where(section => section.Shown).SelectMany(section => section.Rows).Select(row => row.Label)];

        compare.Query = "squash";
        Assert.Equal(["Allow squash merging"], Shown());
        // A search that finds the same rows keeps the rows on screen as they are.
        var rows = compare.Sections.Single(section => section.Shown).Rows;
        compare.Query = "squash ";
        Assert.Same(rows, compare.Sections.Single(section => section.Shown).Rows);
        // Found by the setting's synonym and its group's description, which the row doesn't show.
        compare.Query = "github_token";
        Assert.Equal(["Default permissions"], Shown());
        // Found by a ruleset's name.
        compare.Query = "require pr";
        Assert.Equal(["Main: Require PR"], Shown());
        // Found by the section's title.
        compare.Query = "environments";
        Assert.Empty(Shown());
        Assert.True(compare.NothingFound);
        Assert.Equal("No differences match \u201cenvironments\u201d.", compare.NothingFoundMessage);

        compare.DifferencesOnly = false;
        Assert.Equal(["npm"], Shown());
        Assert.False(compare.NothingFound);
        compare.Query = "wiki";
        Assert.Equal(["Wiki"], Shown());
        // The line that counts matching settings counts rows a search may not find, so it hides.
        Assert.All(compare.Sections, section => Assert.False(section.HasSummary));

        compare.ClearSearchCommand.Execute(null);
        Assert.Contains(compare.Sections, section => section.HasSummary);
        Assert.All(compare.Sections, section => Assert.True(section.Shown));
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
        compare.DifferencesOnly = false;
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

        compare.DifferencesOnly = false;

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
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => Task.CompletedTask);
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
        $$"""{"repository":"TheLunchTrae/repotted","desired":{{desired}},"changes":[{{changes}}],"skipped":[],"warnings":[],"access":{{Documents.Unknown}},"locks":[]}""";

    [AvaloniaFact]
    public async Task A_compare_covers_security_pages_and_autolinks()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted",
             "desired":{
               "security":{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}},
                 "dependabot_runner_settings":{"runner_type":"standard","runner_labels":["x"]}},
               "custom_properties":{"team":"platform"},
               "pages":{"build_type":"workflow"},
               "autolinks":[{"key_prefix":"JIRA-","url_template":"https://jira.example.com/<num>"},{"key_prefix":"OLD-","absent":true}]},
             "changes":[
               {"section":"security","action":"update","target":"security and analysis",
                "fields":[{"field":"security_and_analysis.secret_scanning","from":{"status":"disabled"},"to":{"status":"enabled"}}],
                "request":{"method":"PATCH","path":"/repos/TheLunchTrae/repotted","body":{} } },
               {"section":"pages","action":"create","target":"GitHub Pages site","fields":[],
                "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/pages","body":{"build_type":"workflow"} } },
               {"section":"autolinks","action":"delete","target":"JIRA-","fields":[],
                "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/autolinks/1"} },
               {"section":"autolinks","action":"create","target":"JIRA-",
                "fields":[{"field":"url_template","from":"https://old.example.com/<num>","to":"https://jira.example.com/<num>"}],
                "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/autolinks","body":{} } }],
             "skipped":[],"warnings":["Skipped security.dependabot_runner_settings.runner_labels: GitHub keeps none with standard runners"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            ["Security", "Custom properties", "GitHub Pages", "Autolinks"],
            compare.Sections.Select(section => section.Title));
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Secret Protection", "security_and_analysis.secret_scanning.status", "Off", "On"),
             new CompareRow(CompareKind.Matches, "Push protection", "security_and_analysis.secret_scanning_push_protection", "On", "On"),
             new CompareRow(CompareKind.Matches, "Dependabot runners", "dependabot_runner_settings.runner_type", "Standard", "Standard")],
            compare.Sections[0].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Matches, "team", "team", "platform", "platform")],
            compare.Sections[1].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Adds, "GitHub Pages site", "new GitHub Pages site", CompareRow.NotOnGitHub, CompareRow.Created)],
            compare.Sections[2].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "JIRA-", "url_template", "https://old.example.com/<num>", "https://jira.example.com/<num>")],
            compare.Sections[3].Rows);
        Assert.Equal("1 removed autolink is already gone.", compare.Sections[3].Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_says_when_GitHub_would_not_show_a_section()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"workflow"}},"changes":[],
             "skipped":[],"warnings":["Skipped pages: GitHub refused to read GitHub Pages (Forbidden); that needs the Pages read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);

        var pages = compare.Sections.Single();
        Assert.True(pages.Skipped);
        Assert.Equal("Repotted could not read it: GitHub refused to read GitHub Pages (Forbidden); that needs the Pages read permission", pages.Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_shows_a_changed_Pages_source_once()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"legacy","source":{"branch":"main","path":"/"}}},
             "changes":[{"section":"pages","action":"update","target":"GitHub Pages site",
               "fields":[{"field":"source","from":{"branch":"gh-pages","path":"/"},"to":{"branch":"main","path":"/"}}],
               "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/pages","body":{} } }],
             "skipped":[],"warnings":[],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Branch", "source.branch", "gh-pages", "main"),
             new CompareRow(CompareKind.Matches, "Build from", "build_type", "A branch", "A branch")],
            compare.Sections.Single().Rows);
    }

    [AvaloniaFact]
    public async Task A_compare_says_when_the_profile_leaves_a_section_unchecked()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"legacy"}},"changes":[],
             "skipped":[],"warnings":["Skipped pages: a new site built from a branch needs source.branch, or build_type: workflow"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);

        Assert.Equal("Not checked: a new site built from a branch needs source.branch, or build_type: workflow", compare.Sections.Single().Summary);
    }

    [AvaloniaFact]
    public async Task A_skipped_section_hides_only_its_own_settings()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"custom_properties":{"rulesets":"strict"}},"changes":[],
             "skipped":[],"warnings":["Skipped rulesets: GitHub refused to read rulesets (Forbidden); that needs the Administration read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            [new CompareRow(CompareKind.Matches, "rulesets", "rulesets", "strict", "strict")],
            compare.Sections.Single(section => section.Title == "Custom properties").Rows);
    }

    [AvaloniaFact]
    public async Task A_search_keeps_a_section_it_could_not_read_when_it_finds_its_title()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"repository":{"has_wiki":false},"rulesets":[{"name":"Main"}]},"changes":[],
             "skipped":[],"warnings":["Skipped rulesets: GitHub refused to read rulesets (Forbidden); that needs the Administration read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        var rulesets = compare.Sections.Single(section => section.Skipped);

        compare.Query = "rulesets";
        Assert.True(rulesets.Shown);
        // It keeps the line that says why it wasn't read.
        Assert.True(rulesets.HasSummary);
        Assert.False(compare.NothingFound);
        compare.Query = "wiki";
        Assert.False(rulesets.Shown);
    }

    private static async Task<CompareViewModel> Compare(string plan, FakeDesktop? desktop = null)
    {
        var compare = new CompareViewModel(
            new RepottedClient(new FakeCli().On("plan TheLunchTrae/repotted --profile orgs.yaml --json", plan)),
            desktop ?? new FakeDesktop(),
            "TheLunchTrae/repotted",
            new ProfileListingDocument("orgs", "orgs.yaml", null, null),
            Documents.InstallUrl);
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
            new RepottedClient(new FakeCli()), folders.Profiles, [], [], null, (_, _) => Task.CompletedTask, () => { }, () => { }, new HashSet<string>(), work => work())
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
        var cli = new FakeCli().OnCapture("TheLunchTrae/repotted", output =>
        {
            File.WriteAllText(output, "repository:\n");
            return NotFound;
        });
        var profiles = new ProfilesViewModel(new RepottedClient(cli.On(folders.List(), Documents.NoProfiles)), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        // A capture the app never saw end, such as when it quit, leaves its file, which holds nothing.
        var left = folders.Write(".repotted.yaml.k2v9x0qa.4fz.repotted-capture", "repository:\n");
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        Assert.Null(form.Problem);

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("Not Found", form.Error);
        Assert.Equal([left], Directory.EnumerateFileSystemEntries(folders.Profiles));

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
        var finish = new TaskCompletionSource();
        var stopped = false;
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            cancellationToken.Register(() => stopped = true);
            // A command line that finishes anyway, as one that is slow to stop would.
            await finish.Task;
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
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
        Assert.Equal([files.Base, files.Own], Directory.EnumerateFileSystemEntries(folders.Profiles).Order());
        Assert.Same(next, profiles.Creating);
        Assert.Null(profiles.Captured);
        Assert.Equal(files.Own, profiles.Current?.File);
    }

    [AvaloniaFact]
    public async Task A_capture_holds_its_name_and_frees_it_once_it_stops()
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/repotted");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, _) =>
        {
            File.WriteAllText(output, "repository:\n");
            await finish.Task;
            return NotFound;
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);

        // Another form cannot take the name while the closed one holds it, and can once it lets go.
        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew(null);
        var next = profiles.Creating!;
        next.Name = "Repotted";
        Assert.Equal("Another capture is making Repotted.yaml.", next.Problem);
        finish.SetResult();
        await capturing;

        Assert.Empty(Leftovers());
        Assert.Null(next.Problem);
    }

    [AvaloniaTheory]
    [InlineData("repotted.yaml")]
    [InlineData("Repotted.yaml")]
    public async Task A_file_that_arrives_during_a_capture_is_kept(string arrives)
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/repotted");
        cli.OnCapture("TheLunchTrae/repotted", output =>
        {
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            // A sync brings in a profile of the same name meanwhile.
            folders.Write(arrives, "repository: { has_issues: true }\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal($"{arrives} is already in this folder.", form.Error);
        Assert.Equal("repository: { has_issues: true }\n", File.ReadAllText(Path.Combine(folders.Profiles, arrives)));
        Assert.Empty(Leftovers());
    }

    [AvaloniaFact]
    public async Task A_capture_keeps_the_name_it_started_with()
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, _) =>
        {
            await finish.Task;
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);

        Assert.False(form.Editable);
        // A name in use, typed while GitHub is read, changes nothing.
        form.Name = "orgs";
        finish.SetResult();
        await capturing;

        Assert.Null(form.Error);
        Assert.Equal("repository:\n  has_wiki: false\n", File.ReadAllText(made));
        Assert.Equal(made, profiles.Current?.File);
        Assert.True(form.Editable);
    }

    [AvaloniaFact]
    public async Task A_capture_is_not_held_against_its_own_form()
    {
        var (profiles, cli, _) = await OpenOrgs("TheLunchTrae/one", "TheLunchTrae/two");
        var finish = new Dictionary<string, TaskCompletionSource> { ["TheLunchTrae/one"] = new(), ["TheLunchTrae/two"] = new() };
        foreach (var (repository, done) in finish)
        {
            cli.OnCapture(repository, async (_, _) =>
            {
                await done.Task;
                return NotFound;
            });
        }
        profiles.StartNew("TheLunchTrae/one");
        var first = profiles.Creating!.CreateCommand.ExecuteAsync(null);
        profiles.Creating!.CancelCommand.Execute(null);
        profiles.StartNew("TheLunchTrae/two");
        var form = profiles.Creating!;
        var second = form.CreateCommand.ExecuteAsync(null);

        // The closed form's capture ends first, and the open form checks its name again.
        finish["TheLunchTrae/one"].SetResult();
        await first;

        Assert.Null(form.Problem);
        finish["TheLunchTrae/two"].SetResult();
        await second;
    }

    [AvaloniaFact]
    public async Task A_capture_whose_file_cannot_go_still_lets_go_of_its_name()
    {
        var cli = new FakeCli()
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", output =>
            {
                File.WriteAllText(output, "repository:\n");
                // The folder goes while GitHub is read, so the file can't be removed.
                Directory.Delete(folders.Profiles, recursive: true);
                return NotFound;
            });
        var profiles = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
        await profiles.RefreshCommand.ExecuteAsync(null);
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("Not Found", form.Error);
        Assert.False(form.Working);
        profiles.StartNew(null);
        profiles.Creating!.Name = "repotted";
        Assert.Null(profiles.Creating.Problem);
    }

    [AvaloniaTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Changing_the_folder_during_a_capture_waits_on_the_question_and_leaves_no_capture_file(bool endsFirst)
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            File.WriteAllText(output, "repository:\n");
            await finish.Task.WaitAsync(cancellationToken);
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        Choose(profiles.Current!, "has_wiki", "On");
        profiles.StartNew("TheLunchTrae/repotted");
        var capturing = profiles.Creating!.CreateCommand.ExecuteAsync(null);
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);

        var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        if (endsFirst)
        {
            // A capture that ends while the question waits makes its profile in the folder it started in.
            finish.SetResult();
            await capturing.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(profiles.HasLeaving);
        }
        profiles.DiscardAndLeaveCommand.Execute(null);
        await change.WaitAsync(TimeSpan.FromSeconds(5));
        // Otherwise leaving closes the form, which stops the capture.
        await capturing.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(other, profiles.Folder);
        Assert.Equal(endsFirst, File.Exists(made));
        Assert.Empty(Leftovers());
    }

    [AvaloniaTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_question_that_cannot_settle_keeps_a_running_capture_and_says_why(bool save)
    {
        var (profiles, cli, files) = await OpenOrgs("TheLunchTrae/repotted");
        var editor = profiles.Current!;
        var reload = Task.CompletedTask;
        var resolve = new TaskCompletionSource<string>();
        if (save)
        {
            Choose(editor, "has_wiki", "On");
            cli.On($"profile {files.Own} --set repository.has_wiki=true --json", """{"error":{"kind":"error","message":"The file could not be written"}}""", exitCode: 1);
        }
        else
        {
            // An editor reloading its file can't discard its changes yet.
            editor.Tab("Environments").Entries[0].Editor.Name = "pages";
            File.AppendAllText(files.Own, "# pulled by a sync\n");
            await editor.SaveCommand.ExecuteAsync(null);
            cli.On($"profile {files.Own} --json", _ => resolve.Task);
            reload = editor.ReloadCommand.ExecuteAsync(null);
        }
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var finish = new TaskCompletionSource();
        var stopped = false;
        cli.OnCapture("TheLunchTrae/repotted", async (output, cancellationToken) =>
        {
            cancellationToken.Register(() => stopped = true);
            await finish.Task.WaitAsync(cancellationToken);
            File.WriteAllText(output, "repository:\n  has_wiki: false\n");
            return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
        });
        cli.On(folders.List(), Listing(("base", files.Base, null), ("orgs", files.Own, files.Base), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made));
        profiles.StartNew("TheLunchTrae/repotted");
        var form = profiles.Creating!;
        var capturing = form.CreateCommand.ExecuteAsync(null);
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        orgsDesktop.Folder = other;
        cli.On(folders.List(other), Documents.NoProfiles);
        // A notice already showing, which the one about the question covers for a while.
        const string Earlier = "Repotted could not remember this folder for next time: the disk is full";
        profiles.Notice = Earlier;
        var notice = save
            ? "orgs could not be saved, so you cannot change the folder yet."
            : "orgs is still loading, so you cannot change the folder yet.";
        async Task Answer()
        {
            var change = profiles.ChangeFolderCommand.ExecuteAsync(null);
            Assert.True(profiles.HasLeaving);
            if (save)
            {
                await profiles.SaveAndLeaveCommand.ExecuteAsync(null);
            }
            else
            {
                profiles.DiscardAndLeaveCommand.Execute(null);
            }
            await change.WaitAsync(TimeSpan.FromSeconds(5));
        }

        await Answer();

        // Opening the profile would close the form and stop the capture, so the notice says why instead.
        Assert.Equal(folders.Profiles, profiles.Folder);
        Assert.Same(form, profiles.Creating);
        Assert.True(form.Working);
        Assert.False(stopped);
        Assert.Equal(notice, profiles.Notice);

        // Asking again takes it away, and the notice it covered shows again.
        var asking = profiles.ChangeFolderCommand.ExecuteAsync(null);
        Assert.True(profiles.HasLeaving);
        Assert.Equal(Earlier, profiles.Notice);
        profiles.StayHereCommand.Execute(null);
        await asking.WaitAsync(TimeSpan.FromSeconds(5));
        await Answer();
        Assert.Equal(notice, profiles.Notice);
        resolve.SetResult(Documents.Resolved(files.Own, files.Base));
        await reload.WaitAsync(TimeSpan.FromSeconds(5));
        finish.SetResult();
        await capturing.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(File.Exists(made));
        Assert.NotNull(profiles.Notice);

        // The notice goes once the profile it names opens.
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        Assert.Equal(Earlier, profiles.Notice);
    }

    [AvaloniaFact]
    public async Task Captures_in_two_copies_of_the_app_write_files_of_their_own()
    {
        var made = Path.Combine(folders.Profiles, "repotted.yaml");
        var outputs = new List<string>();
        var finish = new[] { new TaskCompletionSource(), new TaskCompletionSource() };
        var cli = new FakeCli()
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", async (output, _) =>
            {
                var index = outputs.Count;
                outputs.Add(output);
                File.WriteAllText(output, $"# copy {index}\n");
                await finish[index].Task;
                return """{"repository":"TheLunchTrae/repotted","profile":{},"warnings":[]}""";
            });
        var forms = new List<NewProfileViewModel>();
        foreach (var _ in finish)
        {
            var copy = new ProfilesViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => ["TheLunchTrae/repotted"]);
            await copy.RefreshCommand.ExecuteAsync(null);
            copy.StartNew("TheLunchTrae/repotted");
            forms.Add(copy.Creating!);
        }
        var capturing = forms.Select(form => form.CreateCommand.ExecuteAsync(null)).ToList();

        Assert.Equal(2, outputs.Distinct().Count());
        finish[0].SetResult();
        await capturing[0];
        finish[1].SetResult();
        await capturing[1];

        Assert.Equal("# copy 0\n", File.ReadAllText(made));
        Assert.Equal("repotted.yaml is already in this folder.", forms[1].Error);
        Assert.Empty(Leftovers());
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
            .OnCapture("TheLunchTrae/repotted", output =>
            {
                File.WriteAllText(output, "repository:\n  has_wiki: false\n");
                return """{"repository":"TheLunchTrae/repotted","profile":{"repository":{"has_wiki":false}},"warnings":["Skipped rulesets: this repository’s plan does not support rulesets","Skipped environments: the app cannot read Actions"]}""";
            });
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => Task.CompletedTask);
        await shell.RefreshAsync();
        shell.Repositories.Selected = shell.Repositories.Rows.Single(row => row.Name == "repotted");

        shell.Repositories.CaptureCommand.Execute(null);

        Assert.True(shell.ShowingProfiles);
        Assert.Equal($"Profiles / {ControlLabel.For("New profile")}", shell.Crumb);
        var form = shell.Profiles.Creating!;
        Assert.True(form.Captures);
        Assert.Equal(("repotted", "TheLunchTrae/repotted"), (form.Name, form.Repository));
        Assert.Equal(["TheLunchTrae/github-setup", "TheLunchTrae/repotted", "TheLunchTrae/test-repo"], form.Repositories);
        var other = folders.Write("other.yaml", "");
        cli.On(folders.List(), Listing(("other", other, null), ("repotted", made, null)))
            .On($"profile {made} --json", Documents.ResolvedBase(made))
            .On($"profile {other} --json", Documents.ResolvedBase(other));

        await form.CreateCommand.ExecuteAsync(null);

        Assert.Equal("repository:\n  has_wiki: false\n", File.ReadAllText(made));
        Assert.Empty(Leftovers());
        Assert.Equal("Profiles / repotted", shell.Crumb);
        Assert.Equal(
            "Repotted could not read all of the repository, so this profile leaves out:\nSkipped rulesets: this repository’s plan does not support rulesets\nSkipped environments: the app cannot read Actions",
            shell.Profiles.Captured);

        // The note is about the captured profile, so it goes once another opens.
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "other");
        Assert.Null(shell.Profiles.Captured);

        // A finished capture holds its name no longer, so it is free once the profile is gone.
        File.Delete(made);
        shell.Profiles.StartNew(null);
        shell.Profiles.Creating!.Name = "repotted";
        Assert.Null(shell.Profiles.Creating.Problem);
    }

    private const string NotFound = """{"error":{"kind":"error","message":"Not Found"}}""";

    /// <summary>The files that captures write in the profiles folder until they are whole.</summary>
    private IEnumerable<string> Leftovers() => Directory.EnumerateFiles(folders.Profiles, "*.repotted-capture");

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
        var profiles = new ProfilesViewModel(new RepottedClient(cli), orgsDesktop, folders.Settings, () => repositories);
        await profiles.RefreshCommand.ExecuteAsync(null);
        // The fake answers at once, so selecting a profile has loaded it.
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        return (profiles, cli, (own, @base));
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
        var given = JsonNode.Parse(sources.Replace("OWN", JsonSerializer.Serialize(own), StringComparison.Ordinal))!.AsObject();
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
            folders.Settings,
            () => Task.CompletedTask);
}
