using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Reads the real CLI's output, so a change to its JSON that the app cannot
/// read fails here. Runs only with REPOTTED_CLI set, such as to
/// packages/cli/dist/repotted.js; <c>mise run csharp:test</c> builds and sets it.
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
    public async Task The_app_reads_a_failure_for_want_of_a_sign_in()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        var account = await client.StatusAsync(cancellationToken);
        Assert.SkipWhen(account is Account.SignedIn, "Signed in here, so no command fails for want of a sign-in.");

        var error = await Assert.ThrowsAnyAsync<CliException>(() => client.RepositoriesAsync(cancellationToken));

        // With no sign-in at all, the sign-in is lost. A problem, such as a
        // keychain that would not open, may pass, and then may not be lost.
        if (account is Account.SignedOut { Problems.Count: 0 })
        {
            Assert.IsType<SignInLostException>(error);
        }
        else
        {
            Assert.Contains("Not signed in to GitHub.", error.Message, StringComparison.Ordinal);
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

    [Fact]
    public async Task The_cli_saves_every_kind_of_setting_the_app_edits()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write("base.yaml", "security: { security_and_analysis: { secret_scanning: { status: enabled } } }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");

        var resolved = await client.ProfileAsync(own, cancellationToken);
        Assert.EndsWith("base.yaml", resolved.Sources["security"]["security_and_analysis.secret_scanning"], StringComparison.Ordinal);
        Assert.Empty(resolved.Sources["pages"]);

        var saved = await client.SaveProfileAsync(
            own,
            [
                new("repository.pull_request_creation_cap.max_open_pull_requests", JsonValue.Create(3)),
                new("security.security_and_analysis.secret_scanning_push_protection", new JsonObject { ["status"] = "enabled" }),
                new("actions.max_cache_size_gb", JsonValue.Create(5)),
                new("pages.source.branch", JsonValue.Create("main")),
                new("repository.description", JsonValue.Create("")),
            ],
            [],
            cancellationToken);
        Assert.Equal(own, saved.Sources["repository"]["pull_request_creation_cap.max_open_pull_requests"]);
        Assert.Equal(own, saved.Sources["security"]["security_and_analysis.secret_scanning_push_protection"]);
        Assert.Equal(own, saved.Sources["pages"]["source.branch"]);
        Assert.Equal(own, saved.Sources["repository"]["description"]);
        var values = saved.Values;
        Assert.Equal(3, SettingViewModel.Find(values.GetProperty("repository"), "pull_request_creation_cap.max_open_pull_requests")!.GetValue<int>());
        Assert.Equal("main", SettingViewModel.Find(values.GetProperty("pages"), "source.branch")!.GetValue<string>());
        Assert.Equal("", SettingViewModel.Find(values.GetProperty("repository"), "description")!.GetValue<string>());
    }

    [AvaloniaFact]
    public async Task The_cli_saves_the_rulesets_and_environments_the_app_edits()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write("base.yaml", "rulesets:\n  - name: Main\n    enforcement: active\n");
        var orgs = folders.Write(
            "orgs.yaml",
            "extends: base.yaml\nenvironments:\n  - name: legacy\n  - name: npm\n    wait_timer: 5 # minutes\n  - name: review # apps\n  - name: -old\n");
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
        // Taken out ahead of an edit and a rename, and one whose name starts with a dash.
        environments.Entries[0].DropCommand.Execute(null);
        environments.Entries.Single(entry => entry.SavedName == "-old").DropCommand.Execute(null);
        var npm = (EnvironmentEditorViewModel)environments.Entries.Single(entry => entry.SavedName == "npm").Editor;
        npm.WaitTimer = "10";
        environments.Entries.Single(entry => entry.SavedName == "review").Editor.Name = "preview";
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        Assert.False(editor.HasChanges);
        Assert.Equal(
            """
            extends: base.yaml
            environments:
              - name: npm
                wait_timer: 10 # minutes
              - name: preview # apps
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
        // A capture under way writes a dot-prefixed file, which is not a profile yet.
        folders.Write(".captured.yaml.k2v9x0qa.4fz.repotted-capture", "repository:\n");
        // The folder as the user picked it goes through a link, so its path is not the one the CLI lists.
        var folder = folders.LinkToProfiles();
        var listings = await client.ProfilesAsync(folder, cancellationToken);
        var @base = new ProfileItemViewModel(Assert.Single(listings), null);
        string? made = null;
        NewProfileViewModel Form(string name) =>
            new(client, folder, [@base], [], null, (file, _) => Task.FromResult(made = file), () => { }, () => { }, new HashSet<string>(), work => work()) { Name = name };

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
    [Fact]
    public async Task The_cli_stages_an_apply_the_way_the_app_drives_it()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var orgs = folders.Write("orgs.yaml", "repository: { has_issues: true, has_wiki: false }\n");
        var file = folders.Settings.StagedFile("TheLunchTrae/repotted");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);

        var started = await client.StartStagedAsync(file, "TheLunchTrae/repotted", orgs, cancellationToken);
        Assert.Equal("TheLunchTrae/repotted", started.Repository);
        // The CLI names files by their real path, which a temp folder's link can change, as on macOS.
        Assert.Equal("orgs.yaml", Path.GetFileName(started.Base));
        Assert.Equal(started.Base, started.Layers.Sources["repository"]["has_wiki"]);
        // The CLI never replaces a staged apply that is already there.
        await Assert.ThrowsAsync<CliException>(() => client.StartStagedAsync(file, "TheLunchTrae/repotted", orgs, cancellationToken));

        var edited = await client.SaveStagedEditsAsync(file, [new("merge.allow_squash_merge", JsonValue.Create(false))], [], cancellationToken);
        Assert.Equal(edited.File, edited.Sources["merge"]["allow_squash_merge"]);
        Assert.Equal(Path.GetFileName(file), Path.GetFileName(edited.File));

        var excluded = await client.ExcludeAsync(file, "repository.has_wiki", true, cancellationToken);
        Assert.Equal(["repository.has_wiki"], excluded.Exclude);
        // What the apply edits itself is changed in the edits, not left out.
        await Assert.ThrowsAsync<CliException>(() => client.ExcludeAsync(file, "merge.allow_squash_merge", true, cancellationToken));
        Assert.Empty((await client.ExcludeAsync(file, "repository.has_wiki", false, cancellationToken)).Exclude);

        var saved = await client.SaveStagedToProfileAsync(file, cancellationToken);
        Assert.Equal(saved.Base, saved.Layers.Sources["merge"]["allow_squash_merge"]);
        Assert.Contains("allow_squash_merge: false", await File.ReadAllTextAsync(orgs, cancellationToken), StringComparison.Ordinal);
        Assert.Equal(saved, await client.StagedAsync(file, cancellationToken), StagedComparer.Instance);

        await client.DiscardStagedAsync(file, cancellationToken);
        Assert.False(File.Exists(file));
        Assert.True(File.Exists(orgs));
    }

    [Fact]
    public async Task The_cli_stages_an_apply_from_the_repository_as_it_is()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var file = folders.Settings.StagedFile("TheLunchTrae/repotted");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);

        var started = await client.StartStagedAsync(file, "TheLunchTrae/repotted", null, cancellationToken);

        Assert.Null(started.Base);
        Assert.Equal([Path.GetFileName(file)], started.Layers.Chain.Select(Path.GetFileName));
        // With no profile under it, there is nothing to save the edits to.
        await Assert.ThrowsAsync<CliException>(() => client.SaveStagedToProfileAsync(file, cancellationToken));
    }

    /// <summary>Two reads of a staged apply match when they name the same repository, base, exclusions and chain.</summary>
    private sealed class StagedComparer : IEqualityComparer<StagedApply>
    {
        public static readonly StagedComparer Instance = new();

        public bool Equals(StagedApply? x, StagedApply? y) =>
            x is not null && y is not null && x.Repository == y.Repository && x.Base == y.Base
            && x.Exclude.SequenceEqual(y.Exclude) && x.Layers.Chain.SequenceEqual(y.Layers.Chain);

        public int GetHashCode(StagedApply obj) => obj.Repository.GetHashCode(StringComparison.Ordinal);
    }
}
