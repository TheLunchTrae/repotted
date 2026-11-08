using System.Text;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Finds settings by what a person types. A setting is found by its label,
/// its profile key (the GitHub API field name), its note, the labels of its
/// choices, its synonyms, its group's title and description, its tab, and the
/// setting it belongs to, so searching a parent also finds its sub-options.
/// Every word typed must start a word somewhere in that text, ignoring case
/// and punctuation, so <c>allow_squash</c>, "squash allow" and "squ" all find
/// <c>allow_squash_merge</c>, while "on" doesn't find every "configuration".
/// </summary>
internal static class SettingSearch
{
    /// <summary>Each setting's searchable text and the setting it belongs to, read once from <see cref="ProfileFields"/>.</summary>
    private static readonly Dictionary<SettingField, (string Terms, SettingField? Parent)> Index = Build();

    /// <summary>
    /// The words of a query, as the search compares them, each with the space
    /// that starts a word in front; none for a blank query.
    /// </summary>
    public static string[] Words(string? query) =>
        [.. Normalize(query ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(word => $" {word}")];

    /// <summary>Whether every word of <see cref="Words"/> starts a word in <paramref name="terms"/>, text that <see cref="Normalize"/> made.</summary>
    public static bool Matches(string terms, IReadOnlyList<string> words) =>
        words.All(word => terms.Contains(word, StringComparison.Ordinal));

    public static bool Matches(SettingField field, IReadOnlyList<string> words) => Matches(Terms(field), words);

    /// <summary>The text a setting is found by.</summary>
    public static string Terms(SettingField field) =>
        Index.TryGetValue(field, out var entry) ? entry.Terms : Normalize(Own(field));

    /// <summary>The setting a sub-option belongs to, or null for a top-level setting.</summary>
    public static SettingField? Parent(SettingField field) =>
        Index.TryGetValue(field, out var entry) ? entry.Parent : null;

    /// <summary>
    /// Text as the search compares it: lowercase, with punctuation such as
    /// the underscores and dots in a key turned into spaces.
    /// </summary>
    public static string Normalize(string text)
    {
        var builder = new StringBuilder(text.Length + 2).Append(' ');
        foreach (var character in text)
        {
            builder.Append(char.IsLetterOrDigit(character) ? char.ToLowerInvariant(character) : ' ');
        }
        return builder.Append(' ').ToString();
    }

    /// <summary>
    /// What a setting says about itself. On and Off are left out, since every
    /// switch has them and searching them would find every switch.
    /// </summary>
    private static string Own(SettingField field) => string.Join(' ', (IEnumerable<string>)[
        field.Label,
        field.Key,
        field.Note ?? "",
        .. field.Options.Select(option => option.Label).Where(label => label is not ("On" or "Off")),
        .. field.Synonyms,
    ]);

    private static Dictionary<SettingField, (string, SettingField?)> Build()
    {
        var index = new Dictionary<SettingField, (string, SettingField?)>(ReferenceEqualityComparer.Instance);
        foreach (var tab in ProfileFields.Sections)
        {
            foreach (var group in tab.Groups)
            {
                SettingField? parent = null;
                foreach (var field in group.Fields)
                {
                    var owner = field.Nested ? parent : null;
                    var text = string.Join(' ', tab.Name, group.Title, group.Description, Own(field), owner is null ? "" : Own(owner));
                    index[field] = (Normalize(text), owner);
                    if (!field.Nested)
                    {
                        parent = field;
                    }
                }
            }
        }
        return index;
    }
}
