using Avalonia.Data.Converters;
using Avalonia.Markup.Xaml;

namespace Repotted.Desktop.Theme;

/// <summary>
/// Shows a control's label in the platform's own casing. Labels are written
/// once, in sentence case. macOS shows buttons, segmented options, tabs, and
/// page titles in Apple's title style, as in "Sign In with GitHub"; Windows
/// shows them as written. Body text, headings, field labels, checkboxes, radio
/// buttons, and messages stay in sentence case everywhere.
/// </summary>
internal static class ControlLabel
{
    private static readonly bool UsesTitleStyle = OperatingSystem.IsMacOS();

    // Articles, coordinating conjunctions, and prepositions of four letters or
    // fewer, which title style leaves lowercase unless they start or end a
    // label. The lists cover the app's labels, not every word Apple's guide
    // names: add to them when a new label needs it.
    private static readonly HashSet<string> Minor = new(StringComparer.Ordinal)
    {
        "a", "an", "the", "and", "but", "or", "nor", "as", "at", "by", "for", "from", "in", "into", "of", "off",
        "on", "onto", "out", "over", "per", "to", "up", "via", "with",
    };

    // A particle that belongs to its verb is capitalized, as in "Sign In".
    private static readonly HashSet<string> PhrasalVerbs = new(StringComparer.Ordinal)
    {
        "back up", "check out", "log in", "log out", "look up", "opt in", "opt out", "set up", "sign in", "sign out",
        "take out", "turn off", "turn on",
    };

    /// <summary>Converts a bound label to the platform's casing.</summary>
    public static IValueConverter Converter { get; } =
        new FuncValueConverter<object?, object?>(value => value is string label ? For(label) : value);

    /// <summary>A label in the casing of the platform the app runs on.</summary>
    public static string For(string label) => UsesTitleStyle ? TitleStyle(label) : label;

    /// <summary>
    /// Apple's title style: every word capitalized except minor words in the
    /// middle. A word that already has a capital, such as GitHub, macOS, or
    /// YAML, is a name and stays as written, and so is a path.
    /// </summary>
    internal static string TitleStyle(string label)
    {
        // A label that starts with a slash is a path, as in "/docs", and stays as written.
        if (label.StartsWith('/'))
        {
            return label;
        }

        var words = label.Split(' ');
        for (var i = 0; i < words.Length; i++)
        {
            // An access key's underscore or other punctuation can come first.
            var start = words[i].TakeWhile(c => !char.IsLetter(c)).Count();
            var word = words[i][start..];
            if (word.Length == 0 || word.Any(char.IsUpper))
            {
                continue;
            }

            var middle = i > 0 && i < words.Length - 1;
            var particle = i > 0 && PhrasalVerbs.Contains($"{words[i - 1].ToLowerInvariant()} {word}");
            if (middle && Minor.Contains(word) && !particle)
            {
                continue;
            }

            words[i] = words[i][..start] + char.ToUpperInvariant(word[0]) + word[1..];
        }

        return string.Join(' ', words);
    }
}

/// <summary>
/// A fixed label in the platform's casing, for a title or label that is not a
/// button's text: <c>Text="{theme:Label 'New profile'}"</c>.
/// </summary>
internal sealed class LabelExtension(string text) : MarkupExtension
{
    public override object ProvideValue(IServiceProvider serviceProvider) => ControlLabel.For(text);
}
