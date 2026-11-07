using Avalonia.Controls;
using Avalonia.Input.Platform;

namespace Repotted.Desktop.Services;

/// <summary>What the app asks of the operating system, so tests can stand in for it.</summary>
internal interface IDesktop
{
    Task OpenUrlAsync(Uri url);

    Task CopyTextAsync(string text);
}

/// <summary>Opens links in the default browser and copies through the window's clipboard.</summary>
internal sealed class SystemDesktop(Func<TopLevel?> window) : IDesktop
{
    public async Task OpenUrlAsync(Uri url)
    {
        // Only web pages: a link the CLI printed must not start a program.
        if (url.Scheme == Uri.UriSchemeHttps && window() is { } topLevel)
        {
            await topLevel.Launcher.LaunchUriAsync(url).ConfigureAwait(true);
        }
    }

    public Task CopyTextAsync(string text) => window()?.Clipboard?.SetTextAsync(text) ?? Task.CompletedTask;
}
