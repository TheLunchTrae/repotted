using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Styling;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;
using Repotted.Desktop.Views;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>
/// The batch page's transitions, as docs/developer/state-machines.md lists
/// them, against a fake CLI that keeps a batch as <c>stage</c>, <c>plan
/// --staged</c> and <c>apply --only</c> would, files included.
/// </summary>
public sealed class BatchTests : IDisposable
{
    private const string Repotted = "TheLunchTrae/repotted";

    private const string TestRepo = "TheLunchTrae/test-repo";

    private readonly Folders folders = new();

    private readonly string @base;

    public BatchTests() => @base = folders.Write("orgs.yaml", "repository: { has_wiki: false }\nrulesets: [{ name: Main }]\n");

    public void Dispose() => folders.Dispose();

    private AppSettings Settings => folders.Settings;

    private ProfileListingDocument Orgs => new("orgs", @base, null, null);

    /// <summary>One repository of the fake batch.</summary>
    private sealed class Member(string repository, string file, bool joined)
    {
        public string Repository { get; } = repository;

        public string File { get; } = file;

        public bool Joined { get; } = joined;

        public bool LeftOut { get; set; }

        public HashSet<string> Excluded { get; } = [];

        /// <summary>How its plan comes out: changes, in_line, locked or failed.</summary>
        public string Plan { get; set; } = "changes";

        /// <summary>How its apply comes out, as <c>apply --only</c> prints the status.</summary>
        public string Result { get; set; } = "applied";

        /// <summary>Whether a finished apply lets it go from the batch, which can fail after the writes.</summary>
        public bool Ends { get; set; } = true;
    }

    /// <summary>The batch as the fake CLI keeps it, with the answers to every command that reads or changes it.</summary>
    private sealed class World
    {
        private readonly BatchTests tests;

        public World(BatchTests tests, params string[] repositories)
        {
            this.tests = tests;
            Repositories = repositories;
            Cli = FakeCli.SignedIn()
                .On(tests.folders.List(), $$"""{"profiles":[{"name":"orgs","file":{{Json(tests.@base)}},"extends":null,"problem":null}]}""")
                .On($"profile {tests.@base} --json", tests.Base())
                .On($"stage {Folder} --json", BatchDocument)
                .On($"plan --staged={Folder} --out={PlanFile} --json", Planned)
                .On($"stage {Folder} --discard --json", Discarded);
            OnStart(repositories, []);
            foreach (var repository in new[] { Repotted, TestRepo })
            {
                var file = tests.Settings.StagedFile(repository);
                Cli.On($"apply {PlanFile} --only={repository} --yes --json", () => Applied(repository))
                    .On($"stage {Folder} --leave-out={repository} --json", () => Leave(repository, true))
                    .On($"stage {Folder} --put-back={repository} --json", () => Leave(repository, false))
                    .On($"stage {file} --json", () => tests.Staged(Find(repository)))
                    .On($"stage {file} --exclude=rulesets/Main --json", () => Exclude(repository, "rulesets/Main", true))
                    .On($"stage {file} --include=rulesets/Main --json", () => Exclude(repository, "rulesets/Main", false));
            }
            foreach (var key in new[] { "repository.has_wiki", "rulesets/Main" })
            {
                Cli.On($"stage {Folder} --exclude={key} --everywhere --json", () => Everywhere(key, true))
                    .On($"stage {Folder} --include={key} --everywhere --json", () => Everywhere(key, false));
            }
        }

        public IReadOnlyList<string> Repositories { get; }

        public FakeCli Cli { get; }

        public List<Member> Members { get; } = [];

        public string Folder => tests.Settings.BatchFolder;

        public string PlanFile => tests.Settings.BatchPlanFile;

        /// <summary>Runs once the batch starts, such as to say how a repository's plan comes out.</summary>
        public Action? AfterStart { get; set; }

        /// <summary>A repository whose one-off edits set what a change to every repository names, so it keeps them.</summary>
        public string? Refuses { get; set; }

        public string StartCommand(IEnumerable<string> fresh, IEnumerable<string> join) =>
            string.Join(' ', new[] { "stage", Folder, "--batch" }
                .Concat(fresh.Any() ? [$"--staged-dir={tests.Settings.StagedFolder}"] : [])
                .Concat(fresh.Select(repository => $"--new={repository}"))
                .Concat(join.Select(repository => $"--join={tests.Settings.StagedFile(repository)}"))
                .Append($"--profile={tests.@base}")
                .Append("--json"));

        /// <summary>Answers a start of the batch with <paramref name="fresh"/> new and <paramref name="join"/> joined, writing its files.</summary>
        public void OnStart(IReadOnlyList<string> fresh, IReadOnlyList<string> join) =>
            Cli.On(StartCommand(fresh, join), () =>
            {
                Directory.CreateDirectory(Folder);
                System.IO.File.WriteAllText(Path.Combine(Folder, "batch.yaml"), "id: test\n");
                Members.Clear();
                foreach (var repository in join.Concat(fresh))
                {
                    var file = tests.Settings.StagedFile(repository);
                    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                    System.IO.File.WriteAllText(file, $"apply_to: {repository}\n");
                    Members.Add(new Member(repository, file, join.Contains(repository)));
                }
                // As the CLI does, the batch lists the staged applies that joined it first.
                AfterStart?.Invoke();
                return BatchDocument();
            });

        public Member Find(string repository) => Members.Single(member => member.Repository == repository);

        public string BatchDocument() =>
            $$"""
            {"folder":{{Json(Folder)}},"id":"test","profile":{{Json(tests.@base)}},
             "members":[{{string.Join(',', Members.Select(member =>
                 $$"""{"repository":"{{member.Repository}}","file":{{Json(member.File)}},"left_out":{{Bool(member.LeftOut)}},"joined":{{Bool(member.Joined)}}}"""))}}]}
            """;

        private string Planned()
        {
            System.IO.File.WriteAllText(PlanFile, "{}");
            var planned = Members.Where(member => !member.LeftOut && member.Plan != "failed");
            return $$"""
                {"batch":{{Json(Folder)}},"id":"test","profile":{{Json(tests.@base)}},
                 "plans":[{{string.Join(',', planned.Select(tests.MemberPlan))}}],
                 "left_out":[{{string.Join(',', Members.Where(member => member.LeftOut).Select(member =>
                     $$"""{"repository":"{{member.Repository}}","file":{{Json(member.File)}}}"""))}}],
                 "failures":[{{string.Join(',', Members.Where(member => !member.LeftOut && member.Plan == "failed").Select(member =>
                     $$"""{"repository":"{{member.Repository}}","file":{{Json(member.File)}},"error":{"kind":"github","message":"The Repotted App is not installed on {{member.Repository}}.","status":404} }"""))}}]}
                """;
        }

        private string Applied(string repository)
        {
            var member = Find(repository);
            var status = member.Result;
            var ended = status is "applied" or "in_line" && member.Ends;
            if (ended)
            {
                System.IO.File.Delete(member.File);
                Members.Remove(member);
                if (Members.Count == 0)
                {
                    Directory.Delete(Folder, recursive: true);
                }
            }
            var extra = status switch
            {
                "applied" => $",\"applied\":[{WikiChange}]",
                "stale" => $",\"message\":\"{repository} changed since this plan was made.\"",
                "apply_failed" => $$""","message":"Failed to create Main after 1 of the plan's changes: boom\nAlready applied:\n  ~ update repository settings","applied":[{{WikiChange}}],"failed":{{MainChange}},"reason":"boom" """,
                _ => "",
            };
            return $$"""{"batch":{{Json(Folder)}},"results":[{"repository":"{{repository}}","status":"{{status}}","ended":{{Bool(ended)}}{{extra}}}]}""";
        }

        private string Leave(string repository, bool leftOut)
        {
            Find(repository).LeftOut = leftOut;
            return BatchDocument();
        }

        private string Exclude(string repository, string key, bool excluded)
        {
            var member = Find(repository);
            if (excluded)
            {
                member.Excluded.Add(key);
            }
            else
            {
                member.Excluded.Remove(key);
            }
            return tests.Staged(member);
        }

        private string Everywhere(string key, bool excluded)
        {
            List<string> changed = [];
            foreach (var member in Members.Where(member => member.Repository != Refuses))
            {
                if (excluded ? member.Excluded.Add(key) : member.Excluded.Remove(key))
                {
                    changed.Add(member.Repository);
                }
            }
            var refused = Refuses is { } name
                ? $$"""{"repository":"{{name}}","message":"Its one-off edits set {{key}}, so it keeps them."}"""
                : "";
            var document = BatchDocument();
            return $$"""{{document[..^1]}},"changed":[{{string.Join(',', changed.Select(Json))}}],"refused":[{{refused}}]}""";
        }

        private string Discarded()
        {
            foreach (var member in Members.Where(member => !member.Joined))
            {
                System.IO.File.Delete(member.File);
            }
            Members.Clear();
            Directory.Delete(Folder, recursive: true);
            return $$"""{"discarded":{{Json(Folder)}}}""";
        }

        private static string Bool(bool value) => value ? "true" : "false";
    }

    private const string WikiChange =
        """
        {"section":"repository","action":"update","target":"repository settings",
         "fields":[{"field":"has_wiki","from":true,"to":false}],
         "request":{"method":"PATCH","path":"/repos/o/r","body":{"has_wiki":false}}}
        """;

    private const string MainChange =
        """
        {"section":"rulesets","action":"create","target":"Main",
         "fields":[{"field":"name","to":"Main"}],
         "request":{"method":"POST","path":"/repos/o/r/rulesets","body":{}}}
        """;

    private string Base() =>
        $$"""
        {"chain":[{{Json(@base)}}],"profile":{"repository":{"has_wiki":false},"rulesets":[{"name":"Main"}] },
         {{Documents.NoDrafts}},
         "sources":{"repository":{"has_wiki":{{Json(@base)}} },
           "merge":{},"actions":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},"rulesets":{"Main":{{Json(@base)}} },"environments":{},
           {{Documents.NoDraftSources}} } }
        """;

    /// <summary>A member's staged apply as <c>stage &lt;file&gt; --json</c> prints it: the profile, less what it leaves out.</summary>
    private string Staged(Member member)
    {
        var wiki = member.Excluded.Contains("repository.has_wiki");
        var main = member.Excluded.Contains("rulesets/Main");
        return $$"""
            {"file":{{Json(member.File)}},"repository":"{{member.Repository}}","base":{{Json(@base)}},
             "exclude":[{{string.Join(',', member.Excluded.Select(Json))}}],"chain":[{{Json(member.File)}},{{Json(@base)}}],
             "profile":{"repository":{ {{(wiki ? "" : "\"has_wiki\":false")}} }{{(main ? "" : ",\"rulesets\":[{\"name\":\"Main\"}]")}} },
             {{Documents.NoDrafts}},
             "sources":{"repository":{ {{(wiki ? "" : $"\"has_wiki\":{Json(@base)}")}} },
               "merge":{},"actions":{},"security":{},"custom_properties":{},
               "pages":{},"autolinks":{},"rulesets":{ {{(main ? "" : $"\"Main\":{Json(@base)}")}} },"environments":{},
               {{Documents.NoDraftSources}} } }
            """;
    }

    /// <summary>A member's plan in a batch plan: the wiki and the Main ruleset, less what it leaves out.</summary>
    private string MemberPlan(Member member)
    {
        List<(string Change, string Key, string? Field)> changes = member.Plan == "in_line"
            ? []
            : [(WikiChange, "repository.has_wiki", "has_wiki"), (MainChange, "rulesets/Main", null)];
        changes.RemoveAll(change => member.Excluded.Contains(change.Key));
        var exclusions = changes.Select((change, index) =>
            $$"""{"change":{{index}},"field":{{Json(change.Field)}},"key":"{{change.Key}}","edited":false}""");
        var mainIndex = changes.FindIndex(change => change.Key == "rulesets/Main");
        var locks = member.Plan == "locked" && mainIndex >= 0 ? $$"""{"change":{{mainIndex}},"reason":"Needs Administration write"}""" : "";
        var access = member.Plan == "locked"
            ? """{"role":"admin","app":{"status":"installed","settings_url":"https://github.com/settings/installations/7"}}"""
            : Documents.Unknown;
        return $$"""
            {"repository":"{{member.Repository}}","desired":{"repository":{"has_wiki":false},"rulesets":[{"name":"Main"}] },
             "changes":[{{string.Join(',', changes.Select(change => change.Change))}}],
             "warnings":[],"access":{{access}},"locks":[{{locks}}],
             "staged":{"file":{{Json(member.File)}},"repository":"{{member.Repository}}","base":{{Json(@base)}},
               "exclude":[{{string.Join(',', member.Excluded.Select(Json))}}]},
             "exclusions":[{{string.Join(',', exclusions)}}],"skipped":[],
             "file":{{Json(member.File)}},"digest":"abc"}
            """;
    }

    private sealed class Page(BatchViewModel batch)
    {
        public BatchViewModel Batch { get; } = batch;

        public int Closed { get; set; }
    }

    private Page Open(World world, IReadOnlyList<string>? repositories = null, IDesktop? desktop = null)
    {
        Page? page = null;
        var batch = new BatchViewModel(
            new RepottedClient(world.Cli), Settings, repositories ?? world.Repositories, Orgs, () => page!.Closed++, desktop);
        page = new Page(batch);
        return page;
    }

    private async Task<(World World, Page Page)> Reviewing(params string[] repositories)
    {
        var world = new World(this, repositories.Length == 0 ? [Repotted, TestRepo] : repositories);
        var page = Open(world);
        await page.Batch.OpenAsync();
        await Until(() => page.Batch.Step == BatchStep.Reviewing);
        return (world, page);
    }

    private static BatchMemberViewModel MemberOf(BatchViewModel batch, string repository) =>
        batch.Members.Single(member => member.Repository == repository);

    private static CompareRow Row(BatchMemberViewModel member, string key) =>
        member.Review!.Sections.SelectMany(section => section.Differences).First(row => row.LeaveOut?.Key == key);

    [AvaloniaFact]
    public async Task A_new_batch_stages_each_repository_and_shows_every_plan()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;

        Assert.Contains(world.StartCommand([Repotted, TestRepo], []), world.Cli.Calls);
        Assert.True(Settings.HasBatch);
        Assert.Equal("orgs", batch.ProfileName);
        Assert.Equal("Starts each repository from orgs. Nothing changes on GitHub until you apply.", batch.Summary);
        Assert.Equal([Repotted, TestRepo], batch.Members.Select(member => member.Repository));
        Assert.IsType<AllRepositoriesViewModel>(batch.Entries[0]);
        Assert.Same(batch.All, batch.Selected);
        Assert.Equal("4 changes in 2 repositories", batch.All.Summary);
        Assert.Equal(
            [("repository.has_wiki", "Repository settings: has_wiki", 2), ("rulesets/Main", "Create Main", 2)],
            batch.All.Changes.Select(change => (change.Key, change.What, change.Repositories)));
        Assert.All(batch.Members, member => Assert.Equal("2 changes", member.Status));
        Assert.Equal("Apply to 2 repositories", batch.ApplyLabel);
        Assert.Equal("Write 4 changes to 2 repositories on GitHub now?", batch.ConfirmMessage);
        Assert.True(batch.ApplyCommand.CanExecute(null));
        Assert.True(batch.CanLeave);
        // Nothing is written to GitHub before a confirmed apply.
        Assert.DoesNotContain(world.Cli.Calls, call => call.StartsWith("apply ", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public async Task A_repository_with_an_unfinished_apply_joins_the_batch_as_it_is()
    {
        var world = new World(this, Repotted, TestRepo);
        var file = Settings.StagedFile(TestRepo);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, $"apply_to: {TestRepo}\n");
        world.OnStart([Repotted], [TestRepo]);
        var page = Open(world);

        await page.Batch.OpenAsync();
        await Until(() => page.Batch.Step == BatchStep.Reviewing);

        Assert.Contains(world.StartCommand([Repotted], [TestRepo]), world.Cli.Calls);
        Assert.True(MemberOf(page.Batch, TestRepo).Joined);
        Assert.False(MemberOf(page.Batch, Repotted).Joined);
        Assert.Equal($"{TestRepo} had an apply that wasn't finished, so it joined the batch as it was.", page.Batch.Notice);
    }

    [AvaloniaFact]
    public async Task An_unfinished_batch_waits_to_be_resumed_or_started_over()
    {
        var (world, first) = await Reviewing();
        first.Batch.CloseCommand.Execute(null);
        Assert.Equal(1, first.Closed);

        // Opened again with repositories chosen, it asks first.
        var again = Open(world, [Repotted]);
        await again.Batch.OpenAsync();
        Assert.Equal(BatchStep.Unfinished, again.Batch.Step);
        Assert.Equal(
            "A batch apply to 2 repositories from orgs is not finished. Resume it, or start over with the 1 repository you chose?",
            again.Batch.UnfinishedMessage);

        // Starting over discards the batch, then starts one with the repositories chosen.
        world.OnStart([Repotted], []);
        await again.Batch.StartOverCommand.ExecuteAsync(null);
        await Until(() => again.Batch.Step == BatchStep.Reviewing);
        Assert.Contains($"stage {world.Folder} --discard --json", world.Cli.Calls);
        Assert.Equal([Repotted], again.Batch.Members.Select(member => member.Repository));

        // Opened with none chosen, as Resume opens it, it plans the batch there at once.
        var resumed = Open(world, []);
        await resumed.Batch.OpenAsync();
        await Until(() => resumed.Batch.Step == BatchStep.Reviewing);
        Assert.Equal([Repotted], resumed.Batch.Members.Select(member => member.Repository));
    }

    [AvaloniaFact]
    public async Task A_change_left_out_everywhere_is_planned_again_and_says_who_kept_it()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        world.Refuses = TestRepo;

        await batch.LeaveOutEverywhereCommand.ExecuteAsync(batch.All.Changes.Single(change => change.Key == "rulesets/Main"));

        Assert.Contains($"stage {world.Folder} --exclude=rulesets/Main --everywhere --json", world.Cli.Calls);
        Assert.Equal(BatchStep.Reviewing, batch.Step);
        Assert.Equal("1 change", MemberOf(batch, Repotted).Status);
        Assert.Equal("2 changes", MemberOf(batch, TestRepo).Status);
        Assert.Equal($"{TestRepo} kept it: Its one-off edits set rulesets/Main, so it keeps them.", batch.Notice);
        Assert.Equal(("rulesets/Main", 1), batch.All.Excluded.Select(change => (change.Key, change.Repositories)).Single());

        world.Refuses = null;
        await batch.PutBackEverywhereCommand.ExecuteAsync(batch.All.Excluded.Single());
        Assert.All(batch.Members, member => Assert.Equal("2 changes", member.Status));
        Assert.Null(batch.Notice);
    }

    [AvaloniaFact]
    public async Task A_repository_left_out_or_its_change_left_out_changes_what_the_apply_writes()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        var repotted = MemberOf(batch, Repotted);
        batch.Selected = repotted;
        Assert.Equal("1 of 2", batch.Position);

        await batch.LeaveOutCommand.ExecuteAsync(Row(repotted, "rulesets/Main"));
        Assert.Contains($"stage {repotted.File} --exclude=rulesets/Main --json", world.Cli.Calls);
        Assert.Equal("1 change", repotted.Status);
        Assert.Same(repotted, batch.Selected);

        await batch.IncludeCommand.ExecuteAsync(MemberOf(batch, TestRepo));
        Assert.Contains($"stage {world.Folder} --leave-out={TestRepo} --json", world.Cli.Calls);
        Assert.Equal("Left out", MemberOf(batch, TestRepo).Status);
        Assert.False(MemberOf(batch, TestRepo).Included);
        Assert.Equal("Apply to 1 repository", batch.ApplyLabel);
        Assert.Equal("Write 1 change to 1 repository on GitHub now?", batch.ConfirmMessage);

        await batch.IncludeCommand.ExecuteAsync(MemberOf(batch, TestRepo));
        Assert.Contains($"stage {world.Folder} --put-back={TestRepo} --json", world.Cli.Calls);
        Assert.Equal("2 changes", MemberOf(batch, TestRepo).Status);
    }

    [AvaloniaFact]
    public async Task A_repository_that_cannot_be_planned_or_waits_for_access_is_not_applied()
    {
        var world = new World(this, Repotted, TestRepo);
        var page = Open(world);
        world.AfterStart = () =>
        {
            world.Find(Repotted).Plan = "failed";
            world.Find(TestRepo).Plan = "locked";
        };
        await page.Batch.OpenAsync();
        await Until(() => page.Batch.Step == BatchStep.Reviewing);
        var batch = page.Batch;

        Assert.Equal("Couldn't compare", MemberOf(batch, Repotted).Status);
        Assert.Equal($"The Repotted App is not installed on {Repotted}.", MemberOf(batch, Repotted).Problem);
        Assert.Equal("Needs access", MemberOf(batch, TestRepo).Status);
        Assert.True(batch.HasLocked);
        Assert.Equal("Nothing to apply", batch.ApplyLabel);
        Assert.False(batch.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Unsaved_one_off_edits_hold_the_apply_and_leaving_until_they_are_undone()
    {
        var (_, page) = await Reviewing();
        var batch = page.Batch;
        var repotted = MemberOf(batch, Repotted);
        batch.Selected = repotted;
        await Until(() => repotted.Edits is { Loading: false });
        var edits = repotted.Edits!;
        Assert.Equal("Save edits", edits.SaveLabel);

        edits.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_issues")
            .Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        Assert.True(batch.EditsUnsaved);
        Assert.False(batch.CanLeave);
        Assert.False(batch.ApplyCommand.CanExecute(null));
        Assert.False(batch.LeaveOutEverywhereCommand.CanExecute(batch.All.Changes[0]));

        // Leaving waits on a question, and the repository with the edits comes on screen.
        batch.Selected = batch.All;
        var leaving = batch.ConfirmLeaveAsync("quit");
        Assert.Equal("To quit, save or undo your one-off edits first.", batch.LeavingMessage);
        Assert.Same(repotted, batch.Selected);
        Assert.Equal(1, batch.Tab);

        edits.DiscardCommand.Execute(null);
        Assert.True(await leaving);
        Assert.True(batch.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task The_apply_writes_one_repository_at_a_time_and_lists_what_did_not_finish_first()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        world.Find(Repotted).Result = "stale";

        batch.ApplyCommand.Execute(null);
        Assert.Equal(BatchStep.Confirming, batch.Step);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(BatchStep.Done, batch.Step);
        Assert.Equal(
            [$"apply {world.PlanFile} --only={Repotted} --yes --json", $"apply {world.PlanFile} --only={TestRepo} --yes --json"],
            world.Cli.Calls.Where(call => call.StartsWith("apply ", StringComparison.Ordinal)));
        Assert.Equal("Changed on GitHub since the review, so nothing was written.", Assert.Single(batch.Unfinished).Result);
        Assert.Equal("Applied 1 change.", Assert.Single(batch.Finished).Result);
        Assert.Equal("Some repositories didn't finish. Their staged applies stay, to review again.", batch.Summary);

        // Reviewing again plans what is left, which is the one that didn't finish.
        Assert.True(batch.ReviewAgainCommand.CanExecute(null));
        await batch.ReviewAgainCommand.ExecuteAsync(null);
        Assert.Equal(BatchStep.Reviewing, batch.Step);
        Assert.Equal([Repotted], batch.Members.Select(member => member.Repository));
    }

    [AvaloniaFact]
    public async Task A_batch_whose_last_repository_finishes_ends()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        world.Find(TestRepo).Result = "apply_failed";
        world.Find(Repotted).Result = "in_line";

        batch.ApplyCommand.Execute(null);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);
        Assert.Equal("Already in line, so nothing was written.", MemberOf(batch, Repotted).Result);
        Assert.Equal(
            "Applied 1 change, then stopped. Failed to create Main after 1 of the plan's changes: boom. Nothing after it was written.",
            MemberOf(batch, TestRepo).Result);
        Assert.True(Settings.HasBatch);

        world.Find(TestRepo).Result = "applied";
        await batch.ReviewAgainCommand.ExecuteAsync(null);
        batch.ApplyCommand.Execute(null);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);
        Assert.Equal("The batch is finished.", batch.Summary);
        Assert.False(Settings.HasBatch);
        Assert.False(File.Exists(Settings.BatchPlanFile));
        Assert.False(batch.ReviewAgainCommand.CanExecute(null));
        Assert.False(batch.BatchRemains);
        // The staged applies it ended left no empty folder behind.
        Assert.Empty(Directory.EnumerateFileSystemEntries(Settings.StagedFolder));
    }

    [AvaloniaFact]
    public async Task A_batch_where_every_repository_joins_starts_without_new_staged_applies()
    {
        var world = new World(this, Repotted, TestRepo);
        foreach (var repository in new[] { Repotted, TestRepo })
        {
            var file = Settings.StagedFile(repository);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, $"apply_to: {repository}\n");
            File.WriteAllText(AppSettings.PlanFile(file), "{}");
        }
        world.OnStart([], [Repotted, TestRepo]);
        var page = Open(world);

        await page.Batch.OpenAsync();
        await Until(() => page.Batch.Step == BatchStep.Reviewing);

        var start = Assert.Single(world.Cli.Calls, call => call.Contains("--batch", StringComparison.Ordinal));
        Assert.DoesNotContain("--staged-dir", start, StringComparison.Ordinal);
        Assert.All(page.Batch.Members, member => Assert.True(member.Joined));
        // Each joined apply's own plan goes, since the batch plans it from now on.
        Assert.All([Repotted, TestRepo], repository => Assert.False(File.Exists(AppSettings.PlanFile(Settings.StagedFile(repository)))));
        Assert.Equal("Starts each new repository from orgs. Nothing changes on GitHub until you apply.", page.Batch.Summary);
    }

    [AvaloniaFact]
    public async Task Repositories_not_in_the_apply_keep_the_batch_to_review_again()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        await batch.IncludeCommand.ExecuteAsync(MemberOf(batch, TestRepo));

        batch.ApplyCommand.Execute(null);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(BatchStep.Done, batch.Step);
        Assert.False(batch.HasUnfinished);
        Assert.Equal(TestRepo, Assert.Single(batch.NotApplied).Repository);
        Assert.True(batch.BatchRemains);
        Assert.True(batch.OnlyNotAppliedRemain);
        Assert.Equal("The repositories that weren't in this apply stay in the batch, to review again.", batch.Summary);
        Assert.True(batch.ReviewAgainCommand.CanExecute(null));
        Assert.True(batch.DiscardCommand.CanExecute(null));

        await batch.ReviewAgainCommand.ExecuteAsync(null);
        Assert.Equal(BatchStep.Reviewing, batch.Step);
        Assert.Equal("Left out", Assert.Single(batch.Members).Status);
    }

    [AvaloniaFact]
    public async Task An_applied_repository_the_batch_could_not_let_go_stays_to_review_again()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        world.Find(Repotted).Ends = false;

        batch.ApplyCommand.Execute(null);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);

        var repotted = MemberOf(batch, Repotted);
        Assert.Equal(MemberOutcome.Unfinished, repotted.Outcome);
        Assert.Equal("Applied 1 change, but its staged apply stays in the batch, so review it again.", repotted.Result);
        Assert.Equal(MemberOutcome.Finished, MemberOf(batch, TestRepo).Outcome);
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_stops_the_apply_at_the_repository_it_reached()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;
        world.Cli.On($"apply {world.PlanFile} --only={Repotted} --yes --json",
            $$"""{"batch":{{Json(world.Folder)}},"results":[{"repository":"{{Repotted}}","status":"failed","ended":false,"error":{"kind":"signed_out","message":"GitHub no longer accepts the sign-in.","status":401} }]}""");

        batch.ApplyCommand.Execute(null);
        await batch.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.StartsWith("GitHub no longer accepts the sign-in.", MemberOf(batch, Repotted).Result, StringComparison.Ordinal);
        Assert.Equal("Not applied, since the apply stopped before it.", MemberOf(batch, TestRepo).Result);
        Assert.DoesNotContain($"apply {world.PlanFile} --only={TestRepo} --yes --json", world.Cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_change_reads_the_open_one_off_edits_again_and_keeps_the_tab()
    {
        var (_, page) = await Reviewing();
        var batch = page.Batch;
        var repotted = MemberOf(batch, Repotted);
        batch.Selected = repotted;
        await Until(() => repotted.Edits is { Loading: false });
        var before = repotted.Edits;

        await batch.LeaveOutCommand.ExecuteAsync(Row(repotted, "rulesets/Main"));
        await Until(() => repotted.Edits is { Loading: false });
        Assert.NotSame(before, repotted.Edits);

        // A plan again, such as after saving the edits, keeps the repository's tab.
        batch.Tab = 1;
        await batch.ReviewAgainCommand.ExecuteAsync(null);
        Assert.Same(repotted, batch.Selected);
        Assert.Equal(1, batch.Tab);
    }

    [AvaloniaFact]
    public async Task A_batch_the_cli_cannot_read_can_still_be_started_over()
    {
        var world = new World(this, Repotted);
        Directory.CreateDirectory(world.Folder);
        File.WriteAllText(Path.Combine(world.Folder, "batch.yaml"), "not: [a batch\n");
        const string Unreadable = """{"error":{"kind":"error","message":"Cannot read the batch."}}""";
        // The batch reads again once a new one starts in its place.
        var broken = true;
        world.AfterStart = () => broken = false;
        world.Cli.On($"stage {world.Folder} --json", () => broken ? Unreadable : world.BatchDocument())
            .On($"stage {world.Folder} --discard --json", Unreadable, exitCode: 1);
        var page = Open(world, [Repotted]);

        await page.Batch.OpenAsync();
        Assert.Equal(BatchStep.Unfinished, page.Batch.Step);
        world.OnStart([Repotted], []);
        await page.Batch.StartOverCommand.ExecuteAsync(null);
        await Until(() => page.Batch.Step == BatchStep.Reviewing);

        Assert.StartsWith("Repotted couldn't read the batch, so it removed it as it was.", page.Batch.Notice, StringComparison.Ordinal);
        Assert.Equal([Repotted], page.Batch.Members.Select(member => member.Repository));
    }

    [AvaloniaFact]
    public async Task Stopping_finishes_the_repository_it_writes_to_and_leaves_the_rest()
    {
        var world = new World(this, Repotted, TestRepo);
        var written = new TaskCompletionSource();
        var page = Open(world);
        await page.Batch.OpenAsync();
        await Until(() => page.Batch.Step == BatchStep.Reviewing);
        var batch = page.Batch;
        world.Cli.On($"apply {world.PlanFile} --only={Repotted} --yes --json", async _ =>
        {
            await written.Task;
            world.Members.Remove(world.Find(Repotted));
            return $$"""{"batch":{{Json(world.Folder)}},"results":[{"repository":"{{Repotted}}","status":"applied","ended":true,"applied":[{{WikiChange}}]}]}""";
        });

        batch.ApplyCommand.Execute(null);
        var applying = batch.ConfirmApplyCommand.ExecuteAsync(null);
        Assert.Equal(BatchStep.Applying, batch.Step);
        Assert.Equal("Applying now", MemberOf(batch, Repotted).Progress);
        Assert.Equal("Waiting", MemberOf(batch, TestRepo).Progress);
        Assert.False(batch.CanLeave);
        batch.StopCommand.Execute(null);
        Assert.False(batch.StopCommand.CanExecute(null));
        written.SetResult();
        await applying;

        Assert.Equal(BatchStep.Done, batch.Step);
        Assert.Equal("Applied 1 change.", MemberOf(batch, Repotted).Result);
        Assert.Equal("Not applied, since the apply stopped before it.", MemberOf(batch, TestRepo).Result);
        Assert.DoesNotContain($"apply {world.PlanFile} --only={TestRepo} --yes --json", world.Cli.Calls);
    }

    [AvaloniaFact]
    public async Task Discarding_asks_first_then_removes_the_batch_and_closes()
    {
        var (world, page) = await Reviewing();
        var batch = page.Batch;

        batch.DiscardCommand.Execute(null);
        Assert.Equal(BatchStep.ConfirmingDiscard, batch.Step);
        Assert.True(batch.ShowReview);
        batch.KeepCommand.Execute(null);
        Assert.Equal(BatchStep.Reviewing, batch.Step);

        batch.DiscardCommand.Execute(null);
        var discarding = batch.ConfirmDiscardCommand.ExecuteAsync(null);
        Assert.False(batch.KeepCommand.CanExecute(null));
        await discarding;
        Assert.Equal(BatchStep.Discarded, batch.Step);
        Assert.Equal(1, page.Closed);
        Assert.False(Settings.HasBatch);
        Assert.Contains($"stage {world.Folder} --discard --json", world.Cli.Calls);
    }

    public static TheoryData<string> Themes => ["light", "dark"];

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Choosing_several_repositories_opens_a_batch_review_with_each_one_on_its_own(string theme)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        var world = new World(this, Repotted, TestRepo);
        var main = new MainViewModel(world.Cli, new FakeDesktop(), Settings);
        var window = new MainWindow { DataContext = main, Width = 1280, Height = 800 };
        window.Show();
        await main.StartAsync();
        Dispatcher.UIThread.RunJobs();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        await Until(() => shell.Profiles.Usable.Any() && !shell.Profiles.Loading && !shell.Profiles.Folder.Syncing);
        var repositories = shell.Repositories;

        // Ticking two rows chooses both, and the panel offers a batch apply in place of one repository's details.
        var list = window.GetVisualDescendants().OfType<ListBox>().Single(box => box.Name == "List");
        list.Selection.Select(1);
        list.Selection.Select(2);
        list.Selection.Deselect(0);
        Dispatcher.UIThread.RunJobs();
        Assert.True(repositories.Choosing);
        Assert.False(repositories.HasSelection);
        var text = Texts(window);
        Assert.Contains("2 repositories selected", text);
        Assert.Contains(ControlLabel.For("Review apply"), text);
        Save(window, $"batch-picker-{theme}");

        repositories.ReviewBatchCommand.Execute(null);
        await Until(() => shell.Batch?.Step == BatchStep.Reviewing);
        var batch = shell.Batch!;
        Assert.True(shell.ShowingBatch);
        Assert.Equal($"Repositories / {ControlLabel.For("Batch apply")}", shell.Crumb);
        text = Texts(window);
        Assert.Contains("All repositories", text);
        Assert.Contains(ControlLabel.For("Leave out everywhere"), text);
        Save(window, $"batch-overview-{theme}");

        batch.Selected = MemberOf(batch, TestRepo);
        Dispatcher.UIThread.RunJobs();
        text = Texts(window);
        Assert.Contains("2 changes to TheLunchTrae/test-repo, in 2 sections.", text);
        Assert.Contains("2 of 2", text);
        Save(window, $"batch-repository-{theme}");

        batch.ApplyCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("Write 4 changes to 2 repositories on GitHub now?", Texts(window));
        Save(window, $"batch-confirm-{theme}");
        world.Find(Repotted).Result = "stale";
        await batch.ConfirmApplyCommand.ExecuteAsync(null);
        text = Texts(window);
        Assert.Contains("Didn't finish", text);
        Assert.Contains("Finished", text);
        Save(window, $"batch-results-{theme}");

        // Back on the list, an apply to a repository of the batch opens the batch.
        batch.CloseCommand.Execute(null);
        Assert.Null(shell.Batch);
        Assert.True(repositories.HasUnfinishedBatch);
        repositories.Chosen = [repositories.Rows.Single(row => row.FullName == Repotted)];
        repositories.Selected = repositories.Rows.Single(row => row.FullName == Repotted);
        repositories.ResumeApplyCommand.Execute(null);
        await Until(() => shell.Batch?.Step == BatchStep.Reviewing);
        Assert.Null(shell.Apply);
        window.Close();
    }
}
