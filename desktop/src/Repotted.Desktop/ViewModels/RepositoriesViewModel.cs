using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The repositories Repotted can manage, grouped by owner with the signed-in
/// account's first, with a search, an owner filter, and the selected one's
/// details, from which it can be compared with a profile or captured as a new
/// one.
/// </summary>
internal sealed partial class RepositoriesViewModel : ViewModelBase
{
    private readonly RepottedClient client;
    private readonly IDesktop desktop;
    private readonly Uri? installUrl;
    private readonly Action<string, ProfileListingDocument> compare;
    private readonly Action<string> capture;
    private readonly Action<string, ProfileListingDocument?>? apply;
    private readonly Func<string, bool> unfinished;
    private readonly Action<IReadOnlyList<string>, ProfileListingDocument?>? batch;
    private readonly Func<bool> batchUnfinished;
    private readonly string? login;
    private readonly AppSettings? settings;

    private IReadOnlyList<RepositoryRowViewModel> all = [];

    // The owners whose repositories the list hides, as saved. An owner that has left the list stays
    // hidden, so it is still hidden when it comes back; an owner new to the list shows.
    private IReadOnlyList<string> hiddenOwners;

    // Set while the owner filter's ticks are set from hiddenOwners, so they are not read back as a choice.
    private bool showingHiddenOwners;

    /// <param name="client">Reads the list.</param>
    /// <param name="desktop">Opens pages on GitHub.</param>
    /// <param name="installUrl">Where to add the Repotted App to more repositories, when it is the App that signs in.</param>
    /// <param name="profiles">The profiles a repository can be compared with.</param>
    /// <param name="compare">Opens a compare of a repository, by full name, with a profile.</param>
    /// <param name="capture">Opens a new profile captured from a repository, by full name.</param>
    /// <param name="apply">Opens an apply to a repository, from a profile or from the repository as it is.</param>
    /// <param name="unfinished">Whether an apply to a repository waits to be resumed.</param>
    /// <param name="batch">Opens a batch apply of a profile to several repositories, or resumes the one there when none are given.</param>
    /// <param name="batchUnfinished">Whether a batch apply waits to be resumed.</param>
    /// <param name="login">The signed-in account, whose repositories are its personal ones.</param>
    /// <param name="settings">Remembers the owner filter between runs.</param>
    public RepositoriesViewModel(
        RepottedClient client,
        IDesktop desktop,
        Uri? installUrl,
        ProfilesViewModel profiles,
        Action<string, ProfileListingDocument> compare,
        Action<string> capture,
        Action<string, ProfileListingDocument?>? apply = null,
        Func<string, bool>? unfinished = null,
        Action<IReadOnlyList<string>, ProfileListingDocument?>? batch = null,
        Func<bool>? batchUnfinished = null,
        string? login = null,
        AppSettings? settings = null)
    {
        this.login = login;
        this.settings = settings;
        hiddenOwners = settings?.Load().HiddenRepositoryOwners ?? [];
        this.batch = batch;
        this.batchUnfinished = batchUnfinished ?? (() => false);
        this.capture = capture;
        this.apply = apply;
        this.unfinished = unfinished ?? (_ => false);
        this.client = client;
        this.desktop = desktop;
        this.installUrl = installUrl;
        this.compare = compare;
        Profiles = profiles;
        Choices = profiles.Usable;
        profiles.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ProfilesViewModel.Usable))
            {
                // The box gets the new list first, which clears its choice, and then the choice, which is
                // in the list by then. The other way round, the box drops a choice it cannot find yet and
                // shows no profile while Compare and Apply act on one.
                var chosen = CompareWith?.Listing.File;
                Choices = profiles.Usable;
                CompareWith = profiles.Usable.FirstOrDefault(item => item.Listing.File == chosen)
                    ?? (profiles.Usable.Count > 0 ? profiles.Usable[0] : null);
            }
        };
    }

    /// <summary>The profiles a repository can be compared with.</summary>
    public ProfilesViewModel Profiles { get; }

    /// <summary>The profiles to compare with, as the box lists them: the usable profiles, taken before the choice among them.</summary>
    [ObservableProperty]
    public partial IReadOnlyList<ProfileItemViewModel> Choices { get; private set; } = [];

    /// <summary>The profile to compare the selected repository with.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(CompareCommand), nameof(ApplyProfileCommand), nameof(ReviewBatchCommand))]
    public partial ProfileItemViewModel? CompareWith { get; set; }

    /// <summary>Whether this window can apply, as it can once signed in.</summary>
    public bool CanApply => apply is not null;

    /// <summary>Whether an apply to the selected repository was left unfinished, to resume.</summary>
    public bool HasUnfinishedApply => CanApply && Selected is { } row && unfinished(row.FullName);

    /// <summary>Whether a batch apply was left unfinished, to resume.</summary>
    public bool HasUnfinishedBatch => CanBatch && batchUnfinished();

    /// <summary>Whether this window can apply to several repositories at once.</summary>
    public bool CanBatch => batch is not null;

    /// <summary>Checks again whether an apply was left unfinished, such as after one closes.</summary>
    public void RefreshUnfinished()
    {
        OnPropertyChanged(nameof(HasUnfinishedApply));
        OnPropertyChanged(nameof(HasUnfinishedBatch));
        ReviewBatchCommand.NotifyCanExecuteChanged();
    }

    /// <summary>
    /// The repositories chosen in the list, which with more than one stand
    /// for a batch apply in place of the selected repository's details.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Choosing), nameof(HasSelection), nameof(ChosenLabel), nameof(HasUnfinishedApply))]
    [NotifyCanExecuteChangedFor(
        nameof(ReviewBatchCommand), nameof(CompareCommand), nameof(CaptureCommand), nameof(ApplyProfileCommand),
        nameof(ChangeSettingsCommand), nameof(ResumeApplyCommand))]
    public partial IReadOnlyList<RepositoryRowViewModel> Chosen { get; set; } = [];

    /// <summary>Whether several repositories are chosen, for a batch apply.</summary>
    public bool Choosing => Chosen.Count > 1;

    public string ChosenLabel => $"{Chosen.Count} repositories selected";

    /// <summary>What the list shows: each owner's heading, then the owner's repositories that match the search.</summary>
    public ObservableCollection<object> Items { get; } = [];

    /// <summary>The repositories the list shows, in its order.</summary>
    public IReadOnlyList<RepositoryRowViewModel> Rows => [.. Items.OfType<RepositoryRowViewModel>()];

    /// <summary>The owners in the list, the signed-in account first, each ticked when the list shows its repositories.</summary>
    public ObservableCollection<OwnerChoice> Owners { get; } = [];

    /// <summary>Whether the list shows and has more than one owner to choose among.</summary>
    public bool ShowOwnerFilter => ShowTable && Owners.Count > 1;

    /// <summary>Whether the signed-in account has repositories of its own in the list.</summary>
    public bool HasPersonal => Owners.Any(owner => owner.Personal);

    /// <summary>Whether the owner filter hides some owners' repositories.</summary>
    public bool OwnersFiltered => Owners.Any(owner => !owner.Shown);

    /// <summary>The owner filter's button: which owners the list shows.</summary>
    public string OwnersLabel => Owners.Where(owner => owner.Shown).ToList() switch
    {
        var shown when shown.Count == Owners.Count => ControlLabel.For("All owners"),
        [] => ControlLabel.For("No owners"),
        [{ Personal: true }] => ControlLabel.For("Personal"),
        [var one] => one.Owner,
        var shown => ControlLabel.For($"{shown.Count} owners"),
    };

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelection), nameof(HasUnfinishedApply))]
    [NotifyCanExecuteChangedFor(nameof(CompareCommand), nameof(CaptureCommand), nameof(ApplyProfileCommand), nameof(ChangeSettingsCommand), nameof(ResumeApplyCommand))]
    public partial RepositoryRowViewModel? Selected { get; set; }

    /// <summary>Every repository in the list, whatever the search, by full name.</summary>
    public IReadOnlyList<string> Names => [.. all.Select(row => row.FullName)];

    /// <summary>Whether one repository is selected, whose details show.</summary>
    public bool HasSelection => Selected is not null && !Choosing;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(ShowAddInHeading), nameof(ShowOwnerFilter))]
    [NotifyCanExecuteChangedFor(nameof(RefreshCommand))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(HasError), nameof(ShowAddInHeading), nameof(ShowOwnerFilter))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    /// <summary>
    /// Whether the App's installations decide the list, so more repositories
    /// come from installing it. Null until the list has loaded.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanAddRepositories), nameof(ShowAddInHeading), nameof(EmptyMessage), nameof(Description))]
    public partial bool? FromInstallations { get; set; }

    /// <summary>Whether installing the Repotted App on more repositories adds to the list.</summary>
    public bool CanAddRepositories => FromInstallations == true && installUrl is not null;

    /// <summary>The heading offers it too, except where the empty list already does.</summary>
    public bool ShowAddInHeading => CanAddRepositories && !ShowEmpty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(CountLabel), nameof(ShowAddInHeading), nameof(ShowOwnerFilter))]
    public partial int Count { get; set; }

    public string CountLabel => OwnersFiltered
        ? $"{Owners.Where(owner => owner.Shown).Sum(owner => owner.Count)} of {Count}"
        : $"All {Count}";

    public bool ShowTable => !Loading && Error is null && Count > 0;

    public bool ShowEmpty => !Loading && Error is null && FromInstallations is not null && Count == 0;

    public string EmptyMessage => FromInstallations == true
        ? $"{Capitalized(AppName)} is not installed on any repositories you administer yet."
        : "This token administers no repositories.";

    public string Description => FromInstallations switch
    {
        true => $"Repositories {AppName} is installed on that you administer.",
        false => "Repositories your account administers.",
        null => "",
    };

    private string AppName => installUrl is null ? "your GitHub App" : "the Repotted App";

    private static string Capitalized(string text) => string.Concat(text[..1].ToUpperInvariant(), text[1..]);

    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    /// <summary>Reads the list; one read at a time, which the Refresh command enforces.</summary>
    [RelayCommand(CanExecute = nameof(CanRefresh))]
    private async Task RefreshAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            var list = await client.RepositoriesAsync(CancellationToken.None).ConfigureAwait(true);
            all = [.. list.Repositories.Select(repository => new RepositoryRowViewModel(repository))];
            Count = all.Count;
            FromInstallations = list.FromInstallations;
            Owners.Clear();
            foreach (var group in ByOwner(all))
            {
                Owners.Add(new OwnerChoice(group.Key, IsPersonal(group.Key), group.Count(), OnOwnerTicked));
            }
            ShowHiddenOwners();
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Error = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    private bool CanRefresh() => !Loading;

    /// <summary>Shows only the signed-in account's own repositories.</summary>
    [RelayCommand]
    private void ShowOnlyPersonal()
    {
        Hide(Owners.Where(owner => !owner.Personal));
        ShowHiddenOwners();
    }

    [RelayCommand]
    private void ShowAllOwners()
    {
        hiddenOwners = [];
        SaveOwners();
        ShowHiddenOwners();
    }

    private void OnOwnerTicked()
    {
        if (!showingHiddenOwners)
        {
            Hide(Owners.Where(owner => !owner.Shown));
            OwnersChanged();
        }
    }

    /// <summary>Hides these owners of the list, and any owners hidden before that are not in it, and saves that.</summary>
    private void Hide(IEnumerable<OwnerChoice> owners)
    {
        hiddenOwners =
        [
            .. hiddenOwners.Where(name => !Owners.Any(owner => SameOwner(owner.Owner, name))),
            .. owners.Select(owner => owner.Owner),
        ];
        SaveOwners();
    }

    /// <summary>Ticks every owner but the hidden ones, and shows their repositories.</summary>
    private void ShowHiddenOwners()
    {
        showingHiddenOwners = true;
        foreach (var owner in Owners)
        {
            owner.Shown = !hiddenOwners.Any(name => SameOwner(owner.Owner, name));
        }
        showingHiddenOwners = false;
        OwnersChanged();
    }

    private void OwnersChanged()
    {
        OnPropertyChanged(nameof(ShowOwnerFilter));
        OnPropertyChanged(nameof(OwnersFiltered));
        OnPropertyChanged(nameof(OwnersLabel));
        OnPropertyChanged(nameof(CountLabel));
        OnPropertyChanged(nameof(HasPersonal));
        ApplyFilter();
    }

    /// <summary>Remembers the owner filter for the next run. Losing it costs only a choice, so a failed save is let go.</summary>
    private void SaveOwners()
    {
        try
        {
            settings?.Save(settings.Load() with { HiddenRepositoryOwners = hiddenOwners.Count > 0 ? hiddenOwners : null });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
        }
    }

    // GitHub logins ignore case.
    private static bool SameOwner(string left, string right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    private bool IsPersonal(string owner) => login is not null && SameOwner(owner, login);

    /// <summary>Repositories by owner: the signed-in account's first, then the others by login.</summary>
    private IEnumerable<IGrouping<string, RepositoryRowViewModel>> ByOwner(IEnumerable<RepositoryRowViewModel> rows) =>
        rows.GroupBy(row => row.Owner, StringComparer.OrdinalIgnoreCase)
            .OrderBy(group => !IsPersonal(group.Key))
            .ThenBy(group => group.Key, StringComparer.OrdinalIgnoreCase);

    [RelayCommand]
    private Task AddRepositoriesAsync() => installUrl is { } url ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    [RelayCommand(CanExecute = nameof(CanCompare))]
    private void Compare()
    {
        if (Selected is { } row && CompareWith is { } profile)
        {
            compare(row.FullName, profile.Listing);
        }
    }

    private bool CanCompare() => HasSelection && CompareWith is not null;

    /// <summary>Starts an apply of the chosen profile, or resumes the unfinished one, which shows the diff to edit before anything is written.</summary>
    [RelayCommand(CanExecute = nameof(CanCompare))]
    private void ApplyProfile()
    {
        if (Selected is { } row && CompareWith is { } profile)
        {
            apply?.Invoke(row.FullName, profile.Listing);
        }
    }

    /// <summary>Opens the unfinished apply to the selected repository, which asks whether to resume it or start over.</summary>
    [RelayCommand(CanExecute = nameof(HasSelection))]
    private void ResumeApply()
    {
        if (Selected is { } row)
        {
            apply?.Invoke(row.FullName, CompareWith?.Listing);
        }
    }

    /// <summary>Starts an apply from the repository as it is, to change settings once without a profile.</summary>
    [RelayCommand(CanExecute = nameof(HasSelection))]
    private void ChangeSettings()
    {
        if (Selected is { } row)
        {
            apply?.Invoke(row.FullName, null);
        }
    }

    [RelayCommand(CanExecute = nameof(HasSelection))]
    private void Capture()
    {
        if (Selected is { } row)
        {
            capture(row.FullName);
        }
    }

    /// <summary>
    /// Starts a batch apply of the chosen profile to the chosen repositories,
    /// which shows each repository's changes to edit before anything is written.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanReviewBatch))]
    private void ReviewBatch()
    {
        if (CompareWith is { } profile)
        {
            batch?.Invoke([.. Chosen.Select(row => row.FullName)], profile.Listing);
        }
    }

    private bool CanReviewBatch() => Choosing && CompareWith is not null;

    /// <summary>Opens the unfinished batch apply, to resume it.</summary>
    [RelayCommand]
    private void ResumeBatch() => batch?.Invoke([], null);

    [RelayCommand]
    private Task OpenOnGitHubAsync() => Selected is { } row ? desktop.OpenUrlAsync(row.GitHubUrl) : Task.CompletedTask;

    private void ApplyFilter()
    {
        var selected = Selected?.FullName;
        var words = Filter.Trim();
        var shown = Owners.Where(owner => owner.Shown).Select(owner => owner.Owner).ToHashSet(StringComparer.OrdinalIgnoreCase);
        List<object> items = [];
        foreach (var group in ByOwner(all.Where(row => shown.Contains(row.Owner) && row.FullName.Contains(words, StringComparison.OrdinalIgnoreCase))))
        {
            items.Add(new OwnerHeading(group.Key, IsPersonal(group.Key), group.Count()));
            items.AddRange(group);
        }

        // The list is changed in place rather than filled again, so the rows chosen for a batch apply
        // that still show stay chosen. What stays keeps its order, since every list is in the same order.
        var kept = items.ToHashSet();
        for (var i = Items.Count - 1; i >= 0; i--)
        {
            if (!kept.Contains(Items[i]))
            {
                Items.RemoveAt(i);
            }
        }
        for (var i = 0; i < items.Count; i++)
        {
            if (i == Items.Count || !Equals(Items[i], items[i]))
            {
                Items.Insert(i, items[i]);
            }
        }

        // The list may have moved the selection to another chosen row that still shows; that one stays.
        var rows = Rows;
        Selected = rows.FirstOrDefault(row => row.FullName == Selected?.FullName)
            ?? rows.FirstOrDefault(row => row.FullName == selected)
            ?? (rows.Count > 0 ? rows[0] : null);
    }
}
