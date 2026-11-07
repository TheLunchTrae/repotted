using Avalonia.Controls;
using Avalonia.Threading;

namespace Repotted.Desktop.Views;

internal sealed partial class NewProfileView : UserControl
{
    public NewProfileView() => InitializeComponent();

    // The name comes first, so each form opens ready to type it. The view is
    // reused from one form to the next, and is shown only after its form is
    // set, so the focus waits for the layout.
    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (DataContext is not null)
        {
            Dispatcher.UIThread.Post(() => NameBox.Focus(), DispatcherPriority.Loaded);
        }
    }
}
