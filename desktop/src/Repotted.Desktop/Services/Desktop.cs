using System.Diagnostics;
using Avalonia.Input.Platform;

namespace Repotted.Desktop.Services;

/// <summary>What the app asks of the operating system, so tests can stand in for it.</summary>
internal interface IDesktop
{
    void OpenUrl(Uri url);

    Task CopyTextAsync(string text);
}

/// <summary>Opens links in the default browser and copies through the window's clipboard.</summary>
internal sealed class SystemDesktop(Func<IClipboard?> clipboard) : IDesktop
{
    public void OpenUrl(Uri url)
    {
        if (url.Scheme != Uri.UriSchemeHttps)
        {
            return;
        }
        using var process = Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
    }

    public Task CopyTextAsync(string text) => clipboard()?.SetTextAsync(text) ?? Task.CompletedTask;
}
