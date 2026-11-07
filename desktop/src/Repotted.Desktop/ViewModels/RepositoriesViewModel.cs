using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The repositories Repotted can manage, with a search filter and the selected
/// one's details. <paramref name="installUrl"/> is where to add the Repotted App
/// to more repositories, when it is the App that signs in.
/// </summary>
internal sealed partial class RepositoriesViewModel(RepottedClient client, IDesktop desktop, Uri? installUrl)
    : ViewModelBase
{
    private IReadOnlyList<RepositoryRowViewModel> all = [];

    public ObservableCollection<RepositoryRowViewModel> Rows { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelection))]
    public partial RepositoryRowViewModel? Selected { get; set; }

    public bool HasSelection => Selected is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(ShowAddInHeading))]
    [NotifyCanExecuteChangedFor(nameof(RefreshCommand))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(HasError), nameof(ShowAddInHeading))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    /// <summary>
    /// Whether the App's installations decide the list, so more repositories
    /// come from installing it. Null until the list has loaded.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanAddRepositories), nameof(ShowAddInHeading), nameof(EmptyMessage), nameof(Description))]
    public partial bool? FromInstallations { get; set; }

    /// <summary>Whether installing the Repotted App on more repositories adds to the list.</summary>
    public bool CanAddRepositories => FromInstallations == true && installUrl is not null;

    /// <summary>The heading offers it too, except where the empty list already does.</summary>
    public bool ShowAddInHeading => CanAddRepositories && !ShowEmpty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(CountLabel), nameof(ShowAddInHeading))]
    public partial int Count { get; set; }

    public string CountLabel => $"All {Count}";

    public bool ShowTable => !Loading && Error is null && Count > 0;

    public bool ShowEmpty => !Loading && Error is null && FromInstallations is not null && Count == 0;

    public string EmptyMessage => FromInstallations == true
        ? $"{Capitalized(AppName)} is not installed on any repositories you administer yet."
        : "This token administers no repositories.";

    public string Description => FromInstallations switch
    {
        true => $"Repositories {AppName} is installed on that you administer.",
        false => "Repositories your account administers.",
        null => "",
    };

    private string AppName => installUrl is null ? "your GitHub App" : "the Repotted App";

    private static string Capitalized(string text) => string.Concat(text[..1].ToUpperInvariant(), text[1..]);

    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    /// <summary>Reads the list; one read at a time, which the Refresh command enforces.</summary>
    [RelayCommand(CanExecute = nameof(CanRefresh))]
    private async Task RefreshAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            var list = await client.RepositoriesAsync(CancellationToken.None).ConfigureAwait(true);
            all = [.. list.Repositories.Select(repository => new RepositoryRowViewModel(repository))];
            Count = all.Count;
            FromInstallations = list.FromInstallations;
            ApplyFilter();
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Error = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    private bool CanRefresh() => !Loading;

    [RelayCommand]
    private Task AddRepositoriesAsync() => installUrl is { } url ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    [RelayCommand]
    private Task OpenOnGitHubAsync() => Selected is { } row ? desktop.OpenUrlAsync(row.GitHubUrl) : Task.CompletedTask;

    private void ApplyFilter()
    {
        var selected = Selected?.FullName;
        Rows.Clear();
        foreach (var row in all.Where(row => row.FullName.Contains(Filter.Trim(), StringComparison.OrdinalIgnoreCase)))
        {
            Rows.Add(row);
        }
        Selected = Rows.FirstOrDefault(row => row.FullName == selected) ?? Rows.FirstOrDefault();
    }
}
