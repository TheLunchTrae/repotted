using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

public sealed class RepottedClientTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task Status_reads_the_signed_in_account()
    {
        var client = new RepottedClient(new FakeCli().On("status --json", Documents.SignedIn));

        var account = await client.StatusAsync(None);

        Assert.Equal(new Account.SignedIn("TheLunchTrae", "Trae", null), account);
    }

    [Fact]
    public async Task Status_reads_why_it_is_signed_out()
    {
        var client = new RepottedClient(new FakeCli().On("status --json", Documents.SignedOut, exitCode: 1));

        var account = await client.StatusAsync(None);

        var signedOut = Assert.IsType<Account.SignedOut>(account);
        Assert.False(signedOut.Rejected);
        Assert.Null(signedOut.TokenVariable);
        Assert.Empty(signedOut.Problems);
    }

    [Fact]
    public async Task A_failure_document_becomes_its_message()
    {
        var client = new RepottedClient(new FakeCli().On(
            "repos --json",
            """{"error":{"kind":"error","message":"getaddrinfo ENOTFOUND api.github.com"}}""",
            exitCode: 1));

        var error = await Assert.ThrowsAsync<CliException>(() => client.RepositoriesAsync(None));

        Assert.Equal("getaddrinfo ENOTFOUND api.github.com", error.Message);
    }

    [Fact]
    public async Task Output_that_is_not_json_says_so()
    {
        var client = new RepottedClient(new FakeCli().On("status --json", "Usage: repotted <command>", exitCode: 2));

        var error = await Assert.ThrowsAsync<CliException>(() => client.StatusAsync(None));

        Assert.StartsWith("Could not read what the Repotted command line printed", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Repositories_reads_the_list_and_its_source()
    {
        var client = new RepottedClient(new FakeCli().On("repos --json", Documents.Repositories));

        var list = await client.RepositoriesAsync(None);

        Assert.True(list.FromInstallations);
        Assert.Equal(
            ["TheLunchTrae/github-setup", "TheLunchTrae/repotted", "TheLunchTrae/test-repo"],
            list.Repositories.Select(repository => repository.FullName));
        Assert.True(list.Repositories[2].Private);
    }

    [Fact]
    public async Task Sign_in_shows_the_code_before_it_finishes()
    {
        var entered = new TaskCompletionSource();
        var client = new RepottedClient(new FakeCli().OnLines("login --json", [Documents.Code, Documents.Done], entered.Task));
        DeviceCode? shown = null;

        var signingIn = client.SignInAsync(code => shown = code, None);

        Assert.False(signingIn.IsCompleted);
        Assert.Equal(new DeviceCode(new Uri("https://github.com/login/device"), "ABCD-1234",
            new DateTimeOffset(2026, 11, 7, 8, 0, 0, TimeSpan.Zero)), shown);
        entered.SetResult();
        var result = await signingIn;
        Assert.Equal(new Uri("https://github.com/apps/repotted-app/installations/new"), result.InstallUrl);
    }

    [Fact]
    public async Task Sign_in_reports_a_failure_after_the_code()
    {
        var client = new RepottedClient(new FakeCli().OnLines(
            "login --json",
            [Documents.Code, """{"event":"error","error":{"kind":"error","message":"The code expired."}}"""],
            exitCode: 1));

        var error = await Assert.ThrowsAsync<CliException>(() => client.SignInAsync(_ => { }, None));

        Assert.Equal("The code expired.", error.Message);
    }

    [Fact]
    public async Task Sign_in_reports_a_failure_before_the_code()
    {
        var client = new RepottedClient(new FakeCli().On(
            "login --json",
            """{"error":{"kind":"error","message":"GitHub refused the device flow."}}""",
            exitCode: 1));

        var error = await Assert.ThrowsAsync<CliException>(() => client.SignInAsync(_ => { }, None));

        Assert.Equal("GitHub refused the device flow.", error.Message);
    }
}
