using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Repotted.Desktop.Theme;

/// <summary>Paints a label in its own color, as GitHub shows it.</summary>
internal static class LabelChip
{
    /// <summary>A brush of a color such as <c>a2eeef</c> or <c>#14281a</c>; none for anything else.</summary>
    public static IValueConverter Brush { get; } =
        new FuncValueConverter<string?, IBrush?>(hex =>
            hex is not null && Color.TryParse(hex.StartsWith('#') ? hex : $"#{hex}", out var color) ? new SolidColorBrush(color) : null);
}
