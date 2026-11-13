using Avalonia.Headless.XUnit;
using Repotted.Desktop.Services;
using Repotted.Desktop.Theme;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>The repository list and the account it shows.</summary>
public sealed class RepositoriesTests : ViewModelTests
{
    [AvaloniaFact]
    public async Task Search_filters_the_list_and_keeps_the_selection()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var shell = Assert.IsType<ShellViewModel>(main.Page);
        shell.Repositories.Selected = shell.Repositories.Rows[1];

        shell.Search = "REPO";

        Assert.Equal(["TheLunchTrae/repotted", "TheLunchTrae/test-repo"], shell.Repositories.Rows.Select(row => row.FullName));
        Assert.Equal("TheLunchTrae/repotted", shell.Repositories.Selected?.FullName);

        shell.Search = "nothing like it";
        Assert.Empty(shell.Repositories.Rows);
        Assert.False(shell.Repositories.HasSelection);
        Assert.Equal(3, shell.Repositories.Count);
    }

    [AvaloniaFact]
    public async Task The_list_is_grouped_by_owner_with_the_signed_in_account_first()
    {
        var repositories = await Owned();

        Assert.Equal(
            ["TheLunchTrae (personal, 2)", "repotted", "test-repo", "lunchbox-labs (2)", "compasslet", "tool-inspector", "Pixel-Garden (1)", "site"],
            Listed(repositories));
        Assert.Equal(["TheLunchTrae", "lunchbox-labs", "Pixel-Garden"], repositories.Owners.Select(owner => owner.Owner));
        Assert.True(repositories.CanFilterOwners);
        Assert.False(repositories.OwnersFiltered);
        Assert.Equal(ControlLabel.For("All owners"), repositories.OwnersLabel);
        Assert.Equal("All 5", repositories.CountLabel);
        Assert.Equal("TheLunchTrae/repotted", repositories.Selected?.FullName);
    }

    [AvaloniaFact]
    public async Task One_owner_has_nothing_to_filter()
    {
        var main = App(FakeCli.SignedIn());
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.False(repositories.CanFilterOwners);
        Assert.Equal(["TheLunchTrae (personal, 3)", "github-setup", "repotted", "test-repo"], Listed(repositories));
    }

    [AvaloniaFact]
    public async Task Unticking_owners_hides_their_repositories_and_the_choice_is_remembered()
    {
        var repositories = await Owned();
        repositories.Selected = repositories.Rows.Single(row => row.Name == "compasslet");

        repositories.Owners.Single(owner => owner.Owner == "lunchbox-labs").Shown = false;

        Assert.Equal(["TheLunchTrae (personal, 2)", "repotted", "test-repo", "Pixel-Garden (1)", "site"], Listed(repositories));
        Assert.True(repositories.OwnersFiltered);
        Assert.Equal(ControlLabel.For("2 owners"), repositories.OwnersLabel);
        Assert.Equal("3 of 5", repositories.CountLabel);
        // The selected repository is hidden, so the first one shown is selected instead.
        Assert.Equal("TheLunchTrae/repotted", repositories.Selected?.FullName);
        Assert.Equal(["TheLunchTrae", "Pixel-Garden"], folders.Settings.Load().RepositoryOwners);

        repositories.Owners.Single(owner => owner.Owner == "TheLunchTrae").Shown = false;
        Assert.Equal("Pixel-Garden", repositories.OwnersLabel);

        // A new run starts from the remembered choice.
        var again = await Owned();
        Assert.Equal(["Pixel-Garden (1)", "site"], Listed(again));
        Assert.Equal([false, false, true], again.Owners.Select(owner => owner.Shown));

        again.Owners.Single(owner => owner.Owner == "Pixel-Garden").Shown = false;
        Assert.Empty(again.Rows);
        Assert.Equal(ControlLabel.For("No owners"), again.OwnersLabel);
        Assert.Equal("0 of 5", again.CountLabel);
        Assert.False(again.HasSelection);
    }

    [AvaloniaFact]
    public async Task Only_personal_and_show_all_choose_at_once()
    {
        var repositories = await Owned();

        repositories.ShowOnlyPersonalCommand.Execute(null);

        Assert.Equal(["TheLunchTrae (personal, 2)", "repotted", "test-repo"], Listed(repositories));
        Assert.Equal(ControlLabel.For("Personal"), repositories.OwnersLabel);
        Assert.Equal(["TheLunchTrae"], folders.Settings.Load().RepositoryOwners);

        repositories.ShowAllOwnersCommand.Execute(null);

        Assert.Equal(5, repositories.Rows.Count);
        Assert.True(repositories.Owners.All(owner => owner.Shown));
        Assert.Null(folders.Settings.Load().RepositoryOwners);
    }

    [AvaloniaFact]
    public async Task A_remembered_choice_with_no_owner_in_the_list_shows_every_owner()
    {
        folders.Settings.Save(folders.Settings.Load() with { RepositoryOwners = ["gone-org"] });

        var repositories = await Owned();

        Assert.Equal(5, repositories.Rows.Count);
        Assert.False(repositories.OwnersFiltered);
        // The choice stays as it was until the next one.
        Assert.Equal(["gone-org"], folders.Settings.Load().RepositoryOwners);
    }

    [AvaloniaFact]
    public async Task A_remembered_owner_that_comes_back_is_shown_again()
    {
        folders.Settings.Save(folders.Settings.Load() with { RepositoryOwners = ["thelunchtrae", "gone-org"] });

        var repositories = await Owned();

        // Logins ignore case, and an owner missing from the list doesn't count.
        Assert.Equal(["TheLunchTrae (personal, 2)", "repotted", "test-repo"], Listed(repositories));
        Assert.Equal(ControlLabel.For("Personal"), repositories.OwnersLabel);
    }

    [AvaloniaFact]
    public async Task The_search_and_the_owner_filter_work_together()
    {
        var repositories = await Owned();

        repositories.Filter = "t";

        // Each heading counts what matches, and an owner with nothing that matches has no heading.
        Assert.Equal(
            ["TheLunchTrae (personal, 2)", "repotted", "test-repo", "lunchbox-labs (2)", "compasslet", "tool-inspector", "Pixel-Garden (1)", "site"],
            Listed(repositories));

        repositories.Filter = "co";
        Assert.Equal(["lunchbox-labs (1)", "compasslet"], Listed(repositories));

        repositories.Owners.Single(owner => owner.Owner == "lunchbox-labs").Shown = false;
        Assert.Empty(repositories.Items);
        Assert.Equal("3 of 5", repositories.CountLabel);
    }

    [AvaloniaFact]
    public async Task Another_account_has_no_personal_repositories()
    {
        var main = App(new FakeCli().On("status --json", Documents.SignedInAsOther).On("repos --json", Documents.OwnedRepositories));
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.False(repositories.HasPersonal);
        Assert.Equal(["lunchbox-labs", "Pixel-Garden", "TheLunchTrae"], repositories.Owners.Select(owner => owner.Owner));
    }

    private async Task<RepositoriesViewModel> Owned()
    {
        var main = App(new FakeCli().On("status --json", Documents.SignedIn).On("repos --json", Documents.OwnedRepositories));
        await main.StartAsync();
        return Assert.IsType<ShellViewModel>(main.Page).Repositories;
    }

    /// <summary>The list as it reads: each heading with its count, then its repositories by name.</summary>
    private static IEnumerable<string> Listed(RepositoriesViewModel repositories) =>
        repositories.Items.Select(item => item switch
        {
            OwnerHeading heading => $"{heading.Owner} ({(heading.Personal ? "personal, " : "")}{heading.Count})",
            RepositoryRowViewModel row => row.Name,
            _ => throw new InvalidOperationException(),
        });

    [AvaloniaFact]
    public async Task An_empty_list_says_why_for_each_source()
    {
        var desktop = new FakeDesktop();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", """{"source":"installations","repositories":[]}""");
        var main = App(cli, desktop);
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.True(repositories.ShowEmpty);
        Assert.Contains("not installed", repositories.EmptyMessage, StringComparison.Ordinal);
        Assert.True(repositories.CanAddRepositories);
        // The empty list offers it, so the heading does not as well.
        Assert.False(repositories.ShowAddInHeading);
        await repositories.AddRepositoriesCommand.ExecuteAsync(null);
        Assert.Equal([Documents.InstallUrl], desktop.Opened);

        cli.On("repos --json", """{"source":"admin","repositories":[]}""");
        await repositories.RefreshCommand.ExecuteAsync(null);
        Assert.False(repositories.FromInstallations);
        Assert.False(repositories.CanAddRepositories);
        Assert.Equal("This token administers no repositories.", repositories.EmptyMessage);
    }

    [AvaloniaFact]
    public async Task A_failed_load_shows_the_error_and_tries_again()
    {
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .On("repos --json", """{"error":{"kind":"error","message":"fetch failed"}}""", exitCode: 1);
        var main = App(cli);
        await main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.Equal("fetch failed", repositories.Error);
        Assert.False(repositories.ShowTable);
        Assert.False(repositories.ShowEmpty);

        cli.On("repos --json", Documents.Repositories);
        await repositories.RefreshCommand.ExecuteAsync(null);
        Assert.Null(repositories.Error);
        Assert.True(repositories.ShowTable);
    }

    [AvaloniaFact]
    public async Task Refresh_waits_for_the_read_under_way()
    {
        var answer = new TaskCompletionSource();
        var cli = new FakeCli()
            .On("status --json", Documents.SignedIn)
            .OnLines("repos --json", ["", Documents.Repositories], answer.Task);
        var main = App(cli);

        var starting = main.StartAsync();
        var repositories = Assert.IsType<ShellViewModel>(main.Page).Repositories;

        Assert.True(repositories.Loading);
        Assert.False(repositories.RefreshCommand.CanExecute(null));
        answer.SetResult();
        await starting;
        Assert.True(repositories.RefreshCommand.CanExecute(null));
    }

    [AvaloniaTheory]
    [InlineData("installations", null, "Signed in with the Repotted App.", true)]
    [InlineData("admin", null, "Signed in with a GitHub token.", false)]
    [InlineData("admin", "GITHUB_TOKEN", "Signed in with GITHUB_TOKEN.", false)]
    [InlineData("installations", "GITHUB_TOKEN", "Signed in with GITHUB_TOKEN.", false)]
    public async Task Signed_in_with_says_what_the_token_is(string source, string? variable, string expected, bool canSignOut)
    {
        var shell = Shell("lunch", null, variable, source);
        // Without a variable, only the list tells an App sign-in from another token.
        Assert.Equal(variable is null ? null : expected, shell.SignedInWith);
        Assert.False(shell.ShowSignOut);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);

        Assert.Equal(expected, shell.SignedInWith);
        // Only the Repotted sign-in goes away on signing out; a variable or
        // the GitHub CLI's sign-in would still apply.
        Assert.Equal(canSignOut, shell.ShowSignOut);
    }

    [AvaloniaFact]
    public async Task Another_App_has_no_install_page_to_offer()
    {
        var shell = new ShellViewModel(
            new Account.SignedIn("lunch", null, null, null),
            new RepottedClient(new FakeCli().On("repos --json", """{"source":"installations","repositories":[]}""")),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);

        await shell.Repositories.RefreshCommand.ExecuteAsync(null);

        Assert.Equal("Signed in with your GitHub App.", shell.SignedInWith);
        Assert.False(shell.Repositories.CanAddRepositories);
        Assert.StartsWith("Your GitHub App is not installed", shell.Repositories.EmptyMessage, StringComparison.Ordinal);
    }

    [Fact]
    public void Initials_take_the_first_and_last_words()
    {
        Assert.Equal("TS", Shell("TheLunchTrae", "Trae Smith").Initials);
        Assert.Equal("TH", Shell("TheLunchTrae", null).Initials);
        Assert.Equal("AB", Shell("a-b", null).Initials);
    }

    private ShellViewModel Shell(string login, string? name, string? variable = null, string source = "installations") =>
        new(
            new Account.SignedIn(login, name, variable, Documents.InstallUrl),
            new RepottedClient(new FakeCli().On("repos --json", $$"""{"source":"{{source}}","repositories":[]}""")),
            new FakeDesktop(),
            folders.Settings,
            () => Task.CompletedTask);
}
