using System.Collections.ObjectModel;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A ruleset or environment the profile names once resolved, the file that
/// names it, and what is waiting to be saved: an edit, a new entry, or the
/// entry taken out of this profile.
/// </summary>
internal sealed partial class EntryViewModel : ViewModelBase
{
    private readonly ProfileTabViewModel tab;

    /// <param name="tab">The rulesets or environments tab.</param>
    /// <param name="saved">The entry as the profile resolves it, or null for a new one.</param>
    /// <param name="origin">Whether this profile's file names it, or a base's.</param>
    /// <param name="baseName">The base profile that names it, when this one does not.</param>
    /// <param name="inBase">Whether a base profile names it too, so taking it out of this file brings that one back.</param>
    public EntryViewModel(ProfileTabViewModel tab, JsonObject? saved, SettingOrigin origin, string? baseName, bool inBase)
    {
        this.tab = tab;
        Saved = saved;
        Origin = origin;
        BaseName = baseName;
        InBase = inBase;
    }

    public JsonObject? Saved { get; }

    public SettingOrigin Origin { get; }

    public string? BaseName { get; }

    public bool InBase { get; }

    public bool IsNew => Saved is null;

    /// <summary>The name the entry has in the profile now, before any edit.</summary>
    public string SavedName => Saved?["name"]?.GetValue<string>() ?? "";

    /// <summary>Whether this profile's file names the entry, so it can be taken out.</summary>
    public bool Own => IsNew || Origin == SettingOrigin.Own;

    /// <summary>
    /// Whether the entry can be renamed: only one that this profile alone
    /// names, since renaming one over a base's would bring the base's back.
    /// </summary>
    public bool Renamable => Own && !InBase;

    private EntryEditorViewModel? editor;

    /// <summary>The entry's editor, made when the entry is first opened.</summary>
    public EntryEditorViewModel Editor => editor ??= tab.MakeEditor(this);

    public bool Opened => editor is not null;

    /// <summary>The name the entry will have once saved.</summary>
    public string CurrentName => editor?.Name.Trim() ?? SavedName;

    public string Name => CurrentName is { Length: > 0 } name ? name : $"New {tab.Noun}";

    /// <summary>Whether the entry removes the ruleset or environment from GitHub.</summary>
    public bool Absent => editor?.Removes ?? Saved?["absent"]?.GetValue<bool>() == true;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Changed), nameof(Note), nameof(AccessibleName), nameof(Editable))]
    [NotifyCanExecuteChangedFor(nameof(PutBackCommand))]
    public partial bool Dropped { get; private set; }

    /// <summary>Whether something about the entry is waiting to be saved.</summary>
    public bool Changed => Dropped || IsNew || editor?.Changed == true;

    public bool Unchanged => !Changed;

    public bool CanDrop => Own && !Dropped;

    /// <summary>Whether the editor can change the entry: not once it is taken out.</summary>
    public bool Editable => !Dropped;

    public string DropLabel => IsNew ? $"Discard this {tab.Noun}" : "Take out of profile";

    public string? Problem => Dropped ? null : editor?.Problem;

    public string Note => this switch
    {
        { Dropped: true, InBase: true } => $"Taken out of this profile, so the base profile's {tab.Noun} applies again",
        { Dropped: true } => $"Taken out of this profile, so the profile stops managing it",
        { Problem: { } problem } => problem,
        { IsNew: true } => "New, not saved yet",
        { Changed: true } => "Changed, not saved yet",
        { Absent: true, Own: true } => "Removed from GitHub here",
        { Absent: true } => $"Removed from GitHub in {BaseName}",
        { Own: true } => "Set here",
        _ => $"From {BaseName}",
    };

    public string AccessibleName => $"{Name}: {Note}";

    /// <summary>The edits to the profile file that save this entry.</summary>
    public IEnumerable<EntryChange> Changes()
    {
        if (Dropped)
        {
            yield return new EntryChange(tab.List, SavedName, null);
            yield break;
        }
        if (editor is null || !Changed)
        {
            yield break;
        }
        var entry = editor.Entry;
        var name = entry["name"]!.GetValue<string>();
        // The CLI takes a write right after a drop as a rename in place.
        if (Renames)
        {
            yield return new EntryChange(tab.List, SavedName, null);
        }
        yield return new EntryChange(tab.List, name, entry);
    }

    [RelayCommand]
    private void Open() => tab.Editing = this;

    /// <summary>Takes the entry out of this profile's file, or a new one out of the list.</summary>
    [RelayCommand(CanExecute = nameof(CanDrop))]
    private void Drop()
    {
        if (IsNew)
        {
            tab.Entries.Remove(this);
        }
        else
        {
            Dropped = true;
        }
        tab.Closed(this);
    }

    /// <summary>Takes back taking the entry out, so it is as the profile has it.</summary>
    [RelayCommand(CanExecute = nameof(Dropped))]
    private void PutBack()
    {
        Undo();
        tab.Refresh();
    }

    /// <summary>Puts the entry back as the profile has it.</summary>
    public void Undo()
    {
        Dropped = false;
        editor = null;
        OnPropertyChanged(nameof(Editor));
        Refresh();
    }

    /// <summary>Called by the editor on every edit.</summary>
    public void Refresh()
    {
        OnPropertyChanged(nameof(Name));
        OnPropertyChanged(nameof(Absent));
        OnPropertyChanged(nameof(Changed));
        OnPropertyChanged(nameof(Unchanged));
        OnPropertyChanged(nameof(Problem));
        OnPropertyChanged(nameof(Note));
        OnPropertyChanged(nameof(AccessibleName));
        DropCommand.NotifyCanExecuteChanged();
    }

    /// <summary>A rename on save: the old name is dropped, then the entry written in its place.</summary>
    public bool Renames => !Dropped && editor is not null && Changed && Own && !IsNew && !tab.SameName(editor.Entry["name"]!.GetValue<string>(), SavedName);
}

/// <summary>A tab: a section's settings, or the rulesets or environments the profile names.</summary>
internal sealed partial class ProfileTabViewModel : ViewModelBase
{
    private readonly Action changed;

    /// <summary>A settings tab.</summary>
    public ProfileTabViewModel(string name, IReadOnlyList<SettingGroupViewModel> groups)
    {
        Name = name;
        Groups = groups;
        List = "";
        Noun = "";
        changed = () => { };
    }

    /// <summary>A rulesets or environments tab; <paramref name="list"/> is the profile key.</summary>
    public ProfileTabViewModel(string name, string list, Action changed)
    {
        Name = name;
        Groups = [];
        List = list;
        Noun = list == "environments" ? "environment" : "ruleset";
        this.changed = changed;
    }

    public string Name { get; }

    public IReadOnlyList<SettingGroupViewModel> Groups { get; }

    /// <summary>The profile key the entries are under: rulesets or environments.</summary>
    public string List { get; }

    public string Noun { get; }

    public ObservableCollection<EntryViewModel> Entries { get; } = [];

    public bool IsSettings => Groups.Count > 0;

    public bool IsEntries => !IsSettings;

    public bool HasEntries => Entries.Count > 0;

    public string NewLabel => $"New {Noun}";

    public string BackLabel => $"Back to {Name.ToLowerInvariant()}";

    public string Help => List == "environments"
        ? "Each environment names only what it sets; the rest stays as the repository has it. Open one to edit it."
        : "Each ruleset names only what it sets; the rest stays as the repository has it. Open one to edit it.";

    /// <summary>The entry open in its editor, or null for the list.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowList))]
    public partial EntryViewModel? Editing { get; set; }

    /// <summary>The entry last closed, so the list can put focus back on it.</summary>
    public EntryViewModel? Left { get; private set; }

    /// <summary>Whether an entry has just opened, so its editor takes focus once.</summary>
    private bool opened;

    partial void OnEditingChanged(EntryViewModel? oldValue, EntryViewModel? newValue)
    {
        opened = newValue is not null;
        if (newValue is null)
        {
            Left = oldValue;
        }
    }

    /// <summary>
    /// Whether the editor should take focus: once, when an entry opens, and not
    /// when its view is only built again, such as on going back to the tab.
    /// </summary>
    public bool TakeOpened()
    {
        var was = opened;
        opened = false;
        return was;
    }

    public bool ShowList => Editing is null;

    /// <summary>What the profile manages here, once resolved over its bases.</summary>
    public int Count => IsSettings
        ? Groups.Sum(group => group.Settings.Count(setting => setting.Managed))
        : Entries.Count(entry => !entry.Dropped);

    /// <summary>Whether two names are the same entry: environment names are case-insensitive, as on GitHub.</summary>
    public bool SameName(string left, string right) =>
        string.Equals(left, right, List == "environments" ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    /// <summary>
    /// Whether another entry has or had <paramref name="name"/>. A name this
    /// save takes out is not free until it is saved, since the file names
    /// each entry once.
    /// </summary>
    private bool Taken(EntryViewModel entry, string name) =>
        Entries.Any(other => other != entry && (SameName(other.CurrentName, name) || SameName(other.SavedName, name)));

    public EntryEditorViewModel MakeEditor(EntryViewModel entry)
    {
        bool Taken(string name) => this.Taken(entry, name);
        void Changed() => Refresh();
        return List == "environments"
            ? new EnvironmentEditorViewModel(entry.Saved, entry.Renamable, Taken, Changed)
            : new RulesetEditorViewModel(entry.Saved, entry.Renamable, Taken, Changed);
    }

    [RelayCommand]
    private void New()
    {
        var entry = new EntryViewModel(this, null, SettingOrigin.Own, null, inBase: false);
        // A new entry has nothing but its editor, which says what it still needs.
        _ = entry.Editor;
        Entries.Add(entry);
        Editing = entry;
        Refresh();
    }

    [RelayCommand]
    private void Back() => Editing = null;

    /// <summary>Shows the list again once <paramref name="entry"/> is taken out.</summary>
    public void Closed(EntryViewModel entry)
    {
        if (Editing == entry)
        {
            Editing = null;
        }
        Refresh();
    }

    /// <summary>Puts every entry back as the profile has it.</summary>
    public void Undo()
    {
        Editing = null;
        foreach (var entry in Entries.Where(entry => entry.IsNew).ToList())
        {
            Entries.Remove(entry);
        }
        foreach (var entry in Entries)
        {
            entry.Undo();
        }
        Refresh();
    }

    public void Refresh()
    {
        // A name one entry frees or takes changes what the others can be called.
        foreach (var entry in Entries)
        {
            entry.Refresh();
        }
        OnPropertyChanged(nameof(Count));
        OnPropertyChanged(nameof(HasEntries));
        changed();
    }

    /// <summary>Tells the profile something changed, without telling it back.</summary>
    public void RefreshCount() => OnPropertyChanged(nameof(Count));
}
