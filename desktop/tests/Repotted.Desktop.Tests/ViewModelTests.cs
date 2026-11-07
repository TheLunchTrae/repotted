using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

public sealed class ViewModelTests
{
    private static MainViewModel App(FakeCli cli, FakeDesktop? desktop = null) =>
        new(new RepottedClient(cli), desktop ?? new FakeDesktop());

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
            """{"signed_in":false,"reason":"not_signed_in","message":"…","problems":["Could not read the OS keychain: locked."],"token_variable":null}""",
            exitCode: 1));

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.Equal("Could not read the OS keychain: locked.", signIn.Notice);
    }

    [AvaloniaFact]
    public async Task A_rejected_token_variable_says_to_fix_it()
    {
        var main = App(new FakeCli().On(
            "status --json",
            """{"signed_in":false,"reason":"rejected","message":"GitHub rejected the token in GH_TOKEN.","token_variable":"GH_TOKEN"}""",
            exitCode: 1));

        await main.StartAsync();

        var signIn = Assert.IsType<SignInViewModel>(main.Page);
        Assert.StartsWith("GitHub rejected the token in GH_TOKEN.", signIn.Notice, StringComparison.Ordinal);
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
        Dispatcher.UIThread.RunJobs();

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
        Assert.Null(signIn.Error);
        Assert.Same(signIn, main.Page);
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
        repositories.AddRepositoriesCommand.Execute(null);
        Assert.Equal([RepositoriesViewModel.InstallUrl], desktop.Opened);

        cli.On("repos --json", """{"source":"admin","repositories":[]}""");
        await repositories.RefreshCommand.ExecuteAsync(null);
        Assert.False(repositories.FromInstallations);
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

    [Fact]
    public void Initials_take_the_first_and_last_words()
    {
        Assert.Equal("TS", Shell("TheLunchTrae", "Trae Smith").Initials);
        Assert.Equal("TH", Shell("TheLunchTrae", null).Initials);
        Assert.Equal("AB", Shell("a-b", null).Initials);
    }

    [Fact]
    public void Signed_in_with_names_a_token_variable()
    {
        Assert.Equal("Signed in with Repotted App.", Shell("lunch", null).SignedInWith);
        Assert.Equal(
            "Signed in with GITHUB_TOKEN.",
            new ShellViewModel(new Account.SignedIn("lunch", null, "GITHUB_TOKEN"),
                new RepottedClient(new FakeCli()), new FakeDesktop()).SignedInWith);
    }

    private static ShellViewModel Shell(string login, string? name) =>
        new(new Account.SignedIn(login, name, null), new RepottedClient(new FakeCli()), new FakeDesktop());
}
