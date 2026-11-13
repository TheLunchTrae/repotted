using Avalonia.Automation;
using Avalonia.Controls;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class RepositoriesView : UserControl
{
    public RepositoriesView()
    {
        InitializeComponent();
        // An owner's heading is disabled, so it can't be clicked, focused or reached with the arrow keys.
        List.ContainerPrepared += (_, e) =>
        {
            var heading = e.Container.DataContext is OwnerHeading;
            e.Container.IsEnabled = !heading;
            e.Container.Classes.Set("owner", heading);
            AutomationProperties.SetName(e.Container, e.Container.DataContext switch
            {
                OwnerHeading owner => owner.Description,
                RepositoryRowViewModel row => row.Description,
                _ => null,
            });
        };
        // The view model takes the chosen repositories as a list, since a ListBox's selection can't be bound both ways.
        List.SelectionChanged += (_, _) =>
        {
            // Select all, or a Shift-click across owners, takes in their headings too; they are let go again.
            if (List.Selection.SelectedItems.OfType<OwnerHeading>().Any())
            {
                foreach (var index in List.Selection.SelectedIndexes.Where(index => List.Items[index] is OwnerHeading).ToList())
                {
                    List.Selection.Deselect(index);
                }
                return;
            }
            if (DataContext is RepositoriesViewModel repositories)
            {
                repositories.Chosen = [.. List.Selection.SelectedItems.OfType<RepositoryRowViewModel>()];
            }
        };
    }
}
