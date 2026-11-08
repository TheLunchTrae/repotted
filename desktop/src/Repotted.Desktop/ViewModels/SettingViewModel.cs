using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.Input;

namespace Repotted.Desktop.ViewModels;

/// <summary>Where a setting's value comes from.</summary>
internal enum SettingOrigin
{
    /// <summary>The profile leaves it out, so GitHub keeps the repository's value.</summary>
    NotManaged,

    /// <summary>The profile itself sets it.</summary>
    Own,

    /// <summary>A profile it extends sets it.</summary>
    Inherited,
}

/// <summary>The value a setting would have without this profile, and the profile that sets it.</summary>
internal sealed record InheritedValue(JsonNode Value, string From);

/// <summary>A draft of a setting: the value saved but not applied, and the base profile that holds it, or null for this one.</summary>
internal sealed record DraftValue(JsonNode Value, string? From);

/// <summary>
/// One setting row: its saved value and where that comes from, and the change
/// waiting to be saved, if any. Removing a value the profile sets falls back
/// to <see cref="Inherited"/>, the value its base profile gives, when there is one.
/// A row may also hold a draft: a value saved under the profile's
/// <c>drafts</c>, which plans leave out until it is finished.
/// </summary>
internal sealed partial class SettingViewModel : ViewModelBase
{
    private readonly Action changed;

    /// <summary>The value to save, or null to stop setting it here; meaningful only while <see cref="Changed"/>.</summary>
    private JsonNode? pending;

    public SettingViewModel(
        SettingField field,
        JsonNode? saved,
        SettingOrigin origin,
        InheritedValue? inherited,
        Action changed,
        DraftValue? draft = null)
    {
        Field = field;
        Saved = saved;
        Origin = origin;
        Inherited = inherited;
        SavedDraft = draft;
        this.changed = changed;
        Options = [.. field.Options.Select(option => new OptionViewModel(this, option))];
    }

    public SettingField Field { get; }

    public string Label => Field.Label;

    public string Key => Field.Key;

    public JsonNode? Saved { get; }

    public SettingOrigin Origin { get; }

    /// <summary>What the profiles this one extends give, or null when they leave it out.</summary>
    public InheritedValue? Inherited { get; }

    public IReadOnlyList<OptionViewModel> Options { get; }

    /// <summary>Whether a change to the value waits to be saved.</summary>
    public bool Changed { get; private set; }

    /// <summary>The draft as the profile resolves it, or null.</summary>
    public DraftValue? SavedDraft { get; }

    /// <summary>Whether a change to the draft waits to be saved.</summary>
    public bool DraftChanged { get; private set; }

    /// <summary>The draft to save, or null to take it out; meaningful only while <see cref="DraftChanged"/>.</summary>
    private JsonNode? draftPending;

    /// <summary>Whether anything about the row, its value or its draft, waits to be saved.</summary>
    public bool HasChanges => Changed || DraftChanged;

    /// <summary>The draft once saved, or null when there is none.</summary>
    public JsonNode? Draft => DraftChanged ? draftPending : SavedDraft?.Value;

    public bool HasDraft => Draft is not null;

    /// <summary>Whether the draft is this profile's own, so it can be finished or discarded here.</summary>
    public bool OwnDraft => DraftChanged ? draftPending is not null : SavedDraft is { From: null };

    /// <summary>The draft's value as its option names it, or as JSON when no option does.</summary>
    public string DraftLabel => Draft is not { } draft
        ? ""
        : Field.Options.FirstOrDefault(option => JsonNode.DeepEquals(option.Value, draft))?.Label ?? draft.ToJsonString();

    public string DraftNote => (DraftChanged, OwnDraft) switch
    {
        (true, true) => "Saved as a draft when you save. It applies once you finish it.",
        (_, true) => "Saved, not applied. It applies once you finish it.",
        _ => $"Saved in {SavedDraft?.From}, not applied.",
    };

    public string DraftName => $"{Label} draft: {DraftLabel}. {DraftNote}";

    /// <summary>Whether the chosen value can become a draft instead: a change that sets a value.</summary>
    public bool CanSaveAsDraft => Changed && pending is not null;

    /// <summary>The value shown: what the profile will hold once saved.</summary>
    public JsonNode? Value => !Changed ? Saved : pending ?? Inherited?.Value;

    /// <summary>Whether the profile, once saved, names a value.</summary>
    public bool Managed => Value is not null;

    /// <summary>Whether the profile file itself will hold the value: the rail is solid.</summary>
    public bool OwnAfterSave => Changed ? pending is not null : Origin == SettingOrigin.Own;

    /// <summary>Whether a base profile will give the value: the rail is pale.</summary>
    public bool InheritedAfterSave => Changed ? pending is null && Inherited is not null : Origin == SettingOrigin.Inherited;

    public string Note => (Changed, pending, Origin) switch
    {
        (true, null, _) when Inherited is not null => $"From {Inherited.From} when saved",
        (true, null, _) => "Removed when saved",
        (true, _, _) => "Changed",
        (false, _, SettingOrigin.Own) => "Set here",
        (false, _, SettingOrigin.Inherited) => $"From {Inherited?.From}",
        _ => "Not managed",
    };

    /// <summary>Whether the row can go back: undo a change, or stop setting the value here.</summary>
    public bool CanReset => HasChanges || Origin == SettingOrigin.Own;

    public string ResetLabel => HasChanges ? "Undo" : "Remove";

    public string ResetName => HasChanges ? $"Undo the changes to {Label}" : $"Remove {Label} from this profile";

    /// <summary>What saving sends for this row's value; null when it did not change.</summary>
    public Services.ProfileChange? Change => Changed ? new(Field.Path, pending?.DeepClone()) : null;

    /// <summary>What saving sends for this row's draft; null when it did not change.</summary>
    public Services.ProfileChange? DraftChange => DraftChanged ? new($"drafts.{Field.Path}", draftPending?.DeepClone()) : null;

    /// <summary>
    /// Keeps the chosen value as a draft instead, and puts the value back as
    /// saved: the draft is saved with the profile, and plans leave it out.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanSaveAsDraft))]
    private void SaveAsDraft()
    {
        var value = pending!.DeepClone();
        SetDraft(value);
        Set(changed: false, null);
    }

    /// <summary>Makes the draft the value, so it applies once saved, and takes the draft out.</summary>
    [RelayCommand(CanExecute = nameof(OwnDraft))]
    private void FinishDraft()
    {
        var value = Draft!.DeepClone();
        SetDraft(null);
        if (Origin == SettingOrigin.Own && JsonNode.DeepEquals(value, Saved))
        {
            Set(changed: false, null);
        }
        else
        {
            Set(changed: true, value);
        }
    }

    /// <summary>Takes this profile's draft out, so the value stays as it is.</summary>
    [RelayCommand(CanExecute = nameof(OwnDraft))]
    private void DiscardDraft() => SetDraft(null);

    /// <summary>Records the draft to save: one this profile already has is no change.</summary>
    private void SetDraft(JsonNode? value)
    {
        var own = SavedDraft is { From: null } saved ? saved.Value : null;
        // Only this profile's own draft can be taken out, so a base's comes back when nothing replaces it.
        DraftChanged = value is null ? own is not null : !JsonNode.DeepEquals(value, own);
        draftPending = DraftChanged ? value : null;
        RefreshDraft();
    }

    private void RefreshDraft()
    {
        foreach (var name in (string[])[
            nameof(DraftChanged), nameof(HasChanges), nameof(Draft), nameof(HasDraft), nameof(OwnDraft),
            nameof(DraftLabel), nameof(DraftNote), nameof(DraftName), nameof(CanReset), nameof(ResetLabel), nameof(ResetName),
        ])
        {
            OnPropertyChanged(name);
        }
        FinishDraftCommand.NotifyCanExecuteChanged();
        DiscardDraftCommand.NotifyCanExecuteChanged();
        changed();
    }

    public void Choose(SettingOption option)
    {
        // Choosing the saved value of a profile's own setting is no change at all.
        if (Origin == SettingOrigin.Own && JsonNode.DeepEquals(option.Value, Saved))
        {
            Undo();
            return;
        }
        Set(changed: true, option.Value.DeepClone());
    }

    /// <summary>Undoes the changes, or else stops setting the value in this profile.</summary>
    [RelayCommand]
    private void Reset()
    {
        if (HasChanges)
        {
            Undo();
            return;
        }
        Set(changed: true, null);
    }

    /// <summary>Puts the value and the draft back as saved.</summary>
    public void Undo()
    {
        DraftChanged = false;
        draftPending = null;
        RefreshDraft();
        Set(changed: false, null);
    }

    /// <summary>Records the change and tells the row, its options and the profile, which all show it.</summary>
    private void Set(bool changed, JsonNode? value)
    {
        Changed = changed;
        pending = value;
        foreach (var name in (string[])[
            nameof(Changed), nameof(Value), nameof(Managed), nameof(OwnAfterSave), nameof(InheritedAfterSave),
            nameof(Note), nameof(CanReset), nameof(ResetLabel), nameof(ResetName), nameof(HasChanges), nameof(CanSaveAsDraft),
        ])
        {
            OnPropertyChanged(name);
        }
        foreach (var option in Options)
        {
            option.Refresh();
        }
        SaveAsDraftCommand.NotifyCanExecuteChanged();
        this.changed();
    }

    /// <summary>Reads the value at <paramref name="key"/> in a section, where a dot steps into a nested object.</summary>
    public static JsonNode? Find(JsonElement section, string key)
    {
        var current = section;
        foreach (var part in key.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(part, out current))
            {
                return null;
            }
        }
        return JsonNode.Parse(current.GetRawText());
    }
}

/// <summary>One choice in a setting's segmented control.</summary>
internal sealed partial class OptionViewModel(SettingViewModel setting, SettingOption option) : ViewModelBase
{
    public string Label => option.Label;

    public bool Selected => JsonNode.DeepEquals(setting.Value, option.Value);

    /// <summary>A chosen value that a base profile sets shows paler than one this profile sets.</summary>
    public bool Dim => !setting.OwnAfterSave;

    public string AccessibleName => $"{setting.Label}: {option.Label}";

    /// <summary>Where the setting's value comes from, for screen readers.</summary>
    public string Note => setting.Note;

    [RelayCommand]
    private void Choose() => setting.Choose(option);

    public void Refresh()
    {
        OnPropertyChanged(nameof(Selected));
        OnPropertyChanged(nameof(Dim));
        OnPropertyChanged(nameof(Note));
    }
}
