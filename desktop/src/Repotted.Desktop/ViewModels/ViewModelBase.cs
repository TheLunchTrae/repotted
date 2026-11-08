using CommunityToolkit.Mvvm.ComponentModel;

namespace Repotted.Desktop.ViewModels;

/// <summary>A view model whose view the window shows by its type.</summary>
internal abstract class ViewModelBase : ObservableObject
{
    /// <summary>
    /// Tells the bindings that any property may have changed, so a row can't
    /// miss one. Only for a row that nothing but bindings listens to: code
    /// that waits for a property by name never hears this.
    /// </summary>
    protected void OnAllPropertiesChanged() => OnPropertyChanged(string.Empty);

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
