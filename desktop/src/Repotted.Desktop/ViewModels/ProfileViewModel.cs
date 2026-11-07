using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A group of setting rows under its heading.</summary>
internal sealed record SettingGroupViewModel(string Title, string Description, IReadOnlyList<SettingViewModel> Settings);

/// <summary>A ruleset or environment the profile names, and the file that does.</summary>
internal sealed record EntryViewModel(string Name, bool Absent, SettingOrigin Origin, string? BaseName)
{
    public bool Own => Origin == SettingOrigin.Own;

    public string Note => (Absent, Origin) switch
    {
        (true, SettingOrigin.Own) => "Removed here",
        (true, _) => $"Removed in {BaseName}",
        (false, SettingOrigin.Own) => "Set here",
        _ => $"From {BaseName}",
    };
}

/// <summary>A tab: a section's settings, or the rulesets or environments the profile names.</summary>
internal sealed partial class ProfileTabViewModel(string name) : ViewModelBase
{
    public string Name => name;

    public IReadOnlyList<SettingGroupViewModel> Groups { get; init; } = [];

    public IReadOnlyList<EntryViewModel> Entries { get; init; } = [];

    public bool IsSettings => Groups.Count > 0;

    public bool HasEntries => Entries.Count > 0;

    /// <summary>What the profile manages here, once resolved over its bases.</summary>
    public int Count => IsSettings
        ? Groups.Sum(group => group.Settings.Count(setting => setting.Managed))
        : Entries.Count;

    public void Refresh() => OnPropertyChanged(nameof(Count));
}

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
    [NotifyCanExecuteChangedFor(nameof(SaveCommand))]
    public partial bool Loading { get; set; }

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

    [RelayCommand]
    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            Show(await client.ProfileAsync(File, CancellationToken.None).ConfigureAwait(true));
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

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveAsync()
    {
        var changes = Settings.Select(setting => setting.Change).OfType<ProfileChange>().ToList();
        Loading = true;
        SaveError = null;
        try
        {
            Show(await client.SaveProfileAsync(File, changes, CancellationToken.None).ConfigureAwait(true));
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            SaveError = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    private bool CanSave() => HasChanges && !Loading;

    [RelayCommand(CanExecute = nameof(HasChanges))]
    private void Discard()
    {
        foreach (var setting in Settings.Where(setting => setting.Changed))
        {
            setting.Undo();
        }
        SaveError = null;
    }

    [RelayCommand]
    private void ToggleYaml() => ShowYaml = !ShowYaml;

    private void Show(ResolvedProfile profile)
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
            Tabs.Add(new ProfileTabViewModel(section.Name)
            {
                Groups =
                [
                    .. section.Groups.Select(group => new SettingGroupViewModel(
                        group.Title,
                        group.Description,
                        [
                            .. group.Fields.Select(field =>
                            {
                                var file = sources.GetValueOrDefault(field.Key);
                                return new SettingViewModel(
                                    field,
                                    SettingViewModel.Find(values, field.Key),
                                    Origin(file),
                                    file is null ? null : Base(file),
                                    OnSettingChanged);
                            }),
                        ])),
                ],
            });
        }
        Tabs.Add(EntriesTab("Rulesets", "rulesets"));
        Tabs.Add(EntriesTab("Environments", "environments"));
        SelectedTab = Tabs.FirstOrDefault(tab => tab.Name == selected) ?? Tabs[0];
        BaseName = profile.Chain.Count > 1 ? Path.GetFileNameWithoutExtension(profile.Chain[1]) : null;
        ChangeCount = 0;
        Yaml = ReadText(profile.File);

        ProfileTabViewModel EntriesTab(string name, string section)
        {
            var sources = profile.Sources[section];
            var entries = profile.Values.TryGetProperty(section, out var list) && list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray()
                    .Where(entry => entry.TryGetProperty("name", out _))
                    .Select(entry =>
                    {
                        var entryName = entry.GetProperty("name").GetString() ?? "";
                        var file = sources.GetValueOrDefault(entryName);
                        return new EntryViewModel(
                            entryName,
                            entry.TryGetProperty("absent", out var absent) && absent.ValueKind == JsonValueKind.True,
                            Origin(file),
                            file is null ? null : Base(file));
                    })
                    .ToList()
                : [];
            return new ProfileTabViewModel(name) { Entries = entries };
        }
    }

    private void OnSettingChanged()
    {
        ChangeCount = Settings.Count(setting => setting.Changed);
        foreach (var tab in Tabs)
        {
            tab.Refresh();
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
