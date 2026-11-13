using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A group of setting rows under its heading, which Reset puts back as last saved.</summary>
internal sealed partial class SettingGroupViewModel(string title, string description, IReadOnlyList<SettingViewModel> settings)
    : ViewModelBase
{
    public string Title { get; } = title;

    public string Description { get; } = description;

    public IReadOnlyList<SettingViewModel> Settings { get; } = settings;

    /// <summary>Whether a row in the group differs from what was last saved.</summary>
    public bool HasChanges => Settings.Any(setting => setting.HasChanges);

    public string ResetName => $"Reset the {Title} settings to what was last saved";

    [RelayCommand(CanExecute = nameof(HasChanges))]
    private void Reset()
    {
        foreach (var setting in Settings.Where(setting => setting.HasChanges))
        {
            setting.Undo();
        }
    }

    public void Refresh()
    {
        OnPropertyChanged(nameof(HasChanges));
        ResetCommand.NotifyCanExecuteChanged();
    }
}

/// <summary>A setting row in the search results, shown when the search and filters find it or a sub-option of it.</summary>
internal sealed partial class SettingResultViewModel(SettingViewModel setting) : ViewModelBase
{
    public SettingViewModel Setting { get; } = setting;

    [ObservableProperty]
    public partial bool Shown { get; set; }
}

/// <summary>
/// One group of settings in the search results, with the tab it is on. It
/// holds every row of the group and shows only those found, so a new search
/// shows and hides rows rather than building them again.
/// </summary>
internal sealed partial class SettingResultsViewModel(string tab, string title, IReadOnlyList<SettingResultViewModel> rows)
    : ViewModelBase
{
    public string Tab { get; } = tab;

    public string Title { get; } = title;

    public IReadOnlyList<SettingResultViewModel> Rows { get; } = rows;

    /// <summary>The settings shown in this group now.</summary>
    public IEnumerable<SettingViewModel> Settings => Rows.Where(row => row.Shown).Select(row => row.Setting);

    [ObservableProperty]
    public partial bool Shown { get; set; }
}

/// <summary>
/// Where a profile editor reads and saves its file, and how it names what it
/// edits: a profile, or the one-off edits of a staged apply, which is a
/// profile layer of its own over the profile it starts from.
/// </summary>
/// <param name="Load">Resolves the file.</param>
/// <param name="Save">Writes edits to the file, which the CLI checks first.</param>
/// <param name="Write">Runs a save's write, such as in its turn with the syncs of the profiles folder.</param>
/// <param name="SaveLabel">The save button's label.</param>
/// <param name="OwnLabel">The legend's name for values the file sets itself.</param>
/// <param name="Summary">The line under the heading, given what the file extends, if anything, and its name.</param>
/// <param name="Preview">
/// What applies before and after edits that are not saved, for Preview; null
/// where the file can't hold drafts, as a staged apply's one-off edits can't,
/// so Save as draft, Preview and the draft banner are not offered.
/// </param>
internal sealed record ProfileStore(
    Func<string, CancellationToken, Task<ResolvedProfile>> Load,
    Func<string, IReadOnlyList<ProfileChange>, IReadOnlyList<EntryChange>, CancellationToken, Task<ResolvedProfile>> Save,
    Func<Func<Task>, Task> Write,
    string SaveLabel,
    string OwnLabel,
    Func<string?, string, string> Summary,
    Func<string, IReadOnlyList<ProfileChange>, IReadOnlyList<EntryChange>, CancellationToken, Task<ProfilePreview>>? Preview = null)
{
    /// <summary>Whether the file can hold drafts: a profile can, and a staged apply's one-off edits can't.</summary>
    public bool Drafts => Preview is not null;

    /// <summary>A profile file in <paramref name="folder"/>, which each save writes in its turn with the folder's syncs.</summary>
    public static ProfileStore Profile(RepottedClient client, ProfileFolder folder) => new(
        client.ProfileAsync,
        client.SaveProfileAsync,
        folder.WriteAsync,
        "Save",
        "Set in this profile",
        (@base, file) => @base is null ? $"Saved to {file}." : $"Extends {@base}. Saved to {file}.",
        client.PreviewProfileAsync);
}

/// <summary>
/// One profile, resolved over the profiles it extends: its settings by tab,
/// marked as set here, inherited, or not managed, and the edits waiting to be
/// saved to its file.
/// </summary>
/// <param name="client">Reads and saves the profile.</param>
/// <param name="listing">The profile in the folder.</param>
/// <param name="store">Where it reads and saves, and how a save's write takes its turn.</param>
/// <param name="saved">Runs after each save, such as to sync the folder with its config repository.</param>
/// <param name="close">Closes the editor, which asks first about unsaved changes; null where the page holds it open.</param>
/// <param name="delete">Asks whether to delete the profile; null where an editor can't delete its file, such as on the Apply page.</param>
internal sealed partial class ProfileViewModel(
    RepottedClient client,
    ProfileListingDocument listing,
    ProfileStore store,
    Func<Task>? saved = null,
    Func<Task>? close = null,
    Action? delete = null) : ViewModelBase
{
    public string SaveLabel => store.SaveLabel;

    public string OwnLabel => store.OwnLabel;

    /// <summary>Whether the file can hold drafts, so the Drafts filter is offered; a staged apply's one-off edits can't.</summary>
    public bool HoldsDrafts => store.Drafts;

    public string Name => listing.Name;

    /// <summary>The subfolder of the profiles folder the file is in; empty for the folder itself.</summary>
    public string Folder => listing.Folder;

    /// <summary>Its name with its subfolder, such as <c>team/oss</c>, as the sidebar names it.</summary>
    public string Label => Folder.Length == 0 ? Name : $"{Folder}/{Name}";

    public string File => listing.File;

    public string FileName => Path.GetFileName(listing.File);

    public ObservableCollection<ProfileTabViewModel> Tabs { get; } = [];

    [ObservableProperty]
    public partial ProfileTabViewModel? SelectedTab { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEditor))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(ResetCommand), nameof(ReloadCommand), nameof(SaveAsDraftCommand), nameof(PreviewCommand), nameof(DiscardDraftCommand), nameof(ConfirmDiscardDraftCommand), nameof(PreviewSaveCommand), nameof(PreviewSaveAsDraftCommand), nameof(DeleteCommand))]
    public partial bool Loading { get; set; }

    /// <summary>Whether a save is running; the editor stays on screen, and nothing else can change it.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(ResetCommand), nameof(ReloadCommand), nameof(SaveAsDraftCommand), nameof(PreviewCommand), nameof(DiscardDraftCommand), nameof(ConfirmDiscardDraftCommand), nameof(PreviewSaveCommand), nameof(PreviewSaveAsDraftCommand), nameof(DeleteCommand))]
    public partial bool Saving { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowEditor))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    /// <summary>Why saving failed, such as a change GitHub would not take; the edits stay.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSaveError))]
    public partial string? SaveError { get; set; }

    public bool HasSaveError => SaveError is not null;

    /// <summary>The profile's file and the files it extends, own file first, as the editor last loaded or saved them.</summary>
    private List<string> chain = [];

    /// <summary>The text of each file in the chain when the editor last loaded or saved it; null when it could not be read.</summary>
    private Dictionary<string, string?> loaded = new(StringComparer.Ordinal);

    /// <summary>
    /// The file whose change since the editor read it stopped a save, such as
    /// by a sync: saving writes each edited entry whole, from the copy the
    /// editor read, so it would undo that change. Null when nothing stops it.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(OutOfDate), nameof(OutOfDateMessage))]
    public partial string? ChangedFile { get; private set; }

    public bool OutOfDate => ChangedFile is not null;

    public string OutOfDateMessage => returned
        ? $"{FileName} is back in the folder, but not as you opened it, so saving would put your unsaved changes over what it has now. Reload discards your unsaved changes."
        : ChangedFile is null || ChangedFile == File
        ? $"{FileName} changed since you opened it, so saving would undo that change to the rulesets, environments and labels you edited. Reload discards your unsaved changes."
        // A removed profile has no file to reload, so only Keep mine is offered.
        : Removed
        ? $"{Path.GetFileName(ChangedFile)} changed since you opened this profile, so saving would set the old copy of the inherited rulesets, environments and labels you edited."
        : $"{Path.GetFileName(ChangedFile)} changed since you opened this profile, so saving would set the old copy of the inherited rulesets, environments and labels you edited. Reload discards your unsaved changes.";

    /// <summary>
    /// Whether the file is gone from the folder, such as after a sync, while
    /// the editor holds unsaved edits; saving puts it back.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RemovedMessage), nameof(OutOfDateMessage))]
    [NotifyCanExecuteChangedFor(nameof(ReloadCommand), nameof(DeleteCommand))]
    public partial bool Removed { get; set; }

    partial void OnRemovedChanged(bool value)
    {
        if (value)
        {
            ChangedFile = null;
        }
    }

    /// <summary>Whether the file came back after it was removed, with other text than the editor read.</summary>
    private bool returned;

    partial void OnChangedFileChanged(string? value)
    {
        if (value is null)
        {
            returned = false;
        }
    }

    public string RemovedMessage =>
        $"{FileName} is no longer in the folder, such as after a sync with GitHub removed it. {store.SaveLabel} puts it back with your unsaved changes, and Reset lets it go.";

    public bool ShowEditor => !Loading && Error is null && Tabs.Count > 0;

    /// <summary>The profile this one extends, if any.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary), nameof(InheritedLabel))]
    public partial string? BaseName { get; set; }

    /// <summary>What stops each draft from applying as it stands, as the profile was last read or saved.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasDraftWarnings))]
    public partial IReadOnlyList<string> DraftWarnings { get; private set; } = [];

    public bool HasDraftWarnings => DraftWarnings.Count > 0;

    public string Summary => store.Summary(BaseName, FileName);

    /// <summary>The profile file's own text, as saved.</summary>
    [ObservableProperty]
    public partial string Yaml { get; set; } = "";

    /// <summary>
    /// Whether the YAML panel shows. It starts hidden for a profile, and open
    /// for one-off edits, whose panel shows what the apply changes beside them.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(YamlLabel))]
    public partial bool ShowYaml { get; set; } = !store.Drafts;

    public string YamlLabel => ShowYaml ? "Hide YAML" : "Show YAML";

    /// <summary>
    /// What the last plan of this profile changes, as a diff the YAML panel
    /// shows beside the file, or null where nothing plans it, as outside an apply.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasDiff), nameof(ShowingDiff), nameof(ShowingFile), nameof(YamlWidth))]
    public partial PlanDiffViewModel? Diff { get; set; }

    /// <summary>Whether the YAML panel shows the diff rather than the file, when there is one.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingDiff), nameof(ShowingFile))]
    public partial bool DiffChosen { get; set; } = true;

    public bool HasDiff => Diff is not null;

    public bool ShowingDiff => Diff is not null && DiffChosen;

    public bool ShowingFile => !ShowingDiff;

    /// <summary>The YAML panel is wider with a diff, whose lines carry a sign and tags.</summary>
    public double YamlWidth => Diff is null ? 360 : 400;

    /// <summary>The legend's name for inherited values.</summary>
    public string InheritedLabel => BaseName is null ? "From a base profile" : $"From {BaseName}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasChanges), nameof(ChangesLabel))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(ResetCommand), nameof(ReloadCommand), nameof(SaveAsDraftCommand), nameof(PreviewCommand), nameof(DiscardDraftCommand), nameof(ConfirmDiscardDraftCommand), nameof(PreviewSaveCommand), nameof(PreviewSaveAsDraftCommand), nameof(DeleteCommand))]
    public partial int ChangeCount { get; set; }

    public bool HasChanges => ChangeCount > 0;

    public string ChangesLabel => ChangeCount == 1 ? "1 unsaved change" : $"{ChangeCount} unsaved changes";

    /// <summary>
    /// How many changes this profile's own draft holds, as last saved: draft
    /// settings, rulesets, environments and labels, and what it takes out.
    /// Plans leave them out until Save finishes them.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasDraft), nameof(DraftLabel), nameof(DraftMessage), nameof(ChangesStatus))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(DiscardDraftCommand), nameof(ConfirmDiscardDraftCommand), nameof(PreviewCommand), nameof(PreviewSaveCommand))]
    public partial int DraftCount { get; private set; }

    /// <summary>Whether this profile has a draft of its own, saved but not applied.</summary>
    public bool HasDraft => DraftCount > 0;

    public string DraftLabel => DraftCount == 1 ? "Draft: 1 change" : $"Draft: {DraftCount} changes";

    public string DraftMessage => DraftCount == 1
        ? "1 change in this profile doesn't apply yet: compare and apply leave it out until you save."
        : $"{DraftCount} changes in this profile don't apply yet: compare and apply leave them out until you save.";

    /// <summary>The unsaved changes as the footer counts them, after the draft when there is one.</summary>
    public string ChangesStatus => HasDraft ? $"· {ChangesLabel}" : ChangesLabel;

    /// <summary>Whether Discard draft is waiting on its question, as it writes at once and can't be undone.</summary>
    [ObservableProperty]
    public partial bool ConfirmingDiscardDraft { get; private set; }

    /// <summary>The Preview sheet, while it is open.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Previewing))]
    public partial ProfilePreviewViewModel? Preview { get; private set; }

    public bool Previewing => Preview is not null;

    /// <summary>Whether Preview is reading what Save would apply.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(PreviewCommand))]
    public partial bool PreviewLoading { get; private set; }

    /// <summary>Whether the file, as last loaded or saved, sets any setting, ruleset, environment or label itself.</summary>
    public bool SetsAnything =>
        Settings.Any(setting => setting.Origin == SettingOrigin.Own) || Entries.Any(entry => entry.Origin == SettingOrigin.Own);

    /// <summary>What is typed in the settings search.</summary>
    [ObservableProperty]
    public partial string Query { get; set; } = "";

    partial void OnQueryChanged(string value) => Find();

    /// <summary>Whether only settings the profile manages show: set here or by a profile it extends.</summary>
    [ObservableProperty]
    public partial bool OnlyManaged { get; set; }

    partial void OnOnlyManagedChanged(bool value) => Find();

    /// <summary>Whether only settings with a change, text or draft change waiting to be saved show.</summary>
    [ObservableProperty]
    public partial bool OnlyUnsaved { get; set; }

    partial void OnOnlyUnsavedChanged(bool value) => Find();

    /// <summary>Whether only settings in this profile's own draft show.</summary>
    [ObservableProperty]
    public partial bool OnlyDrafts { get; set; }

    partial void OnOnlyDraftsChanged(bool value) => Find();

    partial void OnChangeCountChanged(int value) => OnPropertyChanged(nameof(ChangesStatus));

    /// <summary>Whether a search or filter is on, so the settings it found show in place of the tabs.</summary>
    public bool Filtering { get; private set; }

    /// <summary>
    /// Every settings group across the settings tabs, each showing what the
    /// search and filters found. A sub-option shows under the setting it
    /// belongs to, so that setting comes with it. The rows are made once for
    /// each load of the profile, the first time a search or filter is on, and
    /// what shows changes only when the search or a filter changes, not when a
    /// row changes, so a row doesn't vanish as you edit it.
    /// </summary>
    public IReadOnlyList<SettingResultsViewModel> Results { get; private set; } = [];

    /// <summary>How many settings were found, or that none were.</summary>
    public string ResultsSummary { get; private set; } = "";

    public bool HasResults => Results.Any(group => group.Shown);

    /// <summary>The search and filters <see cref="Find"/> last showed, so a change that finds the same, such as a trailing space, does nothing.</summary>
    private string? found;

    /// <summary>Set while <see cref="ClearFilters"/> turns several things off, so it finds once.</summary>
    private bool clearing;

    [RelayCommand]
    private void ClearFilters()
    {
        clearing = true;
        Query = "";
        OnlyManaged = false;
        OnlyUnsaved = false;
        OnlyDrafts = false;
        clearing = false;
        Find();
    }

    /// <summary>Finds the settings that match the search and every filter that is on.</summary>
    /// <param name="again">Finds even when the search and filters are the same, as when the rows are new.</param>
    private void Find(bool again = false)
    {
        var words = SettingSearch.Words(Query);
        var key = $"{OnlyManaged} {OnlyUnsaved} {OnlyDrafts} {string.Join(' ', words)}";
        if (clearing || (!again && key == found))
        {
            return;
        }
        found = key;
        Filtering = words.Length > 0 || OnlyManaged || OnlyUnsaved || OnlyDrafts;
        var count = 0;
        if (Filtering)
        {
            if (Results.Count == 0)
            {
                Results = [.. Tabs.Where(tab => tab.IsSettings).SelectMany(tab => tab.Groups.Select(group =>
                    new SettingResultsViewModel(tab.Name, group.Title, [.. group.Settings.Select(row => new SettingResultViewModel(row))])))];
                OnPropertyChanged(nameof(Results));
            }
            foreach (var group in Results)
            {
                var fits = group.Rows.Where(row => Fits(row.Setting, words)).ToList();
                count += fits.Count;
                var parents = fits.Select(row => SettingSearch.Parent(row.Setting.Field)).OfType<SettingField>()
                    .Concat(fits.SelectMany(row => Above(row.Setting)).Select(above => above.Field))
                    .ToHashSet(ReferenceEqualityComparer.Instance);
                foreach (var row in group.Rows)
                {
                    row.Shown = fits.Contains(row) || parents.Contains(row.Setting.Field);
                }
                group.Shown = fits.Count > 0;
            }
        }
        ResultsSummary = count switch
        {
            0 when words.Length > 0 => $"No settings match \u201c{Query.Trim()}\u201d.",
            0 when OnlyUnsaved && Entries.Any(entry => entry.Changed) => "No settings match these filters. Unsaved changes to rulesets, environments and labels are on their own tabs.",
            0 when OnlyDrafts && Entries.Any(entry => entry.HasDraft) => "No settings match these filters. Drafts of rulesets, environments and labels are on their own tabs.",
            0 => "No settings match these filters.",
            1 => "1 setting found.",
            _ => $"{count} settings found.",
        };
        foreach (var name in (string[])[nameof(Filtering), nameof(ResultsSummary), nameof(HasResults)])
        {
            OnPropertyChanged(name);
        }
    }

    private bool Fits(SettingViewModel row, string[] words) =>
        SettingSearch.Matches(row.Field, words)
        && (!OnlyManaged || row.Managed)
        && (!OnlyUnsaved || row.HasChanges)
        && (!OnlyDrafts || row.HasDraft);

    private IEnumerable<SettingViewModel> Settings =>
        Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings);

    private IEnumerable<EntryViewModel> Entries => Tabs.SelectMany(tab => tab.Entries);

    /// <summary>Why Save can't apply the edits yet, such as a ruleset with no name or a rule that isn't finished.</summary>
    public string? Problem => TypedProblem
        ?? Entries.Select(entry => entry.Problem).FirstOrDefault(problem => problem is not null);

    /// <summary>
    /// Why Save as draft can't keep the edits yet: a draft may be unfinished,
    /// but each entry needs a name of its own, and a box needs a value.
    /// </summary>
    public string? DraftProblem => TypedProblem
        ?? Settings.Select(setting => setting.DraftProblem).FirstOrDefault(problem => problem is not null)
        ?? Entries.Select(entry => entry.DraftProblem).FirstOrDefault(problem => problem is not null);

    private string? TypedProblem =>
        Settings.Where(setting => setting.Invalid).Select(setting => $"{setting.Label}: {setting.TypedProblem}").FirstOrDefault();

    [RelayCommand]
    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            // Read the files first, so a change the load misses still counts as a change since.
            var texts = ReadChain();
            var profile = await store.Load(File, CancellationToken.None).ConfigureAwait(true);
            await ShowAsync(profile, texts).ConfigureAwait(true);
        }
        // A load runs unawaited when a profile opens, so every failure shows here.
        catch (Exception error)
        {
            Error = error.Message;
            ChangedFile = null;
        }
        finally
        {
            Loading = false;
        }
    }

    /// <summary>The text of each file the editor last read, read now, or null for one that cannot be read.</summary>
    public Dictionary<string, string?> ReadChain() => ReadFiles(chain.Count == 0 ? [File] : chain);

    /// <summary>
    /// Shows the file as <paramref name="profile"/> resolves it, such as the
    /// staged apply a change to it returned, which needs no load.
    /// <paramref name="texts"/> holds the text of each file from before the
    /// file was resolved, so a change the resolve missed still counts as a
    /// change since. A file the chain gains, such as a base read for the
    /// first time, can only be read after.
    /// </summary>
    public async Task ShowAsync(ResolvedProfile profile, Dictionary<string, string?> texts)
    {
        foreach (var file in ChainOf(profile).Where(file => !texts.ContainsKey(file)))
        {
            texts[file] = ReadFile(file);
        }
        Show(profile, await BaseAsync(profile, texts).ConfigureAwait(true));
        Remember(ChainOf(profile), texts);
        Error = null;
        ChangedFile = null;
        SaveError = null;
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    private Task SaveAsync() => SaveAsync(overwrite: false);

    /// <summary>Saves over a change to the file since the editor read it.</summary>
    [RelayCommand(CanExecute = nameof(CanSave))]
    private Task KeepMineAsync() => SaveAsync(overwrite: true);

    /// <summary>Starts over from the file as it is now, without the unsaved edits.</summary>
    [RelayCommand(CanExecute = nameof(CanReload))]
    private Task ReloadAsync() => LoadAsync();

    private bool CanReload() => CanReset() && !Removed;

    /// <summary>Whether this editor offers Delete profile: the Profiles page's editors do, the Apply page's doesn't.</summary>
    public bool Deletable => delete is not null;

    /// <summary>
    /// Asks whether to delete the profile. A removed profile has no file to
    /// delete, so Reset lets it go instead, and a load or save holds it.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanDelete))]
    private void Delete() => delete?.Invoke();

    private bool CanDelete() => delete is not null && !Loading && !Saving && !Removed;

    /// <summary>
    /// Takes the file as listed again: a removed file that came back with
    /// other text than the editor read, such as a new profile of the same
    /// name, asks before any save; otherwise the file is checked as usual.
    /// </summary>
    public void FileListed()
    {
        if (Removed)
        {
            Removed = false;
            if (!string.Equals(ReadFile(File), loaded.GetValueOrDefault(File), StringComparison.Ordinal))
            {
                returned = true;
                ChangedFile = File;
                return;
            }
        }
        CheckFile();
    }

    /// <summary>
    /// Asks whether saving would undo a change to the file since the editor
    /// read it, and shows the choice when it would. Saving settings writes
    /// only the keys edited, so only edited rulesets, environments and labels count.
    /// </summary>
    public void CheckFile()
    {
        if (StaleFile() is { } file)
        {
            ChangedFile = file;
        }
    }

    /// <summary>
    /// The first file that changed since the editor read it under an edited
    /// entry: the profile's own file for any edited entry, and a file it
    /// extends for an edited entry this profile inherits, which a save writes
    /// whole into this profile as an override.
    /// </summary>
    private string? StaleFile()
    {
        // A file that came back as something else stops any save, settings too.
        if (returned && !string.Equals(ReadFile(File), loaded.GetValueOrDefault(File), StringComparison.Ordinal))
        {
            return File;
        }
        var edited = Entries.Where(entry => entry.Changed).ToList();
        if (edited.Count == 0)
        {
            return null;
        }
        var inherited = edited.Any(entry => !entry.Own);
        var files = chain.Count == 0 ? [File] : inherited ? chain : chain.Take(1);
        return files.FirstOrDefault(file =>
            !string.Equals(ReadFile(file), loaded.GetValueOrDefault(file), StringComparison.Ordinal));
    }

    /// <summary>The profile's chain with this editor's own path first, so each file has one key.</summary>
    private List<string> ChainOf(ResolvedProfile profile) => [File, .. profile.Chain.Skip(1)];

    private void Remember(IEnumerable<string> files, Dictionary<string, string?> texts)
    {
        chain = files.Distinct(StringComparer.Ordinal).ToList();
        loaded = chain.ToDictionary(file => file, file => texts.GetValueOrDefault(file), StringComparer.Ordinal);
    }

    private Task SaveAsync(bool overwrite)
    {
        var (changes, entries) = SaveEdits();
        return WriteAsync(changes, entries, overwrite);
    }

    /// <summary>
    /// The edits Save makes: every value as it ends, so it applies, and this
    /// profile's draft taken out, since what it held is applied or reset.
    /// </summary>
    private (List<ProfileChange> Changes, List<EntryChange> Entries) SaveEdits()
    {
        var rows = Settings.ToList();
        var shown = rows.Select(row => row.Field.Path).ToHashSet(StringComparer.Ordinal);
        // Drafts the editor has no row for, of a custom property, are finished as they are.
        var others = OwnDraftSettings().Where(draft => !shown.Contains(draft.Key)).ToList();
        // A key no row stands for: a custom property's is unset; one with a row, or an entry's, names
        // what this file doesn't set, so it changes nothing and just leaves the list.
        var gone = OwnUnsets().Where(key => !Handled(key) && !key.Contains('/', StringComparison.Ordinal) && !shown.Contains(key));
        var changes = rows.SelectMany(row => row.SaveChanges())
            .Concat(others.Select(draft => new ProfileChange(draft.Key, draft.Value?.DeepClone(), SetsNull: draft.Value is null)))
            .Concat(others.Select(draft => new ProfileChange($"drafts.{draft.Key}", null)))
            .Concat(gone.Select(key => new ProfileChange(key, null)))
            .ToList();
        // Only autolinks, which the editor doesn't show, stay in the list.
        changes.AddRange(UnsetChange([.. AutolinkUnsets()]));
        return (changes, Ordered(Entries.SelectMany(entry => entry.SaveChanges())));
    }

    /// <summary>
    /// The edits Save as draft makes: every value as it ends that is not the
    /// one that applies, as a draft, and nothing that applies changed.
    /// </summary>
    private (List<ProfileChange> Changes, List<EntryChange> Entries) DraftEdits()
    {
        var shown = Settings.Select(row => row.Field.Path).ToHashSet(StringComparer.Ordinal);
        // A key no row stands for stays, unless a row or entry list could: then it names what this file doesn't set.
        var unset = AllOwnUnsets().Where(key => !Handled(key) && (IsAutolink(key) || !(key.Contains('/', StringComparison.Ordinal) || shown.Contains(key))))
            .Concat(Settings.Where(row => row.UnsetOnDraft).Select(row => row.Field.Path))
            .Concat(Entries.Select(entry => entry.UnsetOnDraft).OfType<string>())
            .ToList();
        List<ProfileChange> changes = [.. Settings.SelectMany(row => row.DraftChanges()), .. UnsetChange(unset)];
        return (changes, Ordered(Entries.SelectMany(entry => entry.DraftChanges())));
    }

    /// <summary>
    /// The CLI takes a write right after a drop as a rename in place, so plain
    /// writes go first, then drops, and each rename last, as its drop and write.
    /// </summary>
    private static List<EntryChange> Ordered(IEnumerable<IReadOnlyList<EntryChange>> steps)
    {
        var all = steps.ToList();
        var single = all.Where(step => step.Count == 1).Select(step => step[0]).ToList();
        return
        [
            .. single.Where(change => change.Entry is not null),
            .. single.Where(change => change.Entry is null),
            .. all.Where(step => step.Count > 1).SelectMany(step => step),
        ];
    }

    /// <summary>The edit that makes <c>drafts.unset</c> hold <paramref name="keys"/>, or none when it already does.</summary>
    private IEnumerable<ProfileChange> UnsetChange(List<string> keys)
    {
        if (keys.SequenceEqual(AllOwnUnsets(), StringComparer.Ordinal))
        {
            yield break;
        }
        yield return new ProfileChange("drafts.unset", keys.Count == 0 ? null : new JsonArray([.. keys.Select(key => JsonValue.Create(key))]));
    }

    /// <summary>Whether a row stands for a key of <c>drafts.unset</c>, so the row says whether it stays.</summary>
    private bool Handled(string key) =>
        Settings.Any(row => row.Unsets && row.Field.Path == key)
        || Entries.Any(entry => entry.UnsetKey is { } own && string.Equals(own, key, StringComparison.OrdinalIgnoreCase));

    /// <summary>This profile's own keys of <c>drafts.unset</c>, as the editor last loaded or saved it.</summary>
    private IReadOnlyList<string> AllOwnUnsets() => resolved is { } profile
        ? [.. profile.DraftSources.GetValueOrDefault("unset", Empty).Where(pair => IsOwn(pair.Value)).Select(pair => pair.Key)]
        : [];

    /// <summary>The own keys of <c>drafts.unset</c> that name an autolink, which the editor doesn't show, so it keeps them.</summary>
    private IEnumerable<string> AutolinkUnsets() => AllOwnUnsets().Where(IsAutolink);

    /// <summary>The own keys of <c>drafts.unset</c> the editor saves and discards.</summary>
    private IEnumerable<string> OwnUnsets() => AllOwnUnsets().Where(key => !IsAutolink(key));

    private static bool IsAutolink(string key) => key.StartsWith("autolinks/", StringComparison.Ordinal);

    /// <summary>
    /// This profile's own draft settings, by path, as the editor last loaded
    /// or saved it: those with a row, and of custom properties. A draft of a
    /// key no section has stays in the file, with the profile's warning.
    /// </summary>
    private IEnumerable<KeyValuePair<string, JsonNode?>> OwnDraftSettings()
    {
        if (resolved is not { } profile)
        {
            yield break;
        }
        var shown = Settings.Select(row => row.Field.Path).ToHashSet(StringComparer.Ordinal);
        foreach (var section in Sections)
        {
            var drafts = profile.Drafts.TryGetProperty(section, out var found) ? found : default;
            foreach (var (key, file) in profile.DraftSources.GetValueOrDefault(section, Empty))
            {
                if (IsOwn(file) && (section == "custom_properties" || shown.Contains($"{section}.{key}")))
                {
                    yield return new($"{section}.{key}", SettingViewModel.Find(drafts, key));
                }
            }
        }
    }

    private static readonly IReadOnlyDictionary<string, string> Empty = new Dictionary<string, string>();

    /// <summary>The sections that hold settings, as a profile names them.</summary>
    private static readonly string[] Sections = ["repository", "merge", "actions", "security", "custom_properties", "pages"];

    /// <summary>The lists whose drafts the editor shows, and so can save and discard.</summary>
    private static readonly string[] Lists = ["rulesets", "environments", "labels"];

    private bool IsOwn(string file) => resolved is { } profile && string.Equals(file, profile.File, StringComparison.Ordinal);

    /// <summary>The profile as the editor last loaded or saved it.</summary>
    private ResolvedProfile? resolved;

    /// <summary>How many changes the profile's own draft holds, of those the editor can save and discard.</summary>
    private int CountDraft() =>
        OwnDraftSettings().Count()
        + OwnUnsets().Count()
        + Lists.Sum(list => resolved?.DraftSources.GetValueOrDefault(list, Empty).Count(pair => IsOwn(pair.Value)) ?? 0);

    /// <summary>Keeps every unsaved change as this profile's draft, which plans leave out until Save.</summary>
    [RelayCommand(CanExecute = nameof(CanSaveAsDraft))]
    private Task SaveAsDraftAsync()
    {
        var (changes, entries) = DraftEdits();
        return WriteAsync(changes, entries, overwrite: false);
    }

    /// <summary>Why Save as draft can't keep the edits, when Save could still apply them.</summary>
    public string? DraftOnlyProblem => store.Drafts && HasChanges && Problem is null ? DraftProblem : null;

    public bool HasDraftOnlyProblem => DraftOnlyProblem is not null;

    private bool CanSaveAsDraft() => store.Drafts && HasChanges && !Saving && !Loading && DraftProblem is null;

    /// <summary>Asks before Discard draft, which writes at once.</summary>
    [RelayCommand(CanExecute = nameof(CanDiscardDraft))]
    private void DiscardDraft() => ConfirmingDiscardDraft = true;

    [RelayCommand]
    private void CancelDiscardDraft() => ConfirmingDiscardDraft = false;

    /// <summary>Takes this profile's draft out of its file, so only what applies stays.</summary>
    [RelayCommand(CanExecute = nameof(CanDiscardDraft))]
    private Task ConfirmDiscardDraftAsync()
    {
        ConfirmingDiscardDraft = false;
        List<ProfileChange> changes =
        [
            .. OwnDraftSettings().Select(draft => new ProfileChange($"drafts.{draft.Key}", null)),
            .. UnsetChange([.. AutolinkUnsets()]),
        ];
        var entries = Lists.SelectMany(list => resolved?.DraftSources.GetValueOrDefault(list, Empty)
            .Where(pair => IsOwn(pair.Value))
            .Select(pair => new EntryChange(list, pair.Key, null, Draft: true)) ?? []).ToList();
        return WriteAsync(changes, entries, overwrite: false);
    }

    /// <summary>Discard draft writes at once, so it waits until no unsaved change would be lost with the reload.</summary>
    private bool CanDiscardDraft() => HasDraft && !HasChanges && !Saving && !Loading;

    /// <summary>Opens the Preview sheet: what applies now against what applies once Save runs.</summary>
    [RelayCommand(CanExecute = nameof(CanPreview))]
    private async Task PreviewAsync()
    {
        if (store.Preview is not { } preview)
        {
            return;
        }
        var (changes, entries) = SaveEdits();
        PreviewLoading = true;
        SaveError = null;
        try
        {
            var texts = await preview(File, changes, entries, CancellationToken.None).ConfigureAwait(true);
            Preview = new ProfilePreviewViewModel(Name, texts, DraftCount, ChangeCount);
        }
        catch (Exception error)
        {
            SaveError = error.Message;
        }
        finally
        {
            PreviewLoading = false;
        }
    }

    private bool CanPreview() => store.Drafts && (HasChanges || HasDraft) && !Saving && !Loading && !PreviewLoading && TypedProblem is null;

    [RelayCommand]
    private void ClosePreview() => Preview = null;

    /// <summary>Save as draft from the Preview sheet, which closes it.</summary>
    [RelayCommand(CanExecute = nameof(CanSaveAsDraft))]
    private Task PreviewSaveAsDraftAsync()
    {
        Preview = null;
        return SaveAsDraftAsync();
    }

    /// <summary>Save from the Preview sheet, which closes it.</summary>
    [RelayCommand(CanExecute = nameof(CanSave))]
    private Task PreviewSaveAsync()
    {
        Preview = null;
        return SaveAsync(overwrite: false);
    }

    private async Task WriteAsync(List<ProfileChange> changes, List<EntryChange> entries, bool overwrite)
    {
        Saving = true;
        SaveError = null;
        try
        {
            ResolvedProfile? profile = null;
            Dictionary<string, string?> texts = [];
            async Task Write()
            {
                // A file gone since the last refresh is shown as gone first, and put back only on a save made knowing that.
                var restored = false;
                if (!System.IO.File.Exists(File))
                {
                    if (!Removed)
                    {
                        Removed = true;
                        return;
                    }
                    Restore();
                    restored = true;
                }
                else if (Removed)
                {
                    // Back before a refresh listed it, so it is taken as listed first.
                    FileListed();
                    if (returned)
                    {
                        return;
                    }
                }
                try
                {
                    // Checked here, after any sync before the save, so a file that sync changed counts.
                    if (!overwrite && StaleFile() is { } file)
                    {
                        ChangedFile = file;
                        return;
                    }
                    profile = await store.Save(File, changes, entries, CancellationToken.None).ConfigureAwait(true);
                    texts = ReadFiles(ChainOf(profile));
                }
                finally
                {
                    // A put-back file that took no edits goes again, so the profile stays removed.
                    if (restored && profile is null)
                    {
                        System.IO.File.Delete(File);
                    }
                }
            }
            await store.Write(Write).ConfigureAwait(true);
            if (profile is null)
            {
                return;
            }
            Removed = false;
            Show(profile, await BaseAsync(profile, texts).ConfigureAwait(true));
            Remember(ChainOf(profile), texts);
            ChangedFile = null;
            if (saved is not null)
            {
                await saved().ConfigureAwait(true);
            }
        }
        catch (Exception error)
        {
            SaveError = error.Message;
        }
        finally
        {
            Saving = false;
        }
    }

    /// <summary>Save applies the unsaved changes and the draft together, so it needs one of them, and every entry valid.</summary>
    private bool CanSave() => (HasChanges || HasDraft) && !Saving && !Loading && Problem is null;

    private bool CanReset() => HasChanges && !Saving && !Loading;

    /// <summary>Puts the whole profile back as last saved, draft included.</summary>
    [RelayCommand(CanExecute = nameof(CanReset))]
    private void Reset()
    {
        foreach (var setting in Settings.Where(setting => setting.HasChanges))
        {
            setting.Undo();
        }
        foreach (var tab in Tabs.Where(tab => tab.IsEntries))
        {
            tab.Undo();
        }
        SaveError = null;
        ChangedFile = null;
    }

    /// <summary>
    /// The base as <see cref="BaseAsync"/> last resolved it, with the files it
    /// resolves from and their text as the editor read them before.
    /// </summary>
    private (List<string> Files, List<string?> Texts, ResolvedProfile Base)? resolvedBase;

    /// <summary>
    /// The profile this one extends, resolved alone, which gives each value a
    /// setting falls back to when this profile stops setting it. It resolves
    /// from the files after this one in the chain, so while each reads as it
    /// did, as <paramref name="texts"/> has them, the base resolved last is
    /// used again. A base that is not a valid profile by itself gives none,
    /// and the next load or save tries it again.
    /// </summary>
    private async Task<ResolvedProfile?> BaseAsync(ResolvedProfile profile, Dictionary<string, string?> texts)
    {
        if (profile.Chain.Count < 2)
        {
            return null;
        }
        List<string> files = [.. profile.Chain.Skip(1)];
        List<string?> read = [.. files.Select(file => texts.GetValueOrDefault(file))];
        if (resolvedBase is { } kept
            && kept.Files.SequenceEqual(files, StringComparer.Ordinal)
            && kept.Texts.SequenceEqual(read, StringComparer.Ordinal))
        {
            return kept.Base;
        }
        try
        {
            var @base = await client.ProfileAsync(files[0], CancellationToken.None).ConfigureAwait(true);
            resolvedBase = (files, read, @base);
            return @base;
        }
        catch (CliException)
        {
            resolvedBase = null;
            return null;
        }
    }

    /// <summary>Whether the editor can be closed, as on the Profiles page; one-off edits on the Apply and Batch pages close with their page.</summary>
    public bool CanClose => close is not null;

    [RelayCommand]
    private Task CloseAsync() => close?.Invoke() ?? Task.CompletedTask;

    [RelayCommand]
    private void ToggleYaml() => ShowYaml = !ShowYaml;

    [RelayCommand]
    private void ShowDiff() => Choose(diff: true);

    [RelayCommand]
    private void ShowFile() => Choose(diff: false);

    /// <summary>
    /// Shows the diff or the file. A click on the segment already chosen
    /// unchecks its toggle, so both are told again even when nothing changed.
    /// </summary>
    private void Choose(bool diff)
    {
        DiffChosen = diff;
        OnPropertyChanged(nameof(ShowingDiff));
        OnPropertyChanged(nameof(ShowingFile));
    }

    private void Show(ResolvedProfile profile, ResolvedProfile? @base)
    {
        var selected = SelectedTab?.Name;
        resolved = profile;
        string? Base(string file) =>
            string.Equals(file, profile.File, StringComparison.Ordinal) ? null : LabelOf(file);
        SettingOrigin Origin(string? file) => file is null
            ? SettingOrigin.NotManaged
            : Base(file) is null ? SettingOrigin.Own : SettingOrigin.Inherited;
        // Only this profile's own draft shows: a base's draft is that profile's to finish.
        var unset = OwnUnsets().ToHashSet(StringComparer.Ordinal);

        Tabs.Clear();
        foreach (var section in ProfileFields.Sections)
        {
            var values = profile.Values.TryGetProperty(section.Section, out var found) ? found : default;
            var drafts = profile.Drafts.TryGetProperty(section.Section, out var drafted) ? drafted : default;
            var sources = profile.Sources[section.Section];
            Tabs.Add(new ProfileTabViewModel(
                section.Name,
                [
                    .. section.Groups.Select(group => new SettingGroupViewModel(
                        group.Title,
                        group.Description,
                        [
                            .. group.Fields.Select(field =>
                            {
                                var saved = SettingViewModel.Find(values, field.Key);
                                var origin = Origin(sources.GetValueOrDefault(field.Key));
                                var inherited = origin == SettingOrigin.Inherited
                                    ? new InheritedValue(saved!, Base(sources[field.Key])!)
                                    : Inherit(@base, section.Section, field.Key);
                                var draft = profile.DraftSource(section.Section, field.Key) is { } file && IsOwn(file)
                                    ? new SettingDraft(SettingViewModel.Find(drafts, field.Key))
                                    : unset.Contains(field.Path) && origin == SettingOrigin.Own ? new SettingDraft(null, Unsets: true) : null;
                                SettingViewModel? row = null;
                                row = new SettingViewModel(field, saved, origin, inherited, () => OnRowChanged(row!), draft);
                                return row;
                            }),
                        ])),
                ]));
        }
        // A row that another setting can hide or turn off follows that setting's row.
        var rows = Settings.ToList();
        foreach (var row in rows)
        {
            if (row.Field.DependsOn is { } condition)
            {
                row.ControlledBy = rows.Single(other => other.Field.Section == row.Field.Section && other.Field.Key == condition.Key);
                row.ControlledBy.Dependents.Add(row);
            }
        }
        Tabs.Add(EntriesTab("Rulesets", "rulesets"));
        Tabs.Add(EntriesTab("Environments", "environments"));
        Tabs.Add(EntriesTab("Labels", "labels"));
        SelectedTab = Tabs.FirstOrDefault(tab => tab.Name == selected) ?? Tabs[0];
        BaseName = profile.Chain.Count > 1 ? LabelOf(profile.Chain[1]) : null;
        DraftWarnings = profile.Warnings;
        DraftCount = store.Drafts ? CountDraft() : 0;
        ChangeCount = 0;
        Yaml = ReadText(profile.File);
        // The rows are new, so what a search found is found again among them.
        Results = [];
        OnPropertyChanged(nameof(Results));
        Find(again: true);

        ProfileTabViewModel EntriesTab(string name, string section)
        {
            var tab = new ProfileTabViewModel(name, section, OnSettingChanged);
            var sources = profile.Sources[section];
            var drafts = DraftsOf(profile, section)
                .Where(entry => profile.DraftSource(section, entry["name"]!.GetValue<string>()) is { } file && IsOwn(file))
                .ToList();
            bool Unsets(string entryName) => unset.Any(key => key.StartsWith($"{section}/", StringComparison.Ordinal)
                && tab.SameName(key[(section.Length + 1)..], entryName));
            foreach (var entry in EntriesOf(profile, section))
            {
                var entryName = entry["name"]!.GetValue<string>();
                var file = sources.GetValueOrDefault(entryName);
                var inBase = @base is not null && EntriesOf(@base, section).Any(other => tab.SameName(other["name"]!.GetValue<string>(), entryName));
                var draft = drafts.FirstOrDefault(other => tab.SameName(other["name"]!.GetValue<string>(), entryName));
                if (draft is not null)
                {
                    drafts.Remove(draft);
                }
                tab.Entries.Add(new EntryViewModel(tab, entry, Origin(file), file is null ? null : Base(file), inBase, Stripped(draft), Unsets(entryName)));
            }
            // A draft of an entry that doesn't apply yet follows what applies.
            foreach (var draft in drafts)
            {
                var entryName = draft["name"]!.GetValue<string>();
                var inBase = @base is not null && EntriesOf(@base, section).Any(other => tab.SameName(other["name"]!.GetValue<string>(), entryName));
                tab.Entries.Add(new EntryViewModel(tab, null, SettingOrigin.Own, null, inBase, Stripped(draft)));
            }
            return tab;
        }
    }

    /// <summary>A draft entry without its <c>draft</c> key, as the row edits it.</summary>
    private static JsonObject? Stripped(JsonObject? entry)
    {
        entry?.Remove("draft");
        return entry;
    }

    /// <summary>The named rulesets, environments or labels of a resolved profile.</summary>
    private static IEnumerable<JsonObject> EntriesOf(ResolvedProfile profile, string section) =>
        profile.Values.TryGetProperty(section, out var list) && list.ValueKind == JsonValueKind.Array
            ? JsonNode.Parse(list.GetRawText())!.AsArray().OfType<JsonObject>().Where(entry => entry["name"] is JsonValue)
            : [];

    /// <summary>The draft rulesets, environments or labels of a resolved profile, each with <c>draft: true</c>.</summary>
    private static IEnumerable<JsonObject> DraftsOf(ResolvedProfile profile, string section) =>
        profile.Drafts.TryGetProperty(section, out var list) && list.ValueKind == JsonValueKind.Array
            ? JsonNode.Parse(list.GetRawText())!.AsArray().OfType<JsonObject>().Where(entry => entry["name"] is JsonValue)
            : [];

    /// <summary>
    /// A profile file as the sidebar names it, from the profiles folder, such
    /// as <c>team/oss</c>; a file outside the folder goes by its name alone.
    /// </summary>
    private string LabelOf(string file)
    {
        var root = Path.GetDirectoryName(listing.File) ?? "";
        foreach (var _ in Folder.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            root = Path.GetDirectoryName(root) ?? "";
        }
        var relative = Path.GetRelativePath(root, file);
        return relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative)
            ? Path.GetFileNameWithoutExtension(file)
            : Path.ChangeExtension(relative, null).Replace(Path.DirectorySeparatorChar, '/');
    }

    /// <summary>The value a base profile gives a setting, and the file that sets it there.</summary>
    private InheritedValue? Inherit(ResolvedProfile? @base, string section, string key)
    {
        if (@base is null
            || !@base.Sources[section].TryGetValue(key, out var file)
            || !@base.Values.TryGetProperty(section, out var values)
            || SettingViewModel.Find(values, key) is not { } value)
        {
            return null;
        }
        return new InheritedValue(value, LabelOf(file));
    }

    /// <summary>
    /// A setting that must stand alone in its section, such as Pages'
    /// <c>absent</c>, can't be saved beside the others there: setting one
    /// leaves the others out of this profile's file, and the other way round.
    /// The rows that the changed setting hides or turns off show it again, and
    /// so do the rows above it, which count the settings they hide.
    /// </summary>
    private void OnRowChanged(SettingViewModel row)
    {
        // What the row hides or turns off, and the rows above it that count what they hide.
        foreach (var other in Below(row).Concat(Above(row)))
        {
            other.Refresh();
        }
        if (row.OwnAfterSave)
        {
            foreach (var other in Settings.Where(other => other != row
                && other.Field.Section == row.Field.Section
                && (row.Field.Alone || other.Field.Alone)
                && (other.OwnAfterSave || other.Pending)))
            {
                other.Clear();
            }
        }
        OnSettingChanged();
    }

    private static IEnumerable<SettingViewModel> Below(SettingViewModel row) =>
        row.Dependents.SelectMany(other => Below(other).Prepend(other));

    private static IEnumerable<SettingViewModel> Above(SettingViewModel row)
    {
        for (var parent = row.ControlledBy; parent is not null; parent = parent.ControlledBy)
        {
            yield return parent;
        }
    }

    private void OnSettingChanged()
    {
        ChangeCount = Settings.Count(setting => setting.HasChanges) + Entries.Count(entry => entry.Changed);
        foreach (var tab in Tabs)
        {
            tab.RefreshCount();
            foreach (var group in tab.Groups)
            {
                group.Refresh();
            }
        }
        OnPropertyChanged(nameof(Problem));
        OnPropertyChanged(nameof(HasProblem));
        OnPropertyChanged(nameof(DraftProblem));
        OnPropertyChanged(nameof(DraftOnlyProblem));
        OnPropertyChanged(nameof(HasDraftOnlyProblem));
        SaveCommand.NotifyCanExecuteChanged();
        KeepMineCommand.NotifyCanExecuteChanged();
        SaveAsDraftCommand.NotifyCanExecuteChanged();
        PreviewCommand.NotifyCanExecuteChanged();
        DiscardDraftCommand.NotifyCanExecuteChanged();
        ConfirmDiscardDraftCommand.NotifyCanExecuteChanged();
        PreviewSaveCommand.NotifyCanExecuteChanged();
        PreviewSaveAsDraftCommand.NotifyCanExecuteChanged();
        ResetCommand.NotifyCanExecuteChanged();
    }

    public bool HasProblem => Problem is not null;

    /// <summary>Each file's text, keyed by its path, or null for a file that cannot be read.</summary>
    private static Dictionary<string, string?> ReadFiles(IEnumerable<string> files) =>
        files.Distinct(StringComparer.Ordinal).ToDictionary(file => file, ReadFile, StringComparer.Ordinal);

    /// <summary>Writes the file back as the editor read it, so the save's edits apply to it.</summary>
    private void Restore()
    {
        if (loaded.GetValueOrDefault(File) is not { } text)
        {
            throw new IOException($"Repotted could not put {FileName} back, because it could not read the file when it opened it.");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(File)!);
        using var stream = new FileStream(File, FileMode.CreateNew, FileAccess.Write);
        stream.Write(System.Text.Encoding.UTF8.GetBytes(text));
    }

    /// <summary>The file's text, or null when it cannot be read, such as once a sync removed it.</summary>
    internal static string? ReadFile(string file)
    {
        try
        {
            return System.IO.File.ReadAllText(file);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string ReadText(string file)
    {
        try
        {
            return System.IO.File.ReadAllText(file);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return $"# Could not read {file}: {error.Message}";
        }
    }
}
