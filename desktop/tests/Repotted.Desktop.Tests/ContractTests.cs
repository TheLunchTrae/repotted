using System.Text.Json;
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
    /// <summary>The top-level keys of a profile file that hold no settings, or entries that editors of their own edit.</summary>
    private static readonly HashSet<string> NotSettings = ["extends", "drafts", "rulesets", "environments"];

    /// <summary>
    /// The settings the app leaves to the YAML, each with everything under it.
    /// The app notes each where its group shows.
    /// </summary>
    private static readonly HashSet<string> YamlOnly =
    [
        "repository.topics",
        "custom_properties",
        "autolinks",
        "labels",
        "actions.selected_actions.patterns_allowed",
        "actions.oidc_customization_sub.include_claim_keys",
        "security.security_and_analysis.secret_scanning_delegated_bypass_options",
        "security.code_scanning_default_setup.languages",
        "security.code_quality_setup.languages",
        "security.dependabot_runner_settings.runner_labels",
    ];

    private static RepottedCli Cli()
    {
        Assert.SkipWhen(
            string.IsNullOrEmpty(Environment.GetEnvironmentVariable("REPOTTED_CLI")),
            "Set REPOTTED_CLI to the CLI to check the app against it.");
        return RepottedCli.Locate();
    }

    private static RepottedClient Client() => new(Cli());

    [Fact]
    public async Task The_app_shows_or_leaves_to_the_yaml_every_setting_the_schema_has()
    {
        var run = await Cli().RunAsync(["schema", "--json"], null, TestContext.Current.CancellationToken);
        Assert.Equal((0, ""), (run.ExitCode, run.Error));
        var schema = JsonNode.Parse(run.Output)!.AsObject();
        var fields = ProfileFields.Sections.SelectMany(tab => tab.Groups).SelectMany(group => group.Fields).ToList();
        var named = fields.Select(field => field.Path).Concat(YamlOnly).ToHashSet(StringComparer.Ordinal);

        var settings = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var (key, section) in Properties(schema).Where(property => !NotSettings.Contains(property.Key)))
        {
            Walk(key, section, named, settings);
        }

        // A setting the app neither shows nor leaves to the YAML, and a name the schema doesn't have.
        Assert.Empty(settings.Keys.Except(named));
        Assert.Empty(named.Except(settings.Keys));
        var choices = fields.Where(field => field.Kind == SettingKind.Choice).ToList();
        Assert.Equal(
            choices.Select(field => Describe(field.Path, Values(settings[field.Path]) ?? [])),
            choices.Select(field => Describe(field.Path, field.Options.Select(option => option.Value))));
    }

    /// <summary>
    /// Adds each setting under <paramref name="path"/> to <paramref name="settings"/>
    /// with its schema: a key that holds no object of settings, or one that
    /// <paramref name="named"/> holds, which stands for everything under it.
    /// </summary>
    private static void Walk(string path, JsonObject schema, HashSet<string> named, Dictionary<string, JsonObject> settings)
    {
        var properties = Properties(schema).ToList();
        if (properties.Count == 0 || named.Contains(path))
        {
            settings.TryAdd(path, schema);
            return;
        }
        foreach (var (key, property) in properties)
        {
            Walk($"{path}.{key}", property, named, settings);
        }
    }

    /// <summary>The keys an object's schema allows, in any branch of a union.</summary>
    private static IEnumerable<KeyValuePair<string, JsonObject>> Properties(JsonObject schema)
    {
        if (schema["properties"] is JsonObject properties)
        {
            foreach (var (key, value) in properties)
            {
                // `not` rules a key out, as each branch of an entry union does the others' marking key.
                if (value is JsonObject property && !property.ContainsKey("not"))
                {
                    yield return new(key, property);
                }
            }
        }
        var branches = (schema["oneOf"] as JsonArray ?? []).Concat(schema["anyOf"] as JsonArray ?? []);
        foreach (var branch in branches.OfType<JsonObject>())
        {
            foreach (var nested in Properties(branch))
            {
                yield return nested;
            }
        }
    }

    /// <summary>The values a setting's schema allows, when it names them, or null.</summary>
    private static List<JsonNode>? Values(JsonObject schema)
    {
        if (schema["enum"] is JsonArray values)
        {
            return [.. values.OfType<JsonNode>().Select(item => item.DeepClone())];
        }
        if (schema["const"] is { } value)
        {
            return [value.DeepClone()];
        }
        if (JsonNode.DeepEquals(schema["type"], JsonValue.Create("boolean")))
        {
            return [true, false];
        }
        // A security feature, which GitHub writes as { status: enabled }.
        if (schema["properties"] is JsonObject { Count: 1 } properties)
        {
            var (key, property) = properties.Single();
            return Values(property!.AsObject())?.Select(inner => (JsonNode)new JsonObject { [key] = inner }).ToList();
        }
        return null;
    }

    private static string Describe(string path, IEnumerable<JsonNode> values) =>
        $"{path}: {string.Join(", ", values.Select(value => value.ToJsonString()).Order(StringComparer.Ordinal))}";

    /// <summary>An editor of <paramref name="listing"/>, a profile in the profiles folder of <paramref name="folders"/>.</summary>
    private static ProfileViewModel Editor(RepottedClient client, ProfileListingDocument listing, Folders folders) =>
        new(client, listing, ProfileStore.Profile(client, new ProfileFolder(client, folders.Settings)));

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
        folders.Write("orgs.yaml", "extends: base.yaml\n");

        // The app takes a profile's path from the listing, which names the real file, as
        // macOS's temp folder sits behind a link.
        var listings = await client.ProfilesAsync(folders.Profiles, cancellationToken);
        var own = Assert.Single(listings, listing => listing.Name == "orgs").File;
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
    public async Task The_cli_saves_an_empty_runner_label_as_null_and_an_empty_runner_group_as_empty()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var orgs = folders.Write(
            "orgs.yaml",
            """
            security:
              code_scanning_default_setup:
                runner_type: labeled
                runner_label: gpu
              code_quality_setup:
                runner_label: null
              dependabot_runner_settings:
                runner_type: labeled
                runner_group: builders

            """.ReplaceLineEndings("\n"));
        var listing = Assert.Single(await client.ProfilesAsync(folders.Profiles, cancellationToken));
        var editor = Editor(client, listing, folders);
        await editor.LoadCommand.ExecuteAsync(null);
        var settings = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).ToList();
        SettingViewModel Setting(string key) => settings.Single(setting => setting.Key == key);

        // A null label reads as an empty box, which left empty is no change.
        var quality = Setting("code_quality_setup.runner_label");
        Assert.Equal(("", true, false), (quality.Typed, quality.Managed, editor.HasChanges));
        Setting("code_scanning_default_setup.runner_label").Typed = "";
        Setting("dependabot_runner_settings.runner_group").Typed = "";
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        var saved = (await client.ProfileAsync(orgs, cancellationToken)).Values.GetProperty("security");
        Assert.Equal(JsonValueKind.Null, saved.GetProperty("code_scanning_default_setup").GetProperty("runner_label").ValueKind);
        Assert.Equal("", saved.GetProperty("dependabot_runner_settings").GetProperty("runner_group").GetString());
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
        var editor = Editor(client, listing, folders);
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

    [AvaloniaFact]
    public async Task The_cli_saves_the_drafts_the_app_makes_and_finishes()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var orgs = folders.Write(
            "orgs.yaml",
            """
            repository: { has_wiki: false }
            drafts:
              repository: { has_issues: true }
            rulesets:
              - name: Main
                enforcement: active
              - name: Later
                draft: true
                enforcement: maybe
            environments:
              - name: npm
                draft: true
                wait_timer: soon

            """.ReplaceLineEndings("\n"));
        var listing = Assert.Single(await client.ProfilesAsync(folders.Profiles, cancellationToken));
        var editor = Editor(client, listing, folders);
        await editor.LoadCommand.ExecuteAsync(null);
        var settings = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).ToList();
        var (wiki, issues) = (settings.Single(setting => setting.Key == "has_wiki"), settings.Single(setting => setting.Key == "has_issues"));
        var (rulesets, environments) = (editor.Tabs.Single(tab => tab.List == "rulesets"), editor.Tabs.Single(tab => tab.List == "environments"));

        // Drafts show beside what applies, and the counts leave them out.
        Assert.Equal(("On", true, false), (issues.DraftLabel, issues.OwnDraft, issues.Managed));
        Assert.Equal(
            ["Main: Set here", "Later: Draft, left out of compare and apply"],
            rulesets.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal((1, 0), (rulesets.Count, environments.Count));
        // A draft's value of the wrong kind opens, and stops nothing while it is a draft.
        Assert.Null(environments.Entries.Single().Editor.Problem);

        wiki.Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);
        wiki.SaveAsDraftCommand.Execute(null);
        Assert.Equal((false, "On"), (wiki.Changed, wiki.DraftLabel));
        issues.FinishDraftCommand.Execute(null);
        Assert.Equal((true, false), (issues.Changed, issues.HasDraft));
        rulesets.Entries[0].Editor.IsDraft = true;
        var later = (RulesetEditorViewModel)rulesets.Entries[1].Editor;
        later.IsDraft = false;
        later.Enforcement.Options[0].ChooseCommand.Execute(null);
        Assert.Equal("4 unsaved changes", editor.ChangesLabel);
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        Assert.False(editor.HasChanges);
        // Each change lands in place: a draft finished, one made, and the drafts section kept where it was.
        Assert.Equal(
            """
            repository: { has_wiki: false, has_issues: true }
            drafts:
              repository: { has_wiki: true }
            rulesets:
              - name: Main
                enforcement: active
                draft: true
              - name: Later
                enforcement: active
            environments:
              - name: npm
                draft: true
                wait_timer: soon

            """.ReplaceLineEndings("\n"),
            await File.ReadAllTextAsync(orgs, cancellationToken));
        Assert.Equal(
            ["Later: Set here", "Main: Draft, left out of compare and apply"],
            editor.Tabs.Single(tab => tab.List == "rulesets").Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
    }

    [AvaloniaFact]
    public async Task A_draft_finished_under_the_name_of_an_entry_in_the_same_file_replaces_it()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var orgs = folders.Write(
            "orgs.yaml",
            """
            rulesets:
              - name: Main
                enforcement: active
              - name: Main
                draft: true
                enforcement: evaluate

            """.ReplaceLineEndings("\n"));
        var listing = Assert.Single(await client.ProfilesAsync(folders.Profiles, cancellationToken));
        var editor = Editor(client, listing, folders);
        await editor.LoadCommand.ExecuteAsync(null);
        var rulesets = editor.Tabs.Single(tab => tab.List == "rulesets");

        var draft = rulesets.Entries.Single(entry => entry.SavedDraft);
        draft.Editor.IsDraft = false;
        Assert.Null(draft.Problem);
        // The two become one once saved, so the count stays at one.
        Assert.Equal(
            ["Main: Replaced by its finished draft once saved", "Main: Finished, applies once saved"],
            rulesets.Entries.Select(entry => $"{entry.Name}: {entry.Note}"));
        Assert.Equal(1, rulesets.Count);
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        Assert.Equal(
            """
            rulesets:
              - name: Main
                enforcement: evaluate

            """.ReplaceLineEndings("\n"),
            await File.ReadAllTextAsync(orgs, cancellationToken));
        var saved = editor.Tabs.Single(tab => tab.List == "rulesets").Entries.Single();
        Assert.Equal("Main: Set here", $"{saved.Name}: {saved.Note}");
    }

    [AvaloniaFact]
    public async Task Only_this_profiles_own_entries_become_drafts_and_a_bases_draft_comes_back()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        folders.Write(
            "base.yaml",
            """
            drafts:
              repository: { has_projects: true }
            rulesets:
              - name: Shared
                enforcement: active
              - name: Base only
                enforcement: active
              - name: Edited
                enforcement: active
              - name: Later
                draft: true
              - name: Next
                draft: true

            """.ReplaceLineEndings("\n"));
        folders.Write(
            "orgs.yaml",
            """
            extends: base.yaml
            repository: { has_wiki: false }
            drafts:
              repository: { has_projects: false }
            environments:
              - { name: npm, draft: true, wait_timer: soon }
            rulesets:
              - name: Shared
                enforcement: evaluate
              - name: Edited
                draft: true
                enforcement: disabled
              - name: Next
                draft: true
                enforcement: evaluate

            """.ReplaceLineEndings("\n"));
        var listing = Assert.Single(await client.ProfilesAsync(folders.Profiles, cancellationToken), item => item.Name == "orgs");
        var editor = Editor(client, listing, folders);
        await editor.LoadCommand.ExecuteAsync(null);
        Assert.Null(editor.Error);
        var rulesets = editor.Tabs.Single(tab => tab.List == "rulesets");
        RulesetEditorViewModel Ruleset(string name, bool draft) =>
            (RulesetEditorViewModel)rulesets.Entries.Single(entry => entry.SavedName == name && entry.SavedDraft == draft).Editor;

        // What a draft still needs shows with the profile.
        Assert.Contains(editor.DraftWarnings, warning => warning.Contains("npm", StringComparison.Ordinal));

        // A base's entry or draft can't be made a draft or finished here.
        Assert.False(Ruleset("Base only", draft: false).CanDraft);
        Assert.False(Ruleset("Later", draft: true).CanDraft);

        // A draft of this file's override leaves the base's ruleset applying, so the count stays.
        var count = rulesets.Count;
        var shared = Ruleset("Shared", draft: false);
        Assert.True(shared.CanDraft);
        shared.IsDraft = true;
        Assert.Equal("Saved as a draft: compare and apply leave it out, so the base profile's ruleset applies until you finish it.", shared.DraftNote);
        Assert.Equal(count, rulesets.Count);
        shared.IsDraft = false;

        // A draft can't be finished over a base's entry that is being edited, which would write it twice.
        Ruleset("Edited", draft: false).Enforcement.Options[1].ChooseCommand.Execute(null);
        var edited = Ruleset("Edited", draft: true);
        edited.IsDraft = false;
        Assert.Equal("The profile already has a ruleset named Edited.", edited.Problem);
        edited.IsDraft = true;
        rulesets.Undo();

        // Finishing this file's draft of a base's draft brings the base's back as a draft.
        var next = rulesets.Entries.Single(entry => entry.SavedName == "Next");
        next.Editor.IsDraft = false;
        Assert.Equal("Finished, applies once saved, and the base profile's draft comes back", next.Note);
        rulesets.Undo();

        // Taking out this profile's draft brings back the base's, and choosing the saved value keeps a new draft.
        var settings = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).ToList();
        var projects = settings.Single(setting => setting.Key == "has_projects");
        Assert.Equal(("Off", true), (projects.DraftLabel, projects.OwnDraft));
        projects.DiscardDraftCommand.Execute(null);
        Assert.Equal(("On", false, "Saved in base, not applied."), (projects.DraftLabel, projects.OwnDraft, projects.DraftNote));
        var wiki = settings.Single(setting => setting.Key == "has_wiki");
        wiki.Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);
        wiki.SaveAsDraftCommand.Execute(null);
        wiki.Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        Assert.Equal((true, "On"), (wiki.DraftChanged, wiki.DraftLabel));
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Null(editor.SaveError);
        projects = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_projects");
        Assert.Equal(("On", false), (projects.DraftLabel, projects.OwnDraft));
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
        folders.Settings.Save(folders.Settings.Load() with { ProfilesFolder = folder });
        var profileFolder = new ProfileFolder(client, folders.Settings);
        NewProfileViewModel Form(string name) =>
            new(client, profileFolder, [@base], [], null, (file, _) => Task.FromResult(made = file), () => { }, () => { }, new HashSet<string>()) { Name = name };

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

    [Fact]
    public async Task The_cli_keeps_a_batch_the_way_the_app_drives_it()
    {
        var client = Client();
        var cancellationToken = TestContext.Current.CancellationToken;
        using var folders = new Folders();
        var settings = folders.Settings;
        var orgs = folders.Write("orgs.yaml", "repository: { has_issues: true, has_wiki: false }\n");
        // A repository with an apply already in progress joins the batch as it is.
        var joined = settings.StagedFile("TheLunchTrae/test-repo");
        Directory.CreateDirectory(Path.GetDirectoryName(joined)!);
        await client.StartStagedAsync(joined, "TheLunchTrae/test-repo", null, cancellationToken);

        var started = await client.StartBatchAsync(
            settings.BatchFolder, settings.StagedFolder, ["TheLunchTrae/repotted"], [joined], orgs, cancellationToken);
        Assert.True(settings.HasBatch);
        Assert.Equal("orgs.yaml", Path.GetFileName(started.Profile));
        Assert.Equal(
            [("TheLunchTrae/test-repo", true), ("TheLunchTrae/repotted", false)],
            started.Members.Select(member => (member.Repository, member.Joined)));
        // The batch puts a new staged apply where the app's Apply page looks for one.
        Assert.Equal(
            Path.GetFileName(settings.StagedFile("TheLunchTrae/repotted")),
            Path.GetFileName(started.Members.Single(member => !member.Joined).File));
        Assert.True(File.Exists(settings.StagedFile("TheLunchTrae/repotted")));
        Assert.Equal(started, await client.BatchAsync(settings.BatchFolder, cancellationToken), BatchComparer.Instance);

        var left = await client.LeaveOutOfBatchAsync(settings.BatchFolder, "TheLunchTrae/test-repo", true, cancellationToken);
        Assert.True(left.Members.Single(member => member.Joined).LeftOut);
        Assert.False((await client.LeaveOutOfBatchAsync(settings.BatchFolder, "TheLunchTrae/test-repo", false, cancellationToken))
            .Members.Single(member => member.Joined).LeftOut);

        // Only the profile sets the wiki, so the staged apply that joined from the repository as it is has nothing to leave out.
        var everywhere = await client.ExcludeEverywhereAsync(settings.BatchFolder, "repository.has_wiki", true, cancellationToken);
        Assert.Equal(["TheLunchTrae/repotted"], everywhere.Changed);
        Assert.Empty(everywhere.Refused);
        Assert.Equal(["repository.has_wiki"], (await client.StagedAsync(settings.StagedFile("TheLunchTrae/repotted"), cancellationToken)).Exclude);

        await client.DiscardBatchAsync(settings.BatchFolder, cancellationToken);
        Assert.False(settings.HasBatch);
        Assert.False(File.Exists(settings.StagedFile("TheLunchTrae/repotted")));
        Assert.True(File.Exists(joined));
    }

    /// <summary>Two reads of a batch match when they list the same members the same way.</summary>
    private sealed class BatchComparer : IEqualityComparer<BatchDocument>
    {
        public static readonly BatchComparer Instance = new();

        public bool Equals(BatchDocument? x, BatchDocument? y) =>
            x is not null && y is not null && x.Id == y.Id && x.Profile == y.Profile && x.Members.SequenceEqual(y.Members);

        public int GetHashCode(BatchDocument obj) => obj.Id.GetHashCode(StringComparison.Ordinal);
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
