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
internal sealed partial class ProfileViewModel(RepottedClient client, ProfileListingDocument listing) : ViewModelBase
{
    public string Name => listing.Name;

    public string File => listing.File;

    public string FileName => Path.GetFileName(listing.File);

    public ObservableCollection<ProfileTabViewModel> Tabs { get; } = [];

    [ObservableProperty]
    public partial ProfileTabViewModel? SelectedTab { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEditor))]
    public partial bool Loading { get; set; }

    /// <summary>Whether a save is running; the editor stays on screen, and nothing else can change it.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(DiscardCommand))]
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
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(DiscardCommand))]
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
            var profile = await client.ProfileAsync(File, CancellationToken.None).ConfigureAwait(true);
            Show(profile, await BaseAsync(profile).ConfigureAwait(true));
        }
        // A load runs unawaited when a profile opens, so every failure shows here.
        catch (Exception error)
        {
            Error = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveAsync()
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
            var profile = await client.SaveProfileAsync(File, changes, entries, CancellationToken.None).ConfigureAwait(true);
            Show(profile, await BaseAsync(profile).ConfigureAwait(true));
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

    private bool CanSave() => HasChanges && !Saving && Problem is null;

    private bool CanDiscard() => HasChanges && !Saving;

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
    }

    public bool HasProblem => Problem is not null;

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
