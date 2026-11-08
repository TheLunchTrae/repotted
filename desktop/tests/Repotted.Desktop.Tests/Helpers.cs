using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;

namespace Repotted.Desktop.Tests;

/// <summary>What the tests share: JSON text for canned documents, waiting on the UI thread, and what a window shows.</summary>
internal static class Helpers
{
    /// <summary><paramref name="text"/> as a JSON string, or <c>null</c>.</summary>
    public static string Json(string? text) => JsonSerializer.Serialize(text);

    /// <summary>Runs the UI thread's work until <paramref name="done"/>, for work that ends off the test's own awaits.</summary>
    public static async Task Until(Func<bool> done)
    {
        for (var tries = 0; tries < 500 && !done(); tries++)
        {
            await Task.Delay(10, TestContext.Current.CancellationToken);
            Dispatcher.UIThread.RunJobs();
        }
        Assert.True(done());
    }

    /// <summary>Every piece of text the window shows, runs included.</summary>
    public static HashSet<string> Texts(Window window)
    {
        Dispatcher.UIThread.RunJobs();
        var texts = new HashSet<string>(StringComparer.Ordinal);
        foreach (var block in window.GetVisualDescendants().OfType<TextBlock>().Where(block => block.IsEffectivelyVisible))
        {
            if (block.Text is { Length: > 0 } text)
            {
                texts.Add(text);
            }
            foreach (var run in block.Inlines?.OfType<Avalonia.Controls.Documents.Run>() ?? [])
            {
                if (run.Text is { Length: > 0 } runText)
                {
                    texts.Add(runText);
                }
            }
        }
        return texts;
    }

    /// <summary>Draws the window, and with REPOTTED_SCREENSHOTS set to a folder, saves the drawing there as a PNG.</summary>
    public static void Save(Window window, string name)
    {
        var folder = Environment.GetEnvironmentVariable("REPOTTED_SCREENSHOTS");
        Dispatcher.UIThread.RunJobs();
        using var frame = window.CaptureRenderedFrame();
        Assert.NotNull(frame);
        if (!string.IsNullOrEmpty(folder))
        {
            Directory.CreateDirectory(folder);
            frame.Save(Path.Combine(folder, $"{name}.png"), new PngBitmapEncoderOptions());
        }
    }
}
