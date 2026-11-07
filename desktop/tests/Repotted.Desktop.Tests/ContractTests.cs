using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Reads the real CLI's output, so a change to its JSON that the app cannot
/// read fails here. Runs only with REPOTTED_CLI set, such as to
/// packages/cli/src/main.ts.
/// </summary>
public sealed class ContractTests
{
    [Fact]
    public async Task The_app_reads_what_status_prints()
    {
        Assert.SkipWhen(
            string.IsNullOrEmpty(Environment.GetEnvironmentVariable("REPOTTED_CLI")),
            "Set REPOTTED_CLI to the CLI to check the app against it.");
        var client = new RepottedClient(RepottedCli.Locate());

        var account = await client.StatusAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(account);
    }
}
