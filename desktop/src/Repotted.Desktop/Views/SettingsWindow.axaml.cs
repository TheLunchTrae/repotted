using Avalonia.Controls;
using Avalonia.Data.Converters;
using Avalonia.Input;

namespace Repotted.Desktop.Views;

/// <summary>
/// The settings in a window of their own, as on macOS, where Repotted >
/// Settings opens them. The shell opens it and closes it when the shell goes.
/// </summary>
internal sealed partial class SettingsWindow : Window
{
    public static IValueConverter IsAccount { get; } = new FuncValueConverter<int, bool>(tab => tab != 1);

    public static IValueConverter IsProfiles { get; } = new FuncValueConverter<int, bool>(tab => tab == 1);

    public SettingsWindow() => InitializeComponent();

    /// <summary>Command+W closes it, as it closes any macOS window.</summary>
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.Key == Key.W && e.KeyModifiers == (OperatingSystem.IsMacOS() ? KeyModifiers.Meta : KeyModifiers.Control))
        {
            Close();
            e.Handled = true;
            return;
        }
        base.OnKeyDown(e);
    }
}
