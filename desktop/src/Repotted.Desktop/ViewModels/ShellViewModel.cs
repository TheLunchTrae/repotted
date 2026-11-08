using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The signed-in app: the sidebar, the header with its search, and the page,
/// which is the repository list, a compare, or the profiles.
/// </summary>
internal sealed partial class ShellViewModel : ViewModelBase
{
    private readonly RepottedClient client;
    private readonly IDesktop desktop;
    private readonly Func<Task> signOut;
    private readonly AppSettings settings;

    /// <summary><paramref name="signOut"/> removes the sign-in and leaves the app.</summary>
    public ShellViewModel(
        Account.SignedIn account,
        RepottedClient client,
        IDesktop desktop,
        AppSettings settings,
        Func<Task> signOut)
    {
        Account = account;
        this.client = client;
        this.desktop = desktop;
        this.signOut = signOut;
        this.settings = settings;
        // Each list reaches the other: a new profile is captured from a listed repository.
        RepositoriesViewModel? repositories = null;
        Profiles = new ProfilesViewModel(client, desktop, settings, () => repositories?.Names ?? []);
        Profiles.PropertyChanged += OnProfilesChanged;
        Repositories = repositories = new RepositoriesViewModel(
            client, desktop, account.InstallUrl, Profiles, OpenCompare, OpenCapture, OpenApply, Unfinished);
        Repositories.PropertyChanged += OnRepositoriesChanged;
    }

    public Account.SignedIn Account { get; }

    public RepositoriesViewModel Repositories { get; }

    public ProfilesViewModel Profiles { get; }

    /// <summary>The page: 0 for the repositories, 1 for the profiles, as the sidebar lists them.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingProfiles), nameof(ShowingRepositories), nameof(ShowingCompare), nameof(ShowingApply), nameof(Crumb), nameof(SearchHint))]
    public partial int Page { get; set; }

    /// <summary>The open compare, which stands in for the repository list until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingRepositories), nameof(ShowingCompare), nameof(Crumb))]
    public partial CompareViewModel? Compare { get; private set; }

    /// <summary>The open apply, which stands in for the repository list, and for a compare, until it closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingRepositories), nameof(ShowingCompare), nameof(ShowingApply), nameof(Crumb))]
    public partial ApplyViewModel? Apply { get; private set; }

    public bool ShowingRepositories => Page == 0 && Compare is null && Apply is null;

    public bool ShowingCompare => Page == 0 && Compare is not null && Apply is null;

    public bool ShowingApply => Page == 0 && Apply is not null;

    public bool ShowingProfiles => Page == 1;

    /// <summary>Where you are, for the header.</summary>
    public string Crumb => (ShowingProfiles, Profiles.Current, Compare, Apply) switch
    {
        (true, _, _, _) when Profiles.ShowCreating => $"Profiles / {ControlLabel.For("New profile")}",
        (true, { } profile, _, _) => $"Profiles / {profile.Name}",
        (true, null, _, _) => "Profiles",
        (false, _, _, { } apply) => $"Repositories / {apply.Repository} / Apply",
        (false, _, { } compare, _) => $"Repositories / {compare.Repository} / Compare",
        _ => "Repositories",
    };

    // Leaving the repositories closes the compare, and the apply when nothing
    // of it would be lost, so the sidebar leads back to the list. An apply
    // that is writing or holds unsaved edits stays until it can close.
    partial void OnPageChanged(int value)
    {
        Compare = null;
        if (Apply?.CanLeave == true)
        {
            CloseApply();
        }
    }

    private void OpenCompare(string repository, ProfileListingDocument profile)
    {
        Compare = new CompareViewModel(client, desktop, repository, profile, Account.InstallUrl, OpenApply);
        _ = Compare.LoadCommand.ExecuteAsync(null);
    }

    [RelayCommand]
    private void CloseCompare() => Compare = null;

    /// <summary>Opens an apply to a repository, from a profile or from the repository as it is, in place of a compare.</summary>
    private void OpenApply(string repository, ProfileListingDocument? profile)
    {
        if (Apply is not null)
        {
            return;
        }
        Page = 0;
        Compare = null;
        Apply = new ApplyViewModel(
            client, settings, repository, profile, CloseApply, Profiles.Folder, Profiles.RefreshAsync, desktop, Account.InstallUrl);
        _ = Apply.OpenAsync();
    }

    private void CloseApply()
    {
        Apply = null;
        Repositories.RefreshUnfinished();
    }

    /// <summary>Whether an apply to a repository was left unfinished, to resume.</summary>
    private bool Unfinished(string repository) =>
        AppSettings.IsRepositoryName(repository) && System.IO.File.Exists(settings.StagedFile(repository));

    private void OpenCapture(string repository)
    {
        Page = 1;
        Profiles.StartNew(repository);
    }

    /// <summary>
    /// Leaves what stands in for a page, such as a compare or the new profile
    /// form, when its sidebar entry is chosen though it is already selected.
    /// </summary>
    public void ShowPage(int page)
    {
        if (page != Page)
        {
            return;
        }
        if (page == 0)
        {
            Compare = null;
            if (Apply?.CanLeave == true)
            {
                CloseApply();
            }
        }
        else
        {
            Profiles.CancelNew();
        }
    }

    /// <summary>Whether the app may quit, as <see cref="ConfirmLeaveAsync"/> answers.</summary>
    public Task<bool> ConfirmQuitAsync() => ConfirmLeaveAsync("quit");

    /// <summary>
    /// Whether the app may be left to <paramref name="act"/>, such as "sign
    /// out": at once when nothing is unsaved, and otherwise once the profiles
    /// page, brought into view, has asked and the changes are saved or
    /// discarded.
    /// </summary>
    public async Task<bool> ConfirmLeaveAsync(string act, bool wait = false)
    {
        // An apply that is running, or holds unsaved one-off edits, shows itself and says what it needs.
        if (Apply is { CanLeave: false } apply)
        {
            Page = 0;
            if (!await apply.ConfirmLeaveAsync(act, wait).ConfigureAwait(true))
            {
                return false;
            }
        }
        if (!Profiles.HasUnsaved)
        {
            return true;
        }
        Page = 1;
        return await Profiles.ConfirmLeaveAsync(act).ConfigureAwait(true);
    }

    /// <summary>Whether leaving the app would ask first, or wait, for unsaved changes or an apply.</summary>
    public bool MustAskToLeave => Profiles.HasUnsaved || Apply is { CanLeave: false };

    public string SearchHint => ShowingProfiles ? "Find a profile" : "Find a repository";

    /// <summary>Loads both lists, which the sidebar counts.</summary>
    public Task RefreshAsync() =>
        Task.WhenAll(Repositories.RefreshCommand.ExecuteAsync(null), Profiles.RefreshCommand.ExecuteAsync(null));

    /// <summary>Up to two letters for the avatar.</summary>
    public string Initials
    {
        get
        {
            var words = (Account.Name ?? Account.Login)
                .Split([' ', '-', '_'], StringSplitOptions.RemoveEmptyEntries);
            var letters = words.Length >= 2
                ? $"{words[0][0]}{words[^1][0]}"
                : (words.FirstOrDefault() ?? "?")[..Math.Min(2, (words.FirstOrDefault() ?? "?").Length)];
            return letters.ToUpperInvariant();
        }
    }

    /// <summary>
    /// What the token is. A variable says so itself. Otherwise only an App's
    /// sign-in reaches its installations, so the repository list tells an App
    /// sign-in from another token, such as the GitHub CLI's.
    /// </summary>
    public string? SignedInWith => (Account.TokenVariable, Repositories.FromInstallations) switch
    {
        ({ } variable, _) => $"Signed in with {variable}.",
        (null, true) => Account.InstallUrl is null ? "Signed in with your GitHub App." : "Signed in with the Repotted App.",
        (null, false) => "Signed in with a GitHub token.",
        (null, null) => null,
    };

    /// <summary>
    /// Whether the token is the Repotted sign-in, which signing out removes.
    /// A variable or the GitHub CLI's sign-in would still apply afterwards.
    /// </summary>
    public bool ShowSignOut => Account.TokenVariable is null && Repositories.FromInstallations is true;

    /// <summary>
    /// Signs out once unsaved changes are saved or discarded, since signing
    /// out leaves the app. It waits for a sync, and for a save and the sync
    /// after it, which can't be stopped partway.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanSignOut))]
    private async Task SignOutAsync()
    {
        if (await ConfirmLeaveAsync("sign out").ConfigureAwait(true))
        {
            await signOut().ConfigureAwait(true);
        }
    }

    private bool CanSignOut() => !Profiles.Busy;

    /// <summary>
    /// Stops the work the app started that can be stopped, a capture and a
    /// connect's first sync, and any sync not yet started. The task ends once
    /// a save or sync already running ends.
    /// </summary>
    public Task Stop() => Profiles.Stop();

    [ObservableProperty]
    public partial string Search { get; set; } = "";

    partial void OnSearchChanged(string value)
    {
        Repositories.Filter = value;
        Profiles.Filter = value;
    }

    private void OnProfilesChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(ProfilesViewModel.Current) or nameof(ProfilesViewModel.Creating))
        {
            OnPropertyChanged(nameof(Crumb));
        }
        else if (e.PropertyName == nameof(ProfilesViewModel.Busy))
        {
            SignOutCommand.NotifyCanExecuteChanged();
        }
    }

    private void OnRepositoriesChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(RepositoriesViewModel.FromInstallations))
        {
            OnPropertyChanged(nameof(SignedInWith));
            OnPropertyChanged(nameof(ShowSignOut));
        }
    }
}
