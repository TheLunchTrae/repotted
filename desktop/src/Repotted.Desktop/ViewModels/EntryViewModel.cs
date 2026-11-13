using System.Collections.ObjectModel;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A ruleset, environment or label the profile names once resolved, this
/// profile's draft of it, if any, and what is waiting to be saved: an edit, a
/// new entry, or the entry taken out of this profile. The entry starts from
/// its draft when there is one, so a change and Reset are measured from what
/// was last saved, draft included.
/// </summary>
internal sealed partial class EntryViewModel : ViewModelBase
{
    private readonly ProfileTabViewModel tab;

    /// <param name="tab">The rulesets, environments or labels tab.</param>
    /// <param name="applied">The entry as it applies, or null for one only a draft has, or a new one.</param>
    /// <param name="origin">Whether this profile's file names it, or a base's.</param>
    /// <param name="baseName">The base profile that names it, when this one does not.</param>
    /// <param name="inBase">Whether a base profile names it too, so taking it out of this file brings that one back.</param>
    /// <param name="draft">This profile's draft of it, without its <c>draft</c> key, or null.</param>
    /// <param name="unsets">Whether this profile's draft takes it out of the profile, in <c>drafts.unset</c>.</param>
    public EntryViewModel(
        ProfileTabViewModel tab,
        JsonObject? applied,
        SettingOrigin origin,
        string? baseName,
        bool inBase,
        JsonObject? draft = null,
        bool unsets = false)
    {
        this.tab = tab;
        Applied = applied;
        Origin = origin;
        BaseName = baseName;
        InBase = inBase;
        SavedDraft = draft;
        // Only an entry this file names can be taken out of it.
        Unsets = unsets && origin == SettingOrigin.Own;
        dropped = Unsets;
    }

    /// <summary>The entry as it applies now, or null when it does not.</summary>
    public JsonObject? Applied { get; }

    public SettingOrigin Origin { get; }

    public string? BaseName { get; }

    public bool InBase { get; }

    /// <summary>This profile's draft of the entry, as saved, or null.</summary>
    public JsonObject? SavedDraft { get; }

    /// <summary>Whether this profile's draft takes the entry out of the profile.</summary>
    public bool Unsets { get; }

    /// <summary>Whether this profile has a draft of the entry: a version of it, or taking it out.</summary>
    public bool HasDraft => SavedDraft is not null || Unsets;

    /// <summary>Whether the row shows its draft, with nothing changing it yet.</summary>
    public bool InDraft => HasDraft && !Changed;

    /// <summary>The entry as last saved, draft included, which the editor starts from; null for a new one.</summary>
    public JsonObject? Saved => SavedDraft ?? Applied;

    /// <summary>Whether the entry is new since the profile was last saved.</summary>
    public bool IsNew => Saved is null;

    /// <summary>The name the entry has as last saved, draft included.</summary>
    public string SavedName => Saved?["name"].AsText() ?? "";

    /// <summary>The name the entry applies under now, or null when it does not apply.</summary>
    private string? AppliedName => Applied?["name"].AsText();

    /// <summary>Whether this profile's file names the entry, or will once its draft is finished, so it can be taken out.</summary>
    public bool Own => IsNew || Origin == SettingOrigin.Own || SavedDraft is not null;

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

    /// <summary>Whether the entry removes the ruleset, environment or label from GitHub.</summary>
    public bool Absent => editor?.Removes ?? Saved?["absent"].AsFlag() == true;

    /// <summary>Whether the entry is a label, which the list shows as GitHub does.</summary>
    public bool IsLabel => tab.List == "labels";

    private LabelEditorViewModel? Label => editor as LabelEditorViewModel;

    /// <summary>The label's color as GitHub writes it, or null when the profile leaves it out or removes the label.</summary>
    public string? Hex => Absent ? null : Label is { } label ? label.Hex : LabelColor.Normal(Saved?["color"].AsText());

    public bool HasColor => Hex is not null;

    /// <summary>The text color that reads on the label's color.</summary>
    public string Ink => LabelColor.Ink(Hex);

    /// <summary>The label's description as the profile sets it, or null when it leaves each repository's own or removes the label.</summary>
    public string? Description => Absent ? null : Label is { } label
        ? label.SetsDescription ? label.Description : null
        : Saved?["description"].AsText();

    /// <summary>The old names the label renames, as it will be saved.</summary>
    public IReadOnlyList<string> Claims => Label is { } label
        ? label.Claims
        : Absent ? [] : [.. (Saved?["renamed_from"] as JsonArray ?? []).Select(item => item.AsText()).OfType<string>()];

    /// <summary>What a label's old names do, for the list and the editor's heading.</summary>
    public string? Renaming => Claims switch
    {
        [] => null,
        [var one] => $"Renames {one} where a repository still has it",
        var several => $"Renames {string.Join(", ", several.SkipLast(1))} or {several[^1]} where a repository still has one",
    };

    private bool dropped;

    /// <summary>Whether the entry is taken out of this profile's file once saved.</summary>
    public bool Dropped
    {
        get => dropped;
        private set
        {
            if (SetProperty(ref dropped, value))
            {
                OnPropertyChanged(nameof(Changed));
                OnPropertyChanged(nameof(Note));
                OnPropertyChanged(nameof(AccessibleName));
                OnPropertyChanged(nameof(Editable));
                PutBackCommand.NotifyCanExecuteChanged();
            }
        }
    }

    /// <summary>Whether something about the entry differs from what was last saved, draft included.</summary>
    public bool Changed => Dropped != Unsets || IsNew || (!Dropped && editor?.Changed == true);

    public bool Unchanged => !Changed;

    public bool CanDrop => Own && !Dropped;

    /// <summary>Whether the editor can change the entry: not once it is taken out.</summary>
    public bool Editable => !Dropped;

    public string DropLabel => IsNew ? $"Discard this {tab.Noun}" : "Take out of profile";

    /// <summary>What stops Save, which applies the entry: a name, or a field, that isn't valid.</summary>
    public string? Problem => Dropped ? null : editor?.Problem;

    /// <summary>What stops Save as draft, where the entry may be unfinished: only its name.</summary>
    public string? DraftProblem => Dropped ? null : editor?.DraftProblem;

    /// <summary>The entry as it will be once saved, or null when this file won't name it.</summary>
    private JsonObject? Final => Dropped ? null : editor?.Entry ?? Saved;

    /// <summary>Whether the entry as it ends is the one that applies now, so it needs no draft.</summary>
    private bool FinalApplies => Final is { } entry
        ? Applied is not null && JsonNode.DeepEquals(entry, Applied)
        : Origin != SettingOrigin.Own;

    /// <summary>Whether this file will name the entry once saved: not for a base's entry left as it is.</summary>
    private bool FinalOwn => Final is not null && !(Origin == SettingOrigin.Inherited && FinalApplies);

    public string Note => this switch
    {
        { Dropped: true, Unsets: true, Changed: false, InBase: true } => $"Taken out in the draft, so the base profile's {tab.Noun} applies once you save",
        { Dropped: true, Unsets: true, Changed: false } => "Taken out in the draft, so the profile stops managing it once you save",
        { Dropped: true, InBase: true } => $"Taken out of this profile, so the base profile's {tab.Noun} applies again",
        { Dropped: true } => "Taken out of this profile, so the profile stops managing it",
        { Problem: { } problem } => problem,
        { IsNew: true } => "New, not saved yet",
        { Changed: true } => "Changed, not saved yet",
        { SavedDraft: not null, Applied: null } => "New in the draft, applies once you save",
        { SavedDraft: not null } => "Changed in the draft, applies once you save",
        { Absent: true, Own: true } => "Removed from GitHub here",
        { Renaming: { } renaming, Own: true } => renaming,
        { Absent: true } => $"Removed from GitHub in {BaseName}",
        { Own: true } => "Set here",
        _ => $"From {BaseName}",
    };

    public string AccessibleName => $"{Name}: {Note}";

    /// <summary>
    /// The edits that Save makes for this entry, so it applies as it ends:
    /// each a step of one edit, or a rename as a drop and the write that the
    /// CLI takes as one, which the profile saves after every other step.
    /// </summary>
    public IEnumerable<IReadOnlyList<EntryChange>> SaveChanges()
    {
        var draftName = SavedDraft?["name"].AsText();
        var own = Origin == SettingOrigin.Own ? AppliedName : null;
        var draftLeft = draftName is not null;
        if (FinalOwn && Final is { } entry)
        {
            var name = entry["name"]!.GetValue<string>();
            if (own is not null)
            {
                if (!FinalApplies)
                {
                    yield return tab.SameName(own, name)
                        ? [new EntryChange(tab.List, name, entry)]
                        : [new EntryChange(tab.List, own, null), new EntryChange(tab.List, name, entry)];
                }
            }
            else if (draftName is not null)
            {
                // A draft finished where it is, in place of the draft.
                yield return [new EntryChange(tab.List, draftName, null, Draft: true), new EntryChange(tab.List, name, entry)];
                draftLeft = false;
            }
            else
            {
                yield return [new EntryChange(tab.List, name, entry)];
            }
        }
        else if (own is not null && Final is null)
        {
            yield return [new EntryChange(tab.List, own, null)];
        }
        if (draftLeft)
        {
            yield return [new EntryChange(tab.List, draftName!, null, Draft: true)];
        }
    }

    /// <summary>
    /// The edits that Save as draft makes for this entry: the entry as it
    /// ends, as a draft, when it is not the one that applies, and the draft
    /// taken out otherwise. What applies stays as it is.
    /// </summary>
    public IEnumerable<IReadOnlyList<EntryChange>> DraftChanges()
    {
        var draftName = SavedDraft?["name"].AsText();
        if (!FinalApplies && Final is { } entry)
        {
            var draft = entry.DeepClone().AsObject();
            draft["draft"] = true;
            var name = entry["name"]!.GetValue<string>();
            if (draftName is null)
            {
                yield return [new EntryChange(tab.List, name, draft)];
            }
            else if (!JsonNode.DeepEquals(entry, SavedDraft))
            {
                yield return tab.SameName(draftName, name)
                    ? [new EntryChange(tab.List, name, draft, Draft: true)]
                    : [new EntryChange(tab.List, draftName, null, Draft: true), new EntryChange(tab.List, name, draft)];
            }
        }
        else if (draftName is not null)
        {
            yield return [new EntryChange(tab.List, draftName, null, Draft: true)];
        }
    }

    /// <summary>
    /// The key in <c>drafts.unset</c> that Save as draft lists for this entry,
    /// as <c>rulesets/Legacy</c>: the entry this file applies now, when the
    /// draft takes it out or renames it; null otherwise.
    /// </summary>
    public string? UnsetOnDraft =>
        Origin == SettingOrigin.Own && AppliedName is { } own && !FinalApplies
        && (Final is not { } entry || !tab.SameName(entry["name"]!.GetValue<string>(), own))
            ? $"{tab.List}/{own}"
            : null;

    /// <summary>The key in <c>drafts.unset</c> that names this entry as saved, or null when it is in none.</summary>
    public string? UnsetKey => Unsets ? $"{tab.List}/{AppliedName}" : null;

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
        Dropped = false;
        editor = null;
        Refresh();
        tab.Refresh();
    }

    /// <summary>Puts the entry back as last saved, draft included.</summary>
    public void Undo()
    {
        Dropped = Unsets;
        editor = null;
        Refresh();
    }

    /// <summary>Called by the editor on every edit, and once the editor is dropped, so it is made again.</summary>
    public void Refresh()
    {
        OnAllPropertiesChanged();
        DropCommand.NotifyCanExecuteChanged();
        editor?.Recheck();
    }
}

/// <summary>A tab: a section's settings, or the rulesets, environments or labels the profile names.</summary>
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

    /// <summary>A rulesets, environments or labels tab; <paramref name="list"/> is the profile key.</summary>
    public ProfileTabViewModel(string name, string list, Action changed)
    {
        Name = name;
        Groups = [];
        List = list;
        Noun = list[..^1];
        this.changed = changed;
    }

    public string Name { get; }

    public IReadOnlyList<SettingGroupViewModel> Groups { get; }

    /// <summary>The profile key the entries are under: rulesets, environments or labels.</summary>
    public string List { get; }

    public string Noun { get; }

    /// <summary>Whether a ruleset here can apply to pushes, which only organizations have.</summary>
    public bool Pushes { get; init; } = true;

    public ObservableCollection<EntryViewModel> Entries { get; } = [];

    public bool IsSettings => Groups.Count > 0;

    public bool IsEntries => !IsSettings;

    public bool HasEntries => Entries.Count > 0;

    public string NewLabel => $"New {Noun}";

    public string BackLabel => $"Back to {Name.ToLowerInvariant()}";

    public string ResetName => $"Reset the {Name.ToLowerInvariant()} to what was last saved";

    public string Help => List == "labels"
        ? "Each label names only what it sets; labels the profile leaves out stay as each repository has them. Open one to edit it."
        : $"Each {Noun} names only what it sets; the rest stays as the repository has it. Open one to edit it.";

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

    /// <summary>What the profile manages here once saved, resolved over its bases.</summary>
    public int Count => IsSettings
        ? Groups.Sum(group => group.Settings.Count(setting => setting.Managed))
        : Entries.Count(entry => !entry.Dropped || entry.InBase);

    /// <summary>Whether anything on the tab differs from what was last saved, so Reset has something to put back.</summary>
    public bool HasChanges => IsSettings
        ? Groups.Any(group => group.Settings.Any(setting => setting.HasChanges))
        : Entries.Any(entry => entry.Changed);

    /// <summary>Whether two names are the same entry: environment and label names are case-insensitive, as on GitHub.</summary>
    public bool SameName(string left, string right) =>
        string.Equals(left, right, List == "rulesets" ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Whether another entry has or had <paramref name="name"/>: the name it
    /// will have, or the one it was last saved or applies under. A name this
    /// save takes out is not free until it is saved, since the file names each
    /// entry once, and each draft once.
    /// </summary>
    private bool Taken(EntryViewModel entry, string name) =>
        Entries.Any(other => other != entry
            && (SameName(other.CurrentName, name)
                || (!other.IsNew && SameName(other.SavedName, name))
                || (other.Applied?["name"].AsText() is { } applied && SameName(applied, name))));

    public EntryEditorViewModel MakeEditor(EntryViewModel entry)
    {
        bool Taken(string name) => this.Taken(entry, name);
        void Changed() => Refresh();
        return List switch
        {
            "environments" => new EnvironmentEditorViewModel(entry.Saved, entry.Renamable, Taken, Changed),
            "labels" => new LabelEditorViewModel(entry.Saved, entry.Renamable, Taken, old => ClaimedBy(entry, old), Changed),
            _ => new RulesetEditorViewModel(entry.Saved, entry.Renamable, Taken, Changed, Pushes),
        };
    }

    /// <summary>
    /// The other label that applies under <paramref name="old"/>, or removes
    /// it, or lists it as an old name, as the profile will be saved, or null.
    /// A label's old name can be none of these, since apply would then rename
    /// one label into another or two into one.
    /// </summary>
    private string? ClaimedBy(EntryViewModel entry, string old) =>
        Entries.Where(other => other != entry && !other.Dropped)
            .FirstOrDefault(other => SameName(other.CurrentName, old) || other.Claims.Any(name => SameName(name, old)))
            ?.CurrentName;

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

    /// <summary>Puts every entry back as last saved, draft included.</summary>
    [RelayCommand(CanExecute = nameof(HasChanges))]
    private void Reset() => Undo();

    /// <summary>Puts every entry back as last saved, draft included.</summary>
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
    public void RefreshCount()
    {
        OnPropertyChanged(nameof(Count));
        OnPropertyChanged(nameof(HasChanges));
        ResetCommand.NotifyCanExecuteChanged();
    }
}
