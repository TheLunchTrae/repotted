using System.Text.Json;
using System.Text.Json.Nodes;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Reads the documents the CLI's own tests print against their in-memory
/// GitHub, which they save in Fixtures, the way the app reads them: through
/// <see cref="RepottedClient"/>, with the checks it makes after parsing. Each
/// test asserts what the app takes from its document, so a renamed member or
/// a changed value fails here even when the document still parses. Run the
/// CLI's tests, such as with <c>pnpm vitest run -u</c>, to write them again.
/// </summary>
public sealed class CliFixtureTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static readonly string Folder = Path.Combine(AppContext.BaseDirectory, "Fixtures");

    /// <summary>Every fixture in the folder, each of which a test here reads.</summary>
    private static readonly string[] Names =
    [
        "apply-failed.json",
        "apply-partway.json",
        "apply-stale.json",
        "apply.json",
        "batch-apply-stopped.json",
        "batch-apply.json",
        "batch-everywhere.json",
        "batch-plan.json",
        "batch.json",
        "capture.json",
        "login.jsonl",
        "logout.json",
        "plan-locked.json",
        "plan.json",
        "repos.json",
        "stage.json",
        "staged-plan-skipped.json",
        "staged-plan.json",
        "status-rejected.json",
        "status.json",
        "sync-conflict.json",
        "sync.json",
    ];

    private static string Fixture(string name) => File.ReadAllText(Path.Combine(Folder, name));

    private static RepottedClient Answering(string command, string fixture, int exitCode = 0) =>
        new(new FakeCli().On(command, Fixture(fixture), exitCode));

    /// <summary>A batch apply's document with only its result at <paramref name="index"/>, as the app's one <c>--only</c> gets it.</summary>
    private static string Only(string fixture, int index)
    {
        var document = JsonNode.Parse(Fixture(fixture))!.AsObject();
        var result = document["results"]![index]!.DeepClone();
        document["results"] = new JsonArray(result);
        return document.ToJsonString();
    }

    [Fact]
    public void Every_fixture_is_read_here()
    {
        var files = Directory.GetFiles(Folder).Select(file => Path.GetFileName(file)).Order(StringComparer.Ordinal);

        Assert.Equal(Names.Order(StringComparer.Ordinal), files);
    }

    [Fact]
    public async Task Status_signed_in()
    {
        var account = await Answering("status --json", "status.json").StatusAsync(None);

        Assert.Equal(
            new Account.SignedIn("lunch", "Lunch", null, new Uri("https://github.com/apps/repotted-app/installations/new")),
            account);
    }

    [Fact]
    public async Task Status_rejected()
    {
        var account = await Answering("status --json", "status-rejected.json", exitCode: 1).StatusAsync(None);

        var signedOut = Assert.IsType<Account.SignedOut>(account);
        Assert.True(signedOut.Rejected);
        Assert.Null(signedOut.TokenVariable);
        Assert.Empty(signedOut.Problems);
    }

    [Fact]
    public async Task Login()
    {
        var lines = File.ReadAllLines(Path.Combine(Folder, "login.jsonl"));
        var client = new RepottedClient(new FakeCli().OnLines("login --json", lines));
        DeviceCode? shown = null;

        await client.SignInAsync(code => shown = code, None);

        Assert.Equal(
            new DeviceCode(new Uri("https://github.com/login/device"), "ABCD-1234", new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero)),
            shown);
    }

    [Fact]
    public async Task Logout()
    {
        var cli = new FakeCli().On("logout --json", Fixture("logout.json"));

        await new RepottedClient(cli).SignOutAsync(None);

        Assert.Equal(["logout --json"], cli.Calls);
    }

    [Fact]
    public async Task Repositories()
    {
        var list = await Answering("repos --json", "repos.json").RepositoriesAsync(None);

        Assert.True(list.FromInstallations);
        Assert.Equal([new RepositoryDocument("lunch/app", true, false)], list.Repositories);
    }

    [Fact]
    public async Task Plan()
    {
        var plan = await Answering("plan lunch/app --profile base.yaml --json", "plan.json").PlanAsync("lunch/app", "base.yaml", None);

        Assert.Equal("lunch/app", plan.Repository);
        Assert.Equal(8, plan.Changes.Count);
        var settings = plan.Changes[0];
        Assert.Equal(("repository", "update", "repository settings"), (settings.Section, settings.Action, settings.Target));
        Assert.Null(settings.Entry);
        var field = settings.Fields[0];
        Assert.Equal("has_projects", field.Field);
        Assert.True(field.From.GetBoolean());
        Assert.False(field.To.GetBoolean());
        var ruleset = plan.Changes[3];
        Assert.Equal(("rulesets", "create"), (ruleset.Section, ruleset.Action));
        Assert.Equal(new ChangeEntryDocument("Main: Block Creation and Deletion"), ruleset.Entry);
        // A new entry has nothing on GitHub to change from.
        Assert.Equal(JsonValueKind.Undefined, ruleset.Fields[0].From.ValueKind);
        Assert.Equal(new AccessDocument("admin", new AppAccessDocument("unknown")), plan.Access);
        Assert.Empty(plan.Warnings);
        Assert.Empty(plan.Locks);
        Assert.Empty(plan.Skipped);
    }

    [Fact]
    public async Task Plan_with_a_change_Repotted_cannot_make()
    {
        var plan = await Answering("plan lunch/app --profile base.yaml --json", "plan-locked.json").PlanAsync("lunch/app", "base.yaml", None);

        Assert.Equal([new LockDocument(0, "Needs Administration write")], plan.Locks);
        Assert.Equal(
            new AppAccessDocument("installed", "https://github.com/settings/installations/4"),
            plan.Access.App);
    }

    [Fact]
    public async Task Capture()
    {
        var warnings = await Answering("capture lunch/app --output app.yaml --json", "capture.json").CaptureAsync("lunch/app", "app.yaml", None);

        Assert.Equal(
            ["Skipped environments: GitHub refused to read environments (Resource not accessible by integration); reading them needs the Actions read permission"],
            warnings);
    }

    [Fact]
    public async Task Apply()
    {
        var result = await Answering("apply plan.json --yes --json", "apply.json").ApplyAsync("plan.json", None);

        var applied = Assert.IsType<ApplyResult.Applied>(result);
        Assert.NotEmpty(applied.Changes);
        Assert.Equal("repository settings", applied.Changes[0].Target);
    }

    [Fact]
    public async Task Apply_of_a_stale_plan()
    {
        var result = await Answering("apply plan.json --yes --json", "apply-stale.json", exitCode: 1).ApplyAsync("plan.json", None);

        var stale = Assert.IsType<ApplyResult.Stale>(result);
        Assert.StartsWith("lunch/app changed since this plan was made.", stale.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Apply_that_fails_partway()
    {
        var result = await Answering("apply plan.json --yes --json", "apply-failed.json", exitCode: 1).ApplyAsync("plan.json", None);

        var failed = Assert.IsType<ApplyResult.PartlyApplied>(result);
        Assert.StartsWith("Failed to update repository settings", failed.Message, StringComparison.Ordinal);
        Assert.Empty(failed.Changes);
        Assert.Equal("repository settings", failed.Failed?.Target);
    }

    [Fact]
    public async Task Apply_that_fails_after_some_changes()
    {
        var result = await Answering("apply plan.json --yes --json", "apply-partway.json", exitCode: 1).ApplyAsync("plan.json", None);

        var failed = Assert.IsType<ApplyResult.PartlyApplied>(result);
        Assert.Equal(["repository settings", "merge methods"], failed.Changes.Select(change => change.Target));
        Assert.Equal("workflow permissions", failed.Failed?.Target);
    }

    [Fact]
    public async Task Sync()
    {
        var sync = await Answering("sync profiles --json", "sync.json").SyncAsync("profiles", null, null, null, null, None);

        Assert.Equal(("lunch/config", "", "main"), (sync.Repository, sync.Path, sync.Branch));
        Assert.NotNull(sync.Commit);
        Assert.Empty(sync.Pulled);
        Assert.Equal(["base.yaml"], sync.Pushed);
        Assert.Empty(sync.Conflicts);
    }

    [Fact]
    public async Task Sync_with_a_conflict()
    {
        var sync = await Answering("sync profiles --json", "sync-conflict.json", exitCode: 1).SyncAsync("profiles", null, null, null, null, None);

        Assert.Empty(sync.Pushed);
        Assert.Equal(["base.yaml"], sync.Conflicts);
    }

    [Fact]
    public async Task Staged_apply()
    {
        var staged = await Answering("stage staged.yaml --json", "stage.json").StagedAsync("staged.yaml", None);

        Assert.Equal("lunch/app", staged.Repository);
        Assert.Equal("<tests>/staged-base.yaml", staged.Base);
        Assert.Empty(staged.Exclude);
        Assert.Equal(["<tests>/staged.yaml", "<tests>/staged-base.yaml"], staged.Layers.Chain);
        Assert.Equal(JsonValueKind.Object, staged.Layers.Values.GetProperty("repository").ValueKind);
        Assert.Equal("<tests>/staged-base.yaml", staged.Layers.Sources["repository"]["has_wiki"]);
    }

    [Fact]
    public async Task Staged_plan()
    {
        var plan = await Answering("plan --staged=staged.yaml --out=plan.json --json", "staged-plan.json")
            .PlanStagedAsync("staged.yaml", "plan.json", None);

        Assert.Equal(
            ("<tests>/staged.yaml", "lunch/app", "<tests>/staged-base.yaml"),
            (plan.Staged.File, plan.Staged.Repository, plan.Staged.Base));
        Assert.Equal(["repository.has_issues"], plan.Staged.Exclude);
        Assert.Equal(
            [
                new PlanExclusionDocument(0, "has_projects", "repository.has_projects", true),
                new PlanExclusionDocument(0, "has_wiki", "repository.has_wiki", false),
            ],
            plan.Exclusions);
    }

    [Fact]
    public async Task Staged_plan_that_leaves_out_drafts()
    {
        var plan = await Answering("plan --staged=staged.yaml --out=plan.json --json", "staged-plan-skipped.json")
            .PlanStagedAsync("staged.yaml", "plan.json", None);

        Assert.Equal([new SkippedDocument("repository", "has_projects")], plan.Skipped);
    }

    [Fact]
    public async Task Batch()
    {
        var batch = await Answering("stage batch --json", "batch.json").BatchAsync("batch", None);

        Assert.Equal(("<batch>/batch", "<id>", "<batch>/profile.yaml"), (batch.Folder, batch.Id, batch.Profile));
        Assert.Equal(
            [
                new BatchMemberDocument("lunch/app", "<batch>/batch/lunch/app.yaml", false, false),
                new BatchMemberDocument("lunch/web", "<batch>/batch/lunch/web.yaml", false, false),
            ],
            batch.Members);
    }

    [Fact]
    public async Task Batch_exclusion_everywhere()
    {
        var everywhere = await Answering("stage batch --exclude=repository.has_wiki --everywhere --json", "batch-everywhere.json")
            .ExcludeEverywhereAsync("batch", "repository.has_wiki", true, None);

        Assert.Equal(2, everywhere.Members.Count);
        Assert.Equal(["lunch/app", "lunch/web"], everywhere.Changed);
        Assert.Empty(everywhere.Refused);
    }

    [Fact]
    public async Task Batch_plan()
    {
        var plan = await Answering("plan --staged=batch --out=plans.json --json", "batch-plan.json").PlanBatchAsync("batch", "plans.json", None);

        Assert.Equal(("<batch>/batch", "<id>"), (plan.Batch, plan.Id));
        Assert.Equal(["lunch/app", "lunch/web"], plan.Plans.Select(member => member.Repository));
        Assert.Equal("<batch>/batch/lunch/web.yaml", plan.Plans[1].File);
        Assert.Equal(64, plan.Plans[1].Digest.Length);
        Assert.Equal(["has_projects"], plan.Plans[1].Changes.Single().Fields.Select(field => field.Field));
        Assert.Equal(["repository.has_wiki"], plan.Plans[0].Staged.Exclude);
        Assert.Empty(plan.LeftOut);
        Assert.Empty(plan.Failures);
    }

    [Fact]
    public async Task Batch_apply()
    {
        var inLine = await new RepottedClient(new FakeCli().On("apply plans.json --only=lunch/app --yes --json", Only("batch-apply.json", 0)))
            .ApplyBatchMemberAsync("plans.json", "lunch/app", None);
        var applied = await new RepottedClient(new FakeCli().On("apply plans.json --only=lunch/web --yes --json", Only("batch-apply.json", 1)))
            .ApplyBatchMemberAsync("plans.json", "lunch/web", None);

        Assert.Equal(("lunch/app", "in_line", true), (inLine.Repository, inLine.Status, inLine.Ended));
        Assert.Equal(("lunch/web", "applied", true), (applied.Repository, applied.Status, applied.Ended));
        Assert.Equal("has_projects", applied.Applied?.Single().Fields.Single().Field);
    }

    [Fact]
    public async Task Batch_apply_that_fails_and_stops()
    {
        var failed = await new RepottedClient(new FakeCli().On("apply plans.json --only=lunch/app --yes --json", Only("batch-apply-stopped.json", 0), 1))
            .ApplyBatchMemberAsync("plans.json", "lunch/app", None);
        var stopped = await new RepottedClient(new FakeCli().On("apply plans.json --only=lunch/web --yes --json", Only("batch-apply-stopped.json", 1), 1))
            .ApplyBatchMemberAsync("plans.json", "lunch/web", None);

        Assert.Equal(("apply_failed", false), (failed.Status, failed.Ended));
        Assert.StartsWith("Failed to update repository settings", failed.Message, StringComparison.Ordinal);
        Assert.Equal("repository settings", failed.Failed?.Target);
        Assert.Equal("Validation failed", failed.Reason);
        Assert.Equal(("stopped", false), (stopped.Status, stopped.Ended));
    }
}
