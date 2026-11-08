using System.Text.Json.Nodes;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

public sealed class EntryEditorTests
{
    private static JsonObject Json(string text) => JsonNode.Parse(text)!.AsObject();

    private static RulesetEditorViewModel Ruleset(string? saved, Func<string, bool>? taken = null) =>
        new(saved is null ? null : Json(saved), renamable: true, (name, _) => taken?.Invoke(name) == true, () => { });

    private static EnvironmentEditorViewModel Environment(string? saved) =>
        new(saved is null ? null : Json(saved), renamable: true, (_, _) => false, () => { });

    private static LabelEditorViewModel Label(string? saved, Func<string, string?>? claimedBy = null) =>
        new(saved is null ? null : Json(saved), renamable: true, (_, _) => false, old => claimedBy?.Invoke(old), () => { });

    private static RuleViewModel Rule(RulesetEditorViewModel editor, string type) =>
        editor.Rules.Single(rule => rule.Kind.Type == type);

    private const string Main = """
        {"name":"Main","enforcement":"active",
         "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]},"repository_name":{"include":["a"]}},
         "rules":[
           {"type":"merge_queue","parameters":{"merge_method":"SQUASH"}},
           {"type":"pull_request","parameters":{"required_approving_review_count":1,"allowed_merge_methods":["squash","merge"],"automatic_copilot_code_review_enabled":true}},
           {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality","integration_id":15368}]}}]}
        """;

    [Fact]
    public void An_unedited_ruleset_is_saved_as_it_was()
    {
        var editor = Ruleset(Main);

        Assert.False(editor.Changed);
        Assert.True(JsonNode.DeepEquals(Json(Main), editor.Entry));
        Assert.Equal("merge_queue", editor.Others);
        Assert.False(editor.LeavesRules);
    }

    [Fact]
    public void A_ruleset_edit_changes_only_what_it_touches()
    {
        var editor = Ruleset(Main);
        var pullRequest = (PullRequestRuleViewModel)Rule(editor, "pull_request");
        var checks = (StatusChecksRuleViewModel)Rule(editor, "required_status_checks");

        editor.Enforcement.Options[1].ChooseCommand.Execute(null);
        editor.Target.Options[0].ChooseCommand.Execute(null);
        editor.Target.ClearCommand.Execute(null);
        Rule(editor, "deletion").Enabled = true;
        pullRequest.Approvals.Number = 2;
        pullRequest.CodeOwners.Value = true;
        checks.Contexts = "quality\nlint\n";
        editor.Include = "~DEFAULT_BRANCH\nreleases/*";

        // Keys and rules keep their order, and what the editor does not show; a rule turned on goes last.
        Assert.Equal(
            Json("""
            {"name":"Main","enforcement":"evaluate",
             "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH","releases/*"],"exclude":[]},"repository_name":{"include":["a"]}},
             "rules":[
               {"type":"merge_queue","parameters":{"merge_method":"SQUASH"}},
               {"type":"pull_request","parameters":{"required_approving_review_count":2,"allowed_merge_methods":["squash","merge"],"automatic_copilot_code_review_enabled":true,"require_code_owner_review":true}},
               {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality","integration_id":15368},{"context":"lint"}]}},
               {"type":"deletion"}]}
            """).ToJsonString(),
            editor.Entry.ToJsonString());
        Assert.True(editor.Changed);

        // Turning a rule off takes it out.
        pullRequest.Enabled = false;
        Assert.DoesNotContain("pull_request", editor.Entry.ToJsonString(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_new_ruleset_names_only_what_is_set()
    {
        var editor = Ruleset(null);
        editor.Name = " Tags ";

        Assert.Equal("""{"name":"Tags"}""", editor.Entry.ToJsonString());
        Assert.Equal("Not set here, so the repository keeps its own, or Active when it is new", editor.Enforcement.Note);
        Assert.True(editor.Enforcement.Options[0].Dim);

        editor.Target.Options[1].ChooseCommand.Execute(null);
        var pullRequest = (PullRequestRuleViewModel)Rule(editor, "pull_request");
        pullRequest.Enabled = true;

        // GitHub's defaults fill the parameters the profile leaves out.
        Assert.Equal("""{"name":"Tags","target":"tag","rules":[{"type":"pull_request"}]}""", editor.Entry.ToJsonString());
        Assert.True(pullRequest.Approvals.Dim);
    }

    [Fact]
    public void A_ruleset_that_cannot_be_saved_says_why()
    {
        var names = new HashSet<string>(StringComparer.Ordinal) { "Taken" };
        var editor = Ruleset(null, names.Contains);

        Assert.Equal("A ruleset needs a name.", editor.Problem);
        editor.Name = "Taken";
        Assert.Equal("The profile already has a ruleset named Taken.", editor.Problem);
        editor.Name = "Main";
        Assert.Null(editor.Problem);

        var pullRequest = (PullRequestRuleViewModel)Rule(editor, "pull_request");
        pullRequest.Enabled = true;
        pullRequest.Methods.Merge = false;
        pullRequest.Methods.Squash = false;
        pullRequest.Methods.Rebase = false;
        Assert.Equal("A pull request rule needs at least one merge method.", editor.Problem);
        pullRequest.Methods.Rebase = true;
        Assert.Contains("\"allowed_merge_methods\":[\"rebase\"]", editor.Entry.ToJsonString(), StringComparison.Ordinal);

        Rule(editor, "required_status_checks").Enabled = true;
        Assert.Equal("Name at least one status check that must pass.", editor.Problem);

        // A ruleset the profile removes needs only its name.
        editor.Removes = true;
        Assert.Null(editor.Problem);
        Assert.Equal("""{"name":"Main","absent":true}""", editor.Entry.ToJsonString());
    }

    [Fact]
    public void Turning_on_a_rule_where_the_yaml_names_none_says_what_happens()
    {
        var editor = Ruleset("""{"name":"Main","enforcement":"active"}""");

        Assert.True(editor.LeavesRules);
        Assert.False(editor.Changed);
        Rule(editor, "non_fast_forward").Enabled = true;
        Assert.Equal("""{"name":"Main","enforcement":"active","rules":[{"type":"non_fast_forward"}]}""", editor.Entry.ToJsonString());
    }

    [Fact]
    public void A_rename_says_what_it_does_on_GitHub()
    {
        var editor = Ruleset("""{"name":"Main"}""");
        Assert.Null(editor.RenameNote);

        editor.Name = "Protect main";
        Assert.Equal("GitHub knows each ruleset by its name, so applying this profile creates Protect main and leaves Main on each repository as it is.", editor.RenameNote);
        editor.Removes = true;
        Assert.Null(editor.RenameNote);

        // Environment names ignore case on GitHub, so a change of case renames the same one.
        var environment = Environment("""{"name":"npm"}""");
        environment.Name = "NPM";
        Assert.Null(environment.RenameNote);
    }

    [Fact]
    public void A_removed_ruleset_can_be_managed_again()
    {
        var editor = Ruleset("""{"name":"Old","absent":true}""");

        Assert.True(editor.Removes);
        Assert.False(editor.Changed);
        editor.Manages = true;
        Assert.Equal("""{"name":"Old"}""", editor.Entry.ToJsonString());
    }

    [Fact]
    public void An_environment_writes_patterns_only_for_chosen_branches_and_tags()
    {
        const string saved = """
            {"name":"npm","wait_timer":5,"reviewers":[{"type":"User","id":1}],
             "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},
             "branch_policies":[{"name":"v*","type":"tag"},{"name":"main"}]}
            """;
        var editor = Environment(saved);

        Assert.False(editor.Changed);
        Assert.Equal(("main", "v*"), (editor.Branches, editor.Tags));
        Assert.True(editor.ShowPatterns);

        editor.Branches = "main\nreleases/*";
        Assert.Equal(
            """[{"name":"main"},{"name":"releases/*"},{"name":"v*","type":"tag"}]""",
            editor.Entry["branch_policies"]!.ToJsonString());

        // Protected branches take no patterns, and any branch is no policy at all.
        editor.Deployments.Options[1].ChooseCommand.Execute(null);
        Assert.False(editor.ShowPatterns);
        Assert.False(editor.Entry.ContainsKey("branch_policies"));
        editor.Deployments.Options[0].ChooseCommand.Execute(null);
        Assert.Equal("null", editor.Entry["deployment_branch_policy"]?.ToJsonString() ?? "null");
        Assert.True(editor.Entry.ContainsKey("deployment_branch_policy"));
        editor.Deployments.ClearCommand.Execute(null);
        Assert.False(editor.Entry.ContainsKey("deployment_branch_policy"));
    }

    [Fact]
    public void An_environment_that_cannot_be_saved_says_why()
    {
        var editor = Environment("""{"name":"npm"}""");

        foreach (var text in new[] { "soon", "-1", "43201", "1.5" })
        {
            editor.WaitTimer = text;
            Assert.Equal("The wait timer is a whole number of minutes, from 0 to 43200.", editor.Problem);
        }
        editor.WaitTimer = " 30 ";
        Assert.Null(editor.Problem);
        Assert.Equal("""{"name":"npm","wait_timer":30}""", editor.Entry.ToJsonString());
        editor.WaitTimer = "";
        Assert.Equal("""{"name":"npm"}""", editor.Entry.ToJsonString());

        editor.SelfReview.Options[0].ChooseCommand.Execute(null);
        editor.Reviewers.Options[0].ChooseCommand.Execute(null);
        Assert.Equal("Prevent self-review needs at least one required reviewer.", editor.Problem);
        // Left out, reviewers keep the repository's, which the plan checks, as the profile schema does.
        editor.Reviewers.ClearCommand.Execute(null);
        Assert.Null(editor.Problem);
        Assert.Equal("""{"name":"npm","prevent_self_review":true}""", editor.Entry.ToJsonString());
        editor.SelfReview.ClearCommand.Execute(null);
        Assert.Null(editor.Problem);

        editor.Deployments.Options[2].ChooseCommand.Execute(null);
        editor.Tags = "v*\nv*";
        Assert.Equal("Each branch or tag pattern can be listed once.", editor.Problem);
    }

    [Fact]
    public void A_label_edit_changes_only_what_it_touches()
    {
        var editor = Label("""{"name":"bug","description":"Broken","color":"#D73A4A"}""");
        Assert.False(editor.Changed);
        Assert.Equal(("d73a4a", "#ffffff"), (editor.Hex, editor.Ink));

        // A color picked from GitHub's goes in as GitHub writes it, and the description keeps its place.
        editor.PickCommand.Execute("fef2c0");
        Assert.True(editor.Swatches.Single(swatch => swatch.Hex == "fef2c0").IsChosen);
        Assert.Equal((LabelColor.Dark, 1), (editor.Ink, editor.Swatches.Count(swatch => swatch.IsChosen)));
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"bug","description":"Broken","color":"fef2c0"}"""), editor.Entry));

        // Leaving the description to each repository takes it out; an empty one clears it.
        editor.KeepsDescription = true;
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"bug","color":"fef2c0"}"""), editor.Entry));
        editor.KeepsDescription = false;
        editor.Description = "";
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"bug","description":"","color":"fef2c0"}"""), editor.Entry));
        Assert.Equal("0 of 100 characters. Empty clears each repository's description.", editor.DescriptionNote);

        // An empty color leaves each repository's own.
        editor.Color = "";
        Assert.Null(editor.Hex);
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"bug","description":""}"""), editor.Entry));
    }

    [Fact]
    public void A_new_label_names_only_what_is_set()
    {
        var editor = Label(null);
        Assert.Equal("A label needs a name.", editor.Problem);
        Assert.True(editor.KeepsDescription);

        editor.Name = " type: bug ";
        editor.Color = "#B60205";
        editor.RenamedFrom = "bug\n\n Defect \n";

        Assert.Null(editor.Problem);
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"type: bug","color":"#B60205","renamed_from":["bug","Defect"]}"""), editor.Entry));
    }

    [Fact]
    public void Renaming_a_label_offers_to_rename_it_on_GitHub()
    {
        var editor = Label("""{"name":"bug","color":"d73a4a"}""");

        // A change of case is the same label, as GitHub matches names.
        editor.Name = "Bug";
        Assert.Null(editor.RenameNote);
        editor.Name = "type: bug";
        Assert.Equal("Applying creates type: bug and leaves bug on each repository, unless Renamed from lists bug.", editor.RenameNote);
        Assert.Equal((true, "Rename bug on GitHub"), (editor.CanAddOldName, editor.AddOldNameLabel));

        editor.AddOldNameCommand.Execute(null);

        Assert.Equal(("bug", null, false), (editor.RenamedFrom, editor.RenameNote, editor.CanAddOldName));
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"type: bug","color":"d73a4a","renamed_from":["bug"]}"""), editor.Entry));

        // A removed label takes no old names.
        editor.Removes = true;
        Assert.True(JsonNode.DeepEquals(Json("""{"name":"type: bug","absent":true}"""), editor.Entry));
        Assert.Empty(editor.Claims);
    }

    [Fact]
    public void A_label_that_cannot_be_saved_says_why()
    {
        var editor = Label("""{"name":"bug"}""", old => old switch
        {
            "wontfix" => "wontfix",
            "defect" => "type: bug",
            _ => null,
        });

        editor.Color = "red";
        Assert.Equal("The color is six hex digits, such as a2eeef, with or without #.", editor.Problem);
        editor.Color = "#fff";
        Assert.NotNull(editor.Problem);
        editor.Color = "000000";
        editor.KeepsDescription = false;
        editor.Description = new string('x', 101);
        Assert.Equal("A label's description can be at most 100 characters.", editor.Problem);
        editor.Description = "Broken";
        editor.RenamedFrom = "BUG";
        Assert.Equal("Renamed from lists the label's own name.", editor.Problem);
        editor.RenamedFrom = "issue\nIssue";
        Assert.Equal("Each old name can be listed once.", editor.Problem);
        editor.RenamedFrom = "wontfix";
        Assert.Equal("The profile has a label named wontfix, so it can't be an old name.", editor.Problem);
        editor.RenamedFrom = "defect";
        Assert.Equal("type: bug already lists defect in Renamed from.", editor.Problem);
        editor.RenamedFrom = "";
        editor.Name = new string('b', 51);
        Assert.Equal("A label's name can be at most 50 characters.", editor.Problem);

        // A draft may be unfinished.
        editor.IsDraft = true;
        Assert.Null(editor.Problem);
    }

    [Theory]
    // Each of GitHub's colors, and the darkest and lightest, reads at 4.5:1 or more.
    [InlineData("000000", LabelColor.Light)]
    [InlineData("ffffff", LabelColor.Dark)]
    [InlineData("b60205", LabelColor.Light)]
    [InlineData("a2eeef", LabelColor.Dark)]
    [InlineData(null, LabelColor.Dark)]
    public void A_label_reads_on_its_color(string? hex, string ink) =>
        Assert.Equal(ink, LabelColor.Ink(hex));

    [Fact]
    public void Every_palette_color_reads_with_its_ink()
    {
        foreach (var (hex, _) in LabelColor.Palette)
        {
            Assert.True(LabelColor.Contrast(hex, LabelColor.Ink(hex)[1..]) >= 4.5, hex);
        }
    }
}
