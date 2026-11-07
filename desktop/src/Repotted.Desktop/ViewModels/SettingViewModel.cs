using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
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

/// <summary>
/// One setting row: its saved value and where that comes from, and the change
/// waiting to be saved, if any.
/// </summary>
internal sealed partial class SettingViewModel : ViewModelBase
{
    private readonly Action changed;

    public SettingViewModel(SettingField field, JsonNode? saved, SettingOrigin origin, string? baseName, Action changed)
    {
        Field = field;
        Saved = saved;
        Origin = origin;
        BaseName = baseName;
        this.changed = changed;
        Options = [.. field.Options.Select(option => new OptionViewModel(this, option))];
    }

    public SettingField Field { get; }

    public string Label => Field.Label;

    public string Key => Field.Key;

    public JsonNode? Saved { get; }

    public SettingOrigin Origin { get; }

    /// <summary>The profile it inherits the value from.</summary>
    public string? BaseName { get; }

    public IReadOnlyList<OptionViewModel> Options { get; }

    /// <summary>Whether a change waits to be saved.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Value), nameof(Managed), nameof(OwnAfterSave), nameof(Note), nameof(CanReset), nameof(ResetLabel), nameof(Removing))]
    public partial bool Changed { get; private set; }

    /// <summary>The value to save, or null to stop managing it; meaningful only while <see cref="Changed"/>.</summary>
    private JsonNode? pending;

    /// <summary>The value shown: the change waiting to be saved, or else the saved one.</summary>
    public JsonNode? Value => Changed ? pending : Saved;

    /// <summary>Whether the profile, once saved, names a value.</summary>
    public bool Managed => Value is not null;

    /// <summary>Whether the profile file itself will hold the value: the rail is solid.</summary>
    public bool OwnAfterSave => Changed ? pending is not null : Origin == SettingOrigin.Own;

    /// <summary>Whether it will come from a base profile: the rail is pale.</summary>
    public bool InheritedAfterSave => !Changed && Origin == SettingOrigin.Inherited;

    /// <summary>A change that stops managing a value this profile set.</summary>
    public bool Removing => Changed && pending is null;

    public string Note => (Changed, pending, Origin) switch
    {
        (true, null, _) => "Removed when saved",
        (true, _, _) => "Changed",
        (false, _, SettingOrigin.Own) => "Set here",
        (false, _, SettingOrigin.Inherited) => $"From {BaseName}",
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
        pending = option.Value.DeepClone();
        Changed = true;
        Refresh();
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
        pending = null;
        Changed = true;
        Refresh();
    }

    public void Undo()
    {
        pending = null;
        Changed = false;
        Refresh();
    }

    private void Refresh()
    {
        OnPropertyChanged(nameof(InheritedAfterSave));
        OnPropertyChanged(nameof(ResetName));
        foreach (var option in Options)
        {
            option.Refresh();
        }
        changed();
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

    [RelayCommand]
    private void Choose() => setting.Choose(option);

    public void Refresh()
    {
        OnPropertyChanged(nameof(Selected));
        OnPropertyChanged(nameof(Dim));
    }
}
