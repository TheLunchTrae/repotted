using Avalonia;
using Avalonia.Automation;
using Avalonia.Automation.Peers;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.LogicalTree;
using Avalonia.Media;
using Avalonia.Styling;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;
using Repotted.Desktop.Views;
using static Repotted.Desktop.Tests.Helpers;

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
        var window = await Show(theme, FakeCli.SignedIn());

        var text = Texts(window);
        Assert.Contains("Repositories", text);
        Assert.Contains("repotted", text);
        Assert.Contains("test-repo", text);
        Assert.Contains("TheLunchTrae/github-setup", text);
        Assert.Contains("No profile", text);
        Assert.Contains(ControlLabel.For("Add repositories"), text);
        Assert.Contains(ControlLabel.For("Sign out"), text);
        Save(window, $"repositories-{theme}");
    }

    [AvaloniaFact]
    public async Task Screen_readers_hear_each_repository_by_name()
    {
        var window = await Show("light", FakeCli.SignedIn());

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

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_repository_list_is_grouped_by_owner_and_filtered_by_owner(string theme)
    {
        var window = await Show(theme, new FakeCli().On("status --json", Documents.SignedIn).On("repos --json", Documents.OwnedRepositories));
        var repositories = ((ShellViewModel)((MainViewModel)window.DataContext!).Page!).Repositories;

        var text = Texts(window);
        Assert.Contains("TheLunchTrae", text);
        Assert.Contains("Personal", text);
        Assert.Contains("lunchbox-labs", text);
        Assert.Contains(ControlLabel.For("All owners"), text);
        Save(window, $"repositories-owners-{theme}");

        var owners = window.GetVisualDescendants().OfType<Button>().Single(button => button.Classes.Contains("owners"));
        owners.Flyout!.ShowAt(owners);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("Show repositories owned by", Texts(window));
        Save(window, $"repositories-owner-filter-{theme}");

        // Unticking an owner's box hides its repositories.
        var pixel = ((Flyout)owners.Flyout).Content is Control content
            ? content.GetLogicalDescendants().OfType<CheckBox>().Single(box => box.DataContext is OwnerChoice { Owner: "Pixel-Garden" })
            : throw new InvalidOperationException();
        pixel.IsChecked = false;
        Dispatcher.UIThread.RunJobs();
        Assert.DoesNotContain(repositories.Rows, row => row.Owner == "Pixel-Garden");
        Assert.Equal(ControlLabel.For("2 owners"), repositories.OwnersLabel);

        repositories.ShowOnlyPersonalCommand.Execute(null);
        owners.Flyout.Hide();
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("2 of 5", Texts(window));
        Save(window, $"repositories-personal-{theme}");
    }

    [AvaloniaFact]
    public async Task Owner_headings_are_read_out_and_never_selected()
    {
        var window = await Show("light", new FakeCli().On("status --json", Documents.SignedIn).On("repos --json", Documents.OwnedRepositories));
        var repositories = ((ShellViewModel)((MainViewModel)window.DataContext!).Page!).Repositories;
        var list = window.GetVisualDescendants().OfType<ListBox>().Single(box => box.Name == "List");

        var headings = window.GetVisualDescendants().OfType<ListBoxItem>().Where(item => item.DataContext is OwnerHeading).ToList();
        Assert.Equal(
            ["TheLunchTrae, personal, 2 repositories", "lunchbox-labs, 2 repositories", "Pixel-Garden, 1 repository"],
            headings.Select(item => ControlAutomationPeer.CreatePeerForElement(item).GetName()));
        Assert.All(headings, item => Assert.False(item.IsEnabled));

        // Select all takes every repository and no heading.
        list.Focus();
        list.SelectAll();
        Dispatcher.UIThread.RunJobs();
        Assert.DoesNotContain(list.Selection.SelectedItems, item => item is OwnerHeading);
        Assert.Equal(5, repositories.Chosen.Count);
        Assert.True(repositories.Choosing);

        // Hiding an owner lets go of its repositories only; the rest stay chosen for the batch.
        repositories.Owners.Single(owner => owner.Owner == "Pixel-Garden").Shown = false;
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(4, repositories.Chosen.Count);
        Assert.DoesNotContain(repositories.Chosen, row => row.Owner == "Pixel-Garden");

        // So does the search.
        repositories.Filter = "co";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["lunchbox-labs/compasslet"], repositories.Chosen.Select(row => row.FullName));
        Assert.Equal("lunchbox-labs/compasslet", repositories.Selected?.FullName);
    }

    [AvaloniaFact]
    public async Task The_search_shortcut_works_before_anything_has_focus()
    {
        var window = await Show("light", FakeCli.SignedIn());
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

        var text = Texts(window);
        Assert.Contains("ABCD-1234", text);
        Assert.Contains("Copy", text);
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
        Assert.Contains(ControlLabel.For("Cancel"), text);
        Assert.DoesNotContain(ControlLabel.For("Sign in with GitHub"), text);
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
        Assert.DoesNotContain(ControlLabel.For("Sign in with GitHub"), text);
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
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);

        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var projects = shell.Profiles.Current!.Tabs[0].Groups.SelectMany(group => group.Settings).Single(setting => setting.Key == "has_projects");
        projects.Options.Single(option => option.Label == "Off").ChooseCommand.Execute(null);

        var text = Texts(window);
        Assert.Contains("Profiles / orgs", text);
        Assert.Contains("Extends base. Saved to orgs.yaml.", text);
        Assert.Contains("Set here", text);
        Assert.Contains("From base", text);
        Assert.Contains("Not managed", text);
        Assert.Contains("1 unsaved change", text);
        Assert.Contains(ControlLabel.For("Save profile"), text);
        Save(window, $"profile-{theme}");

        // Screen readers hear which option is chosen, and where the value comes from.
        var wiki = window.GetVisualDescendants().OfType<ToggleButton>()
            .Where(toggle => AutomationProperties.GetName(toggle)?.StartsWith("Wiki: ", StringComparison.Ordinal) == true)
            .Select(toggle => (Name: AutomationProperties.GetName(toggle), toggle.IsChecked, Help: AutomationProperties.GetHelpText(toggle)));
        Assert.Equal([("Wiki: On", (bool?)false, "Set here"), ("Wiki: Off", true, "Set here")], wiki);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_settings_tabs_show_sub_options_notes_and_typed_values(string theme)
    {
        var @base = folders.Write("base.yaml", "security:\n  vulnerability_alerts: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository:\n  has_wiki: true\n  pull_request_creation_cap:\n    enabled: true\n    max_open_pull_requests: 3\npages:\n  build_type: legacy\n  source:\n    branch: main\n");
        var resolved = $$$"""
            {"chain":[{{{Json(own)}}},{{{Json(@base)}}}],
             "profile":{
               "repository":{"has_wiki":true,"pull_request_creation_cap":{"enabled":true,"max_open_pull_requests":3}},
               "security":{"vulnerability_alerts":true,"security_and_analysis":{"secret_scanning":{"status":"enabled"} },
                 "code_scanning_default_setup":{"runner_type":"standard","runner_label":null} },
               "pages":{"build_type":"legacy","source":{"branch":"main"} } },
             {{{Documents.NoDrafts}}},
             "sources":{
               "repository":{"has_wiki":{{{Json(own)}}},"pull_request_creation_cap.enabled":{{{Json(own)}}},
                 "pull_request_creation_cap.max_open_pull_requests":{{{Json(own)}}} },
               "merge":{},"actions":{},
               "security":{"vulnerability_alerts":{{{Json(@base)}}},"security_and_analysis.secret_scanning":{{{Json(own)}}},
                 "code_scanning_default_setup.runner_type":{{{Json(own)}}},"code_scanning_default_setup.runner_label":{{{Json(own)}}} },
               "custom_properties":{},
               "pages":{"build_type":{{{Json(own)}}},"source.branch":{{{Json(own)}}} },
               "autolinks":{},"rulesets":{},"environments":{},"labels":{},
               {{{Documents.NoDraftSources}}} } }
            """;
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        window.Height = 1500;
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;

        var text = Texts(window);
        Assert.Contains("Restricting editing to collaborators has no API, so it is set on GitHub only.", text);
        Assert.Contains("Who can create pull requests", text);
        var limit = window.GetVisualDescendants().OfType<TextBox>()
            .Single(box => AutomationProperties.GetName(box) == "Open pull requests allowed");
        Assert.Equal("3", limit.Text);
        Save(window, $"settings-repository-{theme}");

        editor.SelectedTab = editor.Tab("Security");
        text = Texts(window);
        Assert.Contains("Malware alerts, Dependabot rules, and preventing direct dismissals have no API here, so they are set on GitHub or in a security configuration.", text);
        Assert.Contains("From base", text);
        Assert.Contains("Used only with labeled runners. Leave it empty for no label.", text);
        // Standard runners use no label, so the box is off.
        var label = window.GetVisualDescendants().OfType<TextBox>()
            .Single(box => box.DataContext is SettingViewModel { Key: "code_scanning_default_setup.runner_label" });
        Assert.False(label.IsEnabled);
        Assert.True(string.IsNullOrEmpty(label.Text));
        Save(window, $"settings-security-{theme}");

        editor.SelectedTab = editor.Tab("Actions");
        Save(window, $"settings-actions-{theme}");

        editor.SelectedTab = editor.Tab("Pages");
        var branch = editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "source.branch");
        branch.Typed = "";
        text = Texts(window);
        Assert.Contains("Enter a value, or remove the setting from this profile.", text);
        Save(window, $"settings-pages-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_tab_leaves_out_what_a_setting_that_is_off_hides_and_lists_action_patterns(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: {}\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nactions:\n  enabled: false\n");
        var resolved = $$$"""
            {"chain":[{{{Json(own)}}},{{{Json(@base)}}}],
             "profile":{"actions":{"enabled":false,"allowed_actions":"selected",
               "selected_actions":{"github_owned_allowed":true,"patterns_allowed":["octo-org/*","!octo-org/old@*"]},
               "fork_pr_workflows_private_repos":{"run_workflows_from_fork_pull_requests":false} } },
             {{{Documents.NoDrafts}}},
             "sources":{
               "repository":{},"merge":{},
               "actions":{"enabled":{{{Json(own)}}},"allowed_actions":{{{Json(own)}}},
                 "selected_actions.github_owned_allowed":{{{Json(own)}}},"selected_actions.patterns_allowed":{{{Json(own)}}},
                 "fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests":{{{Json(own)}}} },
               "security":{},"custom_properties":{},"pages":{},"autolinks":{},"rulesets":{},"environments":{},"labels":{},
               {{{Documents.NoDraftSources}}} } }
            """;
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        window.Height = 1500;
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.SelectedTab = editor.Tab("Actions");

        // Actions off: the tab leaves out what it hides, and says the profile still names some of it.
        var text = Texts(window);
        Assert.DoesNotContain("Allowed actions", text);
        Assert.DoesNotContain("Allowed action patterns", text);
        Assert.Contains("This profile still names 3 settings hidden under it.", text);
        // What GitHub greys out shows off, with why.
        Assert.Contains("Off while Run workflows from fork pull requests is set to Off.", text);
        Save(window, $"settings-actions-off-{theme}");

        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "enabled")
            .Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);
        text = Texts(window);
        Assert.Contains("Allowed actions", text);
        var patterns = window.GetVisualDescendants().OfType<TextBox>()
            .Single(box => AutomationProperties.GetName(box) == "Allowed action patterns");
        Assert.Equal(("octo-org/*\n!octo-org/old@*", true, true), (patterns.Text, patterns.AcceptsReturn, patterns.IsEnabled));
        Save(window, $"settings-actions-selected-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_settings_search_shows_what_it_found_on_every_tab(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\nmerge:\n  allow_rebase_merge: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository:\n  has_wiki: false\nmerge:\n  allow_squash_merge: false\n");
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        window.Height = 1100;
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        Dispatcher.UIThread.RunJobs();
        var search = window.GetVisualDescendants().OfType<TextBox>().Single(box => box.Name == "SettingsSearch");

        // The shortcut moves to the search, and Escape clears it.
        window.KeyPressQwerty(PhysicalKey.F, OperatingSystem.IsMacOS() ? RawInputModifiers.Meta : RawInputModifiers.Control);
        Dispatcher.UIThread.RunJobs();
        Assert.True(search.IsFocused);
        window.KeyTextInput("merge");
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("merge", editor.Query);

        var text = Texts(window);
        Assert.Contains("Merge methods", text);
        Assert.Contains("Delete head branches after merge", text);
        Assert.DoesNotContain(ControlLabel.For("Rulesets"), text);
        Assert.Contains(ControlLabel.For("Clear"), text);
        Save(window, $"settings-search-{theme}");

        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("", editor.Query);
        Assert.Contains(ControlLabel.For("Rulesets"), Texts(window));

        editor.OnlyManaged = true;
        text = Texts(window);
        Assert.Contains("4 settings found.", text);
        Assert.Contains("Allow rebase merging", text);
        Assert.DoesNotContain("Projects", text);
        Save(window, $"settings-managed-{theme}");

        editor.OnlyManaged = false;
        editor.Query = "nothing like this";
        Assert.Contains("No settings match \u201cnothing like this\u201d.", Texts(window));
        Save(window, $"settings-search-empty-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_save_over_a_changed_file_asks_which_version_to_keep(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrulesets:\n  - name: Old tags\n    absent: true\nenvironments:\n  - name: npm\n");
        var cli = FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show(theme, cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.SelectedTab = editor.Tab("Environments");
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        File.AppendAllText(own, "# pulled by a sync\n");

        await editor.SaveCommand.ExecuteAsync(null);

        var text = Texts(window);
        Assert.Contains(editor.OutOfDateMessage, text);
        Assert.Contains(ControlLabel.For("Keep mine"), text);
        Assert.Contains(ControlLabel.For("Reload"), text);
        Save(window, $"profile-out-of-date-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Edits_to_a_removed_profile_stay_until_saved_or_discarded(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository:\n  has_wiki: false\n");
        var cli = FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show(theme, cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.Tabs[0].Groups.SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);
        File.Delete(own);
        cli.On(folders.List(), $$$"""{"profiles":[{"name":"base","file":{{{Json(@base)}}},"extends":null,"problem":null}]}""");

        await shell.Profiles.RefreshCommand.ExecuteAsync(null);

        var text = Texts(window);
        Assert.Contains(editor.RemovedMessage, text);
        Assert.Contains("Removed, edits not saved", text);
        Save(window, $"profile-removed-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Closing_the_window_with_unsaved_changes_asks_first(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrulesets:\n  - name: Old tags\n    absent: true\nenvironments:\n  - name: npm\n");
        var cli = FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show(theme, cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.SelectedTab = editor.Tab("Environments");
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        // Another page open, so the question brings the profiles back into view.
        shell.Page = 0;

        window.Close();

        var text = Texts(window);
        Assert.True(window.IsVisible);
        Assert.Equal(1, shell.Page);
        Assert.Contains("orgs has unsaved changes. Save them before you quit?", text);
        Assert.Contains("Save", text);
        Assert.Contains("Discard", text);
        Assert.Contains("Cancel", text);
        Save(window, $"profiles-leaving-{theme}");

        shell.Profiles.DiscardAndLeaveCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.IsVisible);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_profile_closes_on_its_shortcut_and_asks_first_about_unsaved_changes(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository:\n  has_wiki: false\n");
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        var modifier = OperatingSystem.IsMacOS() ? RawInputModifiers.Meta : RawInputModifiers.Control;
        Assert.Contains(ControlLabel.For("Close profile"), Texts(window));
        Save(window, $"profile-close-{theme}");

        // With nothing unsaved it closes at once, and focus stays on the page.
        var close = window.GetVisualDescendants().OfType<Button>().Single(button => button.Name == "CloseButton" && button.IsEffectivelyVisible);
        close.Focus();
        window.KeyPressQwerty(PhysicalKey.W, modifier);
        Dispatcher.UIThread.RunJobs();
        Assert.Null(shell.Profiles.Current);
        var text = Texts(window);
        Assert.Contains("Choose a profile in the list to edit it, or start a new one.", text);
        Assert.Equal("Profiles", shell.Crumb);
        Assert.Equal("NoneOpenNew", Assert.IsType<Button>(window.FocusManager?.GetFocusedElement()).Name);
        Save(window, $"profiles-none-open-{theme}");

        // With unsaved changes it asks first, about that profile.
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        Assert.Same(editor, shell.Profiles.Current);
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki")
            .Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);
        window.KeyPressQwerty(PhysicalKey.W, modifier);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("orgs has unsaved changes. Save them before you close it?", Texts(window));
        Save(window, $"profile-closing-{theme}");
        // The shortcut waits while the close it started still asks.
        var first = editor.CloseCommand.ExecutionTask!;
        window.KeyPressQwerty(PhysicalKey.W, modifier);
        Dispatcher.UIThread.RunJobs();
        Assert.False(first.IsCompleted);
        shell.Profiles.StayHereCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Same(editor, shell.Profiles.Current);
        Assert.True(editor.HasChanges);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_delete_shortcut_on_a_profile_asks_first_and_names_what_goes_with_it(string theme)
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show(theme, cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "base");
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(ControlLabel.For("Delete profile"), Texts(window));

        // The list's own shortcut: Delete, or Command+Delete on macOS.
        window.GetVisualDescendants().OfType<ListBoxItem>().Single(item => item.DataContext == shell.Profiles.Selected).Focus();
        if (OperatingSystem.IsMacOS())
        {
            window.KeyPressQwerty(PhysicalKey.Backspace, RawInputModifiers.Meta);
        }
        else
        {
            window.KeyPressQwerty(PhysicalKey.Delete, RawInputModifiers.None);
        }

        var text = Texts(window);
        Assert.Contains("Delete base?", text);
        Assert.Contains(
            "This deletes base.yaml from the profiles folder, and it can't be undone. orgs extends it, so it stops loading until it extends another profile.",
            text);
        Assert.Contains(ControlLabel.For("Cancel"), text);
        Assert.True(File.Exists(@base));
        Save(window, $"profiles-delete-{theme}");
    }

    [AvaloniaFact]
    public async Task Closing_the_window_stays_on_cancel_or_a_failed_save_and_closes_once_saved()
    {
        var @base = folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrulesets:\n  - name: Old tags\n    absent: true\nenvironments:\n  - name: npm\n");
        var cli = FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show("light", cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.Tab("Environments").Entries[0].Editor.Name = "pages";
        var save = $$"""profile {{own}} --drop-environment=npm --environment={"name":"pages"} --json""";

        // Cancel keeps the window and the change.
        window.Close();
        shell.Profiles.StayHereCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(window.IsVisible);
        Assert.False(shell.Profiles.HasLeaving);
        Assert.True(editor.HasChanges);

        // A save that fails keeps the window open, with why.
        cli.On(save, """{"error":{"kind":"error","message":"The file could not be written"}}""", exitCode: 1);
        window.Close();
        await shell.Profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(window.IsVisible);
        Assert.Contains("could not be written", editor.SaveError, StringComparison.Ordinal);

        // A save that goes through closes it.
        cli.On(save, () =>
        {
            File.WriteAllText(own, "extends: base.yaml\nrulesets:\n  - name: Old tags\n    absent: true\nenvironments:\n  - name: pages\n");
            return Documents.Resolved(own, @base);
        });
        window.Close();
        await shell.Profiles.SaveAndLeaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.IsVisible);
        Assert.Contains(save, cli.Calls);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Labels_show_on_their_colors_and_open_in_an_editor(string theme)
    {
        var @base = folders.Write("base.yaml", "labels:\n  - name: good first issue\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        var resolved = $$$"""
            {"chain":[{{{Json(own)}}},{{{Json(@base)}}}],
             "profile":{
               "labels":[
                 {"name":"type: feature","color":"a2eeef","description":"New feature or request","renamed_from":["enhancement"]},
                 {"name":"type: bug","color":"d73a4a","description":"Something isn't working"},
                 {"name":"wontfix","absent":true},
                 {"name":"good first issue","color":"7057ff","description":"Good for newcomers"}]},
             {{{Documents.NoDrafts}}},
             "sources":{"repository":{},"merge":{},"actions":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},
               "rulesets":{},"environments":{},
               "labels":{"type: feature":{{{Json(own)}}},"type: bug":{{{Json(own)}}},"wontfix":{{{Json(own)}}},"good first issue":{{{Json(@base)}}} },
               {{{Documents.NoDraftSources}}} } }
            """;
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.SelectedTab = editor.Tab("Labels");
        Dispatcher.UIThread.RunJobs();

        var rows = window.GetVisualDescendants().OfType<Button>()
            .Where(button => button.Classes.Contains("entry"))
            .Select(button => AutomationProperties.GetName(button))
            .ToList();
        Assert.Equal(
            [
                "type: feature: Renames enhancement where a repository still has it",
                "type: bug: Set here",
                "wontfix: Removed from GitHub here",
                "good first issue: From base",
            ],
            rows);
        // Each label shows on its own color, with text that reads on it.
        var chips = window.GetVisualDescendants().OfType<Border>()
            .Where(border => border.Classes.Contains("chip") && border.IsEffectivelyVisible)
            .Select(border => ((border.Background as ISolidColorBrush)?.Color.ToString(), ((TextBlock)border.Child!).Text))
            .ToList();
        Assert.Contains(("#ffa2eeef", "type: feature"), chips);
        Assert.Contains(("#ffd73a4a", "type: bug"), chips);
        Assert.Contains("Good for newcomers", Texts(window));
        Save(window, $"labels-{theme}");

        // A row opens its label, and a color from GitHub's colors shows in the preview.
        editor.Tab("Labels").Entries[1].OpenCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        var text = Texts(window);
        Assert.Contains(ControlLabel.For("Back to labels"), text);
        Assert.Contains("Renamed from", text);
        Assert.Contains("23 of 100 characters. Empty clears each repository's description.", text);
        var swatch = window.GetVisualDescendants().OfType<Button>().Single(button => AutomationProperties.GetName(button) == "Purple, 5319e7");
        swatch.Command!.Execute(swatch.CommandParameter);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("5319e7", window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "Label color").Text);
        Assert.Contains(swatch, window.GetVisualDescendants().OfType<Button>().Where(button => button.Classes.Contains("chosen")));
        Assert.Equal("Purple, 5319e7, chosen", AutomationProperties.GetName(swatch));
        var label = (LabelEditorViewModel)editor.Tab("Labels").Editing!.Editor;
        label.Name = "type: defect";
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(ControlLabel.For("Rename it on GitHub too"), Texts(window));
        Assert.Contains(window.GetVisualDescendants().OfType<Button>(), button => AutomationProperties.GetHelpText(button) == "Lists type: bug in Renamed from, so applying renames type: bug on each repository.");
        window.Height = 1200;
        Save(window, $"label-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Rulesets_and_environments_open_in_an_editor(string theme)
    {
        var @base = folders.Write("base.yaml", "rulesets:\n  - name: Tags\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        var resolved = $$$"""
            {"chain":[{{{Json(own)}}},{{{Json(@base)}}}],
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
             {{{Documents.NoDrafts}}},
             "sources":{"repository":{},"merge":{},"actions":{},"security":{},"custom_properties":{},"pages":{},"autolinks":{},
               "rulesets":{"Main":{{{Json(own)}}},"Tags":{{{Json(@base)}}} },
               "environments":{"npm":{{{Json(own)}}} },"labels":{},
               {{{Documents.NoDraftSources}}} } }
            """;
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", resolved)
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        editor.SelectedTab = editor.Tab("Rulesets");

        var text = Texts(window);
        Assert.Contains(ControlLabel.For("New ruleset"), text);
        var rows = window.GetVisualDescendants().OfType<Button>()
            .Where(button => button.Classes.Contains("entry"))
            .Select(button => AutomationProperties.GetName(button))
            .ToList();
        Assert.Equal(["Main: Set here", "Tags: From base"], rows);
        Assert.Contains("Main", text);
        Assert.DoesNotContain(text, line => line.Contains("Avalonia.Controls", StringComparison.Ordinal));
        Save(window, $"rulesets-{theme}");

        // A row opens its ruleset with focus on its name, and every choice says what it leaves to GitHub.
        window.GetVisualDescendants().OfType<Button>().First(button => AutomationProperties.GetName(button) == "Main: Set here").Focus();
        window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        var main = (RulesetEditorViewModel)editor.Tab("Rulesets").Editing!.Editor;
        var nameBox = window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "Ruleset name");
        Assert.Same(nameBox, window.FocusManager?.GetFocusedElement());

        // Moving between tabs shows the open editor again, and leaves focus on the tabs.
        window.GetVisualDescendants().OfType<ListBoxItem>().Single(item => item.DataContext == editor.Tab("Rulesets")).Focus();
        window.KeyPressQwerty(PhysicalKey.ArrowLeft, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        window.KeyPressQwerty(PhysicalKey.ArrowRight, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Same(editor.Tab("Rulesets"), editor.SelectedTab);
        Assert.IsType<ListBoxItem>(window.FocusManager?.GetFocusedElement());
        main.Enforcement.Options[1].ChooseCommand.Execute(null);
        text = Texts(window);
        Assert.Contains(ControlLabel.For("Back to rulesets"), text);
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
        editor.Tab("Rulesets").BackCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Main: Changed, not saved yet", AutomationProperties.GetName((Control)window.FocusManager!.GetFocusedElement()!));
        editor.Tab("Rulesets").Entries[1].OpenCommand.Execute(null);
        Assert.Contains("A base profile names this one, so this profile keeps its name and sets the rest.", Texts(window));
        Assert.True(window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "Ruleset name").IsReadOnly);

        editor.SelectedTab = editor.Tab("Environments");
        editor.Tab("Environments").Entries[0].OpenCommand.Execute(null);
        text = Texts(window);
        Assert.Contains(ControlLabel.For("Back to environments"), text);
        Assert.Contains("Which ones", text);
        Assert.Equal(
            "main",
            window.GetVisualDescendants().OfType<TextBox>().Single(box => AutomationProperties.GetName(box) == "Branches that may deploy").Text);
        Save(window, $"environment-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Drafts_show_with_a_badge_under_their_setting_and_in_the_list(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\n");
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.ResolvedWithDrafts(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");
        var editor = shell.Profiles.Current!;
        editor.ShowYaml = false;
        var wiki = editor.Tabs[0].Groups.SelectMany(group => group.Settings).Single(setting => setting.Key == "has_wiki");
        wiki.Options.Single(option => option.Label == "On").ChooseCommand.Execute(null);

        var text = Texts(window);
        Assert.Contains("What the drafts still need", text);
        Assert.Contains("Draft environment \"NPM\": Invalid input at wait_timer", text);
        Assert.Contains(ControlLabel.For("Save as draft"), text);
        Assert.Contains("Draft", text);
        Assert.Contains(" · Saved in base, not applied.", text);
        Assert.DoesNotContain(ControlLabel.For("Finish draft"), text);
        wiki.SaveAsDraftCommand.Execute(null);
        text = Texts(window);
        Assert.Contains(ControlLabel.For("Finish draft"), text);
        Assert.Contains(ControlLabel.For("Discard draft"), text);
        var drafts = window.GetVisualDescendants().OfType<TextBlock>()
            .Select(block => AutomationProperties.GetName(block))
            .Where(name => name?.Contains(" draft: ", StringComparison.Ordinal) == true);
        Assert.Contains("Wiki draft: On. Saved as a draft when you save. It applies once you finish it.", drafts);
        window.Height = 1100;
        Save(window, $"drafts-settings-{theme}");

        editor.SelectedTab = editor.Tab("Rulesets");
        Dispatcher.UIThread.RunJobs();
        var rows = window.GetVisualDescendants().OfType<Button>()
            .Where(button => button.Classes.Contains("entry"))
            .Select(button => AutomationProperties.GetName(button))
            .ToList();
        Assert.Equal(
            ["Protect main: From base", "Old tags: Removed from GitHub here", "Later: Draft, left out of compare and apply", "Protect main: Draft, left out of compare and apply"],
            rows);
        Save(window, $"drafts-rulesets-{theme}");

        editor.Tab("Rulesets").Entries[3].OpenCommand.Execute(null);
        text = Texts(window);
        Assert.Contains("Save as a draft", text);
        Assert.Contains("Saved as a draft: compare and apply leave it out, and it may be unfinished. Turn this off to finish it, once it is valid.", text);
        Save(window, $"drafts-ruleset-{theme}");

        // A base's ruleset can be made a draft only in the base.
        editor.Tab("Rulesets").Editing = null;
        editor.Tab("Rulesets").Entries[0].OpenCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        var box = window.GetVisualDescendants().OfType<CheckBox>().Single(check => Equals(check.Content, "Save as a draft"));
        Assert.False(box.IsEnabled);
        Assert.Contains("Set in a base profile, so it can be saved as a draft only there.", Texts(window));
        Save(window, $"drafts-base-ruleset-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task An_empty_profiles_folder_says_what_a_profile_is(string theme)
    {
        var window = await Show(theme, FakeCli.SignedIn());
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);

        shell.Page = 1;

        var text = Texts(window);
        Assert.Contains($"No profiles in {folders.Profiles} yet.", text);
        Assert.Contains(ControlLabel.For("Choose a folder"), text);
        Save(window, $"profiles-empty-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_compare_shows_what_the_profile_would_change(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var window = await Show(theme, FakeCli.SignedIn()
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
        Assert.Contains(ControlLabel.For("Back to repositories"), text);
        Assert.DoesNotContain("Issues", text);
        // Nothing is locked, so the filter for what Repotted can't change isn't offered.
        Assert.DoesNotContain(ControlLabel.For("Can't change"), text);
        Save(window, $"compare-{theme}");

        // The find shortcut goes to this page's search, not the profile editor's, which the shell also keeps.
        var search = window.GetVisualDescendants().OfType<TextBox>().Single(box => box.Name == "CompareSearch");
        window.KeyPressQwerty(PhysicalKey.F, OperatingSystem.IsMacOS() ? RawInputModifiers.Meta : RawInputModifiers.Control);
        Dispatcher.UIThread.RunJobs();
        Assert.True(search.IsFocused);

        // A search finds rows by what the setting is about, and turning off the differences filter adds what matches.
        var compare = shell.Compare!;
        compare.Query = "merg";
        text = Texts(window);
        Assert.Contains("Allow squash merging", text);
        Assert.DoesNotContain("Default permissions", text);
        Save(window, $"compare-search-{theme}");
        compare.DifferencesOnly = false;
        Assert.Contains("Allow rebase merging", Texts(window));
        Save(window, $"compare-search-everything-{theme}");
        // Escape clears the search and leaves the filter as it is.
        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("", compare.Query);
        Assert.False(compare.DifferencesOnly);
        compare.DifferencesOnly = true;

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
    public async Task A_compare_shows_what_Repotted_cannot_change_and_where_to_grant_it(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var desktop = new FakeDesktop();
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base))
            .On($"plan TheLunchTrae/repotted --profile {own} --json", Documents.Plan(
                access: Documents.ActionsRead,
                locks: """{"change":5,"reason":"Needs Actions write"}""",
                changes: Documents.Oidc)), desktop);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        var repositories = shell.Repositories;
        repositories.Selected = repositories.Rows.Single(row => row.Name == "repotted");
        repositories.CompareWith = shell.Profiles.Usable.Single(item => item.Name == "orgs");
        repositories.CompareCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();

        var text = Texts(window);
        Assert.Contains("Repotted can't change 2 differences below. Each says what it needs.", text);
        Assert.Contains(ControlLabel.For("Review App access"), text);
        Assert.Contains("Needs Actions write", text);
        // A compare's rows offer nothing to leave out; that is the apply's.
        Assert.DoesNotContain(ControlLabel.For("Leave out"), text);
        Save(window, $"compare-locked-{theme}");

        // The count of what Repotted can't change is read out when it changes, as after granting access and comparing again.
        var locks = window.GetVisualDescendants().OfType<TextBlock>()
            .Single(block => block.IsEffectivelyVisible && block.Text == "Repotted can't change 2 differences below. Each says what it needs.");
        Assert.Equal(AutomationLiveSetting.Polite, AutomationProperties.GetLiveSetting(locks));

        // The filter for what Repotted can't change shows only the locked rows.
        Assert.Contains(ControlLabel.For("Can't change"), text);
        shell.Compare!.LockedOnly = true;
        text = Texts(window);
        Assert.Contains("Use the default subject claim", text);
        Assert.DoesNotContain("Default permissions", text);
        Save(window, $"compare-locked-only-{theme}");
        shell.Compare.LockedOnly = false;

        var names = window.GetVisualDescendants().OfType<ListBoxItem>()
            .Select(item => ControlAutomationPeer.CreatePeerForElement(item).GetName())
            .ToList();
        Assert.Contains(names, name => name.EndsWith(". Repotted can't change it: Needs Actions write", StringComparison.Ordinal));
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task A_new_profile_starts_from_nothing_another_profile_or_a_repository(string theme)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var window = await Show(theme, FakeCli.SignedIn()
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
        Assert.Contains($"Profiles / {ControlLabel.For("New profile")}", text);
        Assert.Contains("libraries.yaml", text);
        Assert.Contains(ControlLabel.For("Capture"), text);
        Assert.DoesNotContain(ControlLabel.For("Save profile"), text);
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

    [AvaloniaFact]
    public async Task A_capture_under_way_locks_the_name_and_where_it_starts_from()
    {
        var finish = new TaskCompletionSource();
        var window = await Show("light", FakeCli.SignedIn()
            .On(folders.List(), Documents.NoProfiles)
            .OnCapture("TheLunchTrae/repotted", async (_, _) =>
            {
                await finish.Task;
                return """{"error":{"kind":"error","message":"Not Found"}}""";
            }));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        shell.Profiles.StartNew("TheLunchTrae/repotted");
        Dispatcher.UIThread.RunJobs();
        var nameBox = window.GetVisualDescendants().OfType<TextBox>()
            .Single(box => AutomationProperties.GetName(box) == "Profile name");
        var starts = window.GetVisualDescendants().OfType<RadioButton>().ToList();
        Assert.True(nameBox.IsEffectivelyEnabled);

        var capturing = shell.Profiles.Creating!.CreateCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();

        Assert.False(nameBox.IsEffectivelyEnabled);
        Assert.All(starts, start => Assert.False(start.IsEffectivelyEnabled));
        finish.SetResult();
        await capturing;
        Dispatcher.UIThread.RunJobs();
        Assert.True(nameBox.IsEffectivelyEnabled);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task The_repository_form_explains_what_syncing_does(string theme)
    {
        folders.Write("base.yaml", "repository:\n  has_issues: true\n");
        var file = Path.Combine(folders.Profiles, "base.yaml");
        var window = await Show(theme, FakeCli.SignedIn()
            .On(folders.List(), $$"""{"profiles":[{"name":"base","file":{{Json(file)}},"extends":null,"problem":null}]}""")
            .On($"profile {file} --json", Documents.ResolvedBase(file)));
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;

        shell.Profiles.StartConnectCommand.Execute(null);
        shell.Profiles.Connecting!.Repository = "TheLunchTrae/repotted-config";

        var text = Texts(window);
        Assert.Contains(ControlLabel.For("Keep profiles on GitHub"), text);
        Assert.Contains($"Add the profiles from {folders.Profiles}", text);
        Assert.Contains(ControlLabel.For("Use this repository"), text);
        Save(window, $"config-repository-form-{theme}");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Themes))]
    public async Task Synced_profiles_say_where_they_live_and_ask_about_a_conflict(string theme)
    {
        var copy = folders.Settings.ConfigFolder("TheLunchTrae/repotted-config", "");
        Directory.CreateDirectory(copy);
        File.WriteAllText(Path.Combine(copy, ".repotted-sync.json"), "{}");
        var @base = Path.Combine(copy, "base.yaml");
        var own = Path.Combine(copy, "orgs.yaml");
        File.WriteAllText(@base, "repository:\n  has_issues: true\nmerge:\n  allow_rebase_merge: true\n");
        File.WriteAllText(own, "extends: base.yaml\nrepository:\n  has_wiki: false\n");
        folders.Settings.Save(folders.Settings.Load() with { ConfigRepository = "TheLunchTrae/repotted-config", ConfigPath = "" });
        var cli = FakeCli.SignedIn()
            .On($"sync {copy} --json", """{"repository":"TheLunchTrae/repotted-config","path":"","branch":"main","commit":"abc","pulled":[],"pushed":[],"conflicts":["orgs.yaml"]}""", exitCode: 1)
            .On(folders.List(copy), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var window = await Show(theme, cli);
        var shell = Assert.IsType<ShellViewModel>(((MainViewModel)window.DataContext!).Page);
        shell.Page = 1;
        await shell.Profiles.RefreshCommand.ExecuteAsync(null);
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");

        var text = Texts(window);
        Assert.Contains("GitHub repository:", text);
        Assert.Contains("TheLunchTrae/repotted-config", text);
        Assert.Contains("orgs.yaml changed here and on GitHub since the last sync. Keep which version?", text);
        Assert.Contains(ControlLabel.For("Keep mine"), text);
        Assert.Contains(ControlLabel.For("Use GitHub's"), text);
        Assert.Contains(ControlLabel.For("Sync now"), text);
        Assert.Contains("In this repository", text);
        Assert.Contains("Everything else is in sync with main.", text);
        Save(window, $"config-repository-conflict-{theme}");

        // A ruleset that turns the commit away says what to change, under the list.
        cli.On(
            $"sync {copy} --json",
            """{"error":{"kind":"error","message":"GitHub refused the commit to main in TheLunchTrae/repotted-config: Repository rule violations found. A ruleset or branch protection on main, such as one that requires pull requests, needs a bypass for you or the Repotted App."}}""",
            exitCode: 1);
        await shell.Profiles.RefreshCommand.ExecuteAsync(null);
        shell.Profiles.Selected = shell.Profiles.Items.Single(item => item.Name == "orgs");

        Assert.Contains(Texts(window), line => line.StartsWith("Not synced with GitHub. Saves stay on this computer until a sync works. GitHub refused the commit", StringComparison.Ordinal));
        Save(window, $"config-repository-refused-{theme}");
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
        var window = await Show("light", FakeCli.SignedIn()
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

    [AvaloniaFact]
    public void Buttons_show_their_label_in_the_platform_casing_and_checkboxes_do_not()
    {
        var button = new Button { Content = "Keep mine" };
        var option = new ToggleButton { Content = "Pull request title", Classes = { "seg" } };
        var box = new CheckBox { Content = "Keep mine" };
        var radio = new RadioButton { Content = "Keep mine" };
        var row = new TextBlock { Text = "Protect main" };
        var entry = new Button { Content = new Grid { Children = { row } } };
        var window = new Window { Content = new StackPanel { Children = { button, option, box, radio, entry } } };
        window.Show();
        Dispatcher.UIThread.RunJobs();

        // The theme's template; without it Fluent shows the text as written.
        Assert.NotNull(button.ContentTemplate);
        Assert.NotNull(option.ContentTemplate);
        Assert.Equal(ControlLabel.For("Keep mine"), Assert.IsType<AccessText>(button.Presenter?.Child).Text);
        Assert.Equal(ControlLabel.For("Pull request title"), Assert.IsType<AccessText>(option.Presenter?.Child).Text);
        Assert.Null(box.ContentTemplate);
        Assert.Null(radio.ContentTemplate);

        // A button whose content is a control shows that control, not its type name.
        Assert.Null(entry.ContentTemplate);
        Assert.True(row.IsEffectivelyVisible);
        Assert.Same(entry.Content, entry.Presenter?.Child);
    }

    private async Task<Window> Show(string theme, FakeCli cli, FakeDesktop? desktop = null)
    {
        Application.Current!.RequestedThemeVariant = theme == "dark" ? ThemeVariant.Dark : ThemeVariant.Light;
        if (!cli.Answers(folders.List()))
        {
            cli.On(folders.List(), Documents.NoProfiles);
        }
        var main = new MainViewModel(cli, desktop ?? new FakeDesktop(), folders.Settings);
        var window = new MainWindow { DataContext = main, Width = 1280, Height = 800 };
        window.Show();
        await main.StartAsync();
        Dispatcher.UIThread.RunJobs();
        return window;
    }
}
