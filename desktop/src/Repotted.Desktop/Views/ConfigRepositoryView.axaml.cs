using Avalonia.Controls;
using Avalonia.Threading;

namespace Repotted.Desktop.Views;

internal sealed partial class ConfigRepositoryView : UserControl
{
    public ConfigRepositoryView() => InitializeComponent();

    // The repository comes first, so the form opens ready to type it.
    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (DataContext is not null)
        {
            Dispatcher.UIThread.Post(() => RepositoryBox.Focus(), DispatcherPriority.Loaded);
        }
    }
}
