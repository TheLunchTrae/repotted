using Avalonia;
using Avalonia.Controls;

namespace Repotted.Desktop.Views;

internal sealed partial class NewProfileView : UserControl
{
    public NewProfileView() => InitializeComponent();

    // The name comes first, so the form opens ready to type it.
    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        NameBox.Focus();
    }
}
