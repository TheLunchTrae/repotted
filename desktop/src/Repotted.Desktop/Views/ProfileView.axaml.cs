using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class ProfileView : UserControl
{
    private ProfileViewModel? watched;

    public ProfileView()
    {
        InitializeComponent();
        _ = new FindShortcut(this, SettingsSearch, SearchShortcut);
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
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnDetachedFromVisualTree(e);
        Watch(null);
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
    }

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
