using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;

namespace Repotted.Desktop.Views;

internal sealed partial class ProfilesView : UserControl
{
    public ProfilesView()
    {
        InitializeComponent();
        NoneOpen.PropertyChanged += OnNoneOpenPropertyChanged;
    }

    /// <summary>
    /// Keeps the keyboard on the page once a profile closes: focus that went
    /// with the editor moves to the button that starts a new profile.
    /// </summary>
    private void OnNoneOpenPropertyChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
    {
        if (e.Property != IsVisibleProperty || e.NewValue is not true)
        {
            return;
        }
        Dispatcher.UIThread.Post(
            () =>
            {
                if (TopLevel.GetTopLevel(this)?.FocusManager?.GetFocusedElement() is not Visual { IsEffectivelyVisible: true })
                {
                    NoneOpenNew.Focus();
                }
            },
            DispatcherPriority.Loaded);
    }
}
