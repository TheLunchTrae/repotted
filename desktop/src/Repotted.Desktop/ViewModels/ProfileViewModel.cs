using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A group of setting rows under its heading.</summary>
internal sealed record SettingGroupViewModel(string Title, string Description, IReadOnlyList<SettingViewModel> Settings);

/// <summary>
/// One profile, resolved over the profiles it extends: its settings by tab,
/// marked as set here, inherited, or not managed, and the edits waiting to be
/// saved to its file.
/// </summary>
/// <param name="client">Reads and saves the profile.</param>
/// <param name="listing">The profile in the folder.</param>
/// <param name="saved">Runs after each save, such as to sync the folder with its config repository.</param>
/// <param name="exclusive">Runs the write itself, such as once a sync of the folder ends; the write runs at once when null.</param>
internal sealed partial class ProfileViewModel(
    RepottedClient client,
    ProfileListingDocument listing,
    Func<Task>? saved = null,
    Func<Func<Task>, Task>? exclusive = null) : ViewModelBase
{
    public string Name => listing.Name;

    public string File => listing.File;

    public string FileName => Path.GetFileName(listing.File);

    public ObservableCollection<ProfileTabViewModel> Tabs { get; } = [];

    [ObservableProperty]
    public partial ProfileTabViewModel? SelectedTab { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEditor))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(DiscardCommand), nameof(ReloadCommand))]
    public partial bool Loading { get; set; }

    /// <summary>Whether a save is running; the editor stays on screen, and nothing else can change it.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(DiscardCommand), nameof(ReloadCommand))]
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
        ? $"{FileName} changed since you opened it, so saving would undo that change to the rulesets and environments you edited. Reload discards your unsaved changes."
        // A removed profile has no file to reload, so only Keep mine is offered.
        : Removed
        ? $"{Path.GetFileName(ChangedFile)} changed since you opened this profile, so saving would set the old copy of the inherited rulesets and environments you edited."
        : $"{Path.GetFileName(ChangedFile)} changed since you opened this profile, so saving would set the old copy of the inherited rulesets and environments you edited. Reload discards your unsaved changes.";

    /// <summary>
    /// Whether the file is gone from the folder, such as after a sync, while
    /// the editor holds unsaved edits; saving puts it back.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RemovedMessage), nameof(OutOfDateMessage))]
    [NotifyCanExecuteChangedFor(nameof(ReloadCommand))]
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
        $"{FileName} is no longer in the folder, such as after a sync with GitHub removed it. Save profile puts it back with your unsaved changes, and Discard lets it go.";

    public bool ShowEditor => !Loading && Error is null && Tabs.Count > 0;

    /// <summary>The profile this one extends, if any.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary), nameof(InheritedLabel))]
    public partial string? BaseName { get; set; }

    public string Summary => BaseName is null
        ? $"Saved to {FileName}."
        : $"Extends {BaseName}. Saved to {FileName}.";

    /// <summary>The profile file's own text, as saved.</summary>
    [ObservableProperty]
    public partial string Yaml { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(YamlLabel))]
    public partial bool ShowYaml { get; set; } = true;

    public string YamlLabel => ShowYaml ? "Hide YAML" : "Show YAML";

    /// <summary>The legend's name for inherited values.</summary>
    public string InheritedLabel => BaseName is null ? "From a base profile" : $"From {BaseName}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasChanges), nameof(ChangesLabel))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(KeepMineCommand), nameof(DiscardCommand), nameof(ReloadCommand))]
    public partial int ChangeCount { get; set; }

    public bool HasChanges => ChangeCount > 0;

    public string ChangesLabel => ChangeCount == 1 ? "1 unsaved change" : $"{ChangeCount} unsaved changes";

    private IEnumerable<SettingViewModel> Settings =>
        Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings);

    private IEnumerable<EntryViewModel> Entries => Tabs.SelectMany(tab => tab.Entries);

    /// <summary>Why the edits cannot be saved yet, such as a ruleset with no name.</summary>
    public string? Problem => Entries.Select(entry => entry.Problem).FirstOrDefault(problem => problem is not null);

    [RelayCommand]
    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            // Read the files first, so a change the load misses still counts as
            // a change since. A file the chain gains, such as a base read for
            // the first time, can only be read after.
            var texts = ReadFiles(chain.Count == 0 ? [File] : chain);
            var profile = await client.ProfileAsync(File, CancellationToken.None).ConfigureAwait(true);
            foreach (var file in ChainOf(profile).Where(file => !texts.ContainsKey(file)))
            {
                texts[file] = ReadFile(file);
            }
            Show(profile, await BaseAsync(profile).ConfigureAwait(true));
            Remember(ChainOf(profile), texts);
            ChangedFile = null;
            SaveError = null;
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

    [RelayCommand(CanExecute = nameof(CanSave))]
    private Task SaveAsync() => SaveAsync(overwrite: false);

    /// <summary>Saves over a change to the file since the editor read it.</summary>
    [RelayCommand(CanExecute = nameof(CanSave))]
    private Task KeepMineAsync() => SaveAsync(overwrite: true);

    /// <summary>Starts over from the file as it is now, without the unsaved edits.</summary>
    [RelayCommand(CanExecute = nameof(CanReload))]
    private Task ReloadAsync() => LoadAsync();

    private bool CanReload() => CanDiscard() && !Removed;

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
    /// only the keys edited, so only edited rulesets and environments count.
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

    private async Task SaveAsync(bool overwrite)
    {
        var changes = Settings.Select(setting => setting.Change).OfType<ProfileChange>().ToList();
        // The CLI takes a write right after a drop as a rename, so plain writes
        // and drops go first and each rename last, as its own drop and write.
        var entries = Entries.OrderBy(entry => entry.Renames ? 2 : entry.Dropped ? 1 : 0)
            .SelectMany(entry => entry.Changes())
            .ToList();
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
                    profile = await client.SaveProfileAsync(File, changes, entries, CancellationToken.None).ConfigureAwait(true);
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
            await (exclusive is null ? Write() : exclusive(Write)).ConfigureAwait(true);
            if (profile is null)
            {
                return;
            }
            Removed = false;
            Show(profile, await BaseAsync(profile).ConfigureAwait(true));
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

    private bool CanSave() => HasChanges && !Saving && !Loading && Problem is null;

    private bool CanDiscard() => HasChanges && !Saving && !Loading;

    [RelayCommand(CanExecute = nameof(CanDiscard))]
    private void Discard()
    {
        foreach (var setting in Settings.Where(setting => setting.Changed))
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
    /// The profile this one extends, resolved alone, which gives each value a
    /// setting falls back to when this profile stops setting it. A base that
    /// is not a valid profile by itself gives none.
    /// </summary>
    private async Task<ResolvedProfile?> BaseAsync(ResolvedProfile profile)
    {
        if (profile.Chain.Count < 2)
        {
            return null;
        }
        try
        {
            return await client.ProfileAsync(profile.Chain[1], CancellationToken.None).ConfigureAwait(true);
        }
        catch (CliException)
        {
            return null;
        }
    }

    [RelayCommand]
    private void ToggleYaml() => ShowYaml = !ShowYaml;

    private void Show(ResolvedProfile profile, ResolvedProfile? @base)
    {
        var selected = SelectedTab?.Name;
        string? Base(string file) =>
            string.Equals(file, profile.File, StringComparison.Ordinal) ? null : Path.GetFileNameWithoutExtension(file);
        SettingOrigin Origin(string? file) => file is null
            ? SettingOrigin.NotManaged
            : Base(file) is null ? SettingOrigin.Own : SettingOrigin.Inherited;

        Tabs.Clear();
        foreach (var section in ProfileFields.Sections)
        {
            var values = profile.Values.TryGetProperty(section.Section, out var found) ? found : default;
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
                                return new SettingViewModel(field, saved, origin, inherited, OnSettingChanged);
                            }),
                        ])),
                ]));
        }
        Tabs.Add(EntriesTab("Rulesets", "rulesets"));
        Tabs.Add(EntriesTab("Environments", "environments"));
        SelectedTab = Tabs.FirstOrDefault(tab => tab.Name == selected) ?? Tabs[0];
        BaseName = profile.Chain.Count > 1 ? Path.GetFileNameWithoutExtension(profile.Chain[1]) : null;
        ChangeCount = 0;
        Yaml = ReadText(profile.File);

        ProfileTabViewModel EntriesTab(string name, string section)
        {
            var tab = new ProfileTabViewModel(name, section, OnSettingChanged);
            var sources = profile.Sources[section];
            foreach (var entry in EntriesOf(profile, section))
            {
                var entryName = entry["name"]!.GetValue<string>();
                var file = sources.GetValueOrDefault(entryName);
                var inBase = @base is not null && EntriesOf(@base, section).Any(other => tab.SameName(other["name"]!.GetValue<string>(), entryName));
                tab.Entries.Add(new EntryViewModel(tab, entry, Origin(file), file is null ? null : Base(file), inBase));
            }
            return tab;
        }
    }

    /// <summary>The named rulesets or environments of a resolved profile.</summary>
    private static IEnumerable<JsonObject> EntriesOf(ResolvedProfile profile, string section) =>
        profile.Values.TryGetProperty(section, out var list) && list.ValueKind == JsonValueKind.Array
            ? JsonNode.Parse(list.GetRawText())!.AsArray().OfType<JsonObject>().Where(entry => entry["name"] is JsonValue)
            : [];

    /// <summary>The value a base profile gives a setting, and the file that sets it there.</summary>
    private static InheritedValue? Inherit(ResolvedProfile? @base, string section, string key)
    {
        if (@base is null
            || !@base.Sources[section].TryGetValue(key, out var file)
            || !@base.Values.TryGetProperty(section, out var values)
            || SettingViewModel.Find(values, key) is not { } value)
        {
            return null;
        }
        return new InheritedValue(value, Path.GetFileNameWithoutExtension(file));
    }

    private void OnSettingChanged()
    {
        ChangeCount = Settings.Count(setting => setting.Changed) + Entries.Count(entry => entry.Changed);
        foreach (var tab in Tabs)
        {
            tab.RefreshCount();
        }
        OnPropertyChanged(nameof(Problem));
        OnPropertyChanged(nameof(HasProblem));
        SaveCommand.NotifyCanExecuteChanged();
        KeepMineCommand.NotifyCanExecuteChanged();
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
    private static string? ReadFile(string file)
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
