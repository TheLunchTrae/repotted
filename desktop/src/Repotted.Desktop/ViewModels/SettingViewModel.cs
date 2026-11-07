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

/// <summary>
/// One setting row: its saved value and where that comes from, and the change
/// waiting to be saved, if any. Removing a value the profile sets falls back
/// to <see cref="Inherited"/>, the value its base profile gives, when there is one.
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
        Action changed)
    {
        Field = field;
        Saved = saved;
        Origin = origin;
        Inherited = inherited;
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

    /// <summary>Whether a change waits to be saved.</summary>
    public bool Changed { get; private set; }

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
    public bool CanReset => Changed || Origin == SettingOrigin.Own;

    public string ResetLabel => Changed ? "Undo" : "Remove";

    public string ResetName => Changed ? $"Undo the change to {Label}" : $"Remove {Label} from this profile";

    /// <summary>What saving sends for this row; null when nothing changed.</summary>
    public Services.ProfileChange? Change => Changed ? new(Field.Path, pending?.DeepClone()) : null;

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

    /// <summary>Undoes a change, or else stops setting the value in this profile.</summary>
    [RelayCommand]
    private void Reset()
    {
        if (Changed)
        {
            Undo();
            return;
        }
        Set(changed: true, null);
    }

    public void Undo() => Set(changed: false, null);

    /// <summary>Records the change and tells the row, its options and the profile, which all show it.</summary>
    private void Set(bool changed, JsonNode? value)
    {
        Changed = changed;
        pending = value;
        foreach (var name in (string[])[
            nameof(Changed), nameof(Value), nameof(Managed), nameof(OwnAfterSave), nameof(InheritedAfterSave),
            nameof(Note), nameof(CanReset), nameof(ResetLabel), nameof(ResetName),
        ])
        {
            OnPropertyChanged(name);
        }
        foreach (var option in Options)
        {
            option.Refresh();
        }
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
