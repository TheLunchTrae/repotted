using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Threading;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class ApplyView : UserControl
{
    private ApplyViewModel? watched;

    public ApplyView()
    {
        InitializeComponent();
        DataContextChanged += (_, _) => Watch(DataContext as ApplyViewModel);
    }

    private void Watch(ApplyViewModel? apply)
    {
        if (watched is not null)
        {
            watched.PropertyChanged -= OnApplyChanged;
        }
        watched = apply;
        if (apply is not null)
        {
            apply.PropertyChanged += OnApplyChanged;
        }
    }

    /// <summary>
    /// Moves focus to the step the review now shows, since the button that
    /// went to it hides with the step it left.
    /// </summary>
    private void OnApplyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(ApplyViewModel.Editing) || sender is not ApplyViewModel apply)
        {
            return;
        }
        Dispatcher.UIThread.Post(() => StepFocus(apply.Editing)?.Focus(), DispatcherPriority.Loaded);
    }

    /// <summary>The control that takes focus on a step: its main action, or the way back.</summary>
    internal Button? StepFocus(bool editing) =>
        editing ? (ReviewChanges.IsEffectivelyEnabled ? ReviewChanges : DiscardApply)
            : Apply.IsEffectivelyEnabled ? Apply : BackToEdits;
}
