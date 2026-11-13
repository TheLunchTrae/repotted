using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.VisualTree;

namespace Repotted.Desktop.Views;

internal sealed partial class ShellView : UserControl
{
    private TopLevel? topLevel;

    /// <summary>The page selected when the pointer went down, since the list selects on press, before the tap.</summary>
    private int pressedOn = -1;

    /// <summary>The page selected when the key went down, since Space selects a focused item first.</summary>
    private int keyedOn = -1;

    public ShellView()
    {
        InitializeComponent();
        // The list marks Enter and Space handled, and choosing the selected item changes nothing it reports.
        Nav.AddHandler(PointerPressedEvent, (_, _) => pressedOn = Nav.SelectedIndex, RoutingStrategies.Tunnel, handledEventsToo: true);
        Nav.AddHandler(KeyDownEvent, (_, _) => keyedOn = Nav.SelectedIndex, RoutingStrategies.Tunnel, handledEventsToo: true);
        Nav.AddHandler(TappedEvent, OnNavTapped, RoutingStrategies.Bubble, handledEventsToo: true);
        Nav.AddHandler(KeyDownEvent, OnNavKeyDown, RoutingStrategies.Bubble, handledEventsToo: true);
        ProfileList.KeyDown += OnProfileListKeyDown;
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
    private void OnNavTapped(object? sender, TappedEventArgs e) => ShowPage(e.Source, pressedOn);

    // Enter and Space leave the selection as it is, so the page chosen is the one already shown.
    private void OnNavKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is Key.Enter or Key.Space && e.KeyModifiers == KeyModifiers.None)
        {
            ShowPage(e.Source, keyedOn);
        }
    }

    private void ShowPage(object? source, int shown)
    {
        if (DataContext is ViewModels.ShellViewModel shell
            && (source as Visual)?.FindAncestorOfType<ListBoxItem>(includeSelf: true) is { } item
            && Nav.IndexFromContainer(item) is var page and >= 0
            && page == shown)
        {
            shell.ShowPage(page);
        }
    }

    /// <summary>
    /// The platform's delete shortcut on the selected profile asks whether to
    /// delete it: Delete on Windows, and Command+Delete on macOS, as in the
    /// Finder, where Delete alone edits text.
    /// </summary>
    private void OnProfileListKeyDown(object? sender, KeyEventArgs e)
    {
        var shortcut = OperatingSystem.IsMacOS()
            ? e.Key == Key.Back && e.KeyModifiers == KeyModifiers.Meta
            : e.Key == Key.Delete && e.KeyModifiers == KeyModifiers.None;
        if (shortcut && ProfileList.SelectedItem is ViewModels.ProfileItemViewModel item && item.DeleteCommand.CanExecute(null))
        {
            item.DeleteCommand.Execute(null);
            e.Handled = true;
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
