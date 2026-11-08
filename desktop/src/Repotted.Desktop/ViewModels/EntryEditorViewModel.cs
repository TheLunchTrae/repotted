using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The editor for one ruleset or environment. It starts from the entry as the
/// profile resolves it and changes only what is edited here, so keys the
/// editor does not show stay as they are.
/// </summary>
internal abstract partial class EntryEditorViewModel : ViewModelBase
{
    private readonly Func<string, bool> taken;
    private readonly Action changed;

    protected EntryEditorViewModel(JsonObject? saved, bool renamable, Func<string, bool> taken, Action changed)
    {
        Saved = saved;
        Renamable = renamable;
        this.taken = taken;
        this.changed = changed;
        name = saved?["name"]?.GetValue<string>() ?? "";
        removes = saved?["absent"]?.GetValue<bool>() == true;
    }

    /// <summary>The entry the editor started from, or null for a new one.</summary>
    protected JsonObject? Saved { get; }

    /// <summary>The entry to start from: the saved one, unless it removes the entry from GitHub.</summary>
    protected JsonObject Start => Saved is null || Saved.ContainsKey("absent") ? [] : Saved;

    /// <summary>Whether the name can change: not for an entry that a base profile names.</summary>
    public bool Renamable { get; }

    public abstract string Kind { get; }

    /// <summary>The name box's accessible name, such as "Ruleset name".</summary>
    public string NameLabel => $"{char.ToUpperInvariant(Kind[0])}{Kind[1..]} name";

    private string Article => Kind[0] is 'a' or 'e' or 'i' or 'o' or 'u' ? "an" : "a";

    private string name;

    public string Name
    {
        get => name;
        set
        {
            if (name == value)
            {
                return;
            }
            name = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(RenameNote));
            Touched();
        }
    }

    private bool removes;

    /// <summary>Whether the profile removes this entry from GitHub, with <c>absent: true</c>.</summary>
    public bool Removes
    {
        get => removes;
        set
        {
            if (removes == value)
            {
                return;
            }
            removes = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(Manages));
            OnPropertyChanged(nameof(RenameNote));
            Touched();
        }
    }

    /// <summary>How names compare: GitHub's environment names ignore case.</summary>
    protected virtual StringComparison NameComparison => StringComparison.Ordinal;

    /// <summary>What a rename does on GitHub, which knows each entry by its name.</summary>
    public string? RenameNote =>
        !Removes
        && Saved?["name"]?.GetValue<string>() is { } old
        && Name.Trim() is { Length: > 0 } renamed
        && !string.Equals(old, renamed, NameComparison)
            ? $"GitHub knows each {Kind} by its name, so applying this profile creates {renamed} and leaves {old} on each repository as it is."
            : null;

    public bool Manages
    {
        get => !Removes;
        set => Removes = !value;
    }

    /// <summary>The entry as it will be saved.</summary>
    public JsonObject Entry
    {
        get
        {
            if (Removes)
            {
                return new JsonObject { ["name"] = Name.Trim(), ["absent"] = true };
            }
            var entry = Ordered(Build(), Saved);
            entry.Remove("name");
            entry.Remove("absent");
            // The name leads, as it does in a profile written by hand.
            return new JsonObject([new("name", Name.Trim()), .. entry.Select(pair => new KeyValuePair<string, JsonNode?>(pair.Key, pair.Value?.DeepClone()))]);
        }
    }

    /// <summary>Whether the entry differs from the one the editor started from.</summary>
    public bool Changed => Saved is null || !JsonNode.DeepEquals(Entry, Saved);

    /// <summary>Why the entry cannot be saved, if anything.</summary>
    public string? Problem
    {
        get
        {
            var trimmed = Name.Trim();
            if (trimmed.Length == 0)
            {
                return $"{char.ToUpperInvariant(Article[0])}{Article[1..]} {Kind} needs a name.";
            }
            if (taken(trimmed))
            {
                return $"The profile already has {Article} {Kind} named {trimmed}.";
            }
            return Removes ? null : FieldProblem;
        }
    }

    public bool HasProblem => Problem is not null;

    /// <summary>Why a field cannot be saved, if anything.</summary>
    protected abstract string? FieldProblem { get; }

    /// <summary>The entry from the fields, before the name is set.</summary>
    protected abstract JsonObject Build();

    protected void Touched()
    {
        OnPropertyChanged(nameof(Changed));
        OnPropertyChanged(nameof(Problem));
        OnPropertyChanged(nameof(HasProblem));
        changed();
    }

    /// <summary>
    /// <paramref name="built"/> with its keys, and those of the objects in it,
    /// in the order <paramref name="saved"/> has them and any new ones after,
    /// so an edit moves nothing in the YAML.
    /// </summary>
    public static JsonObject Ordered(JsonObject built, JsonObject? saved)
    {
        var keys = (saved ?? []).Select(pair => pair.Key).Where(built.ContainsKey)
            .Concat(built.Select(pair => pair.Key).Where(key => saved?.ContainsKey(key) != true));
        return new JsonObject(keys.Select(key => new KeyValuePair<string, JsonNode?>(
            key,
            built[key] is JsonObject child ? Ordered(child, saved?[key] as JsonObject) : built[key]?.DeepClone())));
    }

    /// <summary>The non-empty lines of a text box, trimmed.</summary>
    public static IReadOnlyList<string> Lines(string text) =>
        [.. text.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0)];

    /// <summary>A list of strings as text, one per line.</summary>
    protected static string Text(JsonNode? list) =>
        list is JsonArray items ? string.Join('\n', items.Select(item => item?.GetValue<string>()).OfType<string>()) : "";
}
