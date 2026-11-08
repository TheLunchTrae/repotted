using System.Text.Json;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>
/// The Apply page's diff: a plan as profile YAML, what GitHub has now against
/// what it has once the plan applies.
/// </summary>
public sealed class PlanDiffTests
{
    private static PlanDocument Plan(string desired, string changes = "", string warnings = "", string locks = "", string skipped = "") =>
        JsonSerializer.Deserialize(
            $$"""
            {"repository":"TheLunchTrae/repotted","desired":{{desired}},"changes":[{{changes}}],
             "warnings":[{{warnings}}],"access":{{Documents.Unknown}},"locks":[{{locks}}],"skipped":[{{skipped}}]}
            """,
            CliJson.Default.PlanDocument)!;

    /// <summary>Each line as the diff draws it: a sign, then the text, then any tag or lock.</summary>
    private static List<string> Drawn(IEnumerable<DiffLine> lines) =>
        [.. lines.Select(line => line.Kind switch
        {
            DiffKind.Removed when line.Tag is not null => $"- {line.Text} [{line.Tag}]",
            DiffKind.Removed => $"- {line.Text}",
            DiffKind.Added => $"+ {line.Text}" + (line.Tag is null ? "" : $" [{line.Tag}]"),
            DiffKind.Note => $"! {line.Text}" + (line.Locked ? " [locked]" : ""),
            _ => $"  {line.Text}",
        })];

    [Fact]
    public void A_changed_setting_shows_what_GitHub_has_now_and_after()
    {
        var plan = Plan(
            """{"repository":{"has_issues":true,"has_wiki":false},"merge":{"allow_squash_merge":false}}""",
            """
            {"section":"repository","action":"update","target":"repository settings","fields":[{"field":"has_wiki","from":true,"to":false}]},
            {"section":"merge","action":"update","target":"merge methods","fields":[{"field":"allow_squash_merge","from":true,"to":false}]}
            """);

        Assert.Equal(
            [
                "  repository:",
                "    has_issues: true",
                "-   has_wiki: true",
                "+   has_wiki: false",
                "  merge:",
                "-   allow_squash_merge: true",
                "+   allow_squash_merge: false",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_setting_GitHub_does_not_have_yet_shows_only_as_added()
    {
        var plan = Plan(
            """{"actions":{"default_workflow_permissions":"read"}}""",
            """{"section":"actions","action":"update","target":"workflow permissions","fields":[{"field":"default_workflow_permissions","to":"read"}]}""");

        Assert.Equal(["  actions:", "+   default_workflow_permissions: read"], Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_nested_setting_keeps_only_what_the_profile_names()
    {
        // GitHub reports more of the object than the profile names; the diff shows only the named keys.
        var plan = Plan(
            """{"security":{"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}}""",
            """
            {"section":"security","action":"update","target":"security and analysis","fields":[{"field":"security_and_analysis.secret_scanning",
              "from":{"status":"disabled","extra":1},"to":{"status":"enabled"}}]}
            """);

        Assert.Equal(
            [
                "  security:",
                "    security_and_analysis:",
                "      secret_scanning:",
                "-       status: disabled",
                "+       status: enabled",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_new_entry_is_all_added_and_a_deleted_one_shows_what_ends_it()
    {
        var plan = Plan(
            """{"rulesets":[{"name":"Main","enforcement":"active","rules":[{"type":"deletion"}]},{"name":"Old","absent":true}]}""",
            """
            {"section":"rulesets","action":"create","target":"Main","fields":[{"field":"name","to":"Main"},{"field":"enforcement","to":"active"},
              {"field":"rules","to":[{"type":"deletion"}]}]},
            {"section":"rulesets","action":"delete","target":"Old","fields":[]}
            """);

        Assert.Equal(
            [
                "  rulesets:",
                "+   - name: Main",
                "+     enforcement: active",
                "+     rules:",
                "+       - type: deletion",
                "    - name: Old",
                "+     absent: true",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void An_environment_branch_policy_shows_in_its_list()
    {
        var plan = Plan(
            """{"environments":[{"name":"production","branch_policies":[{"name":"main","type":"branch"}]}]}""",
            """
            {"section":"environments","action":"create","target":"production: branch main","fields":[]},
            {"section":"environments","action":"delete","target":"production: tag v*","fields":[]}
            """);

        Assert.Equal(
            [
                "  environments:",
                "    - name: production",
                "      branch_policies:",
                "-       - name: v*",
                "-         type: tag",
                "+       - name: main",
                "+         type: branch",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void Labels_show_a_rename_a_new_label_and_a_deleted_one()
    {
        // A label whose name starts with another's and ": " is a label of its own, not a branch policy.
        var plan = Plan(
            """
            {"labels":[{"name":"Type: feature","renamed_from":["enhancement"]},{"name":"priority","color":"b60205"},
              {"name":"priority: high","color":"d93f0b"},{"name":"wontfix","absent":true}]}
            """,
            """
            {"section":"labels","action":"delete","target":"wontfix","fields":[]},
            {"section":"labels","action":"update","target":"Type: feature","fields":[{"field":"name","from":"enhancement","to":"Type: feature"}]},
            {"section":"labels","action":"create","target":"priority: high","fields":[]}
            """);

        Assert.Equal(
            [
                "  labels:",
                "-   - name: enhancement",
                "+   - name: 'Type: feature'",
                "      renamed_from:",
                "        - enhancement",
                "    - name: priority",
                "      color: b60205",
                "+   - name: 'priority: high'",
                "+     color: d93f0b",
                "    - name: wontfix",
                "+     absent: true",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_change_Repotted_cannot_make_has_a_lock_under_it_and_a_one_off_edit_a_tag()
    {
        var plan = Plan(
            """{"repository":{"has_wiki":false},"rulesets":[{"name":"Main"}]}""",
            """
            {"section":"repository","action":"update","target":"repository settings","fields":[{"field":"has_wiki","from":true,"to":false}]},
            {"section":"rulesets","action":"create","target":"Main","fields":[{"field":"name","to":"Main"}]}
            """,
            locks: """{"change":1,"reason":"Needs Administration write"}""");

        var lines = PlanDiff.Lines(plan, (change, _) => change == 0 ? new RowExclusion("repository.has_wiki", Edited: true) : null);

        Assert.Equal(
            [
                "  repository:",
                "-   has_wiki: true",
                "+   has_wiki: false [One-off edit]",
                "  rulesets:",
                "+   - name: Main",
                "! Needs Administration write [locked]",
            ],
            Drawn(lines));
        Assert.Equal("GitHub loses: has_wiki: true", lines[1].AccessibleName);
        Assert.Equal("GitHub gets: has_wiki: false, one-off edit", lines[2].AccessibleName);
        Assert.Equal("GitHub will refuse this: Needs Administration write", lines[5].AccessibleName);
    }

    [Fact]
    public void A_section_the_plan_skipped_shows_as_it_is_with_why()
    {
        var plan = Plan(
            """{"pages":{"build_type":"workflow"}}""",
            warnings: "\"Skipped pages: the token can't read Pages\"");

        Assert.Equal(
            ["  pages:", "    build_type: workflow", "! Not checked: the token can't read Pages"],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_ruleset_shows_its_rules_in_the_profile_order_with_only_what_the_profile_sets()
    {
        // As the engine sends a ruleset update: whole rule lists, with every parameter on both sides.
        var plan = Plan(
            """
            {"rulesets":[{"name":"Main","rules":[{"type":"deletion"},
              {"type":"pull_request","parameters":{"required_approving_review_count":2}}]}]}
            """,
            """
            {"section":"rulesets","action":"update","target":"Main","fields":[{"field":"rules",
              "from":[{"type":"pull_request","parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":false}},
                {"type":"deletion"},{"type":"non_fast_forward"}],
              "to":[{"type":"deletion"},
                {"type":"pull_request","parameters":{"required_approving_review_count":2,"dismiss_stale_reviews_on_push":false}}]}]}
            """);

        Assert.Equal(
            [
                "  rulesets:",
                "    - name: Main",
                "      rules:",
                "        - type: deletion",
                "        - type: pull_request",
                "          parameters:",
                "-           required_approving_review_count: 1",
                "-       - type: non_fast_forward",
                "+           required_approving_review_count: 2",
            ],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_list_whose_order_alone_differs_loses_only_what_the_profile_drops()
    {
        var plan = Plan(
            """{"repository":{"topics":["a","b"]}}""",
            """{"section":"repository","action":"update","target":"topics","fields":[{"field":"topics","from":["b","a","c"],"to":["a","b"]}]}""");

        Assert.Equal(
            ["  repository:", "    topics:", "      - a", "      - b", "-     - c"],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void Reviewers_match_by_type_and_id_whatever_their_order()
    {
        var plan = Plan(
            """
            {"environments":[{"name":"production","wait_timer":5,
              "reviewers":[{"type":"User","id":1},{"type":"Team","id":2}]}]}
            """,
            """
            {"section":"environments","action":"update","target":"production","fields":[
              {"field":"wait_timer","from":0,"to":5},
              {"field":"reviewers","from":[{"type":"Team","id":2},{"type":"User","id":1}],"to":[{"type":"User","id":1},{"type":"Team","id":2}]}]}
            """);

        var drawn = Drawn(PlanDiff.Lines(plan));

        Assert.Equal(["-     wait_timer: 0", "+     wait_timer: 5"], drawn.Where(line => line[0] != ' '));
    }

    [Fact]
    public void A_locked_change_has_its_padlock_under_both_its_lines()
    {
        var plan = Plan(
            """{"repository":{"has_wiki":false}}""",
            """{"section":"repository","action":"update","target":"repository settings","fields":[{"field":"has_wiki","from":true,"to":false}]}""",
            locks: """{"change":0,"reason":"Needs Administration write"}""");

        Assert.Equal(
            ["  repository:", "-   has_wiki: true", "+   has_wiki: false", "! Needs Administration write [locked]"],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_one_off_edit_that_only_drops_a_line_is_tagged()
    {
        var plan = Plan(
            """{"rulesets":[{"name":"Main","rules":[{"type":"deletion"}]}]}""",
            """
            {"section":"rulesets","action":"update","target":"Main","fields":[{"field":"rules",
              "from":[{"type":"deletion"},{"type":"non_fast_forward"}],"to":[{"type":"deletion"}]}]}
            """);

        var lines = PlanDiff.Lines(plan, (_, _) => new RowExclusion("rulesets/Main", Edited: true));

        Assert.Contains("-       - type: non_fast_forward [One-off edit]", Drawn(lines));
    }

    [Fact]
    public void A_setting_the_plan_did_not_check_says_why_and_does_not_match()
    {
        var plan = Plan(
            """{"security":{"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}}""",
            warnings: "\"Skipped security.security_and_analysis.secret_scanning: GitHub did not report it\"");

        Assert.Equal(
            [
                "  security:",
                "    security_and_analysis:",
                "      secret_scanning:",
                "        status: enabled",
                "! Not checked: secret_scanning: GitHub did not report it",
            ],
            Drawn(PlanDiff.Lines(plan)));
        Assert.False(new PlanDiffViewModel(PlanDiff.Lines(plan)).Matches);
    }

    [Fact]
    public void A_branch_policy_belongs_to_the_environment_with_the_longest_name_it_starts_with()
    {
        var plan = Plan(
            """{"environments":[{"name":"prod"},{"name":"prod: tag v1","absent":true}]}""",
            """{"section":"environments","action":"delete","target":"prod: tag v1","fields":[]}""");

        Assert.Equal(
            ["  environments:", "    - name: prod", "    - name: 'prod: tag v1'", "+     absent: true"],
            Drawn(PlanDiff.Lines(plan)));
    }

    [Fact]
    public void A_fold_keeps_the_lines_that_say_which_entry_changes()
    {
        List<DiffLine> lines =
        [
            new(DiffKind.Same, "rulesets:"),
            new(DiffKind.Same, "  - name: First"),
            .. Enumerable.Range(1, 4).Select(index => new DiffLine(DiffKind.Same, $"    rule_{index}: true")),
            new(DiffKind.Same, "  - name: Second"),
            new(DiffKind.Same, "    enforcement: active"),
            new(DiffKind.Same, "    rules:"),
            new(DiffKind.Same, "      - type: deletion"),
            new(DiffKind.Same, "      - type: pull_request"),
            new(DiffKind.Same, "        parameters:"),
            new(DiffKind.Same, "          dismiss_stale_reviews_on_push: true"),
            new(DiffKind.Same, "          require_code_owner_review: true"),
            new(DiffKind.Removed, "          required_approving_review_count: 1"),
            new(DiffKind.Added, "          required_approving_review_count: 2"),
        ];

        var diff = new PlanDiffViewModel(lines);
        var kept = diff.Items.OfType<DiffLine>().Select(line => line.Text).ToList();

        // Only the first ruleset folds; the second keeps its name and the lines down to the change.
        Assert.Equal(5, Assert.Single(diff.Items.OfType<DiffFold>()).Lines.Count);
        Assert.Equal(
            [
                "rulesets:",
                "  - name: Second",
                "    enforcement: active",
                "    rules:",
                "      - type: deletion",
                "      - type: pull_request",
                "        parameters:",
                "          dismiss_stale_reviews_on_push: true",
                "          require_code_owner_review: true",
                "          required_approving_review_count: 1",
                "          required_approving_review_count: 2",
            ],
            kept);
    }

    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("true", "'true'")]
    [InlineData("12", "'12'")]
    [InlineData("a: b", "'a: b'")]
    [InlineData("*.md", "'*.md'")]
    [InlineData("it's", "it's")]
    [InlineData("'quoted'", "'''quoted'''")]
    [InlineData("two\nlines", "\"two\\nlines\"")]
    [InlineData("", "''")]
    public void Strings_are_quoted_only_when_YAML_would_read_them_otherwise(string value, string written)
    {
        Assert.Equal(written, PlanDiff.Yaml.Scalar(System.Text.Json.Nodes.JsonValue.Create(value)));
    }

    [Fact]
    public void Lines_that_move_stay_in_order_with_removed_before_added()
    {
        Assert.Equal(
            ["  a", "- b", "- c", "+ x", "  d", "+ e"],
            Drawn(PlanDiff.Diff(["a", "b", "c", "d"], ["a", "x", "d", "e"])));
    }

    [Fact]
    public void Long_runs_of_unchanged_lines_fold_and_unfold_in_place()
    {
        List<DiffLine> lines =
        [
            new(DiffKind.Same, "repository:"),
            .. Enumerable.Range(1, 5).Select(index => new DiffLine(DiffKind.Same, $"  setting_{index}: true")),
            new(DiffKind.Removed, "  has_wiki: true"),
            new(DiffKind.Added, "  has_wiki: false"),
            new(DiffKind.Same, "  last: true"),
        ];
        var diff = new PlanDiffViewModel(lines);

        Assert.Equal(2, diff.Changes);
        Assert.False(diff.Matches);
        // The section's name and the line beside the change stay; four lines between fold.
        var fold = Assert.IsType<DiffFold>(diff.Items[1]);
        Assert.Equal("Show 4 unchanged lines", fold.Label);
        Assert.Equal(6, diff.Items.Count);

        diff.UnfoldCommand.Execute(fold);

        Assert.Equal(lines, diff.Items.Cast<DiffLine>());
    }

    [Fact]
    public void A_short_run_of_unchanged_lines_does_not_fold()
    {
        var diff = new PlanDiffViewModel(
        [
            new(DiffKind.Same, "repository:"),
            new(DiffKind.Same, "  a: 1"),
            new(DiffKind.Same, "  b: 2"),
            new(DiffKind.Same, "  c: 3"),
            new(DiffKind.Added, "  d: 4"),
        ]);

        Assert.All(diff.Items, item => Assert.IsType<DiffLine>(item));
    }

    [Fact]
    public void A_plan_with_nothing_to_change_matches()
    {
        var plan = Plan("""{"repository":{"has_issues":true}}""");
        var diff = new PlanDiffViewModel(PlanDiff.Lines(plan));

        Assert.True(diff.Matches);
        Assert.Equal(["  repository:", "    has_issues: true"], Drawn(PlanDiff.Lines(plan)));
    }
}
