using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace Repotted.Desktop.Views;

/// <summary>
/// Ctrl+F, or Command+F on macOS, moves to a page's search while the page
/// shows, and Escape in the search clears it. The shortcut listens on the
/// window, so it works wherever focus is on the page.
/// </summary>
internal sealed class FindShortcut
{
    private static readonly KeyModifiers Modifier = OperatingSystem.IsMacOS() ? KeyModifiers.Meta : KeyModifiers.Control;

    private readonly TextBox search;

    private TopLevel? topLevel;

    /// <param name="page">The page the search is on.</param>
    /// <param name="search">The search box.</param>
    /// <param name="hint">The text in the box that names the shortcut.</param>
    public FindShortcut(Control page, TextBox search, TextBlock hint)
    {
        this.search = search;
        hint.Text = OperatingSystem.IsMacOS() ? "⌘F" : "Ctrl F";
        page.AttachedToVisualTree += (_, _) =>
        {
            topLevel = TopLevel.GetTopLevel(page);
            topLevel?.AddHandler(InputElement.KeyDownEvent, OnShortcut, RoutingStrategies.Tunnel);
        };
        page.DetachedFromVisualTree += (_, _) =>
        {
            topLevel?.RemoveHandler(InputElement.KeyDownEvent, OnShortcut);
            topLevel = null;
        };
        search.KeyDown += OnSearchKeyDown;
    }

    private void OnShortcut(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.F && e.KeyModifiers == Modifier && search.IsEffectivelyVisible && search.IsEffectivelyEnabled)
        {
            search.Focus();
            search.SelectAll();
            e.Handled = true;
        }
    }

    private void OnSearchKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && e.KeyModifiers == KeyModifiers.None && !string.IsNullOrEmpty(search.Text))
        {
            search.Clear();
            e.Handled = true;
        }
    }
}
