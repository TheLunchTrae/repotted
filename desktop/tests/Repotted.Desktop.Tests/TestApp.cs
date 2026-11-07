using Avalonia;
using Avalonia.Headless;
using Repotted.Desktop.Tests;

[assembly: AvaloniaTestApplication(typeof(TestApp))]

namespace Repotted.Desktop.Tests;

/// <summary>The app under the headless platform, drawing with Skia so screenshots show the real theme.</summary>
public static class TestApp
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}
