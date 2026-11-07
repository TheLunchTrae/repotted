using Avalonia;
using Avalonia.Automation.Peers;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
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
public sealed class ViewTests : IDisposable
{
    private readonly Folders folders = new();

    public void Dispose() => folders.Dispose();

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

    [AvaloniaFact]
    public async Task Screen_readers_hear_each_repository_by_name()
    {
        var window = await Show("light", new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));

        var names = window.GetVisualDescendants().OfType<ListBoxItem>()
            .Where(item => item.DataContext is RepositoryRowViewModel)
            .Select(item => ControlAutomationPeer.CreatePeerForElement(item).GetName());

        Assert.Equal(
            [
                "TheLunchTrae/github-setup, public, no profile",
                "TheLunchTrae/repotted, public, no profile",
                "TheLunchTrae/test-repo, private, no profile",
            ],
            names);
    }

    [AvaloniaFact]
    public async Task The_search_shortcut_works_before_anything_has_focus()
    {
        var window = await Show("light", new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));
        var search = window.GetVisualDescendants().OfType<TextBox>().Single(box => box.Name == "SearchBox");
        Assert.Null(window.FocusManager?.GetFocusedElement());

        window.KeyPressQwerty(PhysicalKey.K, OperatingSystem.IsMacOS() ? RawInputModifiers.Meta : RawInputModifiers.Control);
        Dispatcher.UIThread.RunJobs();

        Assert.True(search.IsFocused);
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
    public async Task The_sign_in_shows_it_has_started_before_the_code(string theme)
    {
        var never = new TaskCompletionSource();
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedOut, exitCode: 1)
            .OnLines("login --json", ["", Documents.Code], never.Task));
        var signIn = Assert.IsType<SignInViewModel>(((MainViewModel)window.DataContext!).Page);

        _ = signIn.SignInCommand.ExecuteAsync(null);

        var text = Texts(window);
        Assert.Contains("Asking GitHub for a code", text);
        Assert.Contains("Cancel", text);
        Assert.DoesNotContain("Sign in with GitHub", text);
        Save(window, $"sign-in-starting-{theme}");
        signIn.SignInCancelCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_rejected_token_variable_offers_no_sign_in(string theme)
    {
        var window = await Show(theme, new FakeCli().On(
            "status --json",
            """{"signed_in":false,"reason":"rejected","message":"GitHub rejected the token in GH_TOKEN.","problems":[],"token_variable":"GH_TOKEN","install_url":"https://github.com/apps/repotted-app/installations/new"}""",
            exitCode: 1));

        var text = Texts(window);
        Assert.Contains(text, line => line.EndsWith("then reopen Repotted.", StringComparison.Ordinal));
        Assert.DoesNotContain("Sign in with GitHub", text);
        Save(window, $"sign-in-variable-{theme}");
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

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_profile_shows_where_each_setting_comes_from(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\nmerge:\n  allow_rebase_merge: true\nrulesets:\n  - name: Protect main\n");
        var own = folders.Write(
            "orgs.yaml",
            "# Repositories in our organizations\nextends: base.yaml\nrepository:\n  has_wiki: false\nmerge:\n  allow_squash_merge: false\nrulesets:\n  - name: Old tags\n    absent: true\nenvironments:\n  - name: npm\n");
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);

        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var projects = shell.Profiles.Current!.Tabs[0].Groups[0].Settings.Single(setting => setting.Key == "has_projects");
        projects.Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);

        var text = Texts(window);
        Assert.Contains("Profiles / orgs", text);
        Assert.Contains("Extends base. Saved to orgs.yaml.", text);
        Assert.Contains("Set here", text);
        Assert.Contains("From base", text);
        Assert.Contains("Not managed", text);
        Assert.Contains("1 unsaved change", text);
        Assert.Contains("Save profile", text);
        Save(window, $"profile-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task An_empty_profiles_folder_says_what_a_profile_is(string theme)
    {
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);

        shell.Page = 1;

        var text = Texts(window);
        Assert.Contains($"No profiles in {folders.Profiles} yet.", text);
        Assert.Contains("Choose a folder", text);
        Save(window, $"profiles-empty-{theme}");
    }

    private async Task<Window> Show(string theme, FakeCli cli)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        if (!cli.Answers(folders.List()))
        {
            cli.On(folders.List(), Documents.NoProfiles);
        }
        var main = new MainViewModel(new RepottedClient(cli), new FakeDesktop(), folders.Settings);
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
