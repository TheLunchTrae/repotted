using Repotted.Desktop.Services;
using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

/// <summary>What the view model tests of each page share: a profiles folder of their own, and ways to open the app and its profiles.</summary>
public abstract class ViewModelTests : IDisposable
{
    private protected readonly Folders folders = new();

    /// <summary>The desktop the profiles page from OpenOrgs uses, whose folder pick a test can set.</summary>
    private protected readonly FakeDesktop orgsDesktop = new();

    public void Dispose()
    {
        Dispose(true);
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            folders.Dispose();
        }
    }

    private protected MainViewModel App(FakeCli cli, FakeDesktop? desktop = null) =>
        new(cli.Answers(folders.List()) ? cli : cli.On(folders.List(), Documents.NoProfiles),
            desktop ?? new FakeDesktop(),
            folders.Settings);

    /// <summary>The files that captures write in the profiles folder until they are whole.</summary>
    private protected IEnumerable<string> Leftovers() => Directory.EnumerateFiles(folders.Profiles, "*.repotted-capture");

    private protected async Task<(ProfilesViewModel Profiles, FakeCli Cli, (string Own, string Base) Files)> OpenOrgs(params string[] repositories)
    {
        var @base = folders.Write("base.yaml", "repository: { has_issues: true }\n");
        var own = folders.Write("orgs.yaml", "extends: base.yaml\nrepository: { has_wiki: false }\n");
        var cli = new FakeCli()
            .On(folders.List(), Documents.Profiles(own, @base))
            .On($"profile {own} --json", Documents.Resolved(own, @base))
            .On($"profile {@base} --json", Documents.ResolvedBase(@base));
        var profiles = new ProfilesViewModel(new RepottedClient(cli), orgsDesktop, folders.Settings, () => repositories);
        await profiles.RefreshCommand.ExecuteAsync(null);
        // The fake answers at once, so selecting a profile has loaded it.
        profiles.Selected = profiles.Items.Single(item => item.Name == "orgs");
        return (profiles, cli, (own, @base));
    }

    private protected static SettingViewModel Find(ProfileViewModel editor, string key) =>
        editor.Tabs.SelectMany(tab => tab.Groups).SelectMany(group => group.Settings).Single(setting => setting.Key == key);

    private protected static void Choose(ProfileViewModel editor, string key, string label) =>
        Find(editor, key).Options.Single(option => option.Label == label).ChooseCommand.Execute(null);
}
