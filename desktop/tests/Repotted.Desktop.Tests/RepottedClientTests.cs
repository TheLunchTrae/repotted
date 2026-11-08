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

        Assert.Equal(new Account.SignedIn("TheLunchTrae", "Trae", null, Documents.InstallUrl), account);
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
    public async Task A_lost_sign_in_is_its_own_failure_and_says_so_first()
    {
        var cli = new FakeCli().On("repos --json", Documents.SignedOutFailure, exitCode: 1);
        var client = new RepottedClient(cli);
        var lost = 0;
        client.SignInLost += (_, _) => lost++;

        var error = await Assert.ThrowsAsync<SignInLostException>(() => client.RepositoriesAsync(None));

        Assert.Equal("Bad credentials", error.Message);
        Assert.Equal(1, lost);

        // Any other failure says nothing about the sign-in.
        cli.On("repos --json", """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        var other = await Assert.ThrowsAsync<CliException>(() => client.RepositoriesAsync(None));
        Assert.IsNotType<SignInLostException>(other);
        Assert.Equal(1, lost);
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
        await signingIn;
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

    [Theory]
    // A renamed member reads as missing, which a signed-out status never is.
    [InlineData("""{"signed_in":false,"why":"rejected","message":"…","problems":[],"token_variable":null,"install_url":null}""")]
    [InlineData("""{"signed_in":false,"reason":"rejected","message":"…","trouble":[],"token_variable":null,"install_url":null}""")]
    [InlineData("""{"signed_in":false,"reason":"expired","message":"…","problems":[],"token_variable":null,"install_url":null}""")]
    [InlineData("""{"signed_in":true,"name":"Trae","token_variable":null,"install_url":null}""")]
    [InlineData("""{"signed_in":true,"login":"lunch","name":null,"install_url":null}""")]
    [InlineData("""{"signed_in":true,"login":null,"name":null,"token_variable":null,"install_url":null}""")]
    public async Task A_status_the_app_does_not_know_says_so(string document)
    {
        var client = new RepottedClient(new FakeCli().On("status --json", document));

        var error = await Assert.ThrowsAsync<CliException>(() => client.StatusAsync(None));

        Assert.StartsWith("Could not read what the Repotted command line printed", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_install_page_that_is_not_https_is_dropped()
    {
        var client = new RepottedClient(new FakeCli().On(
            "status --json",
            """{"signed_in":true,"login":"lunch","name":null,"token_variable":null,"install_url":"file:///etc/passwd"}"""));

        var account = Assert.IsType<Account.SignedIn>(await client.StatusAsync(None));

        Assert.Null(account.InstallUrl);
    }

    [Fact]
    public async Task An_unknown_repository_source_says_so()
    {
        var client = new RepottedClient(new FakeCli().On("repos --json", """{"source":"org","repositories":[]}"""));

        var error = await Assert.ThrowsAsync<CliException>(() => client.RepositoriesAsync(None));

        Assert.Contains("unknown repository source", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_crash_shows_what_it_printed_on_stderr()
    {
        var client = new RepottedClient(new FakeCli().On(
            "status --json",
            "",
            exitCode: 1,
            error: "file:///repotted/main.js:12\n  throw error;\nTypeError: Cannot read properties of undefined (reading 'login')\n"));

        var error = await Assert.ThrowsAsync<CliException>(() => client.StatusAsync(None));

        Assert.Equal(
            "The Repotted command line failed (exit code 1): file:///repotted/main.js:12 throw error; TypeError: Cannot read properties of undefined (reading 'login')",
            error.Message);
    }

    [Fact]
    public async Task Warnings_from_a_run_that_succeeded_are_not_a_crash()
    {
        var client = new RepottedClient(new FakeCli().On("status --json", "not json", error: "ExperimentalWarning: …"));

        var error = await Assert.ThrowsAsync<CliException>(() => client.StatusAsync(None));

        Assert.StartsWith("Could not read what the Repotted command line printed", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"event":"code","verification_uri":"not a link","user_code":"ABCD-1234","expires_at":"2026-11-07T08:00:00.000Z"}""")]
    [InlineData("""{"event":"code","verification_uri":"http://github.com/login/device","user_code":"ABCD-1234","expires_at":"2026-11-07T08:00:00.000Z"}""")]
    [InlineData("Debugger listening on ws://127.0.0.1:9229")]
    public async Task A_sign_in_line_the_app_cannot_use_fails_the_sign_in(string line)
    {
        DeviceCode? shown = null;
        var client = new RepottedClient(new FakeCli().OnLines("login --json", [line, Documents.Done]));

        await Assert.ThrowsAsync<CliException>(() => client.SignInAsync(code => shown = code, None));

        Assert.Null(shown);
    }
}
