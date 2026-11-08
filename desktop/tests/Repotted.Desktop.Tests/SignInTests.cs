using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>Signing in and out, and what the app does when it loses the sign-in.</summary>
public sealed class SignInTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task Signed_in_opens_the_repository_list()
    {
        var main = App(FakeCli.SignedIn());

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
        var cli = FakeCli.SignedIn();
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
        var cli = FakeCli.SignedIn();
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
        var cli = FakeCli.SignedIn()
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
        var cli = FakeCli.SignedIn();
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
        var cli = FakeCli.SignedIn();
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
        var cli = FakeCli.SignedIn();
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
        var cli = FakeCli.SignedIn()
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
        var cli = FakeCli.SignedIn()
            .On(folders.List(), $$"""{"profiles":[{"name":"base","file":{{Json(file)}},"extends":null,"problem":null}]}""")
            .On($"profile {file} --json", Documents.ResolvedBase(file))
            .On("logout --json", """{"removed":true}""");
        var main = App(cli);
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Profiles.Selected = shell.Profiles.Items.Single();
        Choose(shell.Profiles.Current!, "has_wiki", "Off");
        return (main, shell, cli, file);
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
            .On(folders.List(), $$"""{"profiles":[{"name":"base","file":{{Json(file)}},"extends":null,"problem":null}]}""")
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
        var cli = FakeCli.SignedIn()
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
        var cli = FakeCli.SignedIn()
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
        var cli = FakeCli.SignedIn()
            .On("logout --json", """{"error":{"kind":"error","message":"Could not reach the OS keychain."}}""", exitCode: 1);
        var main = App(cli);
        await main.StartAsync();

        await Assert.IsType<ShellViewModel>(main.Page).SignOutCommand.ExecuteAsync(null);

        var problem = Assert.IsType<ProblemViewModel>(main.Page);
        Assert.Equal("Could not reach the OS keychain.", problem.Message);
        await problem.TryAgainCommand.ExecuteAsync(null);
        Assert.IsType<ShellViewModel>(main.Page);
    }
}
