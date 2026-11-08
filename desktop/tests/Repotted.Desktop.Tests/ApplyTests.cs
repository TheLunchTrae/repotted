using System.Text.Json;
using Avalonia;
using Avalonia.Automation.Peers;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
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
/// The Apply page's transitions, as docs/developer/state-machines.md lists
/// them, against canned CLI output in the shape <c>stage</c>, <c>plan
/// --staged</c> and <c>apply</c> print it.
/// </summary>
public sealed class ApplyTests : IDisposable
{
    private const string Repository = "TheLunchTrae/repotted";

    private readonly Folders folders = new();

    private readonly string file;

    private readonly string plan;

    private readonly string @base;

    public ApplyTests()
    {
        file = folders.Settings.StagedFile(Repository);
        plan = AppSettings.PlanFile(file);
        @base = folders.Write("orgs.yaml", "repository: { has_issues: true, has_wiki: false }\n");
    }

    public void Dispose() => folders.Dispose();

    private static string List(IEnumerable<string> keys) => $"[{string.Join(',', keys.Select(key => Json(key)))}]";

    /// <summary>
    /// A staged apply over orgs, which sets issues and the wiki; the staged
    /// file turns squash merges off. A wiki left out is gone from it.
    /// </summary>
    private string Staged(bool fromProfile = true, params string[] exclude)
    {
        var from = fromProfile ? @base : file;
        var chain = fromProfile ? $"[{Json(file)},{Json(@base)}]" : $"[{Json(file)}]";
        var (wikiValue, wikiSource) = !exclude.Contains("repository.has_wiki") ? (",\"has_wiki\":false", $",\"has_wiki\":{Json(from)}") : ("", "");
        return $$"""
            {"file":{{Json(file)}},"repository":"{{Repository}}","base":{{(fromProfile ? Json(@base) : "null")}},
             "exclude":{{List(exclude)}},"chain":{{chain}},
             "profile":{"repository":{"has_issues":true{{wikiValue}} },"merge":{"allow_squash_merge":false} },
             {{Documents.NoDrafts}},
             "sources":{"repository":{"has_issues":{{Json(from)}}{{wikiSource}} },
               "merge":{"allow_squash_merge":{{Json(file)}} },"actions":{},"security":{},"custom_properties":{},
               "pages":{},"autolinks":{},"rulesets":{},"environments":{},"labels":{},
               {{Documents.NoDraftSources}} } }
            """;
    }

    private string Base() =>
        $$"""
        {"chain":[{{Json(@base)}}],"profile":{"repository":{"has_issues":true,"has_wiki":false} },
         {{Documents.NoDrafts}},
         "sources":{"repository":{"has_issues":{{Json(@base)}},"has_wiki":{{Json(@base)}} },
           "merge":{},"actions":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},"rulesets":{},"environments":{},"labels":{},
           {{Documents.NoDraftSources}} } }
        """;

    private const string WikiChange =
        """
        {"section":"repository","action":"update","target":"repository settings",
         "fields":[{"field":"has_wiki","from":true,"to":false}],
         "request":{"method":"PATCH","path":"/repos/TheLunchTrae/repotted","body":{"has_wiki":false}}}
        """;

    private const string SquashChange =
        """
        {"section":"merge","action":"update","target":"merge methods",
         "fields":[{"field":"allow_squash_merge","from":true,"to":false}],
         "request":{"method":"PATCH","path":"/repos/TheLunchTrae/repotted","body":{"allow_squash_merge":false}}}
        """;

    private const string MainChange =
        """
        {"section":"rulesets","action":"create","target":"Main",
         "fields":[{"field":"name","to":"Main"},{"field":"target","to":"branch"},{"field":"enforcement","to":"active"},
           {"field":"bypass_actors","to":[]},{"field":"rules","to":[{"type":"deletion"}]}],
         "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/rulesets","body":{}}}
        """;

    /// <summary>
    /// The plan <c>plan --staged</c> prints: the wiki from orgs, squash merges
    /// from the staged file's own edit, and the Main ruleset from orgs, unless
    /// the wiki is left out.
    /// </summary>
    private string Plan(bool fromProfile = true, bool wikiLeftOut = false, bool locked = false, bool draft = false)
    {
        List<(string Change, string Exclusion)> changes =
        [
            (WikiChange, """{"field":"has_wiki","key":"repository.has_wiki","edited":false}"""),
            (SquashChange, """{"field":"allow_squash_merge","key":"merge.allow_squash_merge","edited":true}"""),
            (MainChange, """{"field":null,"key":"rulesets/Main","edited":false}"""),
        ];
        if (wikiLeftOut)
        {
            changes.RemoveAt(0);
        }
        var exclusions = changes.Select((change, index) => change.Exclusion.Replace("{", $$"""{"change":{{index}},""", StringComparison.Ordinal));
        // When locked, the ruleset needs a permission the App lacks, which the review shows as a lock.
        var locks = locked ? $$"""{"change":{{changes.Count - 1}},"reason":"Needs Administration write"}""" : "";
        var access = locked
            ? """{"role":"admin","app":{"status":"installed","settings_url":"https://github.com/settings/installations/7"}}"""
            : Documents.Unknown;
        return $$"""
            {"repository":"{{Repository}}",
             "desired":{"repository":{"has_issues":true,"has_wiki":false},"merge":{"allow_squash_merge":false},
               "rulesets":[{"name":"Main","target":"branch","enforcement":"active","bypass_actors":[],"rules":[{"type":"deletion"}]}]},
             "changes":[{{string.Join(',', changes.Select(change => change.Change))}}],
             "warnings":[],"access":{{access}},"locks":[{{locks}}],
             "staged":{"file":{{Json(file)}},"repository":"{{Repository}}","base":{{(fromProfile ? Json(@base) : "null")}},
               "exclude":{{(wikiLeftOut ? """["repository.has_wiki"]""" : "[]")}} },
             "exclusions":[{{string.Join(',', exclusions)}}],
             "skipped":[{{(draft ? """{"section":"rulesets","target":"Release"}""" : "")}}]}
            """;
    }

    private const string Applied =
        $$"""{"repository":"{{Repository}}","applied":[{{WikiChange}},{{SquashChange}},{{MainChange}}]}""";

    private const string Stale =
        $$"""
        {"error":{"kind":"stale_plan","message":"{{Repository}} changed since this plan was made. Run plan again and review the new changes.",
          "current":{"repository":"{{Repository}}","desired":{},"changes":[],"warnings":[]} } }
        """;

    private const string PartlyApplied =
        $$"""
        {"error":{"kind":"apply_failed",
          "message":"Failed to create Main after 2 of the plan's changes: boom\nAlready applied:\n  ~ update repository settings\n  ~ update merge methods\nNothing after the failed change was written. Plan again to see where the repository stands.",
          "applied":[{{WikiChange}},{{SquashChange}}],"failed":{{MainChange}} } }
        """;

    private string New(bool fromProfile = true) =>
        fromProfile ? $"stage {file} --new={Repository} --profile={@base} --json" : $"stage {file} --new={Repository} --json";

    private string Read => $"stage {file} --json";

    private string Planned => $"plan --staged={file} --out={plan} --json";

    private string Discarded => $"stage {file} --discard --json";

    /// <summary>
    /// A CLI that starts, reads and plans the staged apply, writing the files
    /// as the CLI would: the staged file on <c>--new</c> and the plan file on
    /// each plan.
    /// </summary>
    private FakeCli Cli(bool fromProfile = true) =>
        new FakeCli()
            .On(New(fromProfile), () =>
            {
                File.WriteAllText(file, "apply_to: TheLunchTrae/repotted\n");
                return Staged(fromProfile);
            })
            .On(Read, Staged(fromProfile))
            .On($"profile {@base} --json", Base())
            .On(Planned, () =>
            {
                File.WriteAllText(plan, "{}");
                return Plan(fromProfile);
            })
            .On(Discarded, () =>
            {
                File.Delete(file);
                return $$"""{"discarded":{{Json(file)}}}""";
            });

    private ProfileListingDocument Orgs => new("orgs", @base, null, null);

    private sealed class Page(ApplyViewModel apply)
    {
        public ApplyViewModel Apply { get; } = apply;

        public int Closed { get; set; }

        public int ProfilesSaved { get; set; }
    }

    private Page Open(FakeCli cli, bool fromProfile = true, IDesktop? desktop = null, ProfileFolder? profiles = null)
    {
        Page? page = null;
        var client = new RepottedClient(cli);
        var apply = new ApplyViewModel(
            client,
            folders.Settings,
            Repository,
            fromProfile ? Orgs : null,
            () => page!.Closed++,
            profiles ?? new ProfileFolder(client, folders.Settings),
            () =>
            {
                page!.ProfilesSaved++;
                return Task.CompletedTask;
            },
            desktop: desktop);
        page = new Page(apply);
        return page;
    }

    private async Task<(Page Page, FakeCli Cli)> Reviewing(bool fromProfile = true)
    {
        var cli = Cli(fromProfile);
        var page = Open(cli, fromProfile);
        await page.Apply.OpenAsync();
        Assert.Equal(ApplyStep.Reviewing, page.Apply.Step);
        return (page, cli);
    }

    private static CompareRow Row(ApplyViewModel apply, string key) =>
        apply.Sections.SelectMany(section => section.Differences).First(row => row.LeaveOut?.Key == key);

    private static SettingViewModel Setting(ProfileViewModel editor, string key) =>
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == key);

    [AvaloniaFact]
    public async Task A_new_apply_from_a_profile_stages_it_and_shows_the_plan()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;

        Assert.Contains(New(), cli.Calls);
        Assert.True(File.Exists(file));
        Assert.Equal("orgs", apply.BaseName);
        Assert.Equal("Starts from orgs. Nothing changes on GitHub until you apply.", apply.Summary);
        Assert.Equal(3, apply.ChangeCount);
        Assert.Equal("Apply 3 changes", apply.ApplyLabel);
        Assert.Equal($"3 changes to {Repository}, in 2 sections.", apply.ReviewSummary);
        Assert.True(Row(apply, "repository.has_wiki").CanLeaveOut);
        Assert.True(Row(apply, "rulesets/Main").CanLeaveOut);
        // A one-off edit is changed in the edits, not left out.
        Assert.True(Row(apply, "merge.allow_squash_merge").IsEdit);
        Assert.False(Row(apply, "merge.allow_squash_merge").CanLeaveOut);
        Assert.Equal("Save edits", apply.Edits?.SaveLabel);
        Assert.Equal("One-off edit", apply.Edits?.OwnLabel);
        Assert.False(apply.EditsUnsaved);
        Assert.True(apply.CanLeave);
        Assert.True(apply.ApplyCommand.CanExecute(null));
        // Nothing is written to GitHub before a confirmed apply.
        Assert.DoesNotContain(cli.Calls, call => call.StartsWith("apply ", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public async Task An_apply_without_a_profile_starts_from_the_repository_as_it_is()
    {
        var (page, cli) = await Reviewing(fromProfile: false);

        Assert.Contains(New(fromProfile: false), cli.Calls);
        Assert.Null(page.Apply.BaseName);
        Assert.Equal("Starts from the repository as it is. Nothing changes on GitHub until you apply.", page.Apply.Summary);
        // With nothing to save edits to, they stay with this apply.
        Assert.False(page.Apply.SaveToProfileCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task An_unfinished_apply_waits_to_be_resumed()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "apply_to: TheLunchTrae/repotted\n");
        var cli = Cli();
        var page = Open(cli);

        await page.Apply.OpenAsync();

        Assert.Equal(ApplyStep.Unfinished, page.Apply.Step);
        Assert.Equal($"An apply to {Repository} from orgs is not finished. Resume it, or start over from orgs?", page.Apply.UnfinishedMessage);
        Assert.DoesNotContain(Planned, cli.Calls);

        await page.Apply.ResumeCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, page.Apply.Step);
        Assert.DoesNotContain(New(), cli.Calls);
    }

    [AvaloniaFact]
    public async Task Starting_over_replaces_the_unfinished_apply()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "apply_to: TheLunchTrae/repotted\n# old\n");
        File.WriteAllText(plan, "{}");
        var cli = Cli();
        var page = Open(cli);
        await page.Apply.OpenAsync();

        await page.Apply.StartOverCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, page.Apply.Step);
        Assert.Contains(New(), cli.Calls);
        Assert.DoesNotContain("# old", File.ReadAllText(file), StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task An_unfinished_apply_the_cli_cannot_read_can_still_start_over()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "nonsense: [\n");
        var cli = Cli().On(Read, """{"error":{"kind":"error","message":"The staged apply is not valid YAML."}}""", exitCode: 1);
        var page = Open(cli);

        await page.Apply.OpenAsync();

        Assert.Equal(ApplyStep.Unfinished, page.Apply.Step);
        Assert.Contains("Repotted cannot read it: The staged apply is not valid YAML.", page.Apply.UnfinishedMessage, StringComparison.Ordinal);
        Assert.True(page.Apply.StartOverCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_failed_start_shows_why()
    {
        var cli = new FakeCli().On(New(), """{"error":{"kind":"error","message":"orgs.yaml: profile is not valid."}}""", exitCode: 1);
        var page = Open(cli);

        await page.Apply.OpenAsync();

        Assert.Equal(ApplyStep.Failed, page.Apply.Step);
        Assert.Equal("orgs.yaml: profile is not valid.", page.Apply.Outcome);
        // There is no staged apply to review or discard.
        Assert.False(page.Apply.ReviewAgainCommand.CanExecute(null));
        Assert.False(page.Apply.DiscardCommand.CanExecute(null));
        Assert.True(page.Apply.CloseCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_change_GitHub_will_refuse_holds_the_apply_until_it_is_left_out()
    {
        var desktop = new FakeDesktop();
        var cli = Cli().On(Planned, () =>
        {
            File.WriteAllText(plan, "{}");
            return Plan(locked: true);
        });
        var page = Open(cli, desktop: desktop);
        var apply = page.Apply;
        await apply.OpenAsync();

        // The ruleset is locked, so writing would stop at it and leave the rest unwritten.
        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.True(apply.HasLocks);
        Assert.Equal(1, apply.Locked);
        Assert.Equal(
            "GitHub will refuse 1 of the changes below, marked with what it needs. Apply waits until you leave it out, or give the App that access and review again.",
            apply.LockSummary);
        Assert.False(apply.ApplyCommand.CanExecute(null));
        Assert.Equal("Needs Administration write", Row(apply, "rulesets/Main").Lock);

        // The App's installation settings are where the access is granted.
        Assert.True(apply.HasAccessUrl);
        Assert.Equal("Review App access", apply.AccessLabel);
        await apply.ReviewAccessCommand.ExecuteAsync(null);
        Assert.Equal("https://github.com/settings/installations/7", Assert.Single(desktop.Opened).ToString());

        // Leaving the locked change out plans again, and the apply can go on.
        cli.On($"stage {file} --exclude=rulesets/Main --json", Staged(true, "rulesets/Main"))
            .On(Planned, () => Plan());
        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "rulesets/Main"));
        Assert.False(apply.HasLocks);
        Assert.False(apply.HasAccessUrl);
        Assert.True(apply.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Access_granted_since_the_review_lets_the_apply_go_on_once_reviewed_again()
    {
        var cli = Cli().On(Planned, () =>
        {
            File.WriteAllText(plan, "{}");
            return Plan(locked: true);
        });
        var page = Open(cli);
        var apply = page.Apply;
        await apply.OpenAsync();
        Assert.False(apply.ApplyCommand.CanExecute(null));
        // With no way to open a browser, no link is offered.
        Assert.False(apply.HasAccessUrl);

        cli.On(Planned, () => Plan());
        await apply.ReviewAgainCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.False(apply.HasLocks);
        Assert.True(apply.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Leaving_a_change_out_plans_again_without_it_and_putting_it_back_restores_it()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        static bool LosesWiki(PlanDiffViewModel? diff) =>
            diff!.Items.OfType<DiffLine>().Any(line => line.IsRemoved && line.Text == "  has_wiki: true");
        Assert.True(LosesWiki(apply.Edits!.Diff));
        Assert.Null(apply.Edits.Diff!.Footnote);
        cli.On($"stage {file} --exclude=repository.has_wiki --json", Staged(true, "repository.has_wiki"))
            .On(Planned, () => Plan(wikiLeftOut: true));

        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "repository.has_wiki"));

        // Each plan shown replaces the diff beside the one-off edits.
        Assert.False(LosesWiki(apply.Edits.Diff));
        Assert.Equal("1 setting or entry is left out of this apply, so GitHub keeps it as it is.", apply.Edits.Diff!.Footnote);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.Equal(2, apply.ChangeCount);
        var excluded = Assert.Single(apply.Excluded);
        Assert.Equal("repository.has_wiki", excluded.Key);
        Assert.DoesNotContain(apply.Sections.SelectMany(section => section.Differences), row => row.LeaveOut?.Key == "repository.has_wiki");

        cli.On($"stage {file} --include=repository.has_wiki --json", Staged())
            .On(Planned, () => Plan());

        await apply.PutBackCommand.ExecuteAsync(excluded);

        Assert.Equal(3, apply.ChangeCount);
        Assert.Empty(apply.Excluded);
        Assert.True(LosesWiki(apply.Edits.Diff));
    }

    [AvaloniaFact]
    public async Task Leaving_a_change_out_shows_the_staged_apply_it_returns_without_reading_it_again()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var exclude = $"stage {file} --exclude=repository.has_wiki --json";
        cli.On(exclude, Staged(true, "repository.has_wiki"))
            .On(Planned, () => Plan(wikiLeftOut: true));
        cli.Calls.Clear();

        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "repository.has_wiki"));

        // The exclusion's own answer is the edits as they are now, and the base profile is as it was.
        Assert.Equal([exclude, Planned], cli.Calls);
        Assert.Equal(SettingOrigin.NotManaged, Setting(apply.Edits!, "has_wiki").Origin);
    }

    [AvaloniaFact]
    public async Task A_change_that_shows_the_edits_clears_an_earlier_load_error()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var editor = apply.Edits!;
        // An earlier load of the edits failed, so the editor shows the error in place of the tabs.
        editor.Error = "Could not read the profile.";
        cli.On($"stage {file} --exclude=repository.has_wiki --json", Staged(true, "repository.has_wiki"))
            .On(Planned, () => Plan(wikiLeftOut: true));

        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "repository.has_wiki"));

        Assert.Null(editor.Error);
        Assert.True(editor.ShowEditor);
    }

    [AvaloniaFact]
    public async Task A_profile_that_changes_while_a_change_runs_still_stops_a_save_over_it()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        // The staged apply inherits the Main ruleset from orgs.
        var staged = Staged(true, "repository.has_wiki")
            .Replace("\"merge\":{\"allow_squash_merge\":false} }", "\"merge\":{\"allow_squash_merge\":false},\"rulesets\":[{\"name\":\"Main\",\"enforcement\":\"active\"}] }", StringComparison.Ordinal)
            .Replace("\"rulesets\":{},\"environments\":{},", $"\"rulesets\":{{\"Main\":{Json(@base)}}},\"environments\":{{}},", StringComparison.Ordinal);
        cli.On($"stage {file} --exclude=repository.has_wiki --json", () =>
            {
                // The CLI writes the staged file, and a sync changes orgs meanwhile.
                File.AppendAllText(file, "exclude: [repository.has_wiki]\n");
                File.AppendAllText(@base, "# synced\n");
                return staged;
            })
            .On(Planned, () => Plan(wikiLeftOut: true));
        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "repository.has_wiki"));
        var editor = apply.Edits!;
        var main = editor.Tabs.Single(tab => tab.List == "rulesets").Entries.Single();
        Assert.False(main.Own);

        ((RulesetEditorViewModel)main.Editor).Enforcement.Options[1].ChooseCommand.Execute(null);
        editor.CheckFile();

        // The staged file the change wrote reads as the edits show it; orgs, which changed under them, does not.
        Assert.Equal(@base, editor.ChangedFile);
    }

    [AvaloniaFact]
    public async Task A_refused_exclusion_keeps_the_review_as_it_was()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On(
            $"stage {file} --exclude=rulesets/Main --json",
            """{"error":{"kind":"error","message":"rulesets/Main is edited in this apply, so it cannot be left out."}}""",
            exitCode: 1);
        cli.Calls.Clear();

        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "rulesets/Main"));

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.Equal("rulesets/Main is edited in this apply, so it cannot be left out.", apply.Error);
        Assert.Equal(3, apply.ChangeCount);
        Assert.DoesNotContain(Planned, cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_one_off_edit_is_never_left_out()
    {
        var (page, cli) = await Reviewing();
        cli.Calls.Clear();

        await page.Apply.LeaveOutCommand.ExecuteAsync(Row(page.Apply, "merge.allow_squash_merge"));

        Assert.Empty(cli.Calls);
    }

    [AvaloniaFact]
    public async Task The_apply_names_the_drafts_it_leaves_out_of_the_profile()
    {
        var cli = Cli().On(Planned, () =>
        {
            File.WriteAllText(plan, "{}");
            return Plan(draft: true);
        });
        var page = Open(cli);
        await page.Apply.OpenAsync();

        Assert.Equal("Left out as a draft: the ruleset Release.", page.Apply.DraftsNote);

        cli.On(Planned, () => Plan());
        await page.Apply.ReviewAgainCommand.ExecuteAsync(null);
        Assert.Null(page.Apply.DraftsNote);
    }

    [AvaloniaFact]
    public async Task A_one_off_edit_over_the_profile_shows_the_profile_value_under_it()
    {
        // The staged file turns issues off, over orgs, which turns them on.
        var over = Staged()
            .Replace($"\"has_issues\":{Json(@base)}", $"\"has_issues\":{Json(file)}", StringComparison.Ordinal)
            .Replace("\"has_issues\":true", "\"has_issues\":false", StringComparison.Ordinal);
        var cli = Cli().On(Read, over);
        var page = Open(cli);
        await page.Apply.OpenAsync();
        var editor = page.Apply.Edits!;

        // The wiki comes from orgs, as the staged apply resolves it.
        var wiki = Setting(editor, "has_wiki");
        Assert.Equal(SettingOrigin.Inherited, wiki.Origin);
        Assert.Equal(("orgs", false), (wiki.Inherited?.From, wiki.Inherited?.Value.GetValue<bool>()));

        // Issues are the one-off edit's own, and orgs' value is what undoing it brings back.
        var issues = Setting(editor, "has_issues");
        Assert.Equal(SettingOrigin.Own, issues.Origin);
        Assert.Equal(("orgs", true), (issues.Inherited?.From, issues.Inherited?.Value.GetValue<bool>()));
    }

    [AvaloniaFact]
    public async Task One_off_edits_offer_no_drafts()
    {
        var (page, _) = await Reviewing();
        var editor = page.Apply.Edits!;

        // A staged apply holds no drafts, so neither a setting nor a new entry can become one.
        var issues = Setting(editor, "has_issues");
        issues.Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        Assert.True(issues.Changed);
        Assert.False(issues.CanSaveAsDraft);
        Assert.False(issues.SaveAsDraftCommand.CanExecute(null));
        var rulesets = editor.Tabs.Single(tab => tab.List == "rulesets");
        Assert.False(rulesets.Drafts);
        rulesets.NewCommand.Execute(null);
        Assert.False(rulesets.Editing!.Editor.Drafts);
        Assert.False(editor.HoldsDrafts);
    }

    [AvaloniaFact]
    public async Task Unsaved_one_off_edits_hold_the_apply_until_they_are_saved()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var editor = apply.Edits!;

        Setting(editor, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);

        Assert.True(apply.EditsUnsaved);
        Assert.False(apply.CanLeave);
        Assert.False(apply.ApplyCommand.CanExecute(null));
        Assert.False(apply.LeaveOutCommand.CanExecute(Row(apply, "repository.has_wiki")));
        Assert.False(apply.CloseCommand.CanExecute(null));

        var save = $"stage {file} --set repository.has_issues=false --json";
        cli.On(save, Staged());
        cli.Calls.Clear();
        await editor.SaveCommand.ExecuteAsync(null);

        Assert.Contains(save, cli.Calls);
        // A saved edit changes what the apply writes, so it is planned again.
        Assert.Contains(Planned, cli.Calls);
        Assert.False(apply.EditsUnsaved);
        Assert.True(apply.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task One_off_edits_change_only_while_the_plan_is_under_review()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        Assert.True(apply.CanEdit);

        apply.ApplyCommand.Execute(null);
        Assert.Equal(ApplyStep.Confirming, apply.Step);
        Assert.False(apply.CanEdit);
        apply.CancelApplyCommand.Execute(null);
        Assert.True(apply.CanEdit);

        var planned = new TaskCompletionSource<string>();
        cli.On(Planned, _ => planned.Task);
        var planning = apply.ReviewAgainCommand.ExecuteAsync(null);
        Assert.Equal(ApplyStep.Planning, apply.Step);
        Assert.False(apply.CanEdit);
        planned.SetResult(Plan());
        await planning;
        Assert.True(apply.CanEdit);
    }

    [AvaloniaFact]
    public async Task The_apply_waits_while_its_edits_are_read_again()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        apply.ApplyCommand.Execute(null);
        Assert.True(apply.ConfirmApplyCommand.CanExecute(null));
        var read = new TaskCompletionSource();
        cli.OnceReady(Read, Staged(), read.Task);

        var loading = apply.Edits!.LoadCommand.ExecuteAsync(null);

        Assert.True(apply.Edits.Loading);
        Assert.False(apply.ConfirmApplyCommand.CanExecute(null));
        Assert.False(apply.DiscardCommand.CanExecute(null));
        Assert.False(apply.CanLeave);
        read.SetResult();
        await loading;
        Assert.True(apply.ConfirmApplyCommand.CanExecute(null));
        Assert.True(apply.CanLeave);
    }

    [AvaloniaFact]
    public async Task Leaving_waits_while_a_plan_runs_and_says_why()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var planned = new TaskCompletionSource<string>();
        cli.On(Planned, _ => planned.Task);

        var planning = apply.ReviewAgainCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Planning, apply.Step);
        Assert.False(apply.CanLeave);
        Assert.False(apply.CloseCommand.CanExecute(null));
        Assert.False(await apply.ConfirmLeaveAsync("sign out"));
        Assert.False(apply.AskingToLeave);
        Assert.Equal("Repotted is still working on this apply, so you can sign out once it is done.", apply.Error);
        planned.SetResult(Plan());
        await planning;
        // The note goes once the run ends, so it never stands beside what comes after.
        Assert.Null(apply.Error);
        Assert.True(apply.CanLeave);
        Assert.True(await apply.ConfirmLeaveAsync("sign out"));
    }

    [AvaloniaFact]
    public async Task A_wait_to_leave_goes_on_once_the_run_ends()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var planned = new TaskCompletionSource<string>();
        cli.On(Planned, _ => planned.Task);
        var planning = apply.ReviewAgainCommand.ExecuteAsync(null);

        // A lost sign-in waits for the run, since it can't be stopped partway.
        var leaving = apply.ConfirmLeaveAsync("sign in again", wait: true);

        Assert.False(leaving.IsCompleted);
        Assert.Null(apply.Error);
        planned.SetResult(Plan());
        await planning;
        Assert.True(await leaving);
    }

    [AvaloniaFact]
    public async Task Discarding_the_apply_answers_a_question_about_leaving()
    {
        var (page, _) = await Reviewing();
        var apply = page.Apply;
        Setting(apply.Edits!, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        var leaving = apply.ConfirmLeaveAsync("sign out");
        Assert.True(apply.AskingToLeave);

        apply.DiscardCommand.Execute(null);
        await apply.ConfirmDiscardCommand.ExecuteAsync(null);

        // The edits went with the apply, so leaving goes on.
        Assert.Equal(ApplyStep.Discarded, apply.Step);
        Assert.True(await leaving);
        Assert.False(apply.AskingToLeave);
        Assert.Equal(1, page.Closed);
    }

    [AvaloniaFact]
    public async Task Nothing_is_discarded_or_left_while_the_edits_save()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var editor = apply.Edits!;
        Setting(editor, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        var written = new TaskCompletionSource();
        cli.OnceReady($"stage {file} --set repository.has_issues=false --json", Staged(), written.Task);

        var saving = editor.SaveCommand.ExecuteAsync(null);

        Assert.True(editor.Saving);
        Assert.False(apply.DiscardCommand.CanExecute(null));
        Assert.False(apply.CanLeave);
        Assert.False(await apply.ConfirmLeaveAsync("quit"));
        Assert.Equal("Repotted is still working on this apply, so you can quit once it is done.", apply.Error);
        written.SetResult();
        await saving;
        Assert.True(apply.DiscardCommand.CanExecute(null));
        Assert.True(apply.CanLeave);
    }

    [AvaloniaFact]
    public async Task A_question_about_leaving_settles_once_the_edits_are_saved_and_planned()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var editor = apply.Edits!;
        Setting(editor, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        apply.Tab = 0;

        var leaving = apply.ConfirmLeaveAsync("sign out");

        Assert.False(leaving.IsCompleted);
        Assert.True(apply.AskingToLeave);
        Assert.Equal("To sign out, save or undo your one-off edits first.", apply.LeavingMessage);
        // The question shows with the edits it is about.
        Assert.True(apply.ShowingEdits);

        var save = $"stage {file} --set repository.has_issues=false --json";
        cli.On(save, Staged());
        var planned = new TaskCompletionSource<string>();
        cli.On(Planned, _ => planned.Task);
        cli.Calls.Clear();
        var saving = editor.SaveCommand.ExecuteAsync(null);
        await Until(() => apply.Step == ApplyStep.Planning);
        // The saved edits are planned before the page may go, so it never stays behind with an old plan.
        Assert.False(leaving.IsCompleted);

        planned.SetResult(Plan());
        await saving;
        Assert.True(await leaving);
        Assert.Contains(save, cli.Calls);
        Assert.Contains(Planned, cli.Calls);
        Assert.False(apply.AskingToLeave);
        Assert.Equal(ApplyStep.Reviewing, apply.Step);
    }

    [AvaloniaFact]
    public async Task Staying_keeps_the_unsaved_edits_and_a_later_question_replaces_an_open_one()
    {
        var (page, _) = await Reviewing();
        var apply = page.Apply;
        Setting(apply.Edits!, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);

        var first = apply.ConfirmLeaveAsync("quit");
        var second = apply.ConfirmLeaveAsync("sign out");

        Assert.False(await first);
        Assert.Equal("To sign out, save or undo your one-off edits first.", apply.LeavingMessage);
        apply.StayHereCommand.Execute(null);
        Assert.False(await second);
        Assert.False(apply.AskingToLeave);
        Assert.True(apply.EditsUnsaved);
        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.Equal(0, page.Closed);
    }

    [AvaloniaFact]
    public async Task Saving_edits_to_the_profile_lists_the_profiles_again()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        Assert.True(apply.SaveToProfileCommand.CanExecute(null));
        cli.On($"stage {file} --save-to-profile --json", Staged());
        cli.Calls.Clear();

        await apply.SaveToProfileCommand.ExecuteAsync(null);

        Assert.Equal(1, page.ProfilesSaved);
        Assert.Contains(Planned, cli.Calls);
        Assert.Equal(ApplyStep.Reviewing, apply.Step);
    }

    [AvaloniaFact]
    public async Task Saving_edits_to_the_profile_waits_for_a_sync_of_the_profiles_folder()
    {
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "lunch/config", ConfigPath = "" });
        var cli = Cli();
        var profiles = new ProfileFolder(new RepottedClient(cli), folders.Settings);
        var page = Open(cli, profiles: profiles);
        await page.Apply.OpenAsync();
        var sync = $"sync {profiles.Path} --json";
        var syncing = new TaskCompletionSource();
        cli.OnceReady(
            sync,
            """{"repository":"lunch/config","path":"","branch":"main","commit":"abc123","pulled":[],"pushed":[],"conflicts":[]}""",
            syncing.Task);
        var save = $"stage {file} --save-to-profile --json";
        cli.On(save, Staged());
        cli.Calls.Clear();

        var synced = profiles.SyncAsync(null, null);
        var saved = page.Apply.SaveToProfileCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        // The save takes its turn after the sync, so the sync never reads the profile half written.
        Assert.Equal([sync], cli.Calls);
        syncing.SetResult();
        Assert.NotNull(await synced);
        await saved;
        Assert.Equal([sync, save], cli.Calls.GetRange(0, 2));
        Assert.Equal(1, page.ProfilesSaved);
    }

    [AvaloniaFact]
    public async Task Cancelling_the_confirmation_writes_nothing()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;

        apply.ApplyCommand.Execute(null);

        Assert.Equal(ApplyStep.Confirming, apply.Step);
        Assert.Equal($"Write 3 changes to {Repository} on GitHub now?", apply.ConfirmMessage);
        Assert.True(apply.ShowReview);
        Assert.False(apply.ShowActions);

        apply.CancelApplyCommand.Execute(null);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.DoesNotContain(cli.Calls, call => call.StartsWith("apply ", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public async Task A_confirmed_apply_writes_the_reviewed_plan_and_removes_the_staged_apply()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On($"apply {plan} --yes --json", Applied);
        apply.ApplyCommand.Execute(null);

        await apply.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Applied, apply.Step);
        Assert.Equal($"Applied 3 changes to {Repository}.", apply.Outcome);
        Assert.Equal($"Applied to {Repository}.", apply.Summary);
        Assert.Contains(Discarded, cli.Calls);
        Assert.False(File.Exists(file));
        Assert.False(File.Exists(plan));
        Assert.True(apply.CanLeave);
    }

    [AvaloniaFact]
    public async Task A_repository_changed_since_the_review_writes_nothing_and_asks_for_another_review()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On($"apply {plan} --yes --json", Stale, exitCode: 1);
        apply.ApplyCommand.Execute(null);

        await apply.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Stale, apply.Step);
        Assert.StartsWith($"{Repository} changed on GitHub after you reviewed this apply", apply.Outcome, StringComparison.Ordinal);
        Assert.True(File.Exists(file));
        Assert.DoesNotContain(Discarded, cli.Calls);

        await apply.ReviewAgainCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
    }

    [AvaloniaFact]
    public async Task A_failure_partway_says_what_was_written_and_keeps_the_rest_to_review()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On($"apply {plan} --yes --json", PartlyApplied, exitCode: 1);
        apply.ApplyCommand.Execute(null);

        await apply.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.PartlyApplied, apply.Step);
        Assert.Equal(
            $"Applied 2 of 3 changes to {Repository}, then stopped. Failed to create Main after 2 of the plan's changes: boom. Nothing after it was written, so review again to see what is left.",
            apply.Outcome);
        Assert.True(File.Exists(file));
        Assert.True(apply.ReviewAgainCommand.CanExecute(null));
        Assert.True(apply.DiscardCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task An_apply_that_fails_otherwise_warns_that_some_changes_may_be_written()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On($"apply {plan} --yes --json", """{"error":{"kind":"error","message":"getaddrinfo ENOTFOUND api.github.com"}}""", exitCode: 1);
        apply.ApplyCommand.Execute(null);

        await apply.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Failed, apply.Step);
        Assert.Equal(
            "getaddrinfo ENOTFOUND api.github.com Some changes may already be on GitHub, so review again before you apply.",
            apply.Outcome);
        Assert.True(apply.ReviewAgainCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task Nothing_else_starts_while_the_apply_writes()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var written = new TaskCompletionSource();
        cli.OnceReady($"apply {plan} --yes --json", Applied, written.Task);
        apply.ApplyCommand.Execute(null);

        var applying = apply.ConfirmApplyCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Applying, apply.Step);
        Assert.False(apply.CanLeave);
        Assert.False(apply.CloseCommand.CanExecute(null));
        Assert.False(apply.DiscardCommand.CanExecute(null));
        Assert.False(apply.ReviewAgainCommand.CanExecute(null));
        written.SetResult();
        await applying;
        Assert.Equal(ApplyStep.Applied, apply.Step);
    }

    [AvaloniaFact]
    public async Task Nothing_else_starts_while_a_change_or_a_plan_runs()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        var excluded = new TaskCompletionSource();
        cli.OnceReady($"stage {file} --exclude=rulesets/Main --json", Staged(true, "rulesets/Main"), excluded.Task);
        var planned = new TaskCompletionSource<string>();
        cli.On(Planned, _ => planned.Task);

        var leaving = apply.LeaveOutCommand.ExecuteAsync(Row(apply, "rulesets/Main"));

        Assert.True(apply.Working);
        Assert.False(apply.ApplyCommand.CanExecute(null));
        Assert.False(apply.DiscardCommand.CanExecute(null));
        Assert.False(apply.ReviewAgainCommand.CanExecute(null));
        Assert.False(apply.PutBackCommand.CanExecute(new ExcludedViewModel("rulesets/Main")));

        excluded.SetResult();
        await Task.Delay(50, TestContext.Current.CancellationToken);
        Assert.Equal(ApplyStep.Planning, apply.Step);
        Assert.False(apply.ApplyCommand.CanExecute(null));
        Assert.False(apply.LeaveOutCommand.CanExecute(Row(apply, "repository.has_wiki")));

        planned.SetResult(Plan());
        await leaving;
        Assert.Equal(ApplyStep.Reviewing, apply.Step);
    }

    [AvaloniaFact]
    public async Task Discarding_asks_first_and_keeping_returns_to_the_review()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;

        apply.DiscardCommand.Execute(null);

        Assert.Equal(ApplyStep.ConfirmingDiscard, apply.Step);
        Assert.True(apply.ShowReview);

        apply.KeepCommand.Execute(null);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.DoesNotContain(Discarded, cli.Calls);
        Assert.True(File.Exists(file));
    }

    [AvaloniaFact]
    public async Task A_confirmed_discard_removes_the_staged_apply_and_closes()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        apply.DiscardCommand.Execute(null);

        await apply.ConfirmDiscardCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Discarded, apply.Step);
        Assert.Contains(Discarded, cli.Calls);
        Assert.False(File.Exists(file));
        Assert.False(File.Exists(plan));
        Assert.Equal(1, page.Closed);
    }

    [AvaloniaFact]
    public async Task A_refused_discard_keeps_the_review()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On(Discarded, """{"error":{"kind":"error","message":"Permission denied."}}""", exitCode: 1);
        apply.DiscardCommand.Execute(null);

        await apply.ConfirmDiscardCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, apply.Step);
        Assert.Equal("Permission denied.", apply.Error);
        Assert.Equal(0, page.Closed);
    }

    [AvaloniaFact]
    public async Task A_stale_apply_can_be_discarded_too()
    {
        var (page, cli) = await Reviewing();
        var apply = page.Apply;
        cli.On($"apply {plan} --yes --json", Stale, exitCode: 1);
        apply.ApplyCommand.Execute(null);
        await apply.ConfirmApplyCommand.ExecuteAsync(null);

        apply.DiscardCommand.Execute(null);
        Assert.False(apply.ShowReview);
        apply.KeepCommand.Execute(null);

        Assert.Equal(ApplyStep.Stale, apply.Step);
    }

    [AvaloniaFact]
    public async Task A_plan_with_nothing_to_write_has_nothing_to_apply()
    {
        var cli = Cli().On(Planned, () =>
            $$"""
            {"repository":"{{Repository}}","desired":{},"changes":[],"skipped":[],"warnings":[],"access":{{Documents.Unknown}},"locks":[],
             "staged":{"file":{{Json(file)}},"repository":"{{Repository}}","base":{{Json(@base)}},"exclude":[]},"exclusions":[]}
            """);
        var page = Open(cli);

        await page.Apply.OpenAsync();

        Assert.Equal(ApplyStep.Reviewing, page.Apply.Step);
        Assert.Equal("Nothing to apply", page.Apply.ApplyLabel);
        Assert.Equal($"{Repository} already has everything this apply sets.", page.Apply.ReviewSummary);
        Assert.False(page.Apply.ApplyCommand.CanExecute(null));
    }

    [AvaloniaFact]
    public async Task A_failed_plan_can_be_tried_again()
    {
        var cli = Cli().On(Planned, """{"error":{"kind":"error","message":"GitHub rejected the sign-in."}}""", exitCode: 1);
        var page = Open(cli);

        await page.Apply.OpenAsync();

        Assert.Equal(ApplyStep.Failed, page.Apply.Step);
        Assert.Equal("GitHub rejected the sign-in.", page.Apply.Outcome);

        cli.On(Planned, () => Plan());
        await page.Apply.ReviewAgainCommand.ExecuteAsync(null);

        Assert.Equal(ApplyStep.Reviewing, page.Apply.Step);
    }

    [Fact]
    public void Pages_and_autolinks_changes_can_be_left_out_and_show_their_locks()
    {
        var plan = JsonSerializer.Deserialize(
            """
            {"repository":"TheLunchTrae/repotted","desired":{"pages":{"build_type":"workflow"},"autolinks":[]},"skipped":[],"warnings":[],"changes":[
              {"section":"pages","action":"create","target":"GitHub Pages","fields":[{"field":"build_type","to":"workflow"}],
               "request":{"method":"POST","path":"/repos/TheLunchTrae/repotted/pages","body":{}}},
              {"section":"autolinks","action":"delete","target":"JIRA-","fields":[],
               "request":{"method":"DELETE","path":"/repos/TheLunchTrae/repotted/autolinks/3"}}],
             "access":{"role":"admin","app":{"status":"unknown"}},"locks":[{"change":0,"reason":"Needs Pages write"}]}
            """,
            CliJson.Default.PlanDocument)!;

        var sections = PlanSections.Build(plan, (change, field) => (change, field) switch
        {
            (0, null) => new RowExclusion("pages", false),
            (1, null) => new RowExclusion("autolinks/JIRA-", false),
            _ => null,
        });

        // A Pages site leaves out whole, so each of its fields leaves out the site.
        var pages = Assert.Single(Assert.Single(sections, section => section.Title == "GitHub Pages").Differences);
        Assert.Equal("pages", pages.LeaveOut?.Key);
        Assert.Equal("Needs Pages write", pages.Lock);
        var autolink = Assert.Single(Assert.Single(sections, section => section.Title == "Autolinks").Differences);
        Assert.Equal(CompareKind.Removes, autolink.Kind);
        Assert.Equal("autolinks/JIRA-", autolink.LeaveOut?.Key);
        Assert.False(autolink.IsLocked);
    }

    [AvaloniaFact]
    public async Task The_shell_shows_an_apply_in_place_of_the_list_and_keeps_one_that_cannot_close()
    {
        var cli = Cli(fromProfile: false)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.NoProfiles);
        var shell = new ShellViewModel(
            new Account.SignedIn("TheLunchTrae", "Trae", null, Documents.InstallUrl),
            new RepottedClient(cli),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);
        await shell.Repositories.RefreshCommand.ExecuteAsync(null);
        shell.Repositories.Selected = shell.Repositories.Rows.Single(row => row.FullName == Repository);
        Assert.False(shell.Repositories.HasUnfinishedApply);

        shell.Repositories.ChangeSettingsCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Reviewing);

        Assert.True(shell.ShowingApply);
        Assert.False(shell.ShowingRepositories);
        Assert.Equal($"Repositories / {Repository} / Apply", shell.Crumb);

        // Unsaved one-off edits keep the apply open, and a quit asks about them.
        var apply = shell.Apply!;
        Setting(apply.Edits!, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        shell.ShowPage(0);
        Assert.True(shell.ShowingApply);
        var quit = shell.ConfirmQuitAsync();
        Assert.False(quit.IsCompleted);
        Assert.True(apply.AskingToLeave);
        Assert.Equal("To quit, save or undo your one-off edits first.", apply.LeavingMessage);
        Assert.True(apply.ShowingEdits);
        apply.StayHereCommand.Execute(null);
        Assert.False(await quit);
        Assert.False(apply.AskingToLeave);
        Assert.True(apply.EditsUnsaved);

        // Undoing the edits answers the question, and the quit goes on.
        quit = shell.ConfirmQuitAsync();
        Assert.True(apply.AskingToLeave);
        apply.Edits!.DiscardCommand.Execute(null);
        Assert.True(await quit);
        Assert.False(apply.AskingToLeave);

        // Without them the list comes back, with the apply left to resume.
        shell.ShowPage(0);
        Assert.Null(shell.Apply);
        Assert.True(shell.ShowingRepositories);
        Assert.True(shell.Repositories.HasUnfinishedApply);
    }

    [AvaloniaFact]
    public async Task Closing_the_window_asks_about_unsaved_one_off_edits()
    {
        var (window, shell, _) = await ShowList("light");
        shell.Repositories.ChangeSettingsCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Reviewing);
        var apply = shell.Apply!;
        Setting(apply.Edits!, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);

        window.Close();
        Dispatcher.UIThread.RunJobs();
        Assert.True(window.IsVisible);
        Assert.True(apply.AskingToLeave);
        Assert.Contains("To quit, save or undo your one-off edits first.", Texts(window));

        apply.StayHereCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(window.IsVisible);
        Assert.True(apply.EditsUnsaved);

        window.Close();
        apply.Edits!.DiscardCommand.Execute(null);
        await Until(() => !window.IsVisible);
    }

    [AvaloniaFact]
    public async Task Closing_the_window_while_the_apply_writes_stays_and_says_why()
    {
        var (window, shell, cli) = await ShowList("light");
        shell.Repositories.ChangeSettingsCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Reviewing);
        var apply = shell.Apply!;
        var written = new TaskCompletionSource();
        cli.OnceReady($"apply {plan} --yes --json", Applied, written.Task);
        apply.ApplyCommand.Execute(null);
        var applying = apply.ConfirmApplyCommand.ExecuteAsync(null);

        window.Close();
        Dispatcher.UIThread.RunJobs();

        Assert.True(window.IsVisible);
        Assert.Contains("Repotted is still working on this apply, so you can quit once it is done.", Texts(window));
        written.SetResult();
        await applying;
        Assert.Equal(ApplyStep.Applied, apply.Step);
        Assert.Null(apply.Error);
        window.Close();
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.IsVisible);
    }

    public static TheoryData<string> Themes => ["light", "dark"];

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_apply_page_shows_the_diff_to_edit_before_anything_is_written(string theme)
    {
        var (window, shell, cli) = await ShowList(theme);
        var repositories = shell.Repositories;
        // The only profile is picked already, and its box shows it.
        Assert.Equal("orgs", repositories.CompareWith?.Name);
        Assert.Same(repositories.CompareWith, window.GetVisualDescendants().OfType<ComboBox>().Single().SelectedItem);

        var panel = Texts(window);
        Assert.Contains(ControlLabel.For("Apply"), panel);
        Assert.Contains(ControlLabel.For("Change settings once"), panel);
        Assert.Contains("Comparing and capturing only read from GitHub. An apply shows its changes first, and writes nothing until you confirm.", panel);
        Save(window, $"repository-panel-{theme}");

        repositories.ApplyProfileCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Reviewing);
        var apply = shell.Apply!;

        var text = Texts(window);
        Assert.Contains($"Apply to {Repository}", text);
        Assert.Contains("Starts from orgs. Nothing changes on GitHub until you apply.", text);
        Assert.Contains(ControlLabel.For("Apply 3 changes"), text);
        Assert.Contains(ControlLabel.For("Leave out"), text);
        Assert.Contains("One-off edit", text);
        Assert.Contains(ControlLabel.For("Discard apply"), text);
        Assert.Contains($"Repositories / {Repository} / Apply", text);
        Save(window, $"apply-review-{theme}");

        // Every row says what the apply does to it, for screen readers.
        var names = window.GetVisualDescendants().OfType<Button>()
            .Select(button => ControlAutomationPeer.CreatePeerForElement(button).GetName())
            .ToList();
        Assert.Contains(names, name => name.StartsWith(ControlLabel.For("Leave out"), StringComparison.Ordinal));

        // A change GitHub will refuse holds the apply, and the review says why and where to grant it.
        cli.On(Planned, () => Plan(locked: true));
        await apply.ReviewAgainCommand.ExecuteAsync(null);
        text = Texts(window);
        Assert.Contains(apply.LockSummary, text);
        Assert.Contains("Needs Administration write", text);
        Assert.Contains(ControlLabel.For("Review App access"), text);
        Assert.False(apply.ApplyCommand.CanExecute(null));
        Save(window, $"apply-locked-{theme}");

        // Once the access is granted, Review again beside Apply plans with it.
        cli.On(Planned, () => Plan());
        var again = window.GetVisualDescendants().OfType<Button>()
            .Single(button => button.IsEffectivelyVisible && button.Command == apply.ReviewAgainCommand);
        Assert.Equal(ControlLabel.For("Review again"), ControlAutomationPeer.CreatePeerForElement(again).GetName());
        await apply.ReviewAgainCommand.ExecuteAsync(null);
        Assert.False(apply.HasLocks);
        Assert.True(apply.ApplyCommand.CanExecute(null));

        cli.On($"stage {file} --exclude=repository.has_wiki --json", Staged(true, "repository.has_wiki"))
            .On(Planned, () => Plan(wikiLeftOut: true));
        await apply.LeaveOutCommand.ExecuteAsync(Row(apply, "repository.has_wiki"));
        text = Texts(window);
        Assert.Contains("Left out of this apply", text);
        Assert.Contains("repository.has_wiki", text);
        Assert.Contains(ControlLabel.For("Put back"), text);
        Assert.Contains(ControlLabel.For("Apply 2 changes"), text);
        Save(window, $"apply-left-out-{theme}");

        apply.ApplyCommand.Execute(null);
        text = Texts(window);
        Assert.Contains($"Write 2 changes to {Repository} on GitHub now?", text);
        Assert.Contains(ControlLabel.For("Apply now"), text);
        Assert.Contains(ControlLabel.For("Cancel"), text);
        Save(window, $"apply-confirm-{theme}");
        apply.CancelApplyCommand.Execute(null);

        apply.Tab = 1;
        // The sidebar shows the plan as a diff of the profile's YAML first.
        text = Texts(window);
        Assert.Contains(ControlLabel.For("Diff"), text);
        Assert.Contains(ControlLabel.For("File"), text);
        Assert.Contains("GitHub now", text);
        Assert.Contains("allow_squash_merge: true", text);
        Assert.Contains("allow_squash_merge: false", text);
        Assert.Contains("- name: Main", text);
        Assert.Contains("One-off edit", text);
        Save(window, $"apply-diff-{theme}");

        // Screen readers hear each line once, as what it does to GitHub.
        var heard = window.GetVisualDescendants().OfType<Border>()
            .Where(border => border.DataContext is DiffLine && border.Classes.Contains("diffline"))
            .Select(border => ControlAutomationPeer.CreatePeerForElement(border))
            .Where(peer => peer.IsControlElement())
            .Select(peer => peer.GetName())
            .ToList();
        Assert.Contains("GitHub loses: allow_squash_merge: true", heard);
        Assert.Contains("GitHub gets: allow_squash_merge: false, one-off edit", heard);
        Assert.Contains("Stays: merge:", heard);

        // Clicking the view already shown keeps it chosen; File shows the saved file.
        var segments = window.GetVisualDescendants().OfType<ToggleButton>().Where(button => button.Classes.Contains("seg")).ToList();
        var diffButton = segments.Single(button => (string?)button.Content == "Diff");
        // A click toggles the button, as ToggleButton does, then runs its command.
        diffButton.SetCurrentValue(ToggleButton.IsCheckedProperty, false);
        diffButton.Command!.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(diffButton.IsChecked);
        apply.Edits!.ShowFileCommand.Execute(null);
        Assert.DoesNotContain("GitHub now", Texts(window));
        apply.Edits.ShowDiffCommand.Execute(null);

        Setting(apply.Edits!, "has_issues").Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);
        text = Texts(window);
        Assert.Contains("For this apply only, over orgs, which stays as it is unless you save these edits to it.", text);
        Assert.Contains(ControlLabel.For("Save edits"), text);
        Save(window, $"apply-edits-{theme}");

        // Quitting with the edits unsaved asks about them, on the edits.
        var quit = shell.ConfirmQuitAsync();
        text = Texts(window);
        Assert.Contains("To quit, save or undo your one-off edits first.", text);
        Assert.Contains("Saved edits stay in this apply, to resume later. The profile and GitHub stay as they are.", text);
        Assert.Contains(ControlLabel.For("Stay here"), text);
        Save(window, $"apply-leave-{theme}");
        apply.StayHereCommand.Execute(null);
        Assert.False(await quit);
        apply.Edits!.DiscardCommand.Execute(null);
        apply.Tab = 0;

        cli.On($"stage {file} --include=repository.has_wiki --json", Staged())
            .On(Planned, () => Plan())
            .On($"apply {plan} --yes --json", PartlyApplied, exitCode: 1);
        await apply.PutBackCommand.ExecuteAsync(apply.Excluded.Single());
        apply.ApplyCommand.Execute(null);
        await apply.ConfirmApplyCommand.ExecuteAsync(null);
        text = Texts(window);
        Assert.Contains("Starts from orgs. Some of its changes are on GitHub.", text);
        Assert.Contains(ControlLabel.For("Review again"), text);
        Save(window, $"apply-partly-applied-{theme}");

        cli.On($"apply {plan} --yes --json", Stale, exitCode: 1);
        await apply.ReviewAgainCommand.ExecuteAsync(null);
        apply.ApplyCommand.Execute(null);
        await apply.ConfirmApplyCommand.ExecuteAsync(null);
        Save(window, $"apply-stale-{theme}");

        cli.On($"apply {plan} --yes --json", Applied);
        await apply.ReviewAgainCommand.ExecuteAsync(null);
        apply.ApplyCommand.Execute(null);
        await apply.ConfirmApplyCommand.ExecuteAsync(null);
        text = Texts(window);
        Assert.Contains($"Applied 3 changes to {Repository}.", text);
        Assert.Contains(ControlLabel.For("Back to repositories"), text);
        Save(window, $"apply-applied-{theme}");

        apply.CloseCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(shell.ShowingRepositories);
        Assert.False(repositories.HasUnfinishedApply);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task An_unfinished_apply_shows_on_the_repository_and_asks_to_resume(string theme)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "apply_to: TheLunchTrae/repotted\n");
        var (window, shell, _) = await ShowList(theme);

        Assert.True(shell.Repositories.HasUnfinishedApply);
        var text = Texts(window);
        Assert.Contains("An apply here is not finished.", text);
        Assert.Contains(ControlLabel.For("Resume"), text);
        Save(window, $"repository-unfinished-{theme}");

        shell.Repositories.ResumeApplyCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Unfinished);

        text = Texts(window);
        Assert.Contains($"An apply to {Repository} from orgs is not finished. Resume it, or start over from orgs?", text);
        Assert.Contains(ControlLabel.For("Start over"), text);
        Assert.Contains("Starts from orgs. Nothing changes on GitHub until you apply.", text);
        Save(window, $"apply-unfinished-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Discarding_an_apply_asks_first(string theme)
    {
        var (window, shell, _) = await ShowList(theme);
        shell.Repositories.ChangeSettingsCommand.Execute(null);
        await Until(() => shell.Apply?.Step == ApplyStep.Reviewing);

        shell.Apply!.DiscardCommand.Execute(null);

        var text = Texts(window);
        Assert.Contains(ControlLabel.For("Discard apply"), text);
        Assert.Contains(ControlLabel.For("Keep it"), text);
        Save(window, $"apply-discard-{theme}");
    }

    private async Task<(Window Window, ShellViewModel Shell, FakeCli Cli)> ShowList(string theme)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        var cli = Cli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), $$"""{"profiles":[{"name":"orgs","file":{{Json(@base)}},"extends":null,"problem":null}]}""");
        // A change of settings once starts from the repository as it is.
        cli.On(New(fromProfile: false), () =>
        {
            File.WriteAllText(file, "apply_to: TheLunchTrae/repotted\n");
            return Staged();
        });
        var main = new MainViewModel(cli, new FakeDesktop(), folders.Settings);
        var window = new MainWindow { DataContext = main, Width = 1280, Height = 800 };
        window.Show();
        await main.StartAsync();
        Dispatcher.UIThread.RunJobs();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Repositories.Selected = shell.Repositories.Rows.Single(row => row.FullName == Repository);
        await Until(() => shell.Profiles.Usable.Any() && !shell.Profiles.Loading && !shell.Profiles.Folder.Syncing);
        Dispatcher.UIThread.RunJobs();
        return (window, shell, cli);
    }
}
