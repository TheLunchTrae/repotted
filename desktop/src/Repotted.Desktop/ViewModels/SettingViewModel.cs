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
/// This profile's own draft of a setting: a value saved under its
/// <c>drafts</c>, or, when <paramref name="Unsets"/>, the setting named in
/// <c>drafts.unset</c>, so finishing the draft stops setting it here.
/// </summary>
internal sealed record SettingDraft(JsonNode? Value, bool Unsets = false);

/// <summary>
/// One setting row: the value that applies and where that comes from, this
/// profile's draft of it, if any, and the change waiting to be saved. The
/// row starts from the draft when there is one, so a change and Reset are
/// measured from what was last saved, draft included. Removing a value the
/// profile sets falls back to <see cref="Inherited"/>, the value its base
/// profile gives, when there is one.
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
        Action changed,
        SettingDraft? draft = null)
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

    /// <summary>Whether the setting is one of a few values, rather than typed in.</summary>
    public bool IsChoice => Field.Kind == SettingKind.Choice;

    public bool IsTyped => !IsChoice;

    public bool IsNumber => Field.Kind == SettingKind.Number;

    /// <summary>Whether the setting is a list, typed one item a line.</summary>
    public bool IsList => Field.Kind == SettingKind.List;

    /// <summary>
    /// The checks and the search of a list of allowed action patterns, which
    /// the editor gives the row once it has made every row; null for any other setting.
    /// </summary>
    public ActionPatternsViewModel? Patterns { get; set; }

    public bool HasPatterns => Patterns is not null;

    /// <summary>Whether the box is a plain one, with nothing beside it.</summary>
    public bool IsPlainBox => IsTyped && !HasPatterns;

    /// <summary>Whether the choices are too long to sit beside the label, or the value is a list, so they go under it.</summary>
    public bool Wide => IsList || (IsChoice && Field.Options.Sum(option => option.Label.Length) > 40);

    public int OptionsRow => Wide ? 1 : 0;

    public int OptionsColumn => Wide ? 1 : 2;

    public int OptionsSpan => Wide ? 3 : 1;

    /// <summary>Whether it belongs to the setting above it, so it shows indented under it.</summary>
    public bool Nested => Field.Nested;

    public string? FieldNote => Field.Note;

    public bool HasFieldNote => Field.Note is not null;

    /// <summary>
    /// The row of the setting that can hide this one or turn it off, as
    /// <see cref="SettingField.DependsOn"/> names it, once the editor has made
    /// every row; the editor refreshes this row when that one changes.
    /// </summary>
    public SettingViewModel? ControlledBy { get; set; }

    /// <summary>The rows that <see cref="ControlledBy"/> names this one for, which the editor sets with it.</summary>
    public List<SettingViewModel> Dependents { get; } = [];

    /// <summary>
    /// The row whose value hides this one or turns it off: the setting it
    /// depends on, while that shows a value <see cref="SettingField.DependsOn"/>
    /// names, as saved, inherited or changed, or the row that hides or turns
    /// off that setting in turn. Null while nothing does.
    /// </summary>
    private SettingViewModel? Cause => ControlledBy switch
    {
        null => null,
        { Cause: { } above } => above,
        { } parent when Field.DependsOn!.Holds(parent.Value) => parent,
        _ => null,
    };

    /// <summary>
    /// Whether GitHub hides the setting now, as its page does with what
    /// depends on a setting that is off. The tab leaves it out, while search
    /// and filters still find it, off. Its value stays in the profile.
    /// </summary>
    public bool Hidden => ControlledBy is { } parent && (parent.Hidden || (Field.DependsOn!.Hides && Cause == parent));

    /// <summary>
    /// Whether the value can be edited: not while it is <see cref="Hidden"/>,
    /// or while the setting it depends on turns it off. The value and its way back stay.
    /// </summary>
    public bool Enabled => Cause is null;

    /// <summary>Why the setting is hidden or off, naming the setting that does it and its value; null while it isn't.</summary>
    public string? WhyOff => Cause is { } cause
        ? $"{(Hidden ? "Hidden" : "Off")} while {cause.Label} is set to {cause.ValueLabel}."
        : null;

    /// <summary>The value as its option names it, or as the box shows it.</summary>
    private string ValueLabel => Value is not { } value
        ? ""
        : Field.Options.FirstOrDefault(option => JsonNode.DeepEquals(option.Value, value))?.Label ?? Display(value);

    /// <summary>How many settings under this one are hidden by it while this profile still names them once saved, set here or in a base, or with a draft or invalid text.</summary>
    public int HiddenManaged => Under().Count(row => row.Hidden && row.Cause == this && (row.Managed || row.HasDraft || row.Invalid));

    /// <summary>What the row says about the settings it hides that the profile still names; null when there are none.</summary>
    public string? HiddenNote => HiddenManaged switch
    {
        0 => null,
        1 => "This profile still names 1 setting hidden under it.",
        var count => $"This profile still names {count} settings hidden under it.",
    };

    public bool HasHiddenNote => HiddenNote is not null;

    /// <summary>Every row that depends on this one, directly or through another.</summary>
    private IEnumerable<SettingViewModel> Under() => Dependents.SelectMany(row => row.Under().Prepend(row));

    public JsonNode? Saved { get; }

    public SettingOrigin Origin { get; }

    /// <summary>What the profiles this one extends give, or null when they leave it out.</summary>
    public InheritedValue? Inherited { get; }

    public IReadOnlyList<OptionViewModel> Options { get; }

    /// <summary>Whether a change to the value waits to be saved.</summary>
    public bool Changed { get; private set; }

    /// <summary>This profile's own draft of the setting, as saved, or null when it has none.</summary>
    public SettingDraft? SavedDraft { get; }

    public bool HasDraft => SavedDraft is not null;

    /// <summary>Whether the row shows its draft: one is saved and nothing changes it yet.</summary>
    public bool InDraft => HasDraft && !Pending;

    /// <summary>Whether the profile file itself will hold a value once its draft is finished, as the row starts.</summary>
    private bool StartsOwn => SavedDraft is { } draft ? !draft.Unsets : Origin == SettingOrigin.Own;

    /// <summary>The value the row starts from: the draft's, or else what applies.</summary>
    private JsonNode? StartValue => SavedDraft is { } draft
        ? draft.Unsets ? Inherited?.Value : draft.Value
        : Saved;

    /// <summary>The value shown: what the profile will hold once saved.</summary>
    public JsonNode? Value => !Changed ? StartValue : pending ?? Inherited?.Value;

    /// <summary>Whether the profile, once saved, names a value, <c>null</c> included.</summary>
    public bool Managed => OwnAfterSave || InheritedAfterSave;

    /// <summary>Whether the profile file itself will hold the value: the rail is solid.</summary>
    public bool OwnAfterSave => Changed ? pending is not null : StartsOwn;

    /// <summary>Whether a base profile will give the value: the rail is pale.</summary>
    public bool InheritedAfterSave => !OwnAfterSave
        && (Changed || SavedDraft is { Unsets: true } ? Inherited is not null : Origin == SettingOrigin.Inherited);

    /// <summary>The value that applies now, as its option names it, for a row that shows its draft.</summary>
    private string AppliesNow => Origin switch
    {
        SettingOrigin.NotManaged => "not managed",
        _ => Describe(Saved),
    };

    public string Note => (Changed, pending, Origin) switch
    {
        _ when Invalid => "Not valid yet",
        (true, null, _) when Inherited is not null => $"From {Inherited.From} when saved",
        (true, null, _) => "Removed when saved",
        (true, _, _) => "Changed",
        _ when SavedDraft is { Unsets: true } => Inherited is not null
            ? $"In the draft: from {Inherited.From}. Applies now: {AppliesNow}"
            : $"In the draft: not managed. Applies now: {AppliesNow}",
        _ when SavedDraft is not null => $"In the draft. Applies now: {AppliesNow}",
        (false, _, SettingOrigin.Own) => "Set here",
        (false, _, SettingOrigin.Inherited) => $"From {Inherited?.From}",
        _ => "Not managed",
    };

    /// <summary>A value as its option names it, or as the box shows it.</summary>
    private string Describe(JsonNode? value) =>
        Field.Options.FirstOrDefault(option => JsonNode.DeepEquals(option.Value, value))?.Label
        ?? (Display(value).Replace("\n", ", ", StringComparison.Ordinal) is { Length: > 0 } shown ? shown : "empty");

    /// <summary>
    /// Whether the box holds text that isn't a valid value. The row then waits
    /// on the person, like a change does, but saving is held back until the
    /// text is fixed or undone.
    /// </summary>
    public bool Invalid => TypedProblem is not null;

    /// <summary>Whether the value differs from the saved profile: a change to save, or text to fix.</summary>
    public bool Pending => Changed || Invalid;

    /// <summary>Whether anything about the row differs from what was last saved, draft included.</summary>
    public bool HasChanges => Pending;

    /// <summary>Whether the row can go back to what was last saved, or else stop setting the value here.</summary>
    public bool CanReset => HasChanges || StartsOwn;

    public string ResetLabel => HasChanges ? "Reset" : "Remove";

    public string ResetName => HasChanges
        ? $"Reset {Label} to what was last saved"
        : $"Remove {Label} from this profile";

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
            if (string.Equals(value, Display(StartValue), StringComparison.Ordinal))
            {
                Undo();
                return;
            }
            typed = value;
            TypedProblem = Parse(value, out var parsed);
            if (TypedProblem is not null
                || (StartsOwn && JsonNode.DeepEquals(parsed, StartValue)))
            {
                // Text that isn't a value, or that spells the saved value another way, changes nothing.
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

    /// <summary>What screen readers hear after the box's name: the problem with the text, or where the value comes from, after why the box is off while it is.</summary>
    public string TypedHelp => TypedProblem ?? string.Join(' ', new[] { WhyOff, IsList ? FieldNote : null, Note }.OfType<string>());

    /// <summary>What screen readers hear after a choice's name: where the value comes from, after why the choices are off while they are.</summary>
    public string OptionHelp => WhyOff is { } why ? $"{why} {Note}" : Note;

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
        if (Field.Kind == SettingKind.List)
        {
            // Commas separate items too, as GitHub's own box takes them.
            var items = text.Split(['\n', '\r', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (items.Length > MaxItems)
            {
                return $"GitHub takes at most {MaxItems} patterns.";
            }
            value = new JsonArray([.. items.Select(item => JsonValue.Create(item))]);
            return null;
        }
        if (text.Length == 0 && !Field.AllowsEmpty && !Field.EmptyIsNull)
        {
            return "Enter a value, or remove the setting from this profile.";
        }
        value = JsonValue.Create(text);
        return null;
    }

    /// <summary>The most items GitHub takes in a list, as its allowed action patterns.</summary>
    private const int MaxItems = 1000;

    /// <summary>A number, text or list as the box shows it, a list one item a line.</summary>
    private static string Display(JsonNode? value) => value switch
    {
        null => "",
        JsonArray list => string.Join('\n', list.Select(item => item?.AsText() ?? item?.ToJsonString() ?? "")),
        JsonValue scalar when scalar.GetValueKind() == JsonValueKind.String => scalar.GetValue<string>(),
        _ => value.ToJsonString(),
    };

    /// <summary>Whether the profile file holds a value once saved, and which: the change, or else the draft.</summary>
    private (bool Own, JsonNode? Value) Final => Changed ? (pending is not null, pending) : (StartsOwn, StartValue);

    /// <summary>Whether the value the row ends with is the one that applies now, so the row needs no draft.</summary>
    private bool FinalApplies => Final is var (own, value)
        && own == (Origin == SettingOrigin.Own)
        && (!own || Same(value, Saved));

    /// <summary>Two values of the row as the file saves them, where an empty box may be saved as <c>null</c>.</summary>
    private bool Same(JsonNode? left, JsonNode? right) =>
        JsonNode.DeepEquals(Saves(left), Saves(right));

    private JsonNode? Saves(JsonNode? value) => value is not null && SavesNull(value) ? null : value;

    /// <summary>
    /// What Save sends for this row: the value the row ends with, so it
    /// applies, and the draft taken out. The draft's place in
    /// <c>drafts.unset</c> is the profile's to write, as <see cref="UnsetOnDraft"/> says.
    /// </summary>
    public IEnumerable<Services.ProfileChange> SaveChanges()
    {
        if (!FinalApplies)
        {
            var (own, value) = Final;
            yield return Write(Field.Path, own ? value : null);
        }
        if (SavedDraft is { Unsets: false })
        {
            yield return new($"drafts.{Field.Path}", null);
        }
    }

    /// <summary>
    /// What Save as draft sends for this row: the value the row ends with as
    /// a draft, when it is not the one that applies, and the draft taken out
    /// otherwise. What applies stays as it is.
    /// </summary>
    public IEnumerable<Services.ProfileChange> DraftChanges()
    {
        var (own, value) = Final;
        if (!FinalApplies && own)
        {
            if (SavedDraft is not { Unsets: false } draft || !Same(draft.Value, value))
            {
                yield return Write($"drafts.{Field.Path}", value);
            }
        }
        else if (SavedDraft is { Unsets: false })
        {
            yield return new($"drafts.{Field.Path}", null);
        }
    }

    /// <summary>Whether Save as draft lists the setting in <c>drafts.unset</c>: the row ends with no value here, where one applies now.</summary>
    public bool UnsetOnDraft => !FinalApplies && !Final.Own;

    /// <summary>Whether the row's draft is in <c>drafts.unset</c>, so saving it either way takes it out of that list unless <see cref="UnsetOnDraft"/>.</summary>
    public bool Unsets => SavedDraft is { Unsets: true };

    /// <summary>
    /// Why Save as draft can't keep the row: a draft of no value, such as an
    /// empty runner label, reads as no draft, so the row needs Save or Reset.
    /// </summary>
    public string? DraftProblem => !FinalApplies && Final is (true, var value) && Saves(value) is null
        ? $"{Label}: an empty value can't be kept in a draft. Save it, or reset it."
        : null;

    /// <summary>
    /// The change that saves <paramref name="value"/> at <paramref name="key"/>,
    /// or stops setting it there when null. A row whose field has
    /// <see cref="SettingField.EmptyIsNull"/> keeps an empty box's value as
    /// <c>""</c>, and saves that as <c>null</c>.
    /// </summary>
    private Services.ProfileChange Write(string key, JsonNode? value) =>
        value is not null && SavesNull(value) ? new(key, null, SetsNull: true) : new(key, value?.DeepClone());

    private bool SavesNull(JsonNode value) => Field.EmptyIsNull && value.AsText() is "";

    public void Choose(SettingOption option)
    {
        // Choosing the value the row starts from is no change at all.
        if (StartsOwn && JsonNode.DeepEquals(option.Value, StartValue))
        {
            Undo();
            return;
        }
        Set(changed: true, option.Value.DeepClone());
    }

    /// <summary>Puts the row back as last saved, draft included, or else stops setting the value in this profile.</summary>
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

    /// <summary>Tells the bindings the row and its choices may show differently, as when the setting that turns it off changes.</summary>
    public void Refresh()
    {
        OnAllPropertiesChanged();
        foreach (var option in Options)
        {
            option.Refresh();
        }
        // The list may have come out of hiding, which is when its patterns are checked.
        Patterns?.Read();
    }

    /// <summary>Puts the value back as last saved, draft included.</summary>
    public void Undo() => Set(changed: false, null);

    /// <summary>
    /// Leaves the value out of this profile's own file once saved: removes a
    /// value it sets, or undoes a change that would add one. Used when another
    /// setting can't be saved beside it.
    /// </summary>
    public void Clear()
    {
        if (StartsOwn)
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
        OnAllPropertiesChanged();
        foreach (var option in Options)
        {
            option.Refresh();
        }
        Patterns?.Read();
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

    /// <summary>Where the setting's value comes from, for screen readers, after why the setting is off while it is.</summary>
    public string Help => setting.OptionHelp;

    [RelayCommand]
    private void Choose() => setting.Choose(option);

    public void Refresh() => OnAllPropertiesChanged();
}
