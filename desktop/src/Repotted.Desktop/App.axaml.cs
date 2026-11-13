using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Markup.Xaml;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;
using Repotted.Desktop.Views;

namespace Repotted.Desktop;

internal sealed partial class App : Application
{
    public override void Initialize()
    {
        ControlLabel.ApplyToButtons();
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var window = new MainWindow();
            var main = new MainViewModel(
                RepottedCli.Locate(),
                new SystemDesktop(() => window),
                AppSettings.ForUser());
            window.DataContext = main;
            desktop.MainWindow = window;
            desktop.Exit += (_, _) => main.Stop();
            if (OperatingSystem.IsMacOS())
            {
                AddSettingsToAppMenu(main);
            }
            _ = main.StartAsync();
        }
        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Puts Settings… at the top of the macOS app menu, above the Hide and Quit
    /// items macOS adds, with Command+comma, where Mac apps keep their
    /// settings. It opens them while signed in. A menu of the app's own also
    /// drops Avalonia's About item.
    /// </summary>
    private void AddSettingsToAppMenu(MainViewModel main)
    {
        var settings = new NativeMenuItem("Settings…")
        {
            Gesture = new KeyGesture(Key.OemComma, KeyModifiers.Meta),
            IsEnabled = false,
        };
        settings.Click += (_, _) => (main.Page as ShellViewModel)?.OpenSettings();
        main.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(MainViewModel.Page))
            {
                settings.IsEnabled = main.Page is ShellViewModel;
            }
        };
        NativeMenu.SetMenu(this, new NativeMenu { Items = { settings } });
    }
}
