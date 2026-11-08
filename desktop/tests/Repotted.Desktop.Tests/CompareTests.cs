using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>Comparing a profile with a repository.</summary>
public sealed class CompareTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task A_compare_shows_each_difference_and_counts_what_matches()
    {
        var compare = await Compare(Documents.Plan());

        Assert.Equal("5 differences in 3 sections. Matching settings are folded away.", compare.Summary);
        Assert.Equal(
            [("Repository and merge settings", "1 change", "3 settings match."),
             ("Actions", "1 change", "1 setting matches."),
             ("Rulesets", "3 changes", "1 ruleset matches. 1 removed ruleset is already gone."),
             ("Environments", "In line", "1 environment matches.")],
            compare.Sections.Select(section => (section.Title, section.Status, section.Summary)));
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Allow squash merging", "allow_squash_merge", "On", "Off"),
             new CompareRow(CompareKind.Changes, "Default permissions", "default_workflow_permissions", "Read and write", "Read"),
             // A new ruleset says what each rule sets.
             new CompareRow(CompareKind.Adds, "Main: Require Checks", "new ruleset", "Not on GitHub",
                 "required_status_checks: required_status_checks: context: quality"),
             // A ruleset row names the part that differs, not the whole list of rules.
             new CompareRow(CompareKind.Changes, "Main: Require PR", "rules[pull_request].parameters.allowed_merge_methods", "merge, squash, rebase", "rebase"),
             new CompareRow(CompareKind.Removes, "Main: Block Deletion", "absent: true", "On GitHub", "Deleted")],
            compare.Sections.SelectMany(section => section.Rows));
        Assert.Null(compare.DraftsNote);
    }

    [AvaloniaFact]
    public async Task A_compare_names_the_drafts_it_leaves_out()
    {
        var compare = await Compare(Documents.Plan(skipped: """{"section":"repository","target":"has_wiki"},{"section":"rulesets","target":"Later"}"""));

        Assert.Equal("Left out as drafts: repository.has_wiki, the ruleset Later.", compare.DraftsNote);
        Assert.Equal("5 differences in 3 sections. Matching settings are folded away.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task Showing_everything_adds_the_matching_rows()
    {
        var compare = await Compare(Documents.Plan());

        compare.DifferencesOnly = false;

        var settings = compare.Sections[0].Rows;
        Assert.Equal(
            [("Allow squash merging", CompareKind.Changes), ("Issues", CompareKind.Matches), ("Wiki", CompareKind.Matches),
             ("Allow rebase merging", CompareKind.Matches)],
            settings.Select(row => (row.Label, row.Kind)));
        Assert.Equal(("On", "On"), (settings[1].Now, settings[1].Wanted));
        Assert.Equal("5 differences in 3 sections. Matching settings show below them.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_marks_the_differences_Repotted_cannot_change()
    {
        var desktop = new FakeDesktop();
        var compare = await Compare(
            Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc),
            desktop);

        var actions = compare.Sections.Single(section => section.Title == "Actions").Rows;
        Assert.Equal(
            [("default_workflow_permissions", null), ("oidc_customization_sub.use_default", "Needs Actions write"),
             ("oidc_customization_sub.include_claim_keys", "Needs Actions write")],
            actions.Select(row => (row.Key, row.Lock)));
        Assert.Equal(
            "Use the default subject claim, oidc_customization_sub.use_default: GitHub has On, the profile sets Off. "
                + "Repotted can't change it: Needs Actions write",
            actions[1].AccessibleName);
        Assert.True(compare.HasLocks);
        Assert.Equal("Repotted can't change 2 differences below. Each says what it needs.", compare.LockSummary);
        Assert.True(compare.HasAccessUrl);

        await compare.ReviewAccessCommand.ExecuteAsync(null);

        Assert.Equal([new Uri("https://github.com/settings/installations/7")], desktop.Opened);
    }

    [AvaloniaFact]
    public async Task The_cant_change_filter_shows_only_the_locked_differences_and_works_with_the_search()
    {
        var compare = await Compare(
            Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc));
        List<string> Shown() => [.. compare.Sections.Where(section => section.Shown).SelectMany(section => section.Rows).Select(row => row.Key)];

        compare.LockedOnly = true;
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());
        Assert.All(compare.Sections, section => Assert.False(section.HasSummary));
        // Showing matching settings too adds nothing, since only a difference can be locked.
        compare.DifferencesOnly = false;
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());

        // "Actions" also finds the unlocked default permissions row, which the filter leaves out.
        compare.Query = "actions";
        Assert.Equal(["oidc_customization_sub.use_default", "oidc_customization_sub.include_claim_keys"], Shown());
        compare.LockedOnly = false;
        Assert.Contains("default_workflow_permissions", Shown());
        compare.LockedOnly = true;
        compare.Query = "squash";
        Assert.True(compare.NothingFound);
        Assert.Equal("No difference Repotted can't change matches \u201csquash\u201d.", compare.NothingFoundMessage);

        compare.Query = "";
        compare.LockedOnly = false;
        Assert.Contains("allow_squash_merge", Shown());
    }

    [AvaloniaFact]
    public async Task A_compare_turns_the_cant_change_filter_off_when_nothing_is_locked_any_more()
    {
        const string command = "plan TheLunchTrae/repotted --profile orgs.yaml --json";
        var cli = new FakeCli().On(
            command, Documents.Plan(access: Documents.ActionsRead, locks: """{"change":5,"reason":"Needs Actions write"}""", changes: Documents.Oidc));
        var compare = new CompareViewModel(
            new RepottedClient(cli), new FakeDesktop(), "TheLunchTrae/repotted",
            new ProfileListingDocument("orgs", "orgs.yaml", null, null), Documents.InstallUrl);
        await compare.LoadCommand.ExecuteAsync(null);
        compare.LockedOnly = true;

        cli.On(command, Documents.Plan(changes: Documents.Oidc));
        await compare.LoadCommand.ExecuteAsync(null);

        Assert.False(compare.HasLocks);
        Assert.False(compare.LockedOnly);
        Assert.All(compare.Sections, section => Assert.True(section.Shown));
    }

    [AvaloniaFact]
    public async Task A_compare_marks_a_locked_change_in_any_section()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"workflow"}},
             "changes":[{"section":"pages","action":"create","target":"GitHub Pages site","fields":[],
               "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/pages","body":{"build_type":"workflow"} } }],
             "skipped":[],"warnings":[],
             "access":{"role":"admin","app":{"status":"installed","permissions":{"administration":"write"},"settings_url":null}},
             "locks":[{"change":0,"reason":"Needs Pages write"}]}
            """;
        var compare = await Compare(plan);

        Assert.Equal("Needs Pages write", compare.Sections.Single().Rows.Single().Lock);
        Assert.Equal("Repotted can't change 1 difference below. It says what it needs.", compare.LockSummary);
        Assert.False(compare.HasAccessUrl);
    }

    [AvaloniaFact]
    public async Task A_compare_offers_the_install_page_when_the_App_is_not_on_the_repository()
    {
        var desktop = new FakeDesktop();
        var compare = await Compare(
            Documents.Plan(
                access: """{"role":"admin","app":{"status":"not_installed"}}""",
                locks: """{"change":0,"reason":"Needs the GitHub App installed on this repository"}"""),
            desktop);

        Assert.Equal("Install the App", compare.AccessLabel);
        await compare.ReviewAccessCommand.ExecuteAsync(null);
        Assert.Equal([Documents.InstallUrl], desktop.Opened);
    }

    [AvaloniaFact]
    public async Task A_compare_locks_nothing_when_the_access_is_unknown_and_links_only_https()
    {
        var unknown = await Compare(Documents.Plan(changes: Documents.Oidc));

        Assert.False(unknown.HasLocks);
        Assert.False(unknown.HasAccessUrl);
        Assert.DoesNotContain(unknown.Sections.SelectMany(section => section.Rows), row => row.IsLocked);

        var elsewhere = await Compare(Documents.Plan(
            access: Documents.ActionsRead.Replace("https://github.com", "http://github.com", StringComparison.Ordinal),
            locks: """{"change":0,"reason":"Needs Administration write"}"""));

        Assert.Equal("Repotted can't change 1 difference below. It says what it needs.", elsewhere.LockSummary);
        Assert.False(elsewhere.HasAccessUrl);
    }

    [AvaloniaFact]
    public async Task Searching_a_compare_finds_rows_by_setting_section_and_entry()
    {
        var compare = await Compare(Documents.Plan());
        List<string> Shown() => [.. compare.Sections.Where(section => section.Shown).SelectMany(section => section.Rows).Select(row => row.Label)];

        compare.Query = "squash";
        Assert.Equal(["Allow squash merging"], Shown());
        // A search that finds the same rows keeps the rows on screen as they are.
        var rows = compare.Sections.Single(section => section.Shown).Rows;
        compare.Query = "squash ";
        Assert.Same(rows, compare.Sections.Single(section => section.Shown).Rows);
        // Found by the setting's synonym and its group's description, which the row doesn't show.
        compare.Query = "github_token";
        Assert.Equal(["Default permissions"], Shown());
        // Found by a ruleset's name.
        compare.Query = "require pr";
        Assert.Equal(["Main: Require PR"], Shown());
        // Found by the section's title.
        compare.Query = "environments";
        Assert.Empty(Shown());
        Assert.True(compare.NothingFound);
        Assert.Equal("No differences match \u201cenvironments\u201d.", compare.NothingFoundMessage);

        compare.DifferencesOnly = false;
        Assert.Equal(["npm"], Shown());
        Assert.False(compare.NothingFound);
        compare.Query = "wiki";
        Assert.Equal(["Wiki"], Shown());
        // The line that counts matching settings counts rows a search may not find, so it hides.
        Assert.All(compare.Sections, section => Assert.False(section.HasSummary));

        compare.ClearSearchCommand.Execute(null);
        Assert.Contains(compare.Sections, section => section.HasSummary);
        Assert.All(compare.Sections, section => Assert.True(section.Shown));
    }

    [AvaloniaFact]
    public async Task A_changed_ruleset_shows_a_dropped_rule_and_a_new_order()
    {
        var compare = await Compare(Plan(
            """
            {"rulesets":[{"name":"Main","rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}},
              {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality"}]}}]}]}
            """,
            """
            {"section":"rulesets","action":"update","target":"Main",
             "fields":[{"field":"rules",
               "from":[{"type":"pull_request","parameters":{"allowed_merge_methods":["rebase","squash"]}},{"type":"non_fast_forward"}],
               "to":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}},
                 {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality"}]}}]}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/rulesets/7","body":{}}}
            """));

        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Main", "rules[pull_request].parameters.allowed_merge_methods", "rebase, squash", "squash, rebase"),
             // An added rule says what it sets, not only its type.
             new CompareRow(CompareKind.Adds, "Main", "rules[required_status_checks]", "Not on GitHub",
                 "required_status_checks: required_status_checks: context: quality"),
             new CompareRow(CompareKind.Removes, "Main", "rules[non_fast_forward]", "non_fast_forward", "Removed")],
            compare.Sections.Single().Rows);
    }

    [AvaloniaFact]
    public async Task An_environment_shows_each_setting_and_branch_policy_the_profile_changes()
    {
        // GitHub holds the environment as npm; the profile names it NPM.
        var compare = await Compare(Plan(
            """{"environments":[{"name":"NPM","wait_timer":5,"branch_policies":[{"name":"v*","type":"tag"}]},{"name":"staging"}]}""",
            """
            {"section":"environments","action":"update","target":"npm",
             "fields":[{"field":"wait_timer","from":0,"to":5},
               {"field":"deployment_branch_policy","from":null,"to":{"protected_branches":false,"custom_branch_policies":true}}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/environments/npm","body":{}}},
            {"section":"environments","action":"delete","target":"npm: branch main","fields":[],
             "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/environments/npm/deployment-branch-policies/3"}},
            {"section":"environments","action":"create","target":"npm: tag v*",
             "fields":[{"field":"name","to":"v*"},{"field":"type","to":"tag"}],
             "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/environments/npm/deployment-branch-policies","body":{"name":"v*","type":"tag"}}}
            """));

        var environments = compare.Sections.Single();
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "npm", "wait_timer", "0", "5"),
             // GitHub has the setting, as null, so it is changed rather than added.
             new CompareRow(CompareKind.Changes, "npm", "deployment_branch_policy", "none", "protected_branches: false, custom_branch_policies: true"),
             new CompareRow(CompareKind.Removes, "npm: branch main", "branch_policies", "On GitHub", "Removed"),
             new CompareRow(CompareKind.Adds, "npm: tag v*", "new branch policy", "Not on GitHub", "Created")],
            environments.Rows);
        Assert.Equal("1 environment matches.", environments.Summary);
        Assert.Equal("npm: tag v*, new branch policy: not on GitHub, the profile creates it", environments.Rows[3].AccessibleName);
        compare.DifferencesOnly = false;
        Assert.Equal("staging, environment: matches the profile", environments.Rows[^1].AccessibleName);
    }

    [AvaloniaFact]
    public async Task Labels_show_each_rename_change_creation_and_deletion()
    {
        var compare = await Compare(Plan(
            """
            {"labels":[{"name":"type: feature","color":"a2eeef","renamed_from":["enhancement"]},
              {"name":"priority: high","color":"b60205"},{"name":"wontfix","absent":true},{"name":"bug"}]}
            """,
            """
            {"section":"labels","action":"delete","target":"wontfix","fields":[],
             "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/labels/wontfix"}},
            {"section":"labels","action":"update","target":"type: feature",
             "fields":[{"field":"name","from":"enhancement","to":"type: feature"}],
             "request":{"method":"PATCH","path":"/repos/TheLunchTrae/repotted/labels/enhancement","body":{"new_name":"type: feature"}}},
            {"section":"labels","action":"create","target":"priority: high","fields":[],
             "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/labels","body":{"name":"priority: high","color":"b60205"}}}
            """));

        var labels = compare.Sections.Single();
        Assert.Equal("Labels", labels.Title);
        Assert.Equal(
            [new CompareRow(CompareKind.Removes, "wontfix", "absent: true", "On GitHub", "Deleted"),
             new CompareRow(CompareKind.Changes, "type: feature", "name", "enhancement", "type: feature"),
             new CompareRow(CompareKind.Adds, "priority: high", "new label", "Not on GitHub", "Created")],
            labels.Rows);
        Assert.Equal("1 label matches.", labels.Summary);
    }

    [AvaloniaFact]
    public async Task What_matches_shows_by_name()
    {
        var compare = await Compare(Plan(
            """
            {"actions":{"allowed_actions":"selected","selected_actions":{"patterns_allowed":["actions/*"]}},
             "rulesets":[{"name":"Main"},{"name":"main"},{"name":"Main: Tags"}]}
            """,
            """
            {"section":"rulesets","action":"update","target":"Main: Tags",
             "fields":[{"field":"enforcement","from":"disabled","to":"active"}],
             "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/rulesets/8","body":{}}}
            """));

        compare.DifferencesOnly = false;

        Assert.Contains(
            new CompareRow(CompareKind.Matches, "Allowed action patterns", "selected_actions.patterns_allowed", "actions/*", "actions/*"),
            compare.Sections[0].Rows);
        // GitHub tells rulesets apart by their exact names.
        Assert.Equal("2 rulesets match.", compare.Sections[1].Summary);
    }

    [AvaloniaFact]
    public async Task A_profile_with_nothing_to_compare_says_so()
    {
        var compare = await Compare(Plan("{}", ""));

        Assert.True(compare.ShowResult);
        Assert.Empty(compare.Sections);
        Assert.Equal("orgs does not set anything Repotted compares.", compare.Summary);
    }

    [AvaloniaFact]
    public async Task What_the_plan_skipped_is_not_called_in_line()
    {
        const string Skipped = "Skipped actions.allowed_actions: it only applies while Actions is enabled";
        var compare = await Compare(Documents.Plan(
            warnings: $"\"Skipped environments: the sign-in cannot read environments\",\"{Skipped}\""));

        var environments = compare.Sections.Single(section => section.Title == "Environments");
        Assert.Equal("Not checked", environments.Status);
        Assert.False(environments.InLine);
        Assert.Equal("Repotted could not read the environments: the sign-in cannot read environments", environments.Summary);
        // A setting the plan skipped is not counted as matching; the warning says why.
        Assert.Equal("", compare.Sections.Single(section => section.Title == "Actions").Summary);
        Assert.Equal([Skipped], compare.Warnings);
    }

    [AvaloniaFact]
    public async Task Comparing_a_repository_opens_the_compare_and_leaving_closes_it()
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base))
            .On($"plan TheLunchTrae/repotted --profile {own} --json", Documents.Plan());
        var shell = new ShellViewModel(new Account.SignedIn("TheLunchTrae", null, null, null), new RepottedClient(cli), new FakeDesktop(), folders.Settings, () => Task.CompletedTask);
        await shell.RefreshAsync();
        var repositories = shell.Repositories;
        Assert.Equal("base", repositories.CompareWith?.Name);

        repositories.Selected = repositories.Rows.Single(row => row.Name == "repotted");
        repositories.CompareWith = shell.Profiles.Usable.Single(item => item.Name == "orgs");
        repositories.CompareCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();

        Assert.True(shell.ShowingCompare);
        Assert.False(shell.ShowingRepositories);
        Assert.Equal("Repositories / TheLunchTrae/repotted / Compare", shell.Crumb);
        Assert.Equal("orgs compared with TheLunchTrae/repotted", shell.Compare?.Heading);
        Assert.Equal(4, shell.Compare?.Sections.Count);

        shell.Page = 1;
        shell.Page = 0;

        Assert.Null(shell.Compare);
        Assert.True(shell.ShowingRepositories);
    }

    private static string Plan(string desired, string changes) =>
        $$"""{"repository":"TheLunchTrae/repotted","desired":{{desired}},"changes":[{{changes}}],"skipped":[],"warnings":[],"access":{{Documents.Unknown}},"locks":[]}""";

    [AvaloniaFact]
    public async Task A_compare_covers_security_pages_and_autolinks()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted",
             "desired":{
               "security":{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}},
                 "dependabot_runner_settings":{"runner_type":"standard","runner_labels":["x"]}},
               "custom_properties":{"team":"platform"},
               "pages":{"build_type":"workflow"},
               "autolinks":[{"key_prefix":"JIRA-","url_template":"https://jira.example.com/<num>"},{"key_prefix":"OLD-","absent":true}]},
             "changes":[
               {"section":"security","action":"update","target":"security and analysis",
                "fields":[{"field":"security_and_analysis.secret_scanning","from":{"status":"disabled"},"to":{"status":"enabled"}}],
                "request":{"method":"PATCH","path":"/repos/TheLunchTrae/repotted","body":{} } },
               {"section":"pages","action":"create","target":"GitHub Pages site","fields":[],
                "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/pages","body":{"build_type":"workflow"} } },
               {"section":"autolinks","action":"delete","target":"JIRA-","fields":[],
                "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/autolinks/1"} },
               {"section":"autolinks","action":"create","target":"JIRA-",
                "fields":[{"field":"url_template","from":"https://old.example.com/<num>","to":"https://jira.example.com/<num>"}],
                "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/autolinks","body":{} } }],
             "skipped":[],"warnings":["Skipped security.dependabot_runner_settings.runner_labels: GitHub keeps none with standard runners"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            ["Security", "Custom properties", "GitHub Pages", "Autolinks"],
            compare.Sections.Select(section => section.Title));
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Secret Protection", "security_and_analysis.secret_scanning.status", "Off", "On"),
             new CompareRow(CompareKind.Matches, "Push protection", "security_and_analysis.secret_scanning_push_protection", "On", "On"),
             new CompareRow(CompareKind.Matches, "Dependabot runners", "dependabot_runner_settings.runner_type", "Standard", "Standard")],
            compare.Sections[0].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Matches, "team", "team", "platform", "platform")],
            compare.Sections[1].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Adds, "GitHub Pages site", "new GitHub Pages site", CompareRow.NotOnGitHub, CompareRow.Created)],
            compare.Sections[2].Rows);
        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "JIRA-", "url_template", "https://old.example.com/<num>", "https://jira.example.com/<num>")],
            compare.Sections[3].Rows);
        Assert.Equal("1 removed autolink is already gone.", compare.Sections[3].Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_says_when_GitHub_would_not_show_a_section()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"workflow"}},"changes":[],
             "skipped":[],"warnings":["Skipped pages: GitHub refused to read GitHub Pages (Forbidden); that needs the Pages read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);

        var pages = compare.Sections.Single();
        Assert.True(pages.Skipped);
        Assert.Equal("Repotted could not read it: GitHub refused to read GitHub Pages (Forbidden); that needs the Pages read permission", pages.Summary);
    }

    [AvaloniaFact]
    public async Task A_compare_shows_a_changed_Pages_source_once()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"legacy","source":{"branch":"main","path":"/"}}},
             "changes":[{"section":"pages","action":"update","target":"GitHub Pages site",
               "fields":[{"field":"source","from":{"branch":"gh-pages","path":"/"},"to":{"branch":"main","path":"/"}}],
               "request":{"method":"PUT","path":"/repos/TheLunchTrae/repotted/pages","body":{} } }],
             "skipped":[],"warnings":[],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            [new CompareRow(CompareKind.Changes, "Branch", "source.branch", "gh-pages", "main"),
             new CompareRow(CompareKind.Matches, "Build from", "build_type", "A branch", "A branch")],
            compare.Sections.Single().Rows);
    }

    [AvaloniaFact]
    public async Task A_compare_says_when_the_profile_leaves_a_section_unchecked()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"legacy"}},"changes":[],
             "skipped":[],"warnings":["Skipped pages: a new site built from a branch needs source.branch, or build_type: workflow"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);

        Assert.Equal("Not checked: a new site built from a branch needs source.branch, or build_type: workflow", compare.Sections.Single().Summary);
    }

    [AvaloniaFact]
    public async Task A_skipped_section_hides_only_its_own_settings()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"custom_properties":{"rulesets":"strict"}},"changes":[],
             "skipped":[],"warnings":["Skipped rulesets: GitHub refused to read rulesets (Forbidden); that needs the Administration read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        compare.DifferencesOnly = false;

        Assert.Equal(
            [new CompareRow(CompareKind.Matches, "rulesets", "rulesets", "strict", "strict")],
            compare.Sections.Single(section => section.Title == "Custom properties").Rows);
    }

    [AvaloniaFact]
    public async Task A_search_keeps_a_section_it_could_not_read_when_it_finds_its_title()
    {
        const string plan = """
            {"repository":"TheLunchTrae/repotted","desired":{"repository":{"has_wiki":false},"rulesets":[{"name":"Main"}]},"changes":[],
             "skipped":[],"warnings":["Skipped rulesets: GitHub refused to read rulesets (Forbidden); that needs the Administration read permission"],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[]}
            """;
        var compare = await Compare(plan);
        var rulesets = compare.Sections.Single(section => section.Skipped);

        compare.Query = "rulesets";
        Assert.True(rulesets.Shown);
        // It keeps the line that says why it wasn't read.
        Assert.True(rulesets.HasSummary);
        Assert.False(compare.NothingFound);
        compare.Query = "wiki";
        Assert.False(rulesets.Shown);
    }

    private static async Task<CompareViewModel> Compare(string plan, FakeDesktop? desktop = null)
    {
        var compare = new CompareViewModel(
            new RepottedClient(new FakeCli().On("plan TheLunchTrae/repotted --profile orgs.yaml --json", plan)),
            desktop ?? new FakeDesktop(),
            "TheLunchTrae/repotted",
            new ProfileListingDocument("orgs", "orgs.yaml", null, null),
            Documents.InstallUrl);
        await compare.LoadCommand.ExecuteAsync(null);
        Assert.Null(compare.Error);
        return compare;
    }
}
