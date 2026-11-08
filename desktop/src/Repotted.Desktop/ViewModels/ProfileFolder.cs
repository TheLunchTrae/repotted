using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Where the profiles live: the profiles folder, or the app's copy of a
/// GitHub config repository, which syncs on every refresh and commits each
/// save. Every write to the folder and every sync takes its turn here, so a
/// sync never reads a file being written. It runs on the UI thread.
/// </summary>
/// <param name="client">Syncs the copy with the config repository.</param>
/// <param name="settings">Says which folder or repository the app used last.</param>
internal sealed partial class ProfileFolder(RepottedClient client, AppSettings settings) : ViewModelBase
{
    /// <summary>The writes and syncs, one at a time, so a save made during a refresh commits after it.</summary>
    private readonly SerialQueue turns = new();

    /// <summary>Set once the app this folder belongs to is left; a sync then does nothing.</summary>
    private bool stopped;

    /// <summary>The folder the app lists and edits: the profiles folder, or its copy of the config repository.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SourceText), nameof(EmptyMessage))]
    public partial string Path { get; private set; } = StartFolder(settings);

    /// <summary>The config repository profiles live in, as <c>owner/name</c>; null when they live in a local folder.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UsesRepository), nameof(SourceLabel), nameof(SourceText), nameof(RepositoryLabel), nameof(RefreshLabel), nameof(ListLabel), nameof(EmptyMessage))]
    public partial string? Repository { get; private set; } = settings.Load().ConfigRepository;

    /// <summary>The folder in the config repository; empty for its root.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SourceText), nameof(EmptyMessage))]
    public partial string RepositoryPath { get; private set; } = settings.Load().ConfigPath ?? "";

    public bool UsesRepository => Repository is not null;

    public string SourceLabel => UsesRepository ? "GitHub repository:" : "Profiles folder:";

    /// <summary>Where the profiles live, as the user named it.</summary>
    public string SourceText => Repository is null ? Path : RepositoryPath.Length == 0 ? Repository : $"{Repository}/{RepositoryPath}";

    public string RepositoryLabel => UsesRepository ? "Change repository" : "Use a GitHub repository";

    public string RefreshLabel => UsesRepository ? "Sync now" : "Refresh";

    /// <summary>The heading over the list of profiles in the sidebar.</summary>
    public string ListLabel => UsesRepository ? "In this repository" : "In this folder";

    public string EmptyMessage => $"No profiles in {SourceText} yet.";

    private static string StartFolder(AppSettings settings)
    {
        var saved = settings.Load();
        return saved.ConfigRepository is { } repository
            ? settings.ConfigFolder(repository, saved.ConfigPath ?? "")
            : saved.ProfilesFolder ?? AppSettings.DefaultProfilesFolder();
    }

    /// <summary>How the last sync with the config repository went; null when there is nothing to say.</summary>
    [ObservableProperty]
    public partial string? SyncNote { get; private set; }

    /// <summary>Whether the last sync failed, so the folder may be behind GitHub or hold saves GitHub does not have yet.</summary>
    [ObservableProperty]
    public partial bool SyncFailed { get; private set; }

    [ObservableProperty]
    public partial bool Syncing { get; private set; }

    /// <summary>The files that changed both here and on GitHub since the last sync, which wait for the user to pick a side.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasConflicts), nameof(ConflictMessage))]
    public partial IReadOnlyList<string> Conflicts { get; private set; } = [];

    public bool HasConflicts => Conflicts.Count > 0;

    public string ConflictMessage => Conflicts.Count == 1
        ? $"{Conflicts[0]} changed here and on GitHub since the last sync. Keep which version?"
        : $"These files changed here and on GitHub since the last sync: {string.Join(", ", Conflicts)}. Keep which versions?";

    /// <summary>Ends once the write or sync running now, and any queued behind it, ends.</summary>
    public Task Idle => turns.Idle;

    /// <summary>Keeps any later sync from starting, once the app this folder belongs to is left.</summary>
    public void Stop() => stopped = true;

    /// <summary>
    /// Runs work that writes the folder, such as a save or the move of a
    /// finished capture to its profile's name, once the sync before it ends,
    /// and holds the next sync until it ends. So a sync never reads a file
    /// being written, and never pulls a file over one being moved into place.
    /// </summary>
    public Task WriteAsync(Func<Task> work) => turns.RunAsync(work);

    /// <summary>
    /// Syncs the folder with the config repository, if profiles live in one,
    /// and says how it went. Null when it failed, or the profiles moved
    /// elsewhere while it ran.
    /// </summary>
    public async Task<SyncDocument?> SyncAsync(string? prefer, IReadOnlyList<string>? only)
    {
        if (Repository is null)
        {
            return null;
        }
        var folder = Path;
        return await turns.RunAsync<SyncDocument?>(async () =>
        {
            try
            {
                if (stopped || folder != Path)
                {
                    return null;
                }
                Syncing = true;
                var result = await client.SyncAsync(folder, null, null, prefer, only, CancellationToken.None).ConfigureAwait(true);
                if (folder != Path)
                {
                    return null;
                }
                ShowSync(result);
                return result;
            }
            catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
            {
                if (folder == Path)
                {
                    SyncFailed = true;
                    SyncNote = $"Not synced with GitHub. Saves stay on this computer until a sync works. {error.Message}";
                }
                return null;
            }
            finally
            {
                Syncing = false;
            }
        }).ConfigureAwait(true);
    }

    /// <summary>Moves to the app's copy of <paramref name="repository"/>, which a first sync just made, and shows how that sync went.</summary>
    public void UseRepository(string repository, string path, SyncDocument result)
    {
        Repository = repository;
        RepositoryPath = path;
        Path = settings.ConfigFolder(repository, path);
        ShowSync(result);
    }

    /// <summary>Moves to a local folder, which leaves any config repository and what its syncs said.</summary>
    public void UseFolder(string folder)
    {
        Path = folder;
        Repository = null;
        RepositoryPath = "";
        Conflicts = [];
        SyncNote = null;
        SyncFailed = false;
    }

    private void ShowSync(SyncDocument result)
    {
        SyncFailed = false;
        Conflicts = result.Conflicts;
        var committed = result.Pushed.Count switch
        {
            0 => null,
            1 => $"Committed {result.Pushed[0]} to {result.Branch}.",
            var count => $"Committed {count} files to {result.Branch}.",
        };
        // The banner asks about the conflicts, so the note only says what did sync.
        SyncNote = committed ?? (result.Conflicts.Count > 0 ? $"Everything else is in sync with {result.Branch}." : $"In sync with {result.Branch} on GitHub.");
    }
}
