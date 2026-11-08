using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A profile in the sidebar list.</summary>
internal sealed class ProfileItemViewModel(ProfileListingDocument listing, string? baseName)
{
    public ProfileListingDocument Listing => listing;

    public string? BaseName => baseName;

    public string Name => Listing.Name;

    public bool Invalid => Listing.Problem is not null;

    /// <summary>The note beside the name: what it extends, or that it cannot be used.</summary>
    public string Note => Invalid ? "Has a problem" : BaseName is null ? "" : $"extends {BaseName}";
}

/// <summary>
/// The profiles in the profiles folder, which the user picks and the app
/// remembers. It starts as Documents/Repotted. Profiles can live in a GitHub
/// config repository instead: the app then works in its own copy of them,
/// syncs it on every refresh, and commits each save. Each profile opens in an
/// editor, and an editor keeps its unsaved edits while another profile is
/// open. A new profile starts empty, from another profile, or from a repository.
/// </summary>
/// <param name="client">Lists, reads and saves profiles, and captures new ones.</param>
/// <param name="desktop">Asks for a folder.</param>
/// <param name="settings">Remembers the folder.</param>
/// <param name="repositories">The repositories a new profile can be captured from, by full name.</param>
internal sealed partial class ProfilesViewModel(
    RepottedClient client,
    IDesktop desktop,
    AppSettings settings,
    Func<IReadOnlyList<string>> repositories)
    : ViewModelBase
{
    private readonly Dictionary<string, ProfileViewModel> editors = [];

    /// <summary>New profile forms that may still hold a file while they capture, open or closed.</summary>
    private readonly List<NewProfileViewModel> forms = [];

    /// <summary>The file a refresh selects, such as a profile just made.</summary>
    private string? select;

    private IReadOnlyList<ProfileItemViewModel> all = [];

    private int refreshes;

    /// <summary>
    /// The sync that runs last, which the next one waits for, so a save made
    /// during a refresh commits after it. The view model runs on the UI thread.
    /// </summary>
    private Task lastSync = Task.CompletedTask;

    private const string SyncRecord = ".repotted-sync.json";

    public ObservableCollection<ProfileItemViewModel> Items { get; } = [];

    /// <summary>Every profile without a problem, whatever the search, for a compare.</summary>
    [ObservableProperty]
    public partial IReadOnlyList<ProfileItemViewModel> Usable { get; private set; } = [];

    /// <summary>The folder the app lists and edits: the profiles folder, or its copy of the config repository.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(SourceText), nameof(EmptyMessage))]
    public partial string Folder { get; private set; } = StartFolder(settings);

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
    public string SourceText => Repository is null ? Folder : RepositoryPath.Length == 0 ? Repository : $"{Repository}/{RepositoryPath}";

    public string RepositoryLabel => UsesRepository ? "Change repository" : "Use a GitHub repository";

    public string RefreshLabel => UsesRepository ? "Sync now" : "Refresh";

    /// <summary>The heading over the list of profiles in the sidebar.</summary>
    public string ListLabel => UsesRepository ? "In this repository" : "In this folder";

    private static string StartFolder(AppSettings settings)
    {
        var saved = settings.Load();
        return saved.ConfigRepository is { } repository
            ? settings.ConfigFolder(repository, saved.ConfigPath ?? "")
            : saved.ProfilesFolder ?? AppSettings.DefaultProfilesFolder();
    }

    /// <summary>How the last sync with the config repository went; null when there is nothing to say.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowSyncNote), nameof(ShowSyncDone), nameof(ShowSyncProblem))]
    public partial string? SyncNote { get; private set; }

    /// <summary>Whether the note shows under the list; a failure that leaves nothing to list shows as the error instead.</summary>
    public bool ShowSyncNote => SyncNote is not null && Error is null;

    public bool ShowSyncDone => ShowSyncNote && !SyncFailed;

    public bool ShowSyncProblem => ShowSyncNote && SyncFailed;

    /// <summary>Whether the last sync failed, so the folder may be behind GitHub or hold saves GitHub does not have yet.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowSyncDone), nameof(ShowSyncProblem))]
    public partial bool SyncFailed { get; private set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(KeepMineCommand), nameof(UseGitHubsCommand))]
    public partial bool Syncing { get; private set; }

    /// <summary>The files that changed both here and on GitHub since the last sync, which wait for the user to pick a side.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasConflicts), nameof(ConflictMessage))]
    public partial IReadOnlyList<string> Conflicts { get; private set; } = [];

    public bool HasConflicts => Conflicts.Count > 0;

    public string ConflictMessage => Conflicts.Count == 1
        ? $"{Conflicts[0]} changed here and on GitHub since the last sync. Keep which version?"
        : $"These files changed here and on GitHub since the last sync: {string.Join(", ", Conflicts)}. Keep which versions?";

    /// <summary>The form that moves the profiles to a config repository, which stands in for the editor until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowConnecting))]
    public partial ConfigRepositoryViewModel? Connecting { get; private set; }

    public bool ShowConnecting => Connecting is not null;

    // However the form closes, a first sync it started stops with it.
    partial void OnConnectingChanged(ConfigRepositoryViewModel? oldValue, ConfigRepositoryViewModel? newValue) => oldValue?.Dispose();

    [ObservableProperty]
    public partial ProfileItemViewModel? Selected { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowProfile))]
    public partial ProfileViewModel? Current { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowSyncNote), nameof(ShowSyncDone), nameof(ShowSyncProblem))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(HasProfiles))]
    public partial int Count { get; set; }

    public bool HasProfiles => Count > 0;

    public bool ShowEmpty => !Loading && Error is null && Count == 0 && Creating is null && Connecting is null;

    public bool ShowProfile => !Loading && Error is null && Current is not null && Creating is null && Connecting is null;

    /// <summary>The new profile form, which stands in for the editor until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowCreating))]
    public partial NewProfileViewModel? Creating { get; private set; }

    public bool ShowCreating => Creating is not null;

    // However the form closes, a capture it started stops with it.
    partial void OnCreatingChanged(NewProfileViewModel? oldValue, NewProfileViewModel? newValue) => oldValue?.Dispose();

    /// <summary>What a capture could not read, shown over the profile it made until another one opens.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCaptured))]
    public partial string? Captured { get; private set; }

    public bool HasCaptured => Captured is not null;

    /// <summary>Opens the new profile form, to capture <paramref name="repository"/> when one is given.</summary>
    [RelayCommand]
    public void StartNew(string? repository)
    {
        Captured = null;
        Connecting = null;
        // Nothing stays selected, so choosing any profile in the list leaves the form.
        Selected = null;
        forms.RemoveAll(form => form.Holding is null);
        Creating = new NewProfileViewModel(client, Folder, Usable, repositories(), repository, CreatedAsync, CancelNew, Released);
        forms.Add(Creating);
    }

    /// <summary>Closes the new profile form, back to the profile that was open.</summary>
    public void CancelNew()
    {
        if (Creating is null)
        {
            return;
        }
        Creating = null;
        Selected = Items.FirstOrDefault(item => item.Listing.File == Current?.File);
    }

    /// <summary>A folder's path in one form, with no separator at its end, as a picker may give one.</summary>
    private static string SameFolder(string folder) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));

    /// <summary>A closed form gave up the name it held, so the open one may now take it.</summary>
    private void Released() => Creating?.Recheck();

    private async Task CreatedAsync(string file, IReadOnlyList<string> warnings)
    {
        Creating = null;
        select = file;
        await RefreshAsync().ConfigureAwait(true);
        if (warnings.Count > 0)
        {
            Captured = $"Repotted could not read all of the repository, so this profile leaves out:\n{string.Join("\n", warnings)}";
        }
    }

    public string EmptyMessage => $"No profiles in {SourceText} yet.";

    /// <summary>Opens the form that makes a GitHub repository the place profiles live.</summary>
    [RelayCommand]
    public void StartConnect()
    {
        Creating = null;
        Captured = null;
        Selected = null;
        Connecting = new ConfigRepositoryViewModel(
            client,
            settings,
            repositories(),
            Repository is null ? null : (Repository, RepositoryPath),
            Repository is null && Count > 0 ? Folder : null,
            ConnectedAsync,
            CancelConnect);
    }

    /// <summary>Closes the repository form, back to the profile that was open.</summary>
    public void CancelConnect()
    {
        if (Connecting is null)
        {
            return;
        }
        Connecting = null;
        Selected = Items.FirstOrDefault(item => item.Listing.File == Current?.File);
    }

    private async Task ConnectedAsync(string repository, string path, SyncDocument result, IReadOnlyList<string> skipped)
    {
        Notice = skipped.Count == 0
            ? null
            : $"Did not add {string.Join(", ", skipped)} from the profiles folder, because {repository} already had {(skipped.Count == 1 ? "a file" : "files")} of that name.";
        try
        {
            settings.Save(settings.Load() with { ConfigRepository = repository, ConfigPath = path });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Notice = $"Repotted could not remember this repository for next time: {error.Message}";
        }
        Connecting = null;
        Repository = repository;
        RepositoryPath = path;
        Folder = settings.ConfigFolder(repository, path);
        ShowSync(result);
        Selected = null;
        await LoadAsync(sync: false).ConfigureAwait(true);
    }

    /// <summary>Keeps this computer's version of each file in conflict, and commits it.</summary>
    [RelayCommand(CanExecute = nameof(CanSettle))]
    private Task KeepMineAsync() => SettleAsync("local");

    /// <summary>Takes GitHub's version of each file in conflict, over this computer's.</summary>
    [RelayCommand(CanExecute = nameof(CanSettle))]
    private Task UseGitHubsAsync() => SettleAsync("remote");

    private bool CanSettle() => !Syncing;

    /// <summary>Settles the files the banner names; a file that came into conflict since then waits for its own choice.</summary>
    private async Task SettleAsync(string prefer)
    {
        if (await SyncAsync(prefer, Conflicts).ConfigureAwait(true) is not null)
        {
            await LoadAsync(sync: false).ConfigureAwait(true);
        }
    }

    /// <summary>Commits a save to the config repository, and shows what the sync brought back from GitHub.</summary>
    private async Task SavedAsync()
    {
        if (await SyncAsync(null, null).ConfigureAwait(true) is { Pulled.Count: > 0 })
        {
            await LoadAsync(sync: false).ConfigureAwait(true);
        }
    }

    /// <summary>
    /// Runs a save once the sync before it ends, and holds the next sync until
    /// it ends, so a sync never reads a file a save is writing.
    /// </summary>
    private async Task ExclusiveAsync(Func<Task> work)
    {
        var previous = lastSync;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lastSync = done.Task;
        try
        {
            await previous.ConfigureAwait(true);
            await work().ConfigureAwait(true);
        }
        finally
        {
            done.SetResult();
        }
    }

    /// <summary>
    /// Syncs the folder with the config repository, if profiles live in one,
    /// and says how it went. Null when it failed, or the profiles moved
    /// elsewhere while it ran.
    /// </summary>
    private async Task<SyncDocument?> SyncAsync(string? prefer, IReadOnlyList<string>? only)
    {
        if (Repository is null)
        {
            return null;
        }
        var folder = Folder;
        var previous = lastSync;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lastSync = done.Task;
        try
        {
            await previous.ConfigureAwait(true);
            if (folder != Folder)
            {
                return null;
            }
            Syncing = true;
            var result = await client.SyncAsync(folder, null, null, prefer, only, CancellationToken.None).ConfigureAwait(true);
            if (folder != Folder)
            {
                return null;
            }
            ShowSync(result);
            return result;
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            if (folder == Folder)
            {
                SyncFailed = true;
                SyncNote = $"Not synced with GitHub. Saves stay on this computer until a sync works. {error.Message}";
            }
            return null;
        }
        finally
        {
            Syncing = false;
            done.SetResult();
        }
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

    /// <summary>Narrows the sidebar list by name.</summary>
    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    /// <summary>Why the app could not remember the folder; the folder is still used until the app closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNotice))]
    public partial string? Notice { get; set; }

    public bool HasNotice => Notice is not null;

    partial void OnSelectedChanged(ProfileItemViewModel? value)
    {
        if (value is not null)
        {
            Creating = null;
            if (value.Listing.File != Current?.File)
            {
                Captured = null;
            }
            Open(value.Listing);
        }
    }

    /// <summary>Shows a profile's editor, made and loaded the first time the profile opens.</summary>
    private void Open(ProfileListingDocument listing)
    {
        if (!editors.TryGetValue(listing.File, out var editor))
        {
            editor = new ProfileViewModel(client, listing, SavedAsync, ExclusiveAsync);
            editors[listing.File] = editor;
            _ = editor.LoadCommand.ExecuteAsync(null);
        }
        Current = editor;
    }

    /// <summary>Lists the profiles again, after a sync with the config repository when they live in one.</summary>
    [RelayCommand]
    public Task RefreshAsync() => LoadAsync(sync: true);

    private async Task LoadAsync(bool sync)
    {
        // A refresh started later, such as for a newly chosen folder, wins over one still running.
        var refresh = ++refreshes;
        var folder = Folder;
        Loading = true;
        Error = null;
        try
        {
            if (Repository is not null)
            {
                if (sync)
                {
                    await SyncAsync(null, null).ConfigureAwait(true);
                    if (refresh != refreshes)
                    {
                        return;
                    }
                }
                // A copy that never synced has nothing to show, only why.
                if (!File.Exists(Path.Combine(folder, SyncRecord)))
                {
                    Error = SyncNote ?? $"Repotted has not synced with {SourceText} yet.";
                    return;
                }
            }
            // The default folder is the app's to make; a folder the user picked already exists.
            else if (settings.Load().ProfilesFolder is null)
            {
                Directory.CreateDirectory(folder);
            }
            var listed = await client.ProfilesAsync(folder, CancellationToken.None).ConfigureAwait(true);
            if (refresh != refreshes)
            {
                return;
            }
            // A capture still running holds its file empty, so the file is not a
            // profile yet; one that runs on in a folder left behind holds nothing here.
            var held = forms
                .Select(form => form.Holding)
                .OfType<string>()
                .Where(file => string.Equals(SameFolder(Path.GetDirectoryName(file)!), SameFolder(folder), StringComparison.Ordinal))
                .Select(Path.GetFileNameWithoutExtension)
                .ToHashSet(StringComparer.Ordinal);
            var listings = listed.Where(listing => !held.Contains(listing.Name)).ToList();
            // A linked file is listed under its real path, so two names can share one file.
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var listing in listings)
            {
                names.TryAdd(listing.File, listing.Name);
            }
            all =
            [
                .. listings.Select(listing => new ProfileItemViewModel(
                    listing,
                    listing.Extends is null ? null : names.GetValueOrDefault(listing.Extends) ?? Path.GetFileNameWithoutExtension(listing.Extends))),
            ];
            Count = all.Count;
            Usable = [.. all.Where(item => !item.Invalid)];
            // Editors start over from the file, which may have changed outside
            // the app, unless they hold edits that are not saved yet; those
            // check whether saving would undo a change to the file.
            foreach (var (file, editor) in editors.ToList())
            {
                if (!editor.HasChanges || !names.ContainsKey(file))
                {
                    editors.Remove(file);
                }
                else
                {
                    editor.CheckFile();
                }
            }
            // The CLI lists real paths, and the folder's own path may not be one,
            // so a new file is found by its name in the folder.
            var keep = select is null
                ? Current?.File
                : listings.FirstOrDefault(listing => listing.Name == Path.GetFileNameWithoutExtension(select))?.File;
            select = null;
            Current = null;
            ApplyFilter();
            // The new profile form stays open, and nothing in the list is selected under it.
            var creating = Creating is not null;
            if (Items.FirstOrDefault(item => item.Listing.File == keep) is { } shown)
            {
                if (!creating)
                {
                    Selected = shown;
                }
                Open(shown.Listing);
            }
            else if (all.FirstOrDefault(item => item.Listing.File == keep) is { } hidden)
            {
                // The search hides it, but it stays open.
                Open(hidden.Listing);
            }
            else if (Items.FirstOrDefault() is { } first)
            {
                if (!creating)
                {
                    Selected = first;
                }
                Open(first.Listing);
            }
            else
            {
                Selected = null;
            }
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            if (refresh == refreshes)
            {
                Error = error.Message;
            }
        }
        finally
        {
            if (refresh == refreshes)
            {
                Loading = false;
            }
        }
    }

    [RelayCommand]
    private async Task ChangeFolderAsync()
    {
        if (await desktop.PickFolderAsync("Choose the profiles folder").ConfigureAwait(true) is not { } folder)
        {
            return;
        }
        Notice = null;
        Captured = null;
        Creating = null;
        Connecting = null;
        try
        {
            settings.Save(settings.Load() with { ProfilesFolder = folder, ConfigRepository = null, ConfigPath = null });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Notice = $"Repotted could not remember this folder for next time: {error.Message}";
        }
        Folder = folder;
        Repository = null;
        RepositoryPath = "";
        Conflicts = [];
        SyncNote = null;
        SyncFailed = false;
        Selected = null;
        await RefreshAsync().ConfigureAwait(true);
    }

    private void ApplyFilter()
    {
        var keep = Selected;
        Items.Clear();
        foreach (var item in all.Where(item => item.Name.Contains(Filter.Trim(), StringComparison.OrdinalIgnoreCase)))
        {
            Items.Add(item);
        }
        if (keep is not null && Items.Contains(keep))
        {
            Selected = keep;
        }
    }
}
