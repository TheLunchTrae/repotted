using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace Repotted.Desktop.Views;

internal sealed partial class ShellView : UserControl
{
    private TopLevel? topLevel;

    public ShellView()
    {
        InitializeComponent();
        if (OperatingSystem.IsMacOS())
        {
            SearchShortcut.Text = "⌘K";
        }
    }

    // The shortcut listens on the window, so it works before anything in the
    // shell has focus, which is how the window first opens.
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        topLevel = TopLevel.GetTopLevel(this);
        topLevel?.AddHandler(KeyDownEvent, OnShortcut, RoutingStrategies.Tunnel);
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        topLevel?.RemoveHandler(KeyDownEvent, OnShortcut);
        topLevel = null;
        base.OnDetachedFromVisualTree(e);
    }

    /// <summary>Repositories in the sidebar leaves a compare, though the page is already selected.</summary>
    private void OnRepositoriesTapped(object? sender, TappedEventArgs e)
    {
        if (DataContext is ViewModels.ShellViewModel shell && shell.CloseCompareCommand.CanExecute(null))
        {
            shell.CloseCompareCommand.Execute(null);
        }
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
