using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.VisualTree;

namespace Repotted.Desktop.Views;

internal sealed partial class ShellView : UserControl
{
    private TopLevel? topLevel;

    public ShellView()
    {
        InitializeComponent();
        // The list marks Enter and Space handled, and choosing the selected item changes nothing it reports.
        Nav.AddHandler(TappedEvent, OnNavTapped, RoutingStrategies.Bubble, handledEventsToo: true);
        Nav.AddHandler(KeyDownEvent, OnNavKeyDown, RoutingStrategies.Bubble, handledEventsToo: true);
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

    /// <summary>
    /// Choosing the page that is already selected, by click, Enter or Space,
    /// leaves what stands in for it, such as a compare.
    /// </summary>
    private void OnNavTapped(object? sender, TappedEventArgs e) => ShowPage(e.Source);

    private void OnNavKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is Key.Enter or Key.Space && e.KeyModifiers == KeyModifiers.None)
        {
            ShowPage(e.Source);
        }
    }

    private void ShowPage(object? source)
    {
        if (DataContext is ViewModels.ShellViewModel shell
            && (source as Visual)?.FindAncestorOfType<ListBoxItem>(includeSelf: true) is { } item
            && Nav.IndexFromContainer(item) is var page and >= 0)
        {
            shell.ShowPage(page);
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
