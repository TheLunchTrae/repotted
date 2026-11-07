using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using Repotted.Desktop.Views;

namespace Repotted.Desktop;

internal sealed partial class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var window = new MainWindow();
            var main = new MainViewModel(
                new RepottedClient(RepottedCli.Locate()),
                new SystemDesktop(() => window.Clipboard));
            window.DataContext = main;
            desktop.MainWindow = window;
            _ = main.StartAsync();
        }
        base.OnFrameworkInitializationCompleted();
    }
}
