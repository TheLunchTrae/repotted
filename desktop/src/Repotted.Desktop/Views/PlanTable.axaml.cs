using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

/// <summary>
/// A plan's rows by section, as the compare and the apply show them: the
/// setting, its value on GitHub, and what it would be.
/// </summary>
internal sealed partial class PlanTable : UserControl
{
    public static readonly StyledProperty<IReadOnlyList<CompareSectionViewModel>> SectionsProperty =
        AvaloniaProperty.Register<PlanTable, IReadOnlyList<CompareSectionViewModel>>(nameof(Sections), []);

    public static readonly StyledProperty<string> WantedHeaderProperty =
        AvaloniaProperty.Register<PlanTable, string>(nameof(WantedHeader), "");

    public static readonly StyledProperty<IDataTemplate?> RowActionProperty =
        AvaloniaProperty.Register<PlanTable, IDataTemplate?>(nameof(RowAction));

    public PlanTable() => InitializeComponent();

    public IReadOnlyList<CompareSectionViewModel> Sections
    {
        get => GetValue(SectionsProperty);
        set => SetValue(SectionsProperty, value);
    }

    /// <summary>The heading of the last value column, such as what the profile holds.</summary>
    public string WantedHeader
    {
        get => GetValue(WantedHeaderProperty);
        set => SetValue(WantedHeaderProperty, value);
    }

    /// <summary>What each row offers in a column of its own, such as leaving the change out; none leaves the column out.</summary>
    public IDataTemplate? RowAction
    {
        get => GetValue(RowActionProperty);
        set => SetValue(RowActionProperty, value);
    }
}
