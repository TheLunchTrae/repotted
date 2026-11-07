using System.Text.Json.Nodes;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Reads the real CLI's output, so a change to its JSON that the app cannot
/// read fails here. Runs only with REPOTTED_CLI set, such as to
/// packages/cli/src/main.ts; <c>mise run csharp:test</c> sets it.
/// </summary>
public sealed class ContractTests
{
    private static RepottedClient Client()
    {
        Assert.SkipWhen(
            string.IsNullOrEmpty(Environment.GetEnvironmentVariable("REPOTTED_CLI")),
            "Set REPOTTED_CLI to the CLI to check the app against it.");
        return new RepottedClient(RepottedCli.Locate());
    }

    [Fact]
    public async Task The_app_reads_what_status_prints()
    {
        var client = Client();

        // StatusAsync fails on a document it cannot read completely, so either
        // account here means every member the app needs was there.
        var account = await client.StatusAsync(TestContext.Current.CancellationToken);

        switch (account)
        {
            case Account.SignedIn signedIn:
                Assert.NotEmpty(signedIn.Login);
                break;
            case Account.SignedOut signedOut:
                Assert.NotNull(signedOut.Problems);
                break;
            default:
                Assert.Fail($"Unexpected account: {account}");
                break;
        }
    }

    [Fact]
    public async Task The_app_lists_reads_and_saves_profiles()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write("base.yaml", "repository: { has_issues: true }\n");
        folders.Write("orgs.yaml", "# Ours\nextends: base.yaml\nmerge: { allow_squash_merge: false }\n");

        var listings = await client.ProfilesAsync(folders.Profiles, cancellationToken);
        var orgs = Assert.Single(listings, listing => listing.Name == "orgs");
        var @base = Assert.Single(listings, listing => listing.Name == "base");
        Assert.Equal(@base.File, orgs.Extends);
        Assert.Null(orgs.Problem);

        var resolved = await client.ProfileAsync(orgs.File, cancellationToken);
        Assert.Equal([orgs.File, @base.File], resolved.Chain);
        Assert.Equal(@base.File, resolved.Sources["repository"]["has_issues"]);

        var saved = await client.SaveProfileAsync(
            orgs.File,
            [new("repository.has_wiki", JsonValue.Create(false)), new("merge.allow_squash_merge", null)],
            cancellationToken);
        Assert.Equal(orgs.File, saved.Sources["repository"]["has_wiki"]);
        Assert.Empty(saved.Sources["merge"]);
        Assert.Equal("# Ours\nextends: base.yaml\nrepository:\n  has_wiki: false\n", await File.ReadAllTextAsync(orgs.File, cancellationToken));
    }
}
