using Avalonia.Controls;

namespace Repotted.Desktop.Views;

internal sealed partial class CompareView : UserControl
{
    public CompareView()
    {
        InitializeComponent();
        _ = new FindShortcut(this, CompareSearch, SearchShortcut);
    }
}
