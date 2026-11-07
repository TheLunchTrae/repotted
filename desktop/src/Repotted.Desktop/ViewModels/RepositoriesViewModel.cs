using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>The repositories Repotted can manage, with a search filter and the selected one's details.</summary>
internal sealed partial class RepositoriesViewModel(RepottedClient client, IDesktop desktop) : ViewModelBase
{
    /// <summary>Where a user adds the Repotted App to more repositories.</summary>
    internal static readonly Uri InstallUrl = new("https://github.com/apps/repotted-app/installations/new");

    private IReadOnlyList<RepositoryRowViewModel> all = [];

    public ObservableCollection<RepositoryRowViewModel> Rows { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelection))]
    public partial RepositoryRowViewModel? Selected { get; set; }

    public bool HasSelection => Selected is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(HasError))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    /// <summary>Whether the App's installations decide the list, so more repositories come from installing it.</summary>
    [ObservableProperty]
    public partial bool FromInstallations { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTable), nameof(ShowEmpty), nameof(CountLabel))]
    public partial int Count { get; set; }

    public string CountLabel => $"All {Count}";

    public bool ShowTable => !Loading && Error is null && Count > 0;

    public bool ShowEmpty => !Loading && Error is null && Count == 0;

    public string EmptyMessage => FromInstallations
        ? "The Repotted App is not installed on any repositories you administer yet."
        : "This token administers no repositories.";

    public string Description => FromInstallations
        ? "Repositories the Repotted App is installed on that you administer."
        : "Repositories your account administers.";

    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            var list = await client.RepositoriesAsync(CancellationToken.None).ConfigureAwait(true);
            FromInstallations = list.FromInstallations;
            all = [.. list.Repositories.Select(repository => new RepositoryRowViewModel(repository))];
            Count = all.Count;
            OnPropertyChanged(nameof(EmptyMessage));
            OnPropertyChanged(nameof(Description));
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

    [RelayCommand]
    private Task RefreshAsync() => LoadAsync();

    [RelayCommand]
    private void AddRepositories() => desktop.OpenUrl(InstallUrl);

    [RelayCommand]
    private void OpenOnGitHub()
    {
        if (Selected is { } row)
        {
            desktop.OpenUrl(row.GitHubUrl);
        }
    }

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
