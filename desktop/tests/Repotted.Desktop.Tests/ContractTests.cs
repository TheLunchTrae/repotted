using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

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
            [],
            cancellationToken);
        Assert.Equal(orgs.File, saved.Sources["repository"]["has_wiki"]);
        Assert.Empty(saved.Sources["merge"]);
        Assert.Equal("# Ours\nextends: base.yaml\nrepository:\n  has_wiki: false\n", await File.ReadAllTextAsync(orgs.File, cancellationToken));
    }

    [AvaloniaFact]
    public async Task The_cli_saves_the_rulesets_and_environments_the_app_edits()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write("base.yaml", "rulesets:\n  - name: Main\n    enforcement: active\n");
        var orgs = folders.Write("orgs.yaml", "extends: base.yaml\nenvironments:\n  - name: npm\n    wait_timer: 5 # minutes\n");
        var listing = Assert.Single(await client.ProfilesAsync(folders.Profiles, cancellationToken), item => item.Name == "orgs");
        var editor = new ProfileViewModel(client, listing);
        await editor.LoadCommand.ExecuteAsync(null);
        var (rulesets, environments) = (editor.Tabs.Single(tab => tab.List == "rulesets"), editor.Tabs.Single(tab => tab.List == "environments"));

        var main = (RulesetEditorViewModel)rulesets.Entries.Single().Editor;
        main.Enforcement.Options[1].ChooseCommand.Execute(null);
        main.Rules.Single(rule => rule.Kind.Type == "pull_request").Enabled = true;
        environments.NewCommand.Execute(null);
        var staging = (EnvironmentEditorViewModel)environments.Editing!.Editor;
        staging.Name = "staging";
        staging.Deployments.Options[2].ChooseCommand.Execute(null);
        staging.Branches = "main";
        staging.Tags = "v*";
        var npm = (EnvironmentEditorViewModel)environments.Entries[0].Editor;
        npm.WaitTimer = "10";
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        Assert.False(editor.HasChanges);
        Assert.Equal(
            """
            extends: base.yaml
            environments:
              - name: npm
                wait_timer: 10 # minutes
              - name: staging
                deployment_branch_policy:
                  protected_branches: false
                  custom_branch_policies: true
                branch_policies:
                  - name: main
                  - name: v*
                    type: tag
            rulesets:
              - name: Main
                enforcement: evaluate
                rules:
                  - type: pull_request

            """.ReplaceLineEndings("\n"),
            await File.ReadAllTextAsync(orgs, cancellationToken));
        // The base's ruleset is now set here, over it.
        Assert.Equal("Set here", editor.Tabs.Single(tab => tab.List == "rulesets").Entries.Single().Note);
    }

    [Fact]
    public async Task The_cli_reads_the_profiles_the_app_makes()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write("my base.yaml", "repository: { has_issues: true }\n");
        // The folder as the user picked it goes through a link, so its path is not the one the CLI lists.
        var folder = folders.LinkToProfiles();
        var listings = await client.ProfilesAsync(folder, cancellationToken);
        var @base = new ProfileItemViewModel(Assert.Single(listings), null);
        string? made = null;
        NewProfileViewModel Form(string name) =>
            new(client, folder, [@base], [], null, (file, _) => Task.FromResult(made = file), () => { }, () => { }) { Name = name };

        var extending = Form("extending");
        extending.Extends = true;
        await extending.CreateCommand.ExecuteAsync(null);
        Assert.Null(extending.Error);
        var resolved = await client.ProfileAsync(made!, cancellationToken);
        Assert.Equal(["extending.yaml", @base.Listing.File], [Path.GetFileName(resolved.Chain[0]), .. resolved.Chain.Skip(1)]);

        await Form("empty").CreateCommand.ExecuteAsync(null);
        await client.SaveProfileAsync(made!, [new("repository.has_wiki", JsonValue.Create(false))], [], cancellationToken);
        Assert.Equal("repository:\n  has_wiki: false\n", await File.ReadAllTextAsync(made!, cancellationToken));
    }
}
