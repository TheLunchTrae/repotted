using System.Globalization;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.Input;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A label: its color, its description, and the old names a repository may
/// still have it under, which apply renames so issues keep the label.
/// </summary>
internal sealed partial class LabelEditorViewModel : EntryEditorViewModel
{
    private const string Old = "renamed_from";

    /// <summary>GitHub's limits on a label's name and description.</summary>
    public const int NameLimit = 50;

    public const int DescriptionLimit = 100;

    private readonly Func<string, string?> claimedBy;

    /// <param name="saved">The label as the profile resolves it, or null for a new one.</param>
    /// <param name="renamable">Whether the name can change.</param>
    /// <param name="taken">Whether another label has a name, as a draft or not.</param>
    /// <param name="claimedBy">The other label that has a name or lists it as an old name, or null.</param>
    /// <param name="changed">Runs on every edit.</param>
    public LabelEditorViewModel(JsonObject? saved, bool renamable, Func<string, bool, bool> taken, Func<string, string?> claimedBy, Action changed)
        : base(saved, renamable, taken, changed)
    {
        this.claimedBy = claimedBy;
        var start = Start;
        color = start["color"].AsText() ?? "";
        keepsDescription = !start.ContainsKey("description");
        description = start["description"].AsText() ?? "";
        renamedFrom = Text(start[Old]);
        Swatches = [.. LabelColor.Palette.Select(swatch => new LabelSwatchViewModel(this, swatch.Hex, swatch.Name))];
    }

    public override string Kind => "label";

    protected override StringComparison NameComparison => StringComparison.OrdinalIgnoreCase;

    private string color;

    /// <summary>Six hex digits, with or without <c>#</c>; empty leaves each repository's own.</summary>
    public string Color
    {
        get => color;
        set
        {
            if (SetProperty(ref color, value))
            {
                OnPropertyChanged(nameof(Hex));
                OnPropertyChanged(nameof(Ink));
                foreach (var swatch in Swatches)
                {
                    swatch.Refresh();
                }
                Touched();
            }
        }
    }

    /// <summary>The color as GitHub writes it, or null when the box holds none.</summary>
    public string? Hex => LabelColor.Normal(Color);

    /// <summary>The text color that reads on the label's color.</summary>
    public string Ink => LabelColor.Ink(Hex);

    public IReadOnlyList<LabelSwatchViewModel> Swatches { get; }

    [RelayCommand]
    private void Pick(string hex) => Color = hex;

    private bool keepsDescription;

    /// <summary>Whether the profile leaves the description out, so each repository keeps its own.</summary>
    public bool KeepsDescription
    {
        get => keepsDescription;
        set
        {
            if (SetProperty(ref keepsDescription, value))
            {
                OnPropertyChanged(nameof(SetsDescription));
                OnPropertyChanged(nameof(DescriptionNote));
                Touched();
            }
        }
    }

    public bool SetsDescription => !KeepsDescription;

    private string description;

    public string Description
    {
        get => description;
        set
        {
            if (SetProperty(ref description, value))
            {
                OnPropertyChanged(nameof(DescriptionNote));
                Touched();
            }
        }
    }

    public string DescriptionNote => KeepsDescription
        ? "Each repository keeps its own description."
        : $"{Description.Length.ToString(CultureInfo.InvariantCulture)} of {DescriptionLimit.ToString(CultureInfo.InvariantCulture)} characters. Empty clears each repository's description.";

    private string renamedFrom;

    /// <summary>Old names, one per line, that apply renames to this one.</summary>
    public string RenamedFrom
    {
        get => renamedFrom;
        set
        {
            if (SetProperty(ref renamedFrom, value))
            {
                OnPropertyChanged(nameof(RenameNote));
                OnPropertyChanged(nameof(CanAddOldName));
                Touched();
            }
        }
    }

    private IReadOnlyList<string> OldNames => Lines(RenamedFrom);

    /// <summary>The name the profile saved the label under, when it is being renamed here and Renamed from doesn't list it yet.</summary>
    private string? Unlisted =>
        !Removes
        && Saved?["name"].AsText() is { } old
        && Name.Trim() is { Length: > 0 } renamed
        && !string.Equals(old, renamed, StringComparison.OrdinalIgnoreCase)
        && !OldNames.Contains(old, StringComparer.OrdinalIgnoreCase)
            ? old
            : null;

    public override string? RenameNote => Unlisted is { } old
        ? $"Applying creates {Name.Trim()} and leaves {old} on each repository, unless Renamed from lists {old}."
        : null;

    public bool CanAddOldName => Unlisted is not null;

    /// <summary>What the rename link does, naming the old name, which its fixed text leaves out.</summary>
    public string AddOldNameHelp => Unlisted is { } old ? $"Lists {old} in Renamed from, so applying renames {old} on each repository." : "";

    /// <summary>Lists the name the label was saved under in Renamed from, so applying renames it.</summary>
    [RelayCommand]
    private void AddOldName()
    {
        if (Unlisted is { } old)
        {
            RenamedFrom = OldNames.Count == 0 ? old : $"{RenamedFrom.TrimEnd()}\n{old}";
        }
    }

    protected override void Touched()
    {
        OnPropertyChanged(nameof(CanAddOldName));
        OnPropertyChanged(nameof(AddOldNameHelp));
        base.Touched();
    }

    protected override string? FieldProblem
    {
        get
        {
            var name = Name.Trim();
            if (Color.Trim().Length > 0 && Hex is null)
            {
                return "The color is six hex digits, such as a2eeef, with or without #.";
            }
            if (SetsDescription && Description.Length > DescriptionLimit)
            {
                return $"A label's description can be at most {DescriptionLimit} characters.";
            }
            var old = OldNames;
            if (old.Contains(name, StringComparer.OrdinalIgnoreCase))
            {
                return "Renamed from lists the label's own name.";
            }
            if (old.Distinct(StringComparer.OrdinalIgnoreCase).Count() < old.Count)
            {
                return "Each old name can be listed once.";
            }
            if (old.Any(each => each.Length > NameLimit))
            {
                return $"An old name can be at most {NameLimit} characters.";
            }
            foreach (var each in old)
            {
                if (claimedBy(each) is { } other)
                {
                    return string.Equals(other, each, StringComparison.OrdinalIgnoreCase)
                        ? $"The profile has a label named {each}, so it can't be an old name."
                        : $"{other} already lists {each} in Renamed from.";
                }
            }
            return null;
        }
    }

    /// <summary>
    /// The name's own checks, which hold for a label that is removed too:
    /// GitHub's limit, and no other label listing it as an old name, since
    /// apply would rename that label into this one.
    /// </summary>
    protected override string? NameProblem
    {
        get
        {
            var name = Name.Trim();
            if (name.Length > NameLimit)
            {
                return $"A label's name can be at most {NameLimit} characters.";
            }
            return claimedBy(name) is { } other && !string.Equals(other, name, StringComparison.OrdinalIgnoreCase)
                ? $"{other} lists {name} in Renamed from, so no label can be named that."
                : null;
        }
    }

    /// <summary>The old names the label lists, which another label can't have; a label that is removed takes none.</summary>
    public IReadOnlyList<string> Claims => Removes ? [] : OldNames;

    protected override JsonObject Build()
    {
        var entry = Start.DeepClone().AsObject();
        var text = Color.Trim();
        if (text != (Start["color"].AsText() ?? ""))
        {
            entry.Remove("color");
            if (text.Length > 0)
            {
                entry["color"] = text;
            }
        }
        // An untouched description stays as saved, so an edit elsewhere doesn't rewrite it.
        if (SetsDescription != Start.ContainsKey("description") || Description != (Start["description"].AsText() ?? ""))
        {
            entry.Remove("description");
            if (SetsDescription)
            {
                entry["description"] = Description;
            }
        }
        if (RenamedFrom != Text(Start[Old]))
        {
            entry.Remove(Old);
            var old = OldNames;
            if (old.Count > 0)
            {
                entry[Old] = new JsonArray([.. old.Select(name => (JsonNode)name)]);
            }
        }
        return entry;
    }
}

/// <summary>One of GitHub's label colors, which the editor offers to pick.</summary>
internal sealed class LabelSwatchViewModel(LabelEditorViewModel editor, string hex, string name) : ViewModelBase
{
    public string Hex { get; } = hex;

    public string Name { get; } = name;

    public LabelEditorViewModel Editor { get; } = editor;

    /// <summary>Whether the label has this color now.</summary>
    public bool IsChosen => Editor.Hex == Hex;

    /// <summary>The swatch's name for a screen reader, which says when it is the label's color.</summary>
    public string AccessibleName => IsChosen ? $"{Name}, {Hex}, chosen" : $"{Name}, {Hex}";

    public void Refresh()
    {
        OnPropertyChanged(nameof(IsChosen));
        OnPropertyChanged(nameof(AccessibleName));
    }
}

/// <summary>Label colors as GitHub writes them, and the text that reads on each.</summary>
internal static class LabelColor
{
    /// <summary>The dark text on a light label: the app's own text color.</summary>
    public const string Dark = "#14281a";

    public const string Light = "#ffffff";

    /// <summary>GitHub's own label colors, as its label editor offers them.</summary>
    public static readonly IReadOnlyList<(string Hex, string Name)> Palette =
    [
        ("b60205", "Dark red"), ("d93f0b", "Orange"), ("fbca04", "Yellow"), ("0e8a16", "Green"),
        ("006b75", "Teal"), ("1d76db", "Blue"), ("0052cc", "Dark blue"), ("5319e7", "Purple"),
        ("e99695", "Pink"), ("f9d0c4", "Peach"), ("fef2c0", "Light yellow"), ("c2e0c6", "Light green"),
        ("bfdadc", "Light teal"), ("c5def5", "Light blue"), ("bfd4f2", "Pale blue"), ("d4c5f9", "Lavender"),
    ];

    /// <summary>Six lowercase hex digits without <c>#</c>, or null when <paramref name="text"/> is not a color.</summary>
    public static string? Normal(string? text)
    {
        var trimmed = text?.Trim() ?? "";
        var digits = trimmed.StartsWith('#') ? trimmed[1..] : trimmed;
        return digits.Length == 6 && digits.All(char.IsAsciiHexDigit) ? digits.ToLowerInvariant() : null;
    }

    /// <summary>
    /// Dark or light text, whichever contrasts more with <paramref name="hex"/>,
    /// so a label stays readable on any color. No color reads as dark.
    /// </summary>
    public static string Ink(string? hex) =>
        Normal(hex) is { } color && Contrast(color, Light[1..]) > Contrast(color, Dark[1..]) ? Light : Dark;

    /// <summary>The WCAG contrast ratio of two colors.</summary>
    public static double Contrast(string first, string second)
    {
        var (a, b) = (Luminance(first), Luminance(second));
        return (Math.Max(a, b) + 0.05) / (Math.Min(a, b) + 0.05);
    }

    private static double Luminance(string hex)
    {
        double Channel(int at)
        {
            var value = int.Parse(hex.AsSpan(at, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
            return value <= 0.03928 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
        }
        return (0.2126 * Channel(0)) + (0.7152 * Channel(2)) + (0.0722 * Channel(4));
    }
}
