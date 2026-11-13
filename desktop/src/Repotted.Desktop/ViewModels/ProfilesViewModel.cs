using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Security.Cryptography;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A profile in the sidebar list, which its menu and the delete shortcut can ask to delete.</summary>
internal sealed partial class ProfileItemViewModel(
    ProfileListingDocument listing,
    string? baseName,
    bool removed = false,
    Action<ProfileItemViewModel>? delete = null,
    Func<bool>? canDelete = null)
{
    public ProfileListingDocument Listing => listing;

    /// <summary>A removed profile has no file to delete; Discard in its editor lets it go.</summary>
    [RelayCommand(CanExecute = nameof(CanDelete))]
    private void Delete() => delete?.Invoke(this);

    private bool CanDelete() => delete is not null && !Removed && (canDelete?.Invoke() ?? true);

    public string? BaseName => baseName;

    public string Name => Listing.Name;

    public bool Invalid => Listing.Problem is not null;

    /// <summary>Whether the file is gone, and only an editor's unsaved edits keep the profile in the list.</summary>
    public bool Removed => removed;

    /// <summary>The note beside the name: that it is gone, what it extends, or that it cannot be used.</summary>
    public string Note => Removed ? "Removed, edits not saved" : Invalid ? "Has a problem" : BaseName is null ? "" : $"extends {BaseName}";
}

/// <summary>
/// The profiles in the profiles folder, which the user picks and the app
/// remembers. It starts as Documents/Repotted. Profiles can live in a GitHub
/// config repository instead: the app then works in its own copy of them,
/// syncs it on every refresh, and commits each save. Each profile opens in an
/// editor, and an editor keeps its unsaved edits while another profile is
/// open. A new profile starts empty, from another profile, or from a repository.
/// </summary>
internal sealed partial class ProfilesViewModel : ViewModelBase
{
    private readonly RepottedClient client;

    private readonly IDesktop desktop;

    private readonly AppSettings settings;

    private readonly Func<IReadOnlyList<string>> repositories;

    /// <param name="client">Lists, reads and saves profiles, and captures new ones.</param>
    /// <param name="desktop">Asks for a folder.</param>
    /// <param name="settings">Remembers the folder.</param>
    /// <param name="repositories">The repositories a new profile can be captured from, by full name.</param>
    public ProfilesViewModel(RepottedClient client, IDesktop desktop, AppSettings settings, Func<IReadOnlyList<string>> repositories)
    {
        this.client = client;
        this.desktop = desktop;
        this.settings = settings;
        this.repositories = repositories;
        Folder = new ProfileFolder(client, settings);
        Folder.PropertyChanged += OnFolderPropertyChanged;
    }

    private readonly Dictionary<string, ProfileViewModel> editors = [];

    /// <summary>The profile files that captures still running will make, by path, whether their forms are open or closed.</summary>
    private readonly HashSet<string> captures = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The file a refresh selects, such as a profile just made.</summary>
    private string? select;

    private IReadOnlyList<ProfileItemViewModel> all = [];

    private int refreshes;

    private const string SyncRecord = ".repotted-sync.json";

    public ObservableCollection<ProfileItemViewModel> Items { get; } = [];

    /// <summary>Every profile without a problem, whatever the search, for a compare.</summary>
    [ObservableProperty]
    public partial IReadOnlyList<ProfileItemViewModel> Usable { get; private set; } = [];

    /// <summary>Where the profiles live, and the sync state the page shows; every save and sync takes its turn there.</summary>
    public ProfileFolder Folder { get; }

    /// <summary>Whether the sync note shows; a failure that leaves nothing to list shows as the error instead.</summary>
    public bool ShowSyncNote => Folder.SyncNote is not null && Error is null;

    public bool ShowSyncDone => ShowSyncNote && !Folder.SyncFailed;

    public bool ShowSyncProblem => ShowSyncNote && Folder.SyncFailed;

    /// <summary>Whether a sync, or a save and the sync after it, is under way; a save ends once the sync after it does.</summary>
    public bool Busy => Folder.Syncing || DeleteRunning || editors.Values.Any(editor => editor.Saving);

    /// <summary>Keeps what the page shows of the folder in step with it.</summary>
    private void OnFolderPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            // Editors belong to one folder, so another folder starts without them.
            // The leave question has already settled any unsaved changes, so this
            // only drops editors that have none.
            case nameof(ProfileFolder.Path):
                // The question named a profile of the folder left behind.
                Deleting = null;
                foreach (var editor in editors.Values)
                {
                    editor.PropertyChanged -= OnEditorChanged;
                }
                editors.Clear();
                break;
            case nameof(ProfileFolder.SyncNote):
                OnPropertyChanged(nameof(ShowSyncNote));
                OnPropertyChanged(nameof(ShowSyncDone));
                OnPropertyChanged(nameof(ShowSyncProblem));
                break;
            case nameof(ProfileFolder.SyncFailed):
                OnPropertyChanged(nameof(ShowSyncDone));
                OnPropertyChanged(nameof(ShowSyncProblem));
                break;
            case nameof(ProfileFolder.Syncing):
                OnPropertyChanged(nameof(Busy));
                KeepMineCommand.NotifyCanExecuteChanged();
                UseGitHubsCommand.NotifyCanExecuteChanged();
                break;
        }
    }

    /// <summary>
    /// What waits on the question about unsaved changes, such as "change the
    /// folder"; null when nothing asks. Changing the folder, connecting a
    /// repository, and quitting each drop every editor, so each asks first.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasLeaving), nameof(LeavingMessage))]
    public partial string? Leaving { get; private set; }

    public bool HasLeaving => Leaving is not null;

    /// <summary>The answer to the question about unsaved changes: true to go on, false to stay.</summary>
    private TaskCompletionSource<bool>? leave;

    /// <summary>
    /// The notice that names a profile whose changes kept the app where it is
    /// while a capture ran, that profile's file, and the notice it covers. It
    /// goes once the profile opens or the question is asked again, and the
    /// notice it covered shows again.
    /// </summary>
    private (string Shown, string File, string? Covered)? leaveNotice;

    private void ClearLeaveNotice()
    {
        // A notice set since then is newer than the one covered, so it stays.
        if (leaveNotice is { } shown && Notice == shown.Shown)
        {
            Notice = shown.Covered;
        }
        leaveNotice = null;
    }

    /// <summary>The editors the question asks about: the one closing, or null for every editor.</summary>
    private IReadOnlyList<ProfileViewModel>? askedAbout;

    /// <summary>The profiles the question asks about whose editors hold unsaved changes.</summary>
    private List<ProfileViewModel> Unsaved => [.. (askedAbout ?? (IEnumerable<ProfileViewModel>)editors.Values).Where(editor => editor.HasChanges)];

    public bool HasUnsaved => editors.Values.Any(editor => editor.HasChanges);

    /// <summary>The profiles with unsaved changes when the question was asked, which it names.</summary>
    private List<string> leavingNames = [];

    public string LeavingMessage
    {
        get
        {
            var who = leavingNames.Count switch
            {
                1 => $"{leavingNames[0]} has",
                2 => $"{leavingNames[0]} and {leavingNames[1]} have",
                _ => $"{leavingNames.Count} profiles have",
            };
            return $"{who} unsaved changes. Save them before you {Leaving}?";
        }
    }

    /// <summary>
    /// Asks what to do with unsaved changes before <paramref name="act"/>,
    /// such as "change the folder", and answers whether to go on: true when
    /// nothing is unsaved, or once every change is saved or discarded. The
    /// question asks about <paramref name="only"/> when given, and otherwise
    /// about every editor.
    /// </summary>
    public async Task<bool> ConfirmLeaveAsync(string act, IReadOnlyList<ProfileViewModel>? only = null)
    {
        ClearLeaveNotice();
        if (!(only ?? (IEnumerable<ProfileViewModel>)editors.Values).Any(editor => editor.HasChanges))
        {
            return true;
        }
        // A question already waiting gives way to the new one.
        leave?.TrySetResult(false);
        var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        leave = answer;
        askedAbout = only;
        leavingNames = [.. Unsaved.Select(editor => editor.Name).Order(StringComparer.Ordinal)];
        Leaving = act;
        OnPropertyChanged(nameof(LeavingMessage));
        try
        {
            return await answer.Task.ConfigureAwait(true);
        }
        finally
        {
            if (leave == answer)
            {
                leave = null;
                askedAbout = null;
                Leaving = null;
            }
        }
    }

    /// <summary>Saves every unsaved profile, and goes on only when each save went through.</summary>
    [RelayCommand(CanExecute = nameof(CanAnswer))]
    private async Task SaveAndLeaveAsync()
    {
        if (leave is not { } answer)
        {
            return;
        }
        SavingToLeave = true;
        try
        {
            foreach (var editor in Unsaved)
            {
                if (editor.SaveCommand.CanExecute(null))
                {
                    await editor.SaveCommand.ExecuteAsync(null).ConfigureAwait(true);
                }
            }
        }
        finally
        {
            SavingToLeave = false;
        }
        Settle(answer);
    }

    /// <summary>True while Save on the question runs; the question's buttons wait for it.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveAndLeaveCommand), nameof(DiscardAndLeaveCommand), nameof(StayHereCommand))]
    public partial bool SavingToLeave { get; private set; }

    /// <summary>Discards every unsaved change and goes on.</summary>
    [RelayCommand(CanExecute = nameof(CanAnswer))]
    private void DiscardAndLeave()
    {
        if (leave is not { } answer)
        {
            return;
        }
        foreach (var editor in Unsaved)
        {
            // An editor that is loading or saving can't discard yet, and keeps the question open.
            if (editor.DiscardCommand.CanExecute(null))
            {
                editor.DiscardCommand.Execute(null);
            }
        }
        Settle(answer);
    }

    /// <summary>Stays where the profiles are, with every unsaved change kept.</summary>
    [RelayCommand(CanExecute = nameof(CanAnswer))]
    private void StayHere() => leave?.TrySetResult(false);

    /// <summary>The question's buttons wait while Save or a delete runs, so nothing moves on under either.</summary>
    private bool CanAnswer() => !SavingToLeave && !DeleteRunning;

    /// <summary>
    /// Goes on when no profile has unsaved changes left; otherwise opens the
    /// first that does, with why, and stays.
    /// </summary>
    private void Settle(TaskCompletionSource<bool> answer)
    {
        if (Unsaved.FirstOrDefault() is not { } left)
        {
            answer.TrySetResult(true);
            return;
        }
        if (Creating is { Working: true })
        {
            // Opening the profile would close the form and stop its capture, so
            // both stay as they are, and the notice names the profile instead.
            var why = left.Loading ? "is still loading" : left.Saving ? "is still saving" : "could not be saved";
            var covered = leaveNotice is { } earlier && Notice == earlier.Shown ? earlier.Covered : Notice;
            Notice = $"{left.Name} {why}, so you cannot {Leaving} yet.";
            leaveNotice = (Notice, left.File, covered);
            answer.TrySetResult(false);
            return;
        }
        if (Items.FirstOrDefault(item => item.Listing.File == left.File) is { } shown)
        {
            Selected = shown;
        }
        else if (all.FirstOrDefault(item => item.Listing.File == left.File) is { } hidden)
        {
            // The search hides it, but it opens all the same.
            Creating = null;
            Open(hidden.Listing);
        }
        // The question may have been asked from the settings, so the profile it opened comes into view.
        ShowProfiles?.Invoke();
        answer.TrySetResult(false);
    }

    /// <summary>The form that moves the profiles to a config repository, which stands in for the editor until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowNoneOpen), nameof(ShowConnecting))]
    public partial ConfigRepositoryViewModel? Connecting { get; private set; }

    public bool ShowConnecting => Connecting is not null;

    // However the form closes, a first sync it started stops with it.
    partial void OnConnectingChanged(ConfigRepositoryViewModel? oldValue, ConfigRepositoryViewModel? newValue) => oldValue?.Dispose();

    [ObservableProperty]
    public partial ProfileItemViewModel? Selected { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowProfile), nameof(ShowNoneOpen))]
    public partial ProfileViewModel? Current { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowNoneOpen))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowNoneOpen), nameof(ShowSyncNote), nameof(ShowSyncDone), nameof(ShowSyncProblem))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowNoneOpen), nameof(HasProfiles))]
    public partial int Count { get; set; }

    public bool HasProfiles => Count > 0;

    public bool ShowEmpty => !Loading && Error is null && Count == 0 && Creating is null && Connecting is null;

    public bool ShowProfile => !Loading && Error is null && Current is not null && Creating is null && Connecting is null;

    /// <summary>Whether the folder has profiles and none is open, such as after one is closed.</summary>
    public bool ShowNoneOpen => !Loading && Error is null && Count > 0 && Current is null && Creating is null && Connecting is null;

    /// <summary>The new profile form, which stands in for the editor until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(ShowNoneOpen), nameof(ShowCreating))]
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
        DropCloseQuestion(null);
        Captured = null;
        Connecting = null;
        // Nothing stays selected, so choosing any profile in the list leaves the form.
        Selected = null;
        Creating = new NewProfileViewModel(client, Folder, Usable, repositories(), repository, CreatedAsync, CancelNew, Released, captures);
    }

    /// <summary>
    /// Closes the new profile form and the repository form, which stops a
    /// capture or a first sync they run, and keeps any later sync from
    /// starting. The task ends once a save or sync already running ends, since
    /// neither can be stopped partway.
    /// </summary>
    public Task Stop()
    {
        Folder.Stop();
        Creating = null;
        Connecting = null;
        return Folder.Idle;
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

    /// <summary>Opens the form that makes a GitHub repository the place profiles live, in the settings.</summary>
    /// <remarks>
    /// Unsaved changes are settled first: connecting moves this folder's
    /// files to the repository, and the editors close once it connects.
    /// </remarks>
    [RelayCommand]
    public async Task StartConnectAsync()
    {
        if (!await ConfirmLeaveAsync(Folder.Repository is null ? "connect a repository" : "change the repository").ConfigureAwait(true))
        {
            return;
        }
        Creating = null;
        Captured = null;
        Selected = null;
        Connecting = new ConfigRepositoryViewModel(
            client,
            settings,
            repositories(),
            Folder.Repository is { } repository ? (repository, Folder.RepositoryPath) : null,
            Folder.Repository is null && Count > 0 ? Folder.Path : null,
            ConnectedAsync,
            CancelConnect);
        OpenSettings?.Invoke();
    }

    /// <summary>Opens the settings, where the folder or repository is chosen; set by the shell.</summary>
    public Action? OpenSettings { get; set; }

    /// <summary>Brings the profiles page, and the window it is in, into view; set by the shell.</summary>
    public Action? ShowProfiles { get; set; }

    [RelayCommand]
    private void ShowSettings() => OpenSettings?.Invoke();

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
        Folder.UseRepository(repository, path, result);
        closed = false;
        Selected = null;
        await LoadAsync(sync: false).ConfigureAwait(true);
    }

    /// <summary>Keeps this computer's version of each file in conflict, and commits it.</summary>
    [RelayCommand(CanExecute = nameof(CanSettle))]
    private Task KeepMineAsync() => SettleAsync("local");

    /// <summary>Takes GitHub's version of each file in conflict, over this computer's.</summary>
    [RelayCommand(CanExecute = nameof(CanSettle))]
    private Task UseGitHubsAsync() => SettleAsync("remote");

    private bool CanSettle() => !Folder.Syncing;

    /// <summary>Settles the files the banner names; a file that came into conflict since then waits for its own choice.</summary>
    private async Task SettleAsync(string prefer)
    {
        if (await Folder.SyncAsync(prefer, Folder.Conflicts).ConfigureAwait(true) is not null)
        {
            await LoadAsync(sync: false).ConfigureAwait(true);
        }
    }

    /// <summary>Commits a save to the config repository, and shows what the sync brought back from GitHub.</summary>
    private async Task SavedAsync()
    {
        // A save that put a removed file back lists it as a profile again.
        if (await Folder.SyncAsync(null, null).ConfigureAwait(true) is { Pulled.Count: > 0 } || all.Any(item => item.Removed))
        {
            await LoadAsync(sync: false).ConfigureAwait(true);
        }
    }

    /// <summary>Narrows the sidebar list by name.</summary>
    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    /// <summary>
    /// A note over the page: why the app could not remember the folder or the
    /// repository, which are still used until the app closes; which profiles
    /// connecting left out; or which profile kept the app where it was while a
    /// capture ran.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNotice))]
    public partial string? Notice { get; set; }

    public bool HasNotice => Notice is not null;

    partial void OnSelectedChanged(ProfileItemViewModel? value)
    {
        if (value is not null)
        {
            DropCloseQuestion(value.Listing.File);
            if (leaveNotice is { } shown && shown.File == value.Listing.File)
            {
                ClearLeaveNotice();
            }
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
            var opened = new ProfileViewModel(client, listing, ProfileStore.Profile(client, Folder), SavedAsync, () => CloseAsync(listing.File), () => AskDeleteListed(listing));
            editors[listing.File] = opened;
            opened.PropertyChanged += OnEditorChanged;
            _ = opened.LoadCommand.ExecuteAsync(null);
            editor = opened;
        }
        closed = false;
        Current = editor;
    }

    /// <summary>Whether the user closed the open profile, so a refresh opens none in its place.</summary>
    private bool closed;

    /// <summary>Whether a close waits on the question about unsaved changes, so a refresh meanwhile opens no other profile.</summary>
    private bool closing;

    /// <summary>
    /// Closes the open profile, back to the list with none open. Unsaved
    /// changes to it ask first, and the editor keeps them on Cancel; the other
    /// editors keep theirs as they are.
    /// </summary>
    private async Task CloseAsync(string file)
    {
        if (Current is not { } editor || editor.File != file)
        {
            return;
        }
        // Choosing another profile while the question waits takes it back, so
        // going on means this profile's changes are settled. A refresh in the
        // meantime can have opened a new editor for the same file.
        bool confirmed;
        closing = true;
        try
        {
            confirmed = await ConfirmLeaveAsync("close it", [editor]).ConfigureAwait(true);
        }
        finally
        {
            closing = false;
        }
        if (!confirmed)
        {
            return;
        }
        closed = true;
        Captured = null;
        Selected = null;
        Current = null;
    }

    /// <summary>
    /// Takes back a question about closing a profile once the user chooses
    /// another profile, or the new profile form, since that is no longer the
    /// profile on screen. A question about every editor stays. A refresh
    /// while the question waits opens no other profile in its place.
    /// </summary>
    private void DropCloseQuestion(string? opening)
    {
        if (askedAbout is [var asked] && asked.File != opening)
        {
            leave?.TrySetResult(false);
        }
    }

    /// <summary>
    /// Keeps the list in step with an editor whose file is gone: it shows as
    /// removed once a save finds the file gone, and leaves the list once its
    /// edits are discarded. A save starting or ending changes whether the list
    /// is busy.
    /// </summary>
    private void OnEditorChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(ProfileViewModel.Saving))
        {
            OnPropertyChanged(nameof(Busy));
        }
        if (e.PropertyName is nameof(ProfileViewModel.Saving) or nameof(ProfileViewModel.Loading))
        {
            ConfirmDeleteCommand.NotifyCanExecuteChanged();
        }
        if (e.PropertyName == nameof(ProfileViewModel.HasChanges) && sender is ProfileViewModel changed && Deleting?.Listing.File == changed.File)
        {
            ReaskDelete();
        }
        if (sender is not ProfileViewModel editor
            || !editors.TryGetValue(editor.File, out var cached)
            || !ReferenceEquals(cached, editor))
        {
            return;
        }
        if (e.PropertyName == nameof(ProfileViewModel.HasChanges) && editor is { HasChanges: false, Removed: true })
        {
            Forget(editor.File, editor);
            _ = ListAsync();
        }
        else if (!marking
            && (e.PropertyName == nameof(ProfileViewModel.Removed) && editor.Removed
                // A save that found the file back as something else, which the list still shows as removed.
                || e.PropertyName == nameof(ProfileViewModel.OutOfDate) && editor is { OutOfDate: true, Removed: false })
            && editor.Removed != all.Any(item => item.Removed && item.Listing.File == editor.File))
        {
            _ = ListAsync();
        }
    }

    /// <summary>Whether a listing is marking editors, which then shows them itself.</summary>
    private bool marking;

    /// <summary>Lists the profiles again once any sync running ends, so the listing sees what it pulled.</summary>
    private async Task ListAsync()
    {
        await Folder.Idle.ConfigureAwait(true);
        await LoadAsync(sync: false).ConfigureAwait(true);
    }

    /// <summary>
    /// Drops <paramref name="editor"/> from the cache. Its save can still be
    /// running, such as when the sync after it pulled a file, and the list no
    /// longer hears it end, so whether the list is busy is read again now.
    /// </summary>
    private void Forget(string file, ProfileViewModel editor)
    {
        editor.PropertyChanged -= OnEditorChanged;
        editors.Remove(file);
        OnPropertyChanged(nameof(Busy));
    }

    /// <summary>Lists the profiles again, after a sync with the config repository when they live in one.</summary>
    [RelayCommand]
    public Task RefreshAsync() => LoadAsync(sync: true);

    private async Task LoadAsync(bool sync)
    {
        // A refresh started later, such as for a newly chosen folder, wins over one still running.
        var refresh = ++refreshes;
        var folder = Folder.Path;
        Loading = true;
        Error = null;
        try
        {
            if (Folder.UsesRepository)
            {
                if (sync)
                {
                    await Folder.SyncAsync(null, null).ConfigureAwait(true);
                    if (refresh != refreshes)
                    {
                        return;
                    }
                }
                // A copy that never synced has nothing to show, only why.
                if (!File.Exists(Path.Combine(folder, SyncRecord)))
                {
                    Error = Folder.SyncNote ?? $"Repotted has not synced with {Folder.SourceText} yet.";
                    return;
                }
            }
            // The default folder is the app's to make; a folder the user picked already exists.
            else if (settings.Load().ProfilesFolder is null)
            {
                Directory.CreateDirectory(folder);
            }
            var listings = await client.ProfilesAsync(folder, CancellationToken.None).ConfigureAwait(true);
            if (refresh != refreshes)
            {
                return;
            }
            // A linked file is listed under its real path, so two names can share one file.
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var listing in listings)
            {
                names.TryAdd(listing.File, listing.Name);
            }
            // Editors start over from the file, which may have changed outside
            // the app, unless they hold edits that are not saved yet. Those
            // check whether saving would undo a change to the file, and one
            // whose file is gone stays in the list, so its edits can be saved
            // back or discarded.
            List<ProfileItemViewModel> removed = [];
            marking = true;
            foreach (var (file, editor) in editors.ToList())
            {
                if (!editor.HasChanges)
                {
                    Forget(file, editor);
                }
                else if (names.ContainsKey(file))
                {
                    editor.FileListed();
                }
                else
                {
                    editor.Removed = true;
                    removed.Add(new ProfileItemViewModel(new ProfileListingDocument(editor.Name, file, null, null), null, removed: true));
                }
            }
            marking = false;
            all =
            [
                .. listings.Select(listing => new ProfileItemViewModel(
                    listing,
                    listing.Extends is null ? null : names.GetValueOrDefault(listing.Extends) ?? Path.GetFileNameWithoutExtension(listing.Extends),
                    delete: AskDelete,
                    canDelete: () => !DeleteRunning)),
                .. removed,
            ];
            Count = all.Count;
            Usable = [.. all.Where(item => !item.Invalid && !item.Removed)];
            ReaskDelete();
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
            // A profile the user closed, or is closing, leaves none open until they choose one.
            else if (!closed && !closing && Items.FirstOrDefault() is { } first)
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

    /// <summary>
    /// The profile the delete question asks about; null when nothing asks.
    /// The question names what the delete takes with it, as of when it was
    /// asked, and stays until it is answered or another folder opens.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AskingDelete), nameof(DeleteQuestion))]
    [NotifyCanExecuteChangedFor(nameof(ConfirmDeleteCommand), nameof(CancelDeleteCommand))]
    public partial ProfileItemViewModel? Deleting { get; private set; }

    public bool AskingDelete => Deleting is not null;

    public string DeleteQuestion => Deleting is null ? "" : $"Delete {Deleting.Name}?";

    /// <summary>What deleting takes with it: the file, any unsaved changes, and the profiles that stop loading.</summary>
    [ObservableProperty]
    public partial string DeleteDetail { get; private set; } = "";

    /// <summary>True from Delete profile on the question until the file is gone, any sync has committed it, and the list is read again.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Busy))]
    [NotifyCanExecuteChangedFor(nameof(ConfirmDeleteCommand), nameof(CancelDeleteCommand), nameof(SaveAndLeaveCommand), nameof(DiscardAndLeaveCommand), nameof(StayHereCommand))]
    public partial bool DeleteRunning { get; private set; }

    partial void OnDeleteRunningChanged(bool value)
    {
        foreach (var item in all)
        {
            item.DeleteCommand.NotifyCanExecuteChanged();
        }
    }

    /// <summary>
    /// Asks about deleting the profile an editor was opened for. Two names
    /// can list one file, through a link, so the item is found by name too.
    /// </summary>
    private void AskDeleteListed(ProfileListingDocument listing)
    {
        if (Listed(listing) is { } item)
        {
            AskDelete(item);
        }
    }

    private ProfileItemViewModel? Listed(ProfileListingDocument listing) =>
        all.FirstOrDefault(item => item.Listing.File == listing.File && item.Name == listing.Name && !item.Removed);

    /// <summary>
    /// Words the question again after the list or the profile's edits
    /// change, so it names what a delete takes now. It goes once the profile
    /// is no longer listed.
    /// </summary>
    private void ReaskDelete()
    {
        if (Deleting is not { } asked || DeleteRunning)
        {
            return;
        }
        if (Listed(asked.Listing) is { } item)
        {
            AskDelete(item);
        }
        else
        {
            Deleting = null;
        }
    }

    /// <summary>
    /// Asks whether to delete <paramref name="item"/>, naming its file, the
    /// unsaved changes the delete discards, and every listed profile that
    /// extends it, directly or through another, since those stop loading.
    /// Deleting is allowed all the same: the question warns rather than
    /// blocks, so a base and the profiles over it can go in any order.
    /// </summary>
    private void AskDelete(ProfileItemViewModel item)
    {
        if (DeleteRunning || item.Removed)
        {
            return;
        }
        var entry = Entry(item.Listing).Path;
        var file = Path.GetFileName(entry ?? item.Listing.File);
        List<string> parts =
        [
            Folder.Repository is not { } repository ? $"This deletes {file} from the profiles folder, and it can't be undone."
            : entry is not null && IsLink(entry) ? $"This deletes the link {file} here, and it can't be undone, since links don't sync to {repository}."
            : SyncedBlob(file) is not { } synced ? $"This deletes {file} here, and it can't be undone, since it hasn't reached {repository} yet."
            : entry is null || synced == BlobId(entry) ? $"This deletes {file} here and commits the deletion to {repository}, whose history keeps it."
            : $"This deletes {file} here and commits the deletion to {repository}. Its history keeps the last synced version, and changes since then can't be brought back.",
        ];
        if (editors.TryGetValue(item.Listing.File, out var editor) && editor.HasChanges)
        {
            parts.Add("Your unsaved changes to it are discarded.");
        }
        var (direct, through) = Extending(item.Listing.File);
        if (direct.Count + through.Count > 0)
        {
            List<string> names = [.. direct, .. through];
            var many = names.Count > 1;
            var how = through.Count > 0 ? ", directly or through another profile" : "";
            parts.Add($"{Join(names)} {(many ? "extend" : "extends")} it{how}, so {(many ? "they stop" : "it stops")} loading until {(many ? "they extend" : "it extends")} another profile.");
        }
        DeleteDetail = string.Join(" ", parts);
        Deleting = item;
    }

    /// <summary>The listed profiles over <paramref name="file"/>: those that extend it, then those that extend one of them, by name.</summary>
    private (List<string> Direct, List<string> Through) Extending(string file)
    {
        var listed = all.Where(item => !item.Removed).ToList();
        var direct = listed.Where(item => item.Listing.Extends == file).ToList();
        var found = new HashSet<string>(direct.Select(item => item.Listing.File), StringComparer.Ordinal) { file };
        List<ProfileItemViewModel> through = [];
        for (var next = direct; next.Count > 0;)
        {
            next = [.. listed.Where(item => item.Listing.Extends is { } over && next.Any(above => above.Listing.File == over) && found.Add(item.Listing.File))];
            through.AddRange(next);
        }
        return ([.. direct.Select(item => item.Name).Order(StringComparer.Ordinal)], [.. through.Select(item => item.Name).Order(StringComparer.Ordinal)]);
    }

    private static string Join(List<string> names) => names.Count switch
    {
        1 => names[0],
        2 => $"{names[0]} and {names[1]}",
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}",
    };

    /// <summary>
    /// The file in the folder that lists as <paramref name="listing"/>. The
    /// CLI lists a linked file under its real path, so the entry is found by
    /// name: the one whose file name the listing shares, or the only one of
    /// that name. Deleting it takes a link out of the folder, and never the
    /// file the link points to. Gone only when the folder has no entry of
    /// that name; a folder that can't be read, or two entries that could
    /// each be it, find neither.
    /// </summary>
    private (string? Path, bool Gone) Entry(ProfileListingDocument listing)
    {
        List<string> named;
        try
        {
            named =
            [
                .. Directory.EnumerateFiles(Folder.Path).Where(entry =>
                    Path.GetFileNameWithoutExtension(entry) == listing.Name
                    && Path.GetExtension(entry).ToLowerInvariant() is ".yaml" or ".yml"),
            ];
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return (null, false);
        }
        var path = named.FirstOrDefault(entry => Path.GetFileName(entry) == Path.GetFileName(listing.File))
            ?? (named.Count == 1 ? named[0] : null);
        return (path, named.Count == 0);
    }

    private static bool IsLink(string entry) => new FileInfo(entry).LinkTarget is not null;

    /// <summary>The git blob id the last sync recorded for <paramref name="file"/>; null when GitHub never had it.</summary>
    private string? SyncedBlob(string file)
    {
        try
        {
            using var record = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Folder.Path, SyncRecord)));
            return record.RootElement.TryGetProperty("files", out var files)
                && files.TryGetProperty(file, out var id)
                && id.ValueKind == JsonValueKind.String
                ? id.GetString()
                : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>The git blob id of a file, which the sync record compares to tell whether GitHub has this version.</summary>
    private static string? BlobId(string entry)
    {
        try
        {
            var content = File.ReadAllBytes(entry);
            var header = System.Text.Encoding.ASCII.GetBytes($"blob {content.Length}\0");
#pragma warning disable CA5350 // Git names a blob by its SHA-1; this matches that name and secures nothing.
            return Convert.ToHexStringLower(SHA1.HashData([.. header, .. content]));
#pragma warning restore CA5350
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    [RelayCommand(CanExecute = nameof(CanCancelDelete))]
    private void CancelDelete() => Deleting = null;

    private bool CanCancelDelete() => Deleting is not null && !DeleteRunning;

    /// <summary>
    /// Deletes the profile the question names, in the folder's turn with
    /// saves and syncs, so no sync reads the folder partway. Its editor goes
    /// with it, unsaved changes and all. For a config repository, a sync then
    /// commits the deletion, as it commits a save. The list is read again. A
    /// deleted profile that was open stays closed, as if closed, so none opens
    /// in its place; another open profile stays open.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanConfirmDelete))]
    private async Task ConfirmDeleteAsync()
    {
        if (Deleting is not { } item)
        {
            return;
        }
        var folder = Folder.Path;
        var file = item.Listing.File;
        DeleteRunning = true;
        try
        {
            var deleted = false;
            try
            {
                await Folder.WriteAsync(() =>
                {
                    // Another folder opened while the delete waited its turn.
                    if (folder != Folder.Path)
                    {
                        return Task.CompletedTask;
                    }
                    var (entry, gone) = Entry(item.Listing);
                    if (entry is not null)
                    {
                        File.Delete(entry);
                    }
                    // A file gone already, such as by a sync, is as good as deleted.
                    else if (!gone)
                    {
                        throw new IOException($"Repotted could not tell which file in the folder is {item.Name}.");
                    }
                    deleted = true;
                    // The deleted profile closes now, so nothing edits or saves it while the list is read again.
                    if (editors.TryGetValue(file, out var editor))
                    {
                        Forget(file, editor);
                    }
                    // A question about closing it has nothing left to ask.
                    if (askedAbout is [var asked] && asked.File == file)
                    {
                        leave?.TrySetResult(false);
                        // Settled now, not when the close's continuation runs, so the reload below opens none either way.
                        closing = false;
                    }
                    if (editor is not null && ReferenceEquals(Current, editor))
                    {
                        closed = true;
                        Current = null;
                    }
                    if (ReferenceEquals(Selected, item))
                    {
                        Selected = null;
                    }
                    return Task.CompletedTask;
                }).ConfigureAwait(true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Notice = $"Repotted could not delete {item.Name}: {error.Message}";
            }
            Deleting = null;
            if (!deleted || folder != Folder.Path)
            {
                return;
            }
            if (Folder.UsesRepository)
            {
                await Folder.SyncAsync(null, null).ConfigureAwait(true);
            }
            if (folder == Folder.Path)
            {
                await LoadAsync(sync: false).ConfigureAwait(true);
                // The form's name may have been the deleted file's.
                Creating?.Recheck();
            }
        }
        finally
        {
            DeleteRunning = false;
        }
    }

    /// <summary>The question waits while the profile's editor loads or saves, so a save never lands after the delete.</summary>
    private bool CanConfirmDelete() =>
        Deleting is { } item
        && !DeleteRunning
        && !(editors.TryGetValue(item.Listing.File, out var editor) && (editor.Loading || editor.Saving));

    [RelayCommand]
    private async Task ChangeFolderAsync()
    {
        if (await desktop.PickFolderAsync("Choose the profiles folder").ConfigureAwait(true) is not { } folder
            || !await ConfirmLeaveAsync("change the folder").ConfigureAwait(true))
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
        Folder.UseFolder(folder);
        // Another folder, or the same one chosen again, opens its first profile.
        closed = false;
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
