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
        // GitHub refuses it where the repository has no reviewers either, and the YAML is where they are listed.
        editor.Reviewers.ClearCommand.Execute(null);
        Assert.Equal("Prevent self-review needs at least one required reviewer. List them in the YAML first.", editor.Problem);
        editor.SelfReview.ClearCommand.Execute(null);
        Assert.Null(editor.Problem);
        // A file that already leaves reviewers to the repository stays as it is.
        Assert.Null(Environment("""{"name":"npm","prevent_self_review":true}""").Problem);

        editor.Deployments.Options[2].ChooseCommand.Execute(null);
        editor.Tags = "v*\nv*";
        Assert.Equal("Each branch or tag pattern can be listed once.", editor.Problem);
    }
}
