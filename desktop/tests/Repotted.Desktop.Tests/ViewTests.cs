using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.LogicalTree;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;
using Repotted.Desktop.Views;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Draws each page in light and dark. With REPOTTED_SCREENSHOTS set to a
/// folder, each drawing is saved there as a PNG.
/// </summary>
public sealed class ViewTests
{
    public static TheoryData<string> Themes => ["light", "dark"];

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_repository_list_shows_each_repository_and_the_selected_one(string theme)
    {
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));

        var text = Texts(window);
        Assert.Contains("Repositories", text);
        Assert.Contains("repotted", text);
        Assert.Contains("test-repo", text);
        Assert.Contains("TheLunchTrae/github-setup", text);
        Assert.Contains("No profile", text);
        Assert.Contains("Add repositories", text);
        Save(window, $"repositories-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_sign_in_shows_the_code_to_enter(string theme)
    {
        var never = new TaskCompletionSource();
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json", [Documents.Code, Documents.Done], never.Task));
        var signIn = Assert.IsType<SignInViewModel>(((MainViewModel)window.DataContext!).Page);
        Save(window, $"sign-in-{theme}");

        _ = signIn.SignInCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("ABCD-1234", Texts(window));
        Save(window, $"sign-in-code-{theme}");
        signIn.SignInCancelCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_rejected_sign_in_says_so(string theme)
    {
        var window = await Show(theme, new FakeCli().On("status --json", Documents.Rejected, exitCode: 1));

        Assert.Contains("GitHub no longer accepts your last sign-in. Sign in again.", Texts(window));
        Save(window, $"sign-in-rejected-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task An_empty_list_offers_to_add_repositories(string theme)
    {
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", """{"source":"installations","repositories":[]}"""));

        Assert.Contains("The Repotted App is not installed on any repositories you administer yet.", Texts(window));
        Save(window, $"repositories-empty-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_missing_command_line_offers_to_try_again(string theme)
    {
        var window = await Show(theme, new FakeCli().Missing("status --json"));

        Assert.Contains("Repotted could not start", Texts(window));
        Save(window, $"problem-{theme}");
    }

    private static async Task<Window> Show(string theme, FakeCli cli)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        var main = new MainViewModel(new RepottedClient(cli), new FakeDesktop());
        var window = new MainWindow { DataContext = main, Width = 1280, Height = 800 };
        window.Show();
        await main.StartAsync();
        Dispatcher.UIThread.RunJobs();
        return window;
    }

    /// <summary>Every piece of text the window shows, runs included.</summary>
    private static HashSet<string> Texts(Window window)
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
        foreach (var button in window.GetLogicalDescendants().OfType<Button>().Where(button => button.IsEffectivelyVisible))
        {
            if (button.Content is string label)
            {
                texts.Add(label);
            }
        }
        return texts;
    }

    private static void Save(Window window, string name)
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
