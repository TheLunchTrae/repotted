using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class ProfileView : UserControl
{
    public ProfileView() => InitializeComponent();

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
