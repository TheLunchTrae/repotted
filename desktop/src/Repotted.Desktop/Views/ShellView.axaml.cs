using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace Repotted.Desktop.Views;

internal sealed partial class ShellView : UserControl
{
    public ShellView()
    {
        InitializeComponent();
        if (OperatingSystem.IsMacOS())
        {
            SearchShortcut.Text = "⌘K";
        }
        AddHandler(KeyDownEvent, OnShortcut, RoutingStrategies.Tunnel);
    }

    /// <summary>Ctrl+K, or Command+K on macOS, moves to the search.</summary>
    private void OnShortcut(object? sender, KeyEventArgs e)
    {
        var modifier = OperatingSystem.IsMacOS() ? KeyModifiers.Meta : KeyModifiers.Control;
        if (e.Key == Key.K && e.KeyModifiers == modifier)
        {
            SearchBox.Focus();
            SearchBox.SelectAll();
            e.Handled = true;
        }
    }
}
