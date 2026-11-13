using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>How a line's check reads: its icon and color.</summary>
internal enum PatternTone
{
    /// <summary>Nothing to show: a blank line, or a pattern that waits to be checked.</summary>
    None,

    /// <summary>GitHub is being asked.</summary>
    Checking,

    /// <summary>The pattern names something GitHub has.</summary>
    Good,

    /// <summary>The repository exists, and a part of the pattern doesn't.</summary>
    Warning,

    /// <summary>The pattern matches nothing, or is no pattern.</summary>
    Bad,

    /// <summary>Nothing could be said: a wildcard that names nothing to look up, or a check that failed.</summary>
    Muted,
}

/// <summary>
/// What a line's check says: <paramref name="Name"/> shows bold, between
/// <paramref name="Lead"/> and <paramref name="Tail"/>, after a tag when the
/// pattern <paramref name="Blocks"/>.
/// </summary>
internal sealed record PatternNote(PatternTone Tone, string Lead = "", string Name = "", string Tail = "", bool Blocks = false)
{
    public static readonly PatternNote Nothing = new(PatternTone.None);

    public static readonly PatternNote Checking = new(PatternTone.Checking, "Checking…");

    /// <summary>A line that holds several patterns, which commas separate as GitHub's own box takes them.</summary>
    public static readonly PatternNote Several = new(PatternTone.Muted, "Put each pattern on its own line to check it");

    public const string RateLimit = "GitHub's limit is reached. Try again in a minute.";

    /// <summary>The note in a line, worded as <c>repotted check-actions</c> prints it after the pattern.</summary>
    public string Text => Blocks
        ? $"Blocks {(Lead.Length == 0 ? "" : char.ToLowerInvariant(Lead[0]) + Lead[1..])}{Name}{Tail}"
        : $"{Lead}{Name}{Tail}";

    /// <summary>A check that could not run, in the words of <paramref name="error"/>.</summary>
    public static PatternNote Failed(Exception error) =>
        new(PatternTone.Muted, error is RateLimitedException ? RateLimit : error.Message);

    /// <summary>What <paramref name="check"/> says about its pattern.</summary>
    public static PatternNote For(ActionCheckDocument check) => check.Status switch
    {
        "match" => new(PatternTone.Good, Name: check.Repository ?? "", Tail: Matched(check), Blocks: check.Blocks),
        "owner" => new(
            PatternTone.Good,
            check.AllRepositories ? "Any repository from " : "Some repositories from ",
            check.Owner ?? "",
            check.OwnerType == "organization" ? ", an organization" : ", a user",
            check.Blocks),
        "missing_ref" => new(PatternTone.Warning, Name: check.Repository ?? "", Tail: $" has no {RefWords(check.Ref ?? "")}", Blocks: check.Blocks),
        "missing_path" => new(PatternTone.Warning, Name: check.Repository ?? "", Tail: $" has no {check.Path} folder or file", Blocks: check.Blocks),
        "not_found" => new(
            PatternTone.Bad,
            $"No {(check.Missing == "owner" ? "owner" : "repository")} {check.Name} you can see",
            Blocks: check.Blocks),
        "unchecked" => new(
            PatternTone.Muted,
            check.Why == "everything" ? "Matches every action" : "A wildcard owner can't be checked",
            Blocks: check.Blocks),
        "invalid" => new(PatternTone.Bad, $"Not a pattern: {check.Message}"),
        _ => new(PatternTone.Muted, check.RateLimited ? RateLimit : check.Message ?? "Could not be checked"),
    };

    private static bool IsCommit(string reference) => reference.Length == 40 && reference.All(char.IsAsciiHexDigit);

    private static string RefWords(string reference) =>
        IsCommit(reference) ? $"commit {reference[..7]}" : $"tag or branch {reference}";

    private static string Matched(ActionCheckDocument check) => string.Concat(
        check is { Path: { } path } ? $", {(check.PathKind == "folder" ? "folder" : "file")} {path}" : "",
        check is { Ref: { } reference, RefKind: { } kind } ? $", {kind} {(kind == "commit" ? reference[..Math.Min(7, reference.Length)] : reference)}" : "",
        check.Archived ? ", archived" : "");
}

/// <summary>What the editor shows beside one line of the pattern list.</summary>
internal sealed class PatternLineViewModel : ViewModelBase
{
    /// <summary>The line's pattern, without the spaces around it; empty for a blank line.</summary>
    public string Pattern { get; private set; } = "";

    public PatternNote Note { get; private set; } = PatternNote.Nothing;

    public bool Shown => Note.Tone != PatternTone.None;

    public bool Checking => Note.Tone == PatternTone.Checking;

    public bool Good => Note.Tone == PatternTone.Good;

    public bool Warning => Note.Tone == PatternTone.Warning;

    public bool Bad => Note.Tone == PatternTone.Bad;

    public bool Muted => Note.Tone is PatternTone.Muted or PatternTone.Checking;

    /// <summary>What screen readers hear for the line: its pattern, then what the check says.</summary>
    public string AccessibleName => $"{Pattern}: {Note.Text}";

    public void Show(string pattern, PatternNote note)
    {
        if (!string.Equals(pattern, Pattern, StringComparison.Ordinal) || note != Note)
        {
            Pattern = pattern;
            Note = note;
            OnAllPropertiesChanged();
        }
    }
}

/// <summary>
/// The checks beside the allowed action patterns, and the search under them.
/// Each line of the list gets what its pattern matches on GitHub, once
/// typing pauses. A check belongs to the pattern's text, so a line that
/// changes while its check runs never shows that check, and a pattern checked
/// once is not asked about again while the editor is open, until Check
/// again asks about every line.
/// </summary>
internal sealed partial class ActionPatternsViewModel : ViewModelBase, IDisposable
{
    /// <summary>How long typing pauses before the changed lines are checked.</summary>
    public static readonly TimeSpan Pause = TimeSpan.FromMilliseconds(600);

    /// <summary>The most patterns one run of the command line checks, so its arguments fit what Windows allows.</summary>
    private const int BatchSize = 100;

    private readonly RepottedClient client;

    private readonly SettingViewModel row;

    /// <summary>What each pattern matches, by its text, which outlives this row when the editor loads again.</summary>
    private readonly Dictionary<string, ActionCheckDocument> known;

    private readonly Func<TimeSpan, CancellationToken, Task> wait;

    /// <summary>The patterns a run of the command line is checking now.</summary>
    private readonly HashSet<string> checking = new(StringComparer.Ordinal);

    /// <summary>The patterns whose check failed, with why. They are checked again only when asked.</summary>
    private readonly Dictionary<string, PatternNote> failed = new(StringComparer.Ordinal);

    private readonly CancellationTokenSource closed = new();

    /// <summary>Ends the pause before a check when the list changes again, or has nothing left to check.</summary>
    private CancellationTokenSource? paused;

    private bool read;

    private bool disposed;

    /// <param name="client">Runs the checks and the searches.</param>
    /// <param name="row">The row of the pattern list.</param>
    /// <param name="known">The checks the editor already has, by pattern.</param>
    /// <param name="wait">Waits out a pause in typing; <see cref="Task.Delay(TimeSpan, CancellationToken)"/> when null.</param>
    public ActionPatternsViewModel(
        RepottedClient client,
        SettingViewModel row,
        Dictionary<string, ActionCheckDocument> known,
        Func<TimeSpan, CancellationToken, Task>? wait = null)
    {
        this.client = client;
        this.row = row;
        this.known = known;
        this.wait = wait ?? Task.Delay;
        Search = new ActionSearchViewModel(client, Add, Has, this.wait);
    }

    /// <summary>A line for each line of the list, blank ones included, so each sits beside its own.</summary>
    public ObservableCollection<PatternLineViewModel> Lines { get; } = [];

    /// <summary>The row of the list, whose box the checks sit beside.</summary>
    public SettingViewModel Row => row;

    public ActionSearchViewModel Search { get; }

    /// <summary>The checks in a line, such as "4 match, 1 has a missing tag"; empty for an empty list.</summary>
    public string Summary { get; private set; } = "";

    /// <summary>Whether the list has a line to check and none is being checked, so all can be checked again.</summary>
    public bool CanCheckAgain => checking.Count == 0 && Patterns.Any(Checkable);

    private static string PatternOf(string line) => line.Trim();

    private IEnumerable<string> Patterns => row.Typed.Split('\n').Select(PatternOf);

    /// <summary>Whether a line needs GitHub: not a blank one, and not one that holds several patterns.</summary>
    private static bool Checkable(string pattern) => pattern.Length > 0 && !pattern.Contains(',', StringComparison.Ordinal);

    /// <summary>The patterns in the list that nothing is known about yet.</summary>
    private List<string> Unchecked() =>
    [
        .. Patterns.Where(pattern => Checkable(pattern) && !known.ContainsKey(pattern) && !checking.Contains(pattern) && !failed.ContainsKey(pattern))
            .Distinct(StringComparer.Ordinal),
    ];

    /// <summary>
    /// Reads the list again, after it changed or the row came out of hiding.
    /// Lines show what is known at once. What isn't is checked after a pause,
    /// or at once the first time, and not at all while GitHub hides the row.
    /// </summary>
    public void Read()
    {
        if (disposed)
        {
            return;
        }
        Show();
        Search.Refresh();
        paused?.Cancel();
        paused?.Dispose();
        paused = null;
        if (row.Hidden || Unchecked().Count == 0)
        {
            return;
        }
        paused = CancellationTokenSource.CreateLinkedTokenSource(closed.Token);
        _ = CheckAfterAsync(read ? Pause : TimeSpan.Zero, paused.Token);
        read = true;
    }

    private async Task CheckAfterAsync(TimeSpan pause, CancellationToken cancellationToken)
    {
        try
        {
            if (pause > TimeSpan.Zero)
            {
                await wait(pause, cancellationToken).ConfigureAwait(true);
            }
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await CheckAsync(Unchecked()).ConfigureAwait(true);
    }

    /// <summary>Checks <paramref name="patterns"/>, a batch at a time, and shows each batch as it lands.</summary>
    private async Task CheckAsync(List<string> patterns)
    {
        checking.UnionWith(patterns);
        Show();
        foreach (var batch in patterns.Chunk(BatchSize))
        {
            try
            {
                var checks = await client.CheckActionsAsync(batch, closed.Token).ConfigureAwait(true);
                foreach (var (pattern, check) in batch.Zip(checks))
                {
                    if (check.Status == "error")
                    {
                        failed[pattern] = PatternNote.For(check);
                    }
                    else
                    {
                        known[pattern] = check;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            // The check runs unawaited, so every failure shows on its lines. A lost sign-in has already told the app.
            catch (Exception error)
            {
                foreach (var pattern in batch)
                {
                    failed[pattern] = PatternNote.Failed(error);
                }
            }
            finally
            {
                checking.ExceptWith(batch);
            }
            if (disposed)
            {
                return;
            }
            Show();
        }
    }

    /// <summary>
    /// Checks every line again, at once, dropping what was known about each:
    /// a repository made since, a tag pushed, or another sign-in changes
    /// what GitHub answers.
    /// </summary>
    [RelayCommand]
    private void CheckAgain()
    {
        if (!CanCheckAgain)
        {
            return;
        }
        failed.Clear();
        foreach (var pattern in Patterns)
        {
            known.Remove(pattern);
        }
        read = false;
        Read();
    }

    /// <summary>Shows each line what is known about its pattern now, and counts them.</summary>
    private void Show()
    {
        var patterns = Patterns.ToList();
        // An empty box is no line at all, rather than one blank line.
        if (patterns is [""])
        {
            patterns = [];
        }
        while (Lines.Count > patterns.Count)
        {
            Lines.RemoveAt(Lines.Count - 1);
        }
        while (Lines.Count < patterns.Count)
        {
            Lines.Add(new PatternLineViewModel());
        }
        foreach (var (line, pattern) in Lines.Zip(patterns))
        {
            line.Show(pattern, NoteFor(pattern));
        }
        Summary = Summarize();
        OnPropertyChanged(nameof(Summary));
        OnPropertyChanged(nameof(CanCheckAgain));
    }

    private PatternNote NoteFor(string pattern) => pattern switch
    {
        "" => PatternNote.Nothing,
        _ when !Checkable(pattern) => PatternNote.Several,
        _ when known.TryGetValue(pattern, out var check) => PatternNote.For(check),
        _ when failed.TryGetValue(pattern, out var note) => note,
        _ when checking.Contains(pattern) => PatternNote.Checking,
        _ => PatternNote.Nothing,
    };

    private string Summarize()
    {
        var checkable = Lines.Select(line => line.Pattern).Where(Checkable).ToList();
        int Count(Func<ActionCheckDocument, bool> counts) =>
            checkable.Count(pattern => known.TryGetValue(pattern, out var check) && counts(check));
        var unknown = checkable.Where(pattern => !known.ContainsKey(pattern)).ToList();
        return string.Join(", ", new[]
        {
            Count(check => check.Status is "match" or "owner") switch { 0 => null, 1 => "1 matches", var count => $"{count} match" },
            Count(check => check.Status == "missing_ref") switch { 0 => null, 1 => "1 has a missing tag or branch", var count => $"{count} have a missing tag or branch" },
            Count(check => check.Status == "missing_path") switch { 0 => null, 1 => "1 has a missing folder or file", var count => $"{count} have a missing folder or file" },
            Count(check => check.Status is "not_found" or "invalid") switch { 0 => null, 1 => "1 matches nothing", var count => $"{count} match nothing" },
            (Count(check => check.Status == "unchecked") + Lines.Count(line => line.Note == PatternNote.Several)) switch
            {
                0 => null,
                var count => $"{count} can't be checked",
            },
            unknown.Count(failed.ContainsKey) switch { 0 => null, var count => $"{count} could not be checked" },
            unknown.Count(checking.Contains) switch { 0 => null, var count => $"{count} being checked" },
        }.OfType<string>());
    }

    /// <summary>Whether the list holds <paramref name="pattern"/> on a line of its own, in any case, as GitHub reads names.</summary>
    private bool Has(string pattern) => Patterns.Contains(pattern, StringComparer.OrdinalIgnoreCase);

    /// <summary>Puts <paramref name="pattern"/> on a new line at the end of the list, which changes the setting as typing it would.</summary>
    private void Add(string pattern)
    {
        if (!Has(pattern))
        {
            var text = row.Typed.TrimEnd();
            row.Typed = text.Length == 0 ? pattern : $"{text}\n{pattern}";
        }
    }

    /// <summary>Ends the pause, the checks and the search under way; what they find is dropped.</summary>
    public void Dispose()
    {
        if (!disposed)
        {
            disposed = true;
            closed.Cancel();
            closed.Dispose();
            paused?.Dispose();
            Search.Dispose();
        }
    }
}
