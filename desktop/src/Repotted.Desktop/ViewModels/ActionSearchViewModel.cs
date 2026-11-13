using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A repository a search found, which Add puts in the pattern list as <c>owner/repository@*</c>.</summary>
internal sealed partial class FoundActionViewModel(FoundActionDocument found, Action<string> add, Func<string, bool> has) : ViewModelBase
{
    public string Repository => found.Repository;

    /// <summary>The pattern Add puts in the list: every ref of the repository.</summary>
    public string Pattern => $"{found.Repository}@*";

    public string Description => found.Description ?? "";

    public bool HasDescription => !string.IsNullOrWhiteSpace(found.Description);

    /// <summary>The stars in short, such as 320 or 1.1k.</summary>
    public string Stars => found.Stars < 1000
        ? found.Stars.ToString(CultureInfo.InvariantCulture)
        : $"{(found.Stars / 1000.0).ToString("0.0", CultureInfo.InvariantCulture)}k";

    public bool HasActionFile => found.ActionFile is not null;

    public string ActionNote => found.ActionFile ?? "No action.yml at the top";

    /// <summary>Whether the list already holds the pattern on a line of its own.</summary>
    public bool Added => has(Pattern);

    public string AddName => $"Add {Pattern} to the allowed action patterns";

    /// <summary>What screen readers hear for the result.</summary>
    public string AccessibleName => string.Join(", ", new[]
    {
        Repository,
        HasDescription ? Description : null,
        $"{Stars} stars",
        HasActionFile ? $"has {found.ActionFile}" : ActionNote,
        Added ? "added" : null,
    }.OfType<string>());

    [RelayCommand(CanExecute = nameof(CanAdd))]
    private void Add() => add(Pattern);

    private bool CanAdd() => !Added;

    public void Refresh()
    {
        OnPropertyChanged(nameof(Added));
        OnPropertyChanged(nameof(AccessibleName));
        AddCommand.NotifyCanExecuteChanged();
    }
}

/// <summary>
/// The search under the pattern list: it asks GitHub for repositories once
/// typing pauses, or at once on Enter, and lists them to add. One search runs
/// at a time, and a newer one ends the one before it.
/// </summary>
/// <param name="client">Runs the search.</param>
/// <param name="add">Puts a pattern in the list.</param>
/// <param name="has">Whether the list holds a pattern already.</param>
/// <param name="wait">Waits out a pause in typing.</param>
internal sealed partial class ActionSearchViewModel(
    RepottedClient client,
    Action<string> add,
    Func<string, bool> has,
    Func<TimeSpan, CancellationToken, Task> wait) : ViewModelBase, IDisposable
{
    /// <summary>How long typing pauses before the search runs.</summary>
    public static readonly TimeSpan Pause = TimeSpan.FromMilliseconds(500);

    /// <summary>The fewest characters a search that starts by itself takes.</summary>
    private const int MinimumLength = 2;

    /// <summary>Ends the search under way, its pause included, when a newer one starts or the results close.</summary>
    private CancellationTokenSource? running;

    private bool disposed;

    [ObservableProperty]
    public partial string Query { get; set; } = "";

    /// <summary>Whether the results show under the box.</summary>
    [ObservableProperty]
    public partial bool Open { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasResults))]
    public partial IReadOnlyList<FoundActionViewModel> Results { get; private set; } = [];

    public bool HasResults => Results.Count > 0;

    /// <summary>What shows in place of results: that a search runs, found nothing, or failed.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasStatus))]
    public partial string? Status { get; private set; }

    public bool HasStatus => Status is not null;

    /// <summary>Whether a search is under way, or about to start for text typed during one, which the results show.</summary>
    [ObservableProperty]
    public partial bool Searching { get; private set; }

    private string Words => Query.Trim();

    partial void OnQueryChanged(string value)
    {
        if (Words.Length < MinimumLength)
        {
            Stop();
            Open = false;
            return;
        }
        _ = SearchAsync(Pause);
    }

    /// <summary>Closing the results, as Escape or a click elsewhere does, ends the search behind them.</summary>
    partial void OnOpenChanged(bool value)
    {
        if (!value)
        {
            Stop();
        }
    }

    /// <summary>Searches at once, as Enter does, for anything typed.</summary>
    [RelayCommand]
    private Task SubmitAsync() => Words.Length == 0 ? Task.CompletedTask : SearchAsync(TimeSpan.Zero);

    [RelayCommand]
    private void Close() => Open = false;

    private void Stop()
    {
        running?.Cancel();
        running?.Dispose();
        running = null;
        Searching = false;
    }

    private async Task SearchAsync(TimeSpan pause)
    {
        if (disposed)
        {
            return;
        }
        // Text typed during a search keeps the results saying so until its own search starts.
        var searching = Searching;
        Stop();
        Searching = searching;
        var mine = running = new CancellationTokenSource();
        var cancellationToken = mine.Token;
        var words = Words;
        try
        {
            if (pause > TimeSpan.Zero)
            {
                await wait(pause, cancellationToken).ConfigureAwait(true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            Results = [];
            Status = "Searching…";
            Searching = true;
            Open = true;
            var found = await client.FindActionsAsync(words, cancellationToken).ConfigureAwait(true);
            // A newer search, or closing the results, has ended this one, whatever the command line still printed.
            cancellationToken.ThrowIfCancellationRequested();
            Results = [.. found.Select(result => new FoundActionViewModel(result, add, has))];
            Status = found.Count == 0 ? $"GitHub found no repositories for {words}." : null;
        }
        catch (OperationCanceledException)
        {
            return;
        }
        // The search runs unawaited, so every failure shows here. A lost sign-in has already told the app.
        catch (Exception error)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            Results = [];
            Status = error is RateLimitedException ? "GitHub's search limit is reached. Try again in a minute." : error.Message;
        }
        if (running == mine)
        {
            Searching = false;
        }
    }

    /// <summary>Tells each result to read again whether the list holds it.</summary>
    public void Refresh()
    {
        foreach (var result in Results)
        {
            result.Refresh();
        }
    }

    public void Dispose()
    {
        if (!disposed)
        {
            disposed = true;
            Stop();
        }
    }
}
