using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

public sealed class RepottedCliTests
{
    [Theory]
    [InlineData("/opt/repotted/dist/repotted.js", "node")]
    [InlineData("/src/packages/cli/src/main.ts", "bun")]
    [InlineData("/usr/local/bin/repotted", "/usr/local/bin/repotted")]
    public void A_configured_path_runs_with_the_tool_its_extension_needs(string path, string fileName)
    {
        var cli = RepottedCli.FromPath(path);

        Assert.Equal(fileName, cli.FileName);
        Assert.Equal(fileName == path ? [] : [path], cli.Prefix);
    }

    [Fact]
    public async Task Streams_each_line_and_reports_the_exit_code()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/sh.");
        var cli = new RepottedCli("/bin/sh", ["-c", "echo one; echo two; echo noise >&2; exit 3"]);
        var lines = new List<string>();

        var run = await cli.RunAsync([], lines.Add, CancellationToken.None);

        Assert.Equal(["one", "two"], lines);
        Assert.Equal(3, run.ExitCode);
        Assert.Equal($"one{Environment.NewLine}two{Environment.NewLine}", run.Output);
    }

    [Fact]
    public async Task Cancelling_stops_the_process()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/sh.");
        var cli = new RepottedCli("/bin/sh", ["-c", "echo started; sleep 30"]);
        using var cancel = new CancellationTokenSource();

        var running = cli.RunAsync([], _ => cancel.Cancel(), cancel.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_missing_command_line_says_how_to_point_at_it()
    {
        var cli = new RepottedCli(Path.Combine(Path.GetTempPath(), "no-such-repotted"), []);

        var error = await Assert.ThrowsAsync<CliNotFoundException>(
            () => cli.RunAsync(["status", "--json"], null, CancellationToken.None));

        Assert.Contains("REPOTTED_CLI", error.Message, StringComparison.Ordinal);
    }
}
