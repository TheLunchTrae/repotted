using Avalonia.Headless.XUnit;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>The settings: a page at the foot of the sidebar, or a window of their own on macOS.</summary>
public sealed class SettingsTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task The_settings_page_takes_the_sidebar_selection_and_gives_it_back()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.SettingsInWindow = false;
        Assert.Equal(0, shell.NavPage);
        Assert.Equal(-1, shell.SettingsNavPage);

        shell.SettingsNavPage = 0;

        Assert.True(shell.ShowingSettings);
        Assert.False(shell.ShowingRepositories);
        Assert.False(shell.ShowingProfiles);
        Assert.Equal(-1, shell.NavPage);
        Assert.Equal(0, shell.SettingsNavPage);
        Assert.Equal("Settings", shell.Crumb);
        Assert.Equal("Settings", shell.SettingsLabel);

        // The list deselecting its entry as the page changes changes nothing.
        shell.NavPage = -1;
        Assert.True(shell.ShowingSettings);
        shell.NavPage = 1;
        Assert.True(shell.ShowingProfiles);
        Assert.Equal(-1, shell.SettingsNavPage);
        shell.SettingsNavPage = -1;
        Assert.True(shell.ShowingProfiles);
    }

    [AvaloniaFact]
    public async Task On_macOS_the_settings_ask_for_their_window_and_leave_the_page_as_it_is()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.SettingsInWindow = true;
        shell.Page = 1;
        var asked = 0;
        shell.SettingsWindowRequested += (_, _) => asked++;

        shell.OpenSettingsCommand.Execute(null);

        Assert.Equal(1, asked);
        Assert.True(shell.ShowingProfiles);
        Assert.Equal("Settings…", shell.SettingsLabel);
        Assert.Equal("Account", shell.SettingsTitle);
    }

    [AvaloniaFact]
    public async Task Choosing_a_repository_for_the_profiles_opens_it_in_the_settings()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.SettingsInWindow = true;
        shell.Page = 1;
        var asked = 0;
        shell.SettingsWindowRequested += (_, _) => asked++;

        await shell.Profiles.StartConnectCommand.ExecuteAsync(null);

        Assert.NotNull(shell.Profiles.Connecting);
        Assert.Equal(1, asked);
        Assert.Equal(1, shell.SettingsTab);
        Assert.Equal("Profiles", shell.SettingsTitle);

        // The profiles page leads to it too while the form is open.
        shell.Profiles.ShowSettingsCommand.Execute(null);
        Assert.Equal(2, asked);

        shell.SettingsInWindow = false;
        shell.Profiles.ShowSettingsCommand.Execute(null);
        Assert.True(shell.ShowingSettings);
    }

    [AvaloniaFact]
    public async Task Choosing_the_settings_again_keeps_them_open()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.SettingsInWindow = false;

        shell.OpenSettings();
        shell.ShowPage(ShellViewModel.SettingsPage);

        Assert.True(shell.ShowingSettings);
        shell.ShowPage(0);
        Assert.True(shell.ShowingSettings);
    }
}
