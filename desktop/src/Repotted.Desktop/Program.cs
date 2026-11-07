using Avalonia;

namespace Repotted.Desktop;

internal static class Program
{
    // Nothing that touches Avalonia or a SynchronizationContext may run before AppMain.
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    // Also used by the XAML previewer.
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>().UsePlatformDetect().LogToTrace();
}
