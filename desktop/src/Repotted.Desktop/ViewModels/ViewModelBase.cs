using CommunityToolkit.Mvvm.ComponentModel;

namespace Repotted.Desktop.ViewModels;

/// <summary>A view model whose view the window shows by its type.</summary>
internal abstract class ViewModelBase : ObservableObject
{
    /// <summary>
    /// Runs <paramref name="action"/> on the context the view model was used
    /// from, since the CLI reports lines from a background thread.
    /// </summary>
    protected static Action<T> OnContext<T>(Action<T> action)
    {
        var context = SynchronizationContext.Current;
        return value =>
        {
            if (context is null)
            {
                action(value);
            }
            else
            {
                context.Post(_ => action(value), null);
            }
        };
    }
}
