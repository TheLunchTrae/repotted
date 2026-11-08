using Avalonia.Controls;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Views;

internal sealed partial class MainWindow : Window
{
    /// <summary>Whether the user settled the unsaved changes, so the window closes without asking again.</summary>
    private bool settled;

    public MainWindow() => InitializeComponent();

    /// <summary>
    /// Holds the window open while unsaved profile changes, or an apply that
    /// runs or holds unsaved one-off edits, wait for the user.
    /// </summary>
    protected override void OnClosing(WindowClosingEventArgs e)
    {
        base.OnClosing(e);
        if (settled || e.Cancel || DataContext is not MainViewModel { Page: ShellViewModel shell } || !shell.MustAskToLeave)
        {
            return;
        }
        e.Cancel = true;
        _ = CloseOnceSettledAsync(shell);
    }

    private async Task CloseOnceSettledAsync(ShellViewModel shell)
    {
        if (await shell.ConfirmQuitAsync().ConfigureAwait(true))
        {
            settled = true;
            Close();
        }
    }
}
