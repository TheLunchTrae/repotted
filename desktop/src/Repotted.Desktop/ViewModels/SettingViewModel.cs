using System.Globalization;
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

    /// <summary>What is typed in a number or text box, kept as typed while it is being edited.</summary>
    private string? typed;

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

    /// <summary>Whether the setting is one of a few values, rather than typed in.</summary>
    public bool IsChoice => Field.Kind == SettingKind.Choice;

    public bool IsTyped => !IsChoice;

    public bool IsNumber => Field.Kind == SettingKind.Number;

    /// <summary>Whether the choices are too long to sit beside the label, so they go under it.</summary>
    public bool Wide => IsChoice && Field.Options.Sum(option => option.Label.Length) > 40;

    public int OptionsRow => Wide ? 1 : 0;

    public int OptionsColumn => Wide ? 1 : 2;

    public int OptionsSpan => Wide ? 3 : 1;

    /// <summary>Whether it belongs to the setting above it, so it shows indented under it.</summary>
    public bool Nested => Field.Nested;

    public string? FieldNote => Field.Note;

    public bool HasFieldNote => Field.Note is not null;

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
        _ when Invalid => "Not valid yet",
        (true, null, _) when Inherited is not null => $"From {Inherited.From} when saved",
        (true, null, _) => "Removed when saved",
        (true, _, _) => "Changed",
        (false, _, SettingOrigin.Own) => "Set here",
        (false, _, SettingOrigin.Inherited) => $"From {Inherited?.From}",
        _ => "Not managed",
    };

    /// <summary>
    /// Whether the box holds text that isn't a valid value. The row then waits
    /// on the person, like a change does, but saving is held back until the
    /// text is fixed or undone.
    /// </summary>
    public bool Invalid => TypedProblem is not null;

    /// <summary>Whether the row differs from the saved profile: a change to save, or text to fix.</summary>
    public bool Pending => Changed || Invalid;

    /// <summary>Whether the row can go back: undo a change or invalid text, or stop setting the value here.</summary>
    public bool CanReset => Pending || Origin == SettingOrigin.Own;

    public string ResetLabel => Pending ? "Undo" : "Remove";

    public string ResetName => Pending ? $"Undo the change to {Label}" : $"Remove {Label} from this profile";

    /// <summary>
    /// The number or text in the box. Typing a valid value changes the
    /// setting at once, and typing back what the box started with is no
    /// change at all. An invalid value, with <see cref="TypedProblem"/>
    /// saying why, leaves the saved value as it is and keeps the row
    /// <see cref="Invalid"/> until it is fixed or undone.
    /// </summary>
    public string Typed
    {
        get => typed ?? Display(Value);
        set
        {
            if (string.Equals(value, Typed, StringComparison.Ordinal))
            {
                return;
            }
            if (string.Equals(value, Display(Saved), StringComparison.Ordinal))
            {
                Undo();
                return;
            }
            typed = value;
            TypedProblem = Parse(value, out var parsed);
            if (TypedProblem is not null)
            {
                Set(changed: false, null, keepTyped: true);
            }
            else if (!Changed || !JsonNode.DeepEquals(parsed, pending))
            {
                Set(changed: true, parsed, keepTyped: true);
            }
            else
            {
                Set(changed: true, pending, keepTyped: true);
            }
        }
    }

    /// <summary>Why the typed value can't be used, or null when it can.</summary>
    public string? TypedProblem { get; private set; }

    public bool HasTypedProblem => TypedProblem is not null;

    /// <summary>The name screen readers hear for the box.</summary>
    public string TypedName => Label;

    /// <summary>What screen readers hear after the box's name: the problem with the text, or where the value comes from.</summary>
    public string TypedHelp => TypedProblem ?? Note;

    private string? Parse(string text, out JsonNode? value)
    {
        value = null;
        if (Field.Kind == SettingKind.Number)
        {
            if (!int.TryParse(text.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < Field.Minimum)
            {
                return $"Enter a whole number of {Field.Minimum} or more.";
            }
            value = JsonValue.Create(number);
            return null;
        }
        if (text.Length == 0 && !Field.AllowsEmpty)
        {
            return "Enter a value, or remove the setting from this profile.";
        }
        value = JsonValue.Create(text);
        return null;
    }

    /// <summary>A number or text as the box shows it.</summary>
    private static string Display(JsonNode? value) => value switch
    {
        null => "",
        JsonValue scalar when scalar.GetValueKind() == JsonValueKind.String => scalar.GetValue<string>(),
        _ => value.ToJsonString(),
    };

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

    /// <summary>Undoes a change or invalid text, or else stops setting the value in this profile.</summary>
    [RelayCommand]
    private void Reset()
    {
        if (Pending)
        {
            Undo();
            return;
        }
        Set(changed: true, null);
    }

    public void Undo() => Set(changed: false, null);

    /// <summary>
    /// Leaves the value out of this profile's own file once saved: removes a
    /// value it sets, or undoes a change that would add one. Used when another
    /// setting can't be saved beside it.
    /// </summary>
    public void Clear()
    {
        if (Origin == SettingOrigin.Own)
        {
            if (!Changed || pending is not null)
            {
                Set(changed: true, null);
            }
        }
        else if (Pending)
        {
            Undo();
        }
    }

    /// <summary>
    /// Records the change and tells the row, its options and the profile,
    /// which all show it. A change made by typing keeps the box as typed.
    /// </summary>
    private void Set(bool changed, JsonNode? value, bool keepTyped = false)
    {
        Changed = changed;
        pending = value;
        if (!keepTyped)
        {
            typed = null;
            TypedProblem = null;
        }
        foreach (var name in (string[])[
            nameof(Typed), nameof(TypedProblem), nameof(HasTypedProblem), nameof(TypedHelp), nameof(Invalid), nameof(Pending),
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
