using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

public sealed class RepottedCliTests
{
    [Theory]
    [InlineData("/opt/repotted/dist/repotted.js", "node")]
    [InlineData("/opt/repotted/dist/repotted.mjs", "node")]
    [InlineData("/usr/local/bin/repotted", "/usr/local/bin/repotted")]
    public void A_configured_path_runs_with_the_tool_its_extension_needs(string path, string fileName)
    {
        var cli = RepottedCli.FromPath(path);

        Assert.Equal(fileName, cli.FileName);
        Assert.Equal(fileName == path ? [] : [path], cli.Prefix);
    }

    [Fact]
    public void The_app_runs_the_cli_that_ships_beside_it_unless_one_is_configured()
    {
        var folder = Directory.CreateTempSubdirectory();
        try
        {
            Assert.Equal("repotted", RepottedCli.Locate(null, folder.FullName).FileName);

            // The app itself is Repotted, so the shipped CLI has a name of its own.
            var bundled = Path.Combine(folder.FullName, OperatingSystem.IsWindows() ? "repotted-cli.exe" : "repotted-cli");
            File.WriteAllText(bundled, "");
            Assert.Equal(bundled, RepottedCli.Locate(" ", folder.FullName).FileName);
            Assert.Equal("node", RepottedCli.Locate("/src/repotted.js", folder.FullName).FileName);
        }
        finally
        {
            folder.Delete(recursive: true);
        }
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
    public async Task Cancelling_while_the_output_is_quiet_stops_the_process()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/sh.");
        var pidFile = Path.GetTempFileName();
        var cli = new RepottedCli("/bin/sh", ["-c", $"echo $$ > '{pidFile}'; exec sleep 30"]);
        using var cancel = new CancellationTokenSource();

        var running = cli.RunAsync([], null, cancel.Token);
        var pid = await ProcessId(pidFile);
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running).WaitAsync(Limit, TestContext.Current.CancellationToken);
        Assert.True(await Ended(pid));
    }

    [Fact]
    public async Task A_line_handler_that_throws_stops_the_process()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Uses /bin/sh.");
        var cli = new RepottedCli("/bin/sh", ["-c", "echo $$; exec sleep 30"]);
        var pid = 0;

        await Assert.ThrowsAsync<CliException>(() => cli.RunAsync(
            [],
            line =>
            {
                pid = int.Parse(line, System.Globalization.CultureInfo.InvariantCulture);
                throw new CliException("Not JSON.");
            },
            CancellationToken.None)).WaitAsync(Limit, TestContext.Current.CancellationToken);

        Assert.True(await Ended(pid));
    }

    [Fact]
    public async Task A_missing_command_line_says_how_to_point_at_it()
    {
        var cli = new RepottedCli(Path.Combine(Path.GetTempPath(), "no-such-repotted"), []);

        var error = await Assert.ThrowsAsync<CliNotFoundException>(
            () => cli.RunAsync(["status", "--json"], null, CancellationToken.None));

        Assert.Contains("REPOTTED_CLI", error.Message, StringComparison.Ordinal);
    }

    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(10);

    private static async Task<int> ProcessId(string pidFile)
    {
        var deadline = DateTime.UtcNow + Limit;
        while (DateTime.UtcNow < deadline)
        {
            var text = await File.ReadAllTextAsync(pidFile, TestContext.Current.CancellationToken);
            if (int.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, out var pid))
            {
                return pid;
            }
            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
        throw new TimeoutException("The process never wrote its id.");
    }

    /// <summary>Whether the process with <paramref name="pid"/> ends within the limit.</summary>
    private static async Task<bool> Ended(int pid)
    {
        var deadline = DateTime.UtcNow + Limit;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var process = System.Diagnostics.Process.GetProcessById(pid);
                if (process.HasExited)
                {
                    return true;
                }
            }
            catch (ArgumentException)
            {
                return true;
            }
            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
        return false;
    }
}
