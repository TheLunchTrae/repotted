using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using static Repotted.Desktop.Tests.Helpers;

namespace Repotted.Desktop.Tests;

/// <summary>The checks beside the allowed action patterns, and the search under them.</summary>
public sealed class ActionPatternsTests
{
    private const string Actions = """{"pattern":"actions/*","blocks":false,"status":"owner","owner":"actions","owner_type":"organization","all_repositories":true}""";

    private const string MissingTag = """{"pattern":"octo-org/deploy@v9","blocks":false,"status":"missing_ref","repository":"octo-org/deploy","ref":"v9"}""";

    private const string Typo = """{"pattern":"octo-org/deplyo@*","blocks":false,"status":"not_found","missing":"repository","name":"octo-org/deplyo"}""";

    private static readonly SettingField Field = ProfileFields.Sections
        .SelectMany(section => section.Groups).SelectMany(group => group.Fields).Single(field => field.ActionPatterns);

    private static string Checks(params string[] checks) => $$"""{"checks":[{{string.Join(',', checks)}}]}""";

    private static string Check(params string[] patterns) => $"check-actions --json -- {string.Join(' ', patterns)}";

    private static string Find(string words) => $"find-actions --json -- {words}";

    /// <summary>Pauses that end when the test says, in place of waiting for the clock.</summary>
    private sealed class Pauses
    {
        private readonly List<TaskCompletionSource> waiting = [];

        /// <summary>How long each pause that still waits was asked to last.</summary>
        public List<TimeSpan> Waiting { get; } = [];

        public Task Wait(TimeSpan pause, CancellationToken cancellationToken)
        {
            var done = new TaskCompletionSource();
            waiting.Add(done);
            Waiting.Add(pause);
            cancellationToken.Register(() =>
            {
                if (done.TrySetCanceled(cancellationToken))
                {
                    Waiting.Remove(pause);
                }
            });
            return done.Task;
        }

        /// <summary>Ends every pause that still waits, as the clock would.</summary>
        public void End()
        {
            Waiting.Clear();
            foreach (var done in waiting.ToList())
            {
                waiting.Remove(done);
                done.TrySetResult();
            }
        }
    }

    /// <summary>A pattern list that holds <paramref name="patterns"/>, with its checks, read as the editor reads them once it opens.</summary>
    private static (SettingViewModel Row, ActionPatternsViewModel Patterns, Pauses Pauses) Open(
        FakeCli cli,
        string[] patterns,
        Dictionary<string, ActionCheckDocument>? known = null)
    {
        var pauses = new Pauses();
        var row = new SettingViewModel(Field, new JsonArray([.. patterns.Select(pattern => JsonValue.Create(pattern))]), SettingOrigin.Own, null, () => { });
        row.Patterns = new ActionPatternsViewModel(new RepottedClient(cli), row, known ?? new(StringComparer.Ordinal), pauses.Wait);
        row.Patterns.Read();
        return (row, row.Patterns, pauses);
    }

    /// <summary>
    /// Starts a check in <paramref name="editor"/> that never lands, and puts the editor back as saved.
    /// Gives whether the run of the command line behind the check was ended.
    /// </summary>
    internal static async Task<Func<bool>> HoldCheckAsync(ProfileViewModel editor, FakeCli cli)
    {
        CancellationToken? asked = null;
        cli.On(Check("octo-org/held"), cancellationToken =>
        {
            asked = cancellationToken;
            return new TaskCompletionSource<string>().Task;
        });
        var list = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.HasPatterns);
        list.Typed = "octo-org/held";
        // The list is checked once GitHub would show it.
        list.ControlledBy!.Options.Single(option => option.Label == "Selected").ChooseCommand.Execute(null);
        await Until(() => asked is not null);
        editor.ResetCommand.Execute(null);
        Assert.False(editor.HasChanges);
        Assert.False(asked!.Value.IsCancellationRequested);
        return () => asked.Value.IsCancellationRequested;
    }

    private static IEnumerable<string> Notes(ActionPatternsViewModel patterns) => patterns.Lines.Select(line => line.Note.Text);

    [Fact]
    public void A_note_words_a_check_as_the_command_line_does()
    {
        var sha = new string('b', 40);
        ActionCheckDocument[] checks =
        [
            new("actions/setup-*", "owner", Owner: "actions", OwnerType: "organization"),
            new("!octocat/*", "owner", Blocks: true, Owner: "octocat", OwnerType: "user", AllRepositories: true),
            new($"octo-org/deploy@{sha}", "missing_ref", Repository: "octo-org/deploy", Ref: sha),
            new("octo-org/deploy/sub@*", "missing_path", Repository: "octo-org/deploy", Path: "sub"),
            new("!octo-org/deplyo@*", "not_found", Blocks: true, Missing: "repository", Name: "octo-org/deplyo"),
            new("!nobody/*", "not_found", Blocks: true, Missing: "owner", Name: "nobody"),
            new("*", "unchecked", Why: "everything"),
        ];

        // describeActionCheck prints the same after the pattern, in lower case.
        Assert.Equal(
            [
                "Some repositories from actions, an organization",
                "Blocks any repository from octocat, a user",
                "octo-org/deploy has no commit bbbbbbb",
                "octo-org/deploy has no sub folder or file",
                "Blocks no repository octo-org/deplyo you can see",
                "Blocks no owner nobody you can see",
                "Matches every action",
            ],
            checks.Select(check => PatternNote.For(check).Text));
        // The tag shows before the words, which then start as a sentence does.
        var blocked = PatternNote.For(checks[4]);
        Assert.Equal((true, PatternTone.Bad, "No repository octo-org/deplyo you can see"), (blocked.Blocks, blocked.Tone, blocked.Lead));
    }

    [AvaloniaFact]
    public async Task A_list_is_checked_when_it_opens_and_again_once_typing_pauses_for_what_is_new()
    {
        var cli = new FakeCli()
            .On(Check("actions/*", "octo-org/deploy@v9"), Checks(Actions, MissingTag))
            .On(Check("octo-org/deplyo@*"), Checks(Typo));
        var (row, patterns, pauses) = Open(cli, ["actions/*", "octo-org/deploy@v9"]);

        // The first read waits for no pause.
        await Until(() => patterns.Summary == "1 matches, 1 has a missing tag or branch");
        Assert.Empty(pauses.Waiting);
        Assert.Equal(["Any repository from actions, an organization", "octo-org/deploy has no tag or branch v9"], Notes(patterns));
        Assert.Equal((PatternTone.Good, PatternTone.Warning), (patterns.Lines[0].Note.Tone, patterns.Lines[1].Note.Tone));
        Assert.Equal("octo-org/deploy@v9: octo-org/deploy has no tag or branch v9", patterns.Lines[1].AccessibleName);

        // Typing starts the pause again with each change, and a blank line shows nothing.
        row.Typed = "actions/*\n\nocto-org/deploy@v9\n octo-org/deply";
        row.Typed = "actions/*\n\nocto-org/deploy@v9\n octo-org/deplyo@*";
        Assert.Equal([ActionPatternsViewModel.Pause], pauses.Waiting);
        Assert.Equal(["Any repository from actions, an organization", "", "octo-org/deploy has no tag or branch v9", ""], Notes(patterns));
        Assert.Single(cli.Calls);

        // Once it pauses, only the pattern nothing is known about is asked for.
        pauses.End();
        await Until(() => patterns.Summary == "1 matches, 1 has a missing tag or branch, 1 matches nothing");
        Assert.Equal([Check("actions/*", "octo-org/deploy@v9"), Check("octo-org/deplyo@*")], cli.Calls);
        Assert.Equal((PatternTone.Bad, "No repository octo-org/deplyo you can see"), (patterns.Lines[3].Note.Tone, patterns.Lines[3].Note.Text));

        // A pattern checked once is not asked about again, and an emptied list shows no lines.
        row.Typed = "octo-org/deplyo@*";
        Assert.Empty(pauses.Waiting);
        Assert.Equal(["No repository octo-org/deplyo you can see"], Notes(patterns));
        row.Typed = "";
        Assert.Equal((0, ""), (patterns.Lines.Count, patterns.Summary));
    }

    [AvaloniaFact]
    public async Task A_check_that_lands_after_its_line_changed_shows_on_no_other_line()
    {
        var landed = new TaskCompletionSource<string>();
        var cli = new FakeCli()
            .On(Check("octo-org/deplyo@*"), _ => landed.Task)
            .On(Check("actions/*"), Checks(Actions));
        Dictionary<string, ActionCheckDocument> known = new(StringComparer.Ordinal);
        var (row, patterns, pauses) = Open(cli, ["octo-org/deplyo@*"], known);
        Assert.Equal((PatternTone.Checking, "1 being checked"), (patterns.Lines[0].Note.Tone, patterns.Summary));

        // The line changes while its check runs, and the new text is checked beside it.
        row.Typed = "actions/*";
        Assert.Equal(PatternNote.Nothing, patterns.Lines[0].Note);
        pauses.End();
        await Until(() => patterns.Summary == "1 matches");

        landed.SetResult(Checks(Typo));
        await Until(() => known.ContainsKey("octo-org/deplyo@*"));
        Assert.Equal(["Any repository from actions, an organization"], Notes(patterns));

        // The check that landed is kept for its own text, so typing that back asks nothing.
        row.Typed = "octo-org/deplyo@*";
        Assert.Equal(["No repository octo-org/deplyo you can see"], Notes(patterns));
        Assert.Empty(pauses.Waiting);
    }

    [AvaloniaFact]
    public async Task A_check_that_fails_says_why_and_runs_again_only_when_asked()
    {
        const string limited = """{"pattern":"octo-org/deploy@v9","blocks":false,"status":"error","message":"API rate limit exceeded","rate_limited":true}""";
        var cli = new FakeCli()
            .On(Check("actions/*", "octo-org/deploy@v9"), Checks(Actions, limited))
            .On(Check("octo-org/deplyo@*"), """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        var (row, patterns, pauses) = Open(cli, ["actions/*", "octo-org/deploy@v9"]);

        // One pattern's failure leaves the others checked.
        await Until(() => patterns.Summary == "1 matches, 1 could not be checked");
        Assert.Equal((PatternTone.Muted, PatternNote.RateLimit), (patterns.Lines[1].Note.Tone, patterns.Lines[1].Note.Text));

        // A run that fails as a whole says so on each line it asked about, and typing asks for neither again.
        row.Typed = "actions/*\nocto-org/deploy@v9\nocto-org/deplyo@*";
        pauses.End();
        await Until(() => patterns.Summary == "1 matches, 2 could not be checked");
        Assert.Equal("fetch failed", patterns.Lines[2].Note.Text);
        row.Typed = "actions/*\nocto-org/deploy@v9\nocto-org/deplyo@*\n";
        Assert.Empty(pauses.Waiting);
        Assert.Equal(2, cli.Calls.Count);

        // Check again asks at once about every line, what was already known included,
        // so what changed on GitHub since shows: here the misspelled repository was made.
        const string made = """{"pattern":"octo-org/deplyo@*","blocks":false,"status":"match","repository":"octo-org/deplyo","archived":false}""";
        var landed = new TaskCompletionSource<string>();
        cli.On(Check("actions/*", "octo-org/deploy@v9", "octo-org/deplyo@*"), _ => landed.Task);
        Assert.True(patterns.CanCheckAgain);
        patterns.CheckAgainCommand.Execute(null);
        Assert.Equal("3 being checked", patterns.Summary);
        Assert.All(patterns.Lines.Take(3), line => Assert.Equal(PatternNote.Checking, line.Note));
        Assert.Empty(pauses.Waiting);
        // While it runs there is nothing to ask again.
        Assert.False(patterns.CanCheckAgain);
        patterns.CheckAgainCommand.Execute(null);
        Assert.Equal(3, cli.Calls.Count);

        landed.SetResult(Checks(Actions, MissingTag, made));
        await Until(() => patterns.Summary == "2 match, 1 has a missing tag or branch");
        Assert.True(patterns.CanCheckAgain);

        // An empty list, or one of lines that can't be checked, has nothing to check again.
        row.Typed = "octo-org/a, octo-org/b";
        Assert.False(patterns.CanCheckAgain);
    }

    [AvaloniaFact]
    public async Task A_lost_sign_in_tells_the_app_and_shows_on_the_lines()
    {
        var client = new RepottedClient(new FakeCli().On(Check("actions/*"), Documents.SignedOutFailure, exitCode: 1));
        var lost = 0;
        client.SignInLost += (_, _) => lost++;
        var row = new SettingViewModel(Field, new JsonArray("actions/*"), SettingOrigin.Own, null, () => { });
        row.Patterns = new ActionPatternsViewModel(client, row, new(StringComparer.Ordinal));

        row.Patterns.Read();

        await Until(() => lost == 1 && row.Patterns.CanCheckAgain);
        Assert.Equal((1, "Bad credentials"), (lost, row.Patterns.Lines[0].Note.Text));
    }

    [AvaloniaFact]
    public async Task A_list_GitHub_hides_is_checked_once_it_shows()
    {
        var cli = new FakeCli().On(Check("actions/*"), Checks(Actions));
        var allowedField = ProfileFields.Sections.SelectMany(section => section.Groups).SelectMany(group => group.Fields)
            .Single(field => field.Key == Field.DependsOn!.Key);
        SettingViewModel? row = null;
        var allowed = new SettingViewModel(allowedField, JsonValue.Create("all"), SettingOrigin.Own, null, () => row?.Refresh());
        row = new SettingViewModel(Field, new JsonArray("actions/*"), SettingOrigin.Own, null, () => { }) { ControlledBy = allowed };
        allowed.Dependents.Add(row);
        row.Patterns = new ActionPatternsViewModel(new RepottedClient(cli), row, new(StringComparer.Ordinal));

        row.Patterns.Read();
        Assert.True(row.Hidden);
        Assert.Empty(cli.Calls);

        allowed.Choose(allowedField.Options.Single(option => option.Label == "Selected"));
        await Until(() => row.Patterns.Summary == "1 matches");
    }

    [AvaloniaFact]
    public async Task Checks_outlive_the_rows_of_one_load_and_a_dropped_row_drops_what_it_asked()
    {
        var landed = new TaskCompletionSource<string>();
        var asked = default(CancellationToken);
        var cli = new FakeCli().On(Check("actions/*"), cancellationToken =>
        {
            asked = cancellationToken;
            return landed.Task;
        });
        Dictionary<string, ActionCheckDocument> known = new(StringComparer.Ordinal);
        var (row, patterns, pauses) = Open(cli, ["actions/*"], known);

        // Dropping the row ends its run of the command line, and a pause with it.
        row.Typed = "actions/*\nocto-org/deploy@v9";
        Assert.Single(pauses.Waiting);
        patterns.Dispose();
        Assert.True(asked.IsCancellationRequested);
        Assert.Empty(pauses.Waiting);
        landed.SetResult(Checks(Actions));
        await Task.Yield();
        row.Typed = "octo-org/deplyo@*";
        Assert.Single(cli.Calls);

        // The rows of the next load start from what the editor already knows.
        known["actions/*"] = new ActionCheckDocument("actions/*", "owner", Owner: "actions", OwnerType: "organization", AllRepositories: true);
        var (_, again, _) = Open(cli, ["actions/*"], known);
        Assert.Equal(["Any repository from actions, an organization"], Notes(again));
        Assert.Single(cli.Calls);
    }

    [AvaloniaFact]
    public async Task A_line_of_several_patterns_is_not_checked_and_a_long_list_is_checked_in_batches()
    {
        var many = Enumerable.Range(0, 101).Select(index => $"octo-org/a{index}").ToArray();
        string Matches(IEnumerable<string> patterns) => Checks(
            [.. patterns.Select(pattern => $$"""{"pattern":"{{pattern}}","blocks":false,"status":"match","repository":"{{pattern}}","archived":false}""")]);
        var cli = new FakeCli()
            .On(Check(many[..100]), Matches(many[..100]))
            .On(Check(many[100..]), Matches(many[100..]));
        var (row, patterns, _) = Open(cli, many);
        await Until(() => patterns.Summary == "101 match");
        Assert.Equal(2, cli.Calls.Count);

        // Commas separate patterns as GitHub's own box takes them; the checks go by line.
        row.Typed = "octo-org/a0, octo-org/a1";
        Assert.Equal([PatternNote.Several], patterns.Lines.Select(line => line.Note));
        Assert.Equal("1 can't be checked", patterns.Summary);
    }

    [AvaloniaFact]
    public async Task A_search_runs_once_typing_pauses_and_a_newer_one_ends_the_one_before_it()
    {
        var first = new TaskCompletionSource<string>();
        var ended = default(CancellationToken);
        var cli = new FakeCli()
            .On(Check("actions/*"), Checks(Actions))
            .On(Find("setup"), cancellationToken =>
            {
                ended = cancellationToken;
                return first.Task;
            })
            .On(Find("setup dotnet"), Documents.FoundActions);
        var (_, patterns, pauses) = Open(cli, ["actions/*"]);
        var search = patterns.Search;

        // One character is too few to search for.
        search.Query = "s";
        Assert.Empty(pauses.Waiting);
        search.Query = "setup";
        Assert.Equal([ActionSearchViewModel.Pause], pauses.Waiting);
        Assert.False(search.Open);
        pauses.End();
        await Until(() => search.Searching);
        Assert.Equal((true, "Searching…"), (search.Open, search.Status));

        // A newer search ends the run of the one before it, whose answer is dropped.
        search.Query = "setup dotnet";
        Assert.True(ended.IsCancellationRequested);
        // The results go on saying so through the pause, until the newer search starts.
        Assert.Equal((true, true, "Searching…"), (search.Open, search.Searching, search.Status));
        pauses.End();
        await Until(() => search.HasResults);
        first.SetResult("""{"results":[{"repository":"octo-org/stale","description":null,"stars":1,"action_file":null}]}""");
        await Task.Yield();
        Assert.Equal(
            ["actions/setup-dotnet", "actions/setup-node", "microsoft/setup-msbuild", "dotnet/sdk"],
            search.Results.Select(result => result.Repository));
        Assert.Equal((false, null), (search.Searching, search.Status));
        Assert.Equal(("1.1k", "action.yml", true), (search.Results[0].Stars, search.Results[0].ActionNote, search.Results[0].HasActionFile));
        Assert.Equal(("320", "3.0k", "No action.yml at the top"), (search.Results[2].Stars, search.Results[3].Stars, search.Results[3].ActionNote));
        Assert.Equal("dotnet/sdk, Core functionality needed to create .NET Core projects, 3.0k stars, No action.yml at the top", search.Results[3].AccessibleName);
    }

    [AvaloniaFact]
    public async Task Add_puts_a_found_repository_on_a_new_line_once()
    {
        var cli = new FakeCli()
            .On(Check("actions/*", "Actions/Setup-Node@*"), Checks(Actions, Actions))
            .On(Find("setup dotnet"), Documents.FoundActions);
        var (row, patterns, pauses) = Open(cli, ["actions/*", "Actions/Setup-Node@*"]);
        var search = patterns.Search;
        search.Query = "setup dotnet";

        // Enter searches at once, without the pause.
        await search.SubmitCommand.ExecuteAsync(null);
        Assert.Empty(pauses.Waiting);
        var dotnet = search.Results[0];
        // A line that names the repository in another case already holds it.
        Assert.Equal((false, true), (dotnet.Added, search.Results[1].Added));
        Assert.False(search.Results[1].AddCommand.CanExecute(null));

        dotnet.AddCommand.Execute(null);

        Assert.Equal("actions/*\nActions/Setup-Node@*\nactions/setup-dotnet@*", row.Typed);
        Assert.Equal(("Changed", true, false), (row.Note, dotnet.Added, dotnet.AddCommand.CanExecute(null)));
        // The new line is checked like one typed, and removing it offers Add again.
        Assert.Equal([ActionPatternsViewModel.Pause], pauses.Waiting);
        row.Typed = "actions/*";
        Assert.False(dotnet.Added);
    }

    [AvaloniaFact]
    public async Task A_search_says_when_it_finds_nothing_or_fails_and_closing_it_ends_it()
    {
        var held = new TaskCompletionSource<string>();
        var ended = default(CancellationToken);
        var cli = new FakeCli()
            .On(Find("nothing"), """{"results":[]}""")
            .On(Find("limited"), """{"error":{"kind":"error","message":"API rate limit exceeded","rate_limited":true}}""", exitCode: 1)
            .On(Find("offline"), """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1)
            .On(Find("slow"), cancellationToken =>
            {
                ended = cancellationToken;
                return held.Task;
            });
        var (_, patterns, _) = Open(cli, []);
        var search = patterns.Search;

        async Task<string?> Status(string query)
        {
            search.Query = query;
            await search.SubmitCommand.ExecuteAsync(null);
            return search.Status;
        }

        Assert.Equal("GitHub found no repositories for nothing.", await Status("nothing"));
        Assert.Equal("GitHub's search limit is reached. Try again in a minute.", await Status("limited"));
        Assert.Equal("fetch failed", await Status("offline"));
        Assert.Equal((true, false, false), (search.Open, search.HasResults, search.Searching));

        // Escape closes the results and ends the search behind them, and clearing the box closes them too.
        search.Query = "slow";
        var running = search.SubmitCommand.ExecuteAsync(null);
        Assert.True(search.Searching);
        search.CloseCommand.Execute(null);
        Assert.Equal((false, false, true), (search.Open, search.Searching, ended.IsCancellationRequested));
        held.SetResult(Documents.FoundActions);
        await running;
        Assert.Equal((false, false), (search.Open, search.HasResults));
        await Status("nothing");
        search.Query = "";
        Assert.False(search.Open);
    }
}
