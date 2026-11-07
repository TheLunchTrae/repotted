using Avalonia;
using Avalonia.Automation;
using Avalonia.Automation.Peers;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
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

        // Screen readers hear which option is chosen, and where the value comes from.
        var wiki = window.GetVisualDescendants().OfType<ToggleButton>()
            .Where(toggle => AutomationProperties.GetName(toggle)?.StartsWith("Wiki: ", StringComparison.Ordinal) == true)
            .Select(toggle => (Name: AutomationProperties.GetName(toggle), toggle.IsChecked, Help: AutomationProperties.GetHelpText(toggle)));
        Assert.Equal([("Wiki: On", (bool?)false, "Set here"), ("Wiki: Off", true, "Set here")], wiki);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Rulesets_and_environments_open_in_an_editor(string theme)
    {
        var @base = folders.Write("base.yaml", "rulesets:\n  - name: Tags\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        string Path(string file) => System.Text.Json.JsonSerializer.Serialize(file);
        var resolved = $$$"""
            {"chain":[{{{Path(own)}}},{{{Path(@base)}}}],
             "profile":{
               "rulesets":[
                 {"name":"Main","enforcement":"active",
                  "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
                  "rules":[
                    {"type":"deletion"},{"type":"non_fast_forward"},
                    {"type":"pull_request","parameters":{"required_approving_review_count":1,"allowed_merge_methods":["rebase"]}},
                    {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"quality"}]}}]},
                 {"name":"Tags","target":"tag"}],
               "environments":[
                 {"name":"npm","reviewers":[{"type":"User","id":1}],"prevent_self_review":true,
                  "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},
                  "branch_policies":[{"name":"main"},{"name":"v*","type":"tag"}]}]},
             "sources":{"repository":{},"merge":{},"actions":{},
               "rulesets":{"Main":{{{Path(own)}}},"Tags":{{{Path(@base)}}} },
               "environments":{"npm":{{{Path(own)}}} } } }
            """;
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.SelectedTab = editor.Tabs[3];

        var text = Texts(window);
        Assert.Contains("New ruleset", text);
        var rows = window.GetVisualDescendants().OfType<Button>()
            .Where(button => button.Classes.Contains("entry"))
            .Select(button => AutomationProperties.GetName(button))
            .ToList();
        Assert.Equal(["Main: Set here", "Tags: From base"], rows);
        Save(window, $"rulesets-{theme}");

        // A row opens its ruleset with focus on its name, and every choice says what it leaves to GitHub.
        window.GetVisualDescendants().OfType<Button>().First(button => AutomationProperties.GetName(button) == "Main: Set here").Focus();
        window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        var main = (RulesetEditorViewModel)editor.Tabs[3].Editing!.Editor;
        Assert.Same(
            window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "ruleset name"),
            window.FocusManager?.GetFocusedElement());
        main.Enforcement.Options[1].ChooseCommand.Execute(null);
        text = Texts(window);
        Assert.Contains("Back to rulesets", text);
        Assert.Contains("Require a pull request before merging", text);
        Assert.Contains("Changed, not saved yet", text);
        Assert.Contains("Not set here, so the repository keeps its own, or Branches when it is new", text);
        var enforcement = window.GetVisualDescendants().OfType<ToggleButton>()
            .Where(toggle => AutomationProperties.GetName(toggle)?.StartsWith("Enforcement: ", StringComparison.Ordinal) == true)
            .Select(toggle => (AutomationProperties.GetName(toggle), toggle.IsChecked));
        Assert.Equal([("Enforcement: Active", (bool?)false), ("Enforcement: Evaluate", true), ("Enforcement: Disabled", false)], enforcement);
        // Tall enough to show the whole ruleset.
        window.Height = 1500;
        Save(window, $"ruleset-{theme}");

        // Back puts focus on the row it left, and a base's ruleset keeps its name here.
        editor.Tabs[3].BackCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Main: Changed, not saved yet", AutomationProperties.GetName((Control)window.FocusManager!.GetFocusedElement()!));
        editor.Tabs[3].Entries[1].OpenCommand.Execute(null);
        Assert.Contains("A base profile names this one, so this profile keeps its name and sets the rest.", Texts(window));
        Assert.True(window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "ruleset name").IsReadOnly);

        editor.SelectedTab = editor.Tabs[4];
        editor.Tabs[4].Entries[0].OpenCommand.Execute(null);
        text = Texts(window);
        Assert.Contains("Back to environments", text);
        Assert.Contains("Which ones", text);
        Assert.Equal(
            "main",
            window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "Branches that may deploy").Text);
        Save(window, $"environment-{theme}");
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

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_compare_shows_what_the_profile_would_change(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base))
            .On($"plan TheLunchTrae/repotted --profile {own} --json", Documents.Plan()));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        var repositories = shell.Repositories;
        repositories.Selected = repositories.Rows.Single(row => row.Name == "repotted");

        var panel = Texts(window);
        Assert.Contains("Compare with a profile", panel);
        Assert.Contains("Compare", panel);

        repositories.CompareWith = shell.Profiles.Usable.Single(item => item.Name == "orgs");
        Save(window, $"repository-compare-{theme}");
        repositories.CompareCommand.Execute(null);

        var text = Texts(window);
        Assert.Contains("orgs compared with TheLunchTrae/repotted", text);
        Assert.Contains("rules[pull_request].parameters.allowed_merge_methods", text);
        Assert.Contains("merge, squash, rebase", text);
        Assert.Contains("Back to repositories", text);
        Assert.DoesNotContain("Issues", text);
        Save(window, $"compare-{theme}");

        // Every row says what the profile does to it, for screen readers.
        var names = window.GetVisualDescendants().OfType<ListBoxItem>()
            .Select(item => ControlAutomationPeer.CreatePeerForElement(item).GetName())
            .ToList();
        Assert.Contains("Main: Block Deletion, absent: true: on GitHub, the profile removes it", names);
        Assert.Contains(
            "Main: Require PR, rules[pull_request].parameters.allowed_merge_methods: GitHub has merge, squash, rebase, the profile sets rebase",
            names);

        // Repositories in the sidebar is already selected, and still leaves the compare.
        var item = Item(window, "Repositories");
        var point = item.TranslatePoint(new Point(12, 12), window)!.Value;
        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
        Assert.Null(shell.Compare);
        Assert.True(shell.ShowingRepositories);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_new_profile_starts_from_nothing_another_profile_or_a_repository(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var window = await Show(theme, new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        Dispatcher.UIThread.RunJobs();

        var start = window.GetVisualDescendants().OfType<Button>()
            .Single(button => button.Content as string == "New profile" && button.IsEffectivelyVisible);
        start.Command!.Execute(start.CommandParameter);
        Dispatcher.UIThread.RunJobs();
        var nameBox = window.GetVisualDescendants().OfType<TextBox>()
            .Single(box => AutomationProperties.GetName(box) == "Profile name");
        Assert.Same(nameBox, window.FocusManager?.GetFocusedElement());
        var form = shell.Profiles.Creating!;
        form.Name = "libraries";
        form.Captures = true;
        Dispatcher.UIThread.RunJobs();

        var text = Texts(window);
        Assert.Contains("Profiles / New profile", text);
        Assert.Contains("libraries.yaml", text);
        Assert.Contains("Capture", text);
        Assert.DoesNotContain("Save profile", text);
        var extends = window.GetVisualDescendants().OfType<RadioButton>()
            .Single(radio => radio.IsChecked != true && ControlAutomationPeer.CreatePeerForElement(radio).GetName() == "Another profile");
        Assert.Equal(
            "Extends it, so it gets every setting the other one sets.",
            ControlAutomationPeer.CreatePeerForElement(extends).GetHelpText());
        Save(window, $"new-profile-{theme}");

        // Going to another page and back keeps the form as it was.
        Click(window, "Repositories");
        Assert.True(shell.ShowingRepositories);
        Click(window, "Profiles");
        Assert.Same(form, shell.Profiles.Creating);
        Assert.Contains("libraries.yaml", Texts(window));

        // So does Space on Profiles from another page, which selects it before the key reaches the app.
        Click(window, "Repositories", x: 60);
        Item(window, "Profiles").Focus();
        window.KeyPressQwerty(PhysicalKey.Space, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.True(shell.ShowingProfiles);
        Assert.Same(form, shell.Profiles.Creating);

        // Choosing Profiles again, while it is selected, leaves the form: by click, Enter or Space.
        // The click lands apart from the last one, which would otherwise make a double click.
        Click(window, "Profiles", x: 60);
        Assert.Null(shell.Profiles.Creating);
        Assert.Equal("Profiles / base", shell.Crumb);
        foreach (var key in new[] { PhysicalKey.Enter, PhysicalKey.Space })
        {
            shell.Profiles.StartNew(null);
            Dispatcher.UIThread.RunJobs();
            Item(window, "Profiles").Focus();
            window.KeyPressQwerty(key, RawInputModifiers.None);
            Dispatcher.UIThread.RunJobs();
            Assert.Null(shell.Profiles.Creating);
        }
    }

    private static ListBoxItem Item(Window window, string name) =>
        window.GetVisualDescendants().OfType<ListBoxItem>()
            .Single(candidate => AutomationProperties.GetName(candidate) == name);

    private static void Click(Window window, string name, double x = 12)
    {
        var point = Item(window, name).TranslatePoint(new Point(x, 12), window)!.Value;
        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public async Task A_new_folder_the_app_cannot_remember_says_so()
    {
        var other = Path.Combine(folders.Profiles, "other");
        Directory.CreateDirectory(other);
        var window = await Show("light", new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", Documents.Repositories)
            .On(folders.List(other), Documents.NoProfiles), new FakeDesktop { Folder = other });
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        // A directory where the settings file goes makes every save fail.
        File.Delete(Path.Combine(folders.SettingsFolder, "settings.json"));
        Directory.CreateDirectory(Path.Combine(folders.SettingsFolder, "settings.json"));

        await shell.Profiles.ChangeFolderCommand.ExecuteAsync(null);

        var text = Texts(window);
        Assert.Contains($"No profiles in {other} yet.", text);
        Assert.Contains(text, line => line.StartsWith("Repotted could not remember this folder", StringComparison.Ordinal));
        Assert.Empty(Directory.GetFiles(folders.SettingsFolder));
    }

    private async Task<Window> Show(string theme, FakeCli cli, FakeDesktop? desktop = null)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        if (!cli.Answers(folders.List()))
        {
            cli.On(folders.List(), Documents.NoProfiles);
        }
        var main = new MainViewModel(new RepottedClient(cli), desktop ?? new FakeDesktop(), folders.Settings);
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
