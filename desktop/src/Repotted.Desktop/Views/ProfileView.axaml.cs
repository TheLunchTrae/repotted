using System.ComponentModel;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.LogicalTree;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class ProfileView : UserControl
{
    private ProfileViewModel? watched;

    private TopLevel? topLevel;

    /// <summary>Command+W on macOS and Ctrl+W elsewhere, which close a document in each platform's own apps.</summary>
    private static readonly KeyGesture CloseGesture = new(Key.W, OperatingSystem.IsMacOS() ? KeyModifiers.Meta : KeyModifiers.Control);

    public ProfileView()
    {
        InitializeComponent();
        _ = new FindShortcut(this, SettingsSearch, SearchShortcut);
        var shortcut = OperatingSystem.IsMacOS() ? "⌘W" : "Ctrl+W";
        ToolTip.SetTip(CloseButton, $"{ControlLabel.For("Close profile")} ({shortcut})");
        AutomationProperties.SetAcceleratorKey(CloseButton, shortcut);
        PlatformOrder(PreviewActions);
    }

    /// <summary>
    /// Closes the profile on its shortcut while the page shows. It listens on
    /// the window, so it works wherever focus is on the page.
    /// </summary>
    private void OnCloseShortcut(object? sender, KeyEventArgs e)
    {
        // While the question about unsaved changes waits, the close is still running and can't start again.
        // While the page is off, such as during a delete, the shortcut is off with it.
        if (CloseGesture.Matches(e) && CloseButton.IsEffectivelyVisible && CloseButton.IsEffectivelyEnabled && DataContext is ProfileViewModel profile
            && profile.CloseCommand.CanExecute(null))
        {
            profile.CloseCommand.Execute(null);
            e.Handled = true;
        }
    }

    /// <summary>
    /// Sets a sheet's actions, written in macOS's order with the default last,
    /// in the platform's order: Windows and Linux put the default first.
    /// </summary>
    internal static void PlatformOrder(Panel actions)
    {
        if (OperatingSystem.IsMacOS())
        {
            return;
        }
        var buttons = actions.Children.ToList();
        actions.Children.Clear();
        actions.Children.AddRange(Enumerable.Reverse(buttons));
    }

    /// <summary>
    /// Follows the open profile while the page is on screen, so a new search
    /// starts at the top of what it found. Profiles outlive the page in a
    /// cache, so the page lets go of a profile when it leaves the screen.
    /// </summary>
    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Watch(this.IsAttachedToVisualTree() ? DataContext as ProfileViewModel : null);
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        Watch(DataContext as ProfileViewModel);
        topLevel = TopLevel.GetTopLevel(this);
        topLevel?.AddHandler(KeyDownEvent, OnCloseShortcut, RoutingStrategies.Tunnel);
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnDetachedFromVisualTree(e);
        Watch(null);
        topLevel?.RemoveHandler(KeyDownEvent, OnCloseShortcut);
        topLevel = null;
    }

    private void Watch(ProfileViewModel? profile)
    {
        if (watched is not null)
        {
            watched.PropertyChanged -= OnProfileChanged;
        }
        watched = profile;
        if (watched is not null)
        {
            watched.PropertyChanged += OnProfileChanged;
        }
    }

    private void OnProfileChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(ProfileViewModel.Query) or nameof(ProfileViewModel.OnlyManaged)
            or nameof(ProfileViewModel.OnlyUnsaved) or nameof(ProfileViewModel.OnlyDrafts))
        {
            Scroller.Offset = default;
        }
        // The sheet takes focus when it opens, so the keyboard is in it and not behind it.
        if (e.PropertyName is nameof(ProfileViewModel.Previewing) && watched?.Previewing == true)
        {
            Dispatcher.UIThread.Post(() => ClosePreview.Focus(), DispatcherPriority.Loaded);
        }
    }

    /// <summary>
    /// The keys of the action search box: Enter searches at once, the down
    /// arrow moves into the results, and Escape closes them.
    /// </summary>
    private void OnActionSearchKeyDown(object? sender, KeyEventArgs e)
    {
        if (sender is not TextBox { DataContext: ActionPatternsViewModel { Search: { } search } } box)
        {
            return;
        }
        switch (e.Key)
        {
            case Key.Enter:
                search.SubmitCommand.Execute(null);
                e.Handled = true;
                break;
            case Key.Escape when search.Open:
                search.CloseCommand.Execute(null);
                e.Handled = true;
                break;
            case Key.Down when search is { Open: true, HasResults: true } && FoundActions(box) is { } results:
                results.SelectedIndex = Math.Max(results.SelectedIndex, 0);
                (results.ContainerFromIndex(results.SelectedIndex) ?? results).Focus(NavigationMethod.Directional);
                e.Handled = true;
                break;
        }
    }

    /// <summary>Hears the keys of the action search results before the list does, since a list keeps Enter and Space for itself.</summary>
    private void OnFoundActionsAttached(object? sender, VisualTreeAttachmentEventArgs e)
    {
        if (sender is ListBox results)
        {
            results.RemoveHandler(KeyDownEvent, OnFoundActionKeyDown);
            results.AddHandler(KeyDownEvent, OnFoundActionKeyDown, RoutingStrategies.Tunnel);
        }
    }

    /// <summary>
    /// The keys of the action search results: Enter or Space adds the chosen
    /// repository, Escape closes the results, and both that and the up arrow
    /// on the first result go back to the search box.
    /// </summary>
    private void OnFoundActionKeyDown(object? sender, KeyEventArgs e)
    {
        if (sender is not ListBox { DataContext: ActionPatternsViewModel { Search: { } search } } results)
        {
            return;
        }
        // A press on the Add button is the button's own.
        if (e.Key is Key.Enter or Key.Space && e.Source is not Button && results.SelectedItem is FoundActionViewModel found)
        {
            found.AddCommand.Execute(null);
            e.Handled = true;
        }
        else if (e.Key == Key.Escape || (e.Key == Key.Up && results.SelectedIndex <= 0))
        {
            if (e.Key == Key.Escape)
            {
                search.CloseCommand.Execute(null);
            }
            var box = results.FindLogicalAncestorOfType<Popup>()?.Parent is Panel panel
                ? panel.Children.OfType<TextBox>().FirstOrDefault()
                : null;
            box?.Focus();
            e.Handled = true;
        }
    }

    /// <summary>The results list under an action search box.</summary>
    private static ListBox? FoundActions(TextBox box) =>
        (box.Parent as Panel)?.Children.OfType<Popup>().FirstOrDefault()?.Child?.GetLogicalDescendants().OfType<ListBox>().FirstOrDefault();

    /// <summary>Puts focus in an entry's editor once it opens, so the keyboard follows the open.</summary>
    private void OnEntryNameAttached(object? sender, VisualTreeAttachmentEventArgs e)
    {
        var tab = (sender as Visual)?.GetVisualAncestors().OfType<Control>()
            .Select(control => control.DataContext).OfType<ProfileTabViewModel>().FirstOrDefault();
        if (sender is TextBox box && tab?.TakeOpened() == true)
        {
            Dispatcher.UIThread.Post(() => box.Focus(), DispatcherPriority.Loaded);
        }
    }

    /// <summary>Puts focus back on the entry an editor closed, or on the new entry button when that entry has gone.</summary>
    private void OnListPropertyChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
    {
        if (e.Property != IsVisibleProperty || e.NewValue is not true || sender is not Control list
            || list.DataContext is not ProfileTabViewModel { Left: { } left } tab)
        {
            return;
        }
        Dispatcher.UIThread.Post(
            () =>
            {
                var buttons = list.GetVisualDescendants().OfType<Button>().ToList();
                var target = buttons.FirstOrDefault(button => button.DataContext == left && button.Classes.Contains("entry"))
                    ?? buttons.FirstOrDefault(button => button.Command == tab.NewCommand);
                target?.Focus();
            },
            DispatcherPriority.Loaded);
    }
}
