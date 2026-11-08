using Avalonia.Controls;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class RepositoriesView : UserControl
{
    public RepositoriesView()
    {
        InitializeComponent();
        // The view model takes the chosen repositories as a list, since a ListBox's selection can't be bound both ways.
        List.SelectionChanged += (_, _) =>
        {
            if (DataContext is RepositoriesViewModel repositories)
            {
                repositories.Chosen = [.. List.Selection.SelectedItems.OfType<RepositoryRowViewModel>()];
            }
        };
    }
}
