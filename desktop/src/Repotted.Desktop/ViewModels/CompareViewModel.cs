using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A section of a compare: the rows that differ, the rows that match, and a line for the rest.</summary>
internal sealed partial class CompareSectionViewModel : ViewModelBase
{
    private readonly IReadOnlyList<CompareRow> differences;

    private readonly IReadOnlyList<CompareRow> matching;

    private readonly WarningDocument? skippedBy;

    /// <summary>The text each row is found by, as <see cref="SettingSearch"/> compares it.</summary>
    private readonly Dictionary<CompareRow, string> terms = new(ReferenceEqualityComparer.Instance);

    /// <summary>The words searched for; none when the search is blank.</summary>
    private IReadOnlyList<string> words = [];

    /// <summary>The section's title as the search compares it, which finds a section the plan could not read.</summary>
    private readonly string titleTerms;

    private bool differencesOnly = true;

    private bool lockedOnly;

    /// <summary>
    /// A section of rows. A row is found by its label, its key, and what
    /// <c>terms</c> gives for it, such as the setting's description, synonyms
    /// and tab; without <c>terms</c>, as for rulesets, by the section's title.
    /// </summary>
    public CompareSectionViewModel(
        string title,
        IReadOnlyList<CompareRow> differences,
        IReadOnlyList<CompareRow> matching,
        string summary,
        WarningDocument? skippedBy = null,
        Func<CompareRow, string>? terms = null)
    {
        Title = title;
        this.differences = differences;
        this.matching = matching;
        Summary = summary;
        this.skippedBy = skippedBy;
        titleTerms = SettingSearch.Normalize(title);
        foreach (var row in differences.Concat(matching))
        {
            this.terms[row] = SettingSearch.Normalize($"{row.Label} {row.Key} {(terms is null ? title : terms(row))}");
        }
        Rows = differences;
    }

    public string Title { get; }

    public IReadOnlyList<CompareRow> Differences => differences;

    public bool InLine => !Skipped && differences.Count == 0;

    /// <summary>Whether the plan could not read this section, so nothing about it is known.</summary>
    public bool Skipped => skippedBy is not null;

    /// <summary>The plan's warning that says why this section was not read, which shows here and not with the other warnings.</summary>
    public WarningDocument? SkippedBy => skippedBy;

    public bool HasChanges => differences.Count > 0;

    public string Status => (Skipped, differences.Count) switch
    {
        (true, _) => "Not checked",
        (_, 0) => "In line",
        (_, 1) => "1 change",
        (_, var count) => $"{count} changes",
    };

    /// <summary>
    /// The rows on screen: the differences, with the matching rows when they
    /// aren't filtered out, only the locked ones when those alone are asked
    /// for, and of those only what the search finds. It changes only in
    /// <see cref="Filter"/>, and only when the rows it holds change.
    /// </summary>
    public IReadOnlyList<CompareRow> Rows { get; private set; }

    /// <summary>
    /// Whether the section shows: always when nothing narrows it, and
    /// otherwise when it has a row to show, or when it could not be read and
    /// the search finds its title, so a search doesn't hide what went unchecked.
    /// </summary>
    public bool Shown { get; private set; } = true;

    public string Summary { get; }

    /// <summary>
    /// The line for the rest, such as how many settings match, which a search
    /// or the locked filter hides since it counts rows they may leave out. A
    /// section the plan could not read always keeps its line, which says why.
    /// </summary>
    public bool HasSummary => Summary.Length > 0 && (Skipped || (words.Count == 0 && !lockedOnly));

    /// <summary>Shows what fits the compare's filters and has every word of <paramref name="search"/>.</summary>
    public void Filter(bool differencesOnly, bool lockedOnly, IReadOnlyList<string> search)
    {
        this.differencesOnly = differencesOnly;
        this.lockedOnly = lockedOnly;
        words = search;
        IReadOnlyList<CompareRow> rows =
        [
            .. (differencesOnly ? differences : differences.Concat(matching))
                .Where(row => (!lockedOnly || row.IsLocked) && SettingSearch.Matches(terms[row], words)),
        ];
        if (!rows.SequenceEqual(Rows, ReferenceEqualityComparer.Instance))
        {
            Rows = rows;
            OnPropertyChanged(nameof(Rows));
        }
        var shown = (words.Count == 0 && !lockedOnly) || rows.Count > 0
            || (Skipped && !lockedOnly && SettingSearch.Matches(titleTerms, words));
        if (shown != Shown)
        {
            Shown = shown;
            OnPropertyChanged(nameof(Shown));
        }
        OnPropertyChanged(nameof(HasSummary));
    }
}

/// <summary>
/// A profile compared with a repository: what the profile would change, by
/// section, as the plan has it. It only reads; nothing here writes to GitHub.
/// </summary>
/// <param name="client">Plans the compare.</param>
/// <param name="desktop">Opens the App's installation settings to review its access.</param>
/// <param name="repository">The repository, as owner/name.</param>
/// <param name="profile">The profile it is compared with.</param>
/// <param name="installUrl">Where the App is installed, for a repository it isn't installed on.</param>
/// <param name="apply">Starts an apply of the profile to the repository, which shows the diff again to edit before anything is written.</param>
internal sealed partial class CompareViewModel(
    RepottedClient client,
    IDesktop desktop,
    string repository,
    ProfileListingDocument profile,
    Uri? installUrl = null,
    Action<string, ProfileListingDocument?>? apply = null)
    : ViewModelBase
{
    public bool CanApply => apply is not null;

    [RelayCommand]
    private void Apply() => apply?.Invoke(repository, profile);

    public string Repository => repository;

    public string ProfileName => profile.Name;

    public string Heading => $"{profile.Name} compared with {repository}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Locked), nameof(HasLocks), nameof(LockSummary), nameof(HasAccessUrl), nameof(Summary))]
    public partial IReadOnlyList<CompareSectionViewModel> Sections { get; private set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWarnings))]
    public partial IReadOnlyList<string> Warnings { get; private set; } = [];

    public bool HasWarnings => Warnings.Count > 0;

    /// <summary>What the profile holds as drafts, which the compare leaves out, or null for none.</summary>
    [ObservableProperty]
    public partial string? DraftsNote { get; private set; }

    /// <summary>How many differences Repotted cannot change, as the plan's locks have it.</summary>
    public int Locked => Sections.Sum(section => section.Differences.Count(row => row.IsLocked));

    public bool HasLocks => Locked > 0;

    public string LockSummary => Locked == 1
        ? "Repotted can't change 1 difference below. It says what it needs."
        : $"Repotted can't change {Locked} differences below. Each says what it needs.";

    /// <summary>
    /// Where to grant what's missing: the settings page of the GitHub App's
    /// installation on the repository, or the App's install page when it isn't installed there.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasAccessUrl))]
    public partial Uri? AccessUrl { get; private set; }

    [ObservableProperty]
    public partial string AccessLabel { get; private set; } = "Review App access";

    public bool HasAccessUrl => HasLocks && AccessUrl is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowResult))]
    public partial bool Loading { get; set; }

    /// <summary>Whether a plan has come back, so the result can show, even when the profile sets nothing to compare.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowResult))]
    public partial bool Loaded { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowResult))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    public bool ShowResult => !Loading && Error is null && Loaded;

    /// <summary>Whether only what the profile would change shows, and matching settings are folded away; on at first.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary))]
    public partial bool DifferencesOnly { get; set; } = true;

    partial void OnDifferencesOnlyChanged(bool value) => Find();

    /// <summary>Whether only the differences Repotted can't change show; off at first, and only offered when there are some.</summary>
    [ObservableProperty]
    public partial bool LockedOnly { get; set; }

    partial void OnLockedOnlyChanged(bool value) => Find();

    /// <summary>What is typed in the compare's search.</summary>
    [ObservableProperty]
    public partial string Query { get; set; } = "";

    partial void OnQueryChanged(string value) => Find();

    /// <summary>Whether the search finds nothing, so a line says so in place of the rows.</summary>
    public bool NothingFound => SettingSearch.Words(Query).Length > 0 && !Sections.Any(section => section.Shown);

    public string NothingFoundMessage => (LockedOnly, DifferencesOnly) switch
    {
        (true, _) => $"No difference Repotted can't change matches \u201c{Query.Trim()}\u201d.",
        (_, true) => $"No differences match \u201c{Query.Trim()}\u201d.",
        _ => $"Nothing in this compare matches \u201c{Query.Trim()}\u201d.",
    };

    [RelayCommand]
    private void ClearSearch() => Query = "";

    private void Find()
    {
        var words = SettingSearch.Words(Query);
        foreach (var section in Sections)
        {
            section.Filter(DifferencesOnly, LockedOnly, words);
        }
        OnPropertyChanged(nameof(NothingFound));
        OnPropertyChanged(nameof(NothingFoundMessage));
    }

    public string Summary
    {
        get
        {
            var differences = Sections.Sum(section => section.Differences.Count);
            var sections = Sections.Count(section => section.HasChanges);
            if (Sections.Count == 0)
            {
                return $"{profile.Name} does not set anything Repotted compares.";
            }
            var rest = DifferencesOnly ? "Matching settings are folded away." : "Matching settings show below them.";
            return (differences, Sections.Any(section => section.Skipped)) switch
            {
                (0, false) => $"{repository} already has everything {profile.Name} sets.",
                (0, true) => "No differences in the sections Repotted could read.",
                _ => $"{Count(differences, "difference")} in {Count(sections, "section")}. {rest}",
            };
        }
    }

    [RelayCommand]
    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            var plan = await client.PlanAsync(repository, profile.File, CancellationToken.None).ConfigureAwait(true);
            Sections = PlanSections.Build(plan);
            // A section the plan could not read says so in its own place.
            Warnings = [.. plan.Warnings.Where(warning => !Sections.Any(section => section.SkippedBy == warning)).Select(warning => warning.Text)];
            (AccessLabel, AccessUrl) = PlanSections.Access(plan, installUrl);
            // The locked filter is only offered while something is locked, so a compare with nothing locked shows everything again.
            if (!HasLocks && LockedOnly)
            {
                LockedOnly = false;
            }
            else
            {
                Find();
            }
            DraftsNote = PlanSections.Drafts(plan);
            Loaded = true;
        }
        // A compare runs unawaited when it opens, so every failure shows here.
        catch (Exception error)
        {
            Error = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    [RelayCommand]
    private Task ReviewAccessAsync() => AccessUrl is { } url ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";
}
