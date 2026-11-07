using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>The signed-in app: the sidebar, the header with its search, and the page.</summary>
internal sealed partial class ShellViewModel : ViewModelBase
{
    public ShellViewModel(Account.SignedIn account, RepottedClient client, IDesktop desktop)
    {
        Account = account;
        Repositories = new RepositoriesViewModel(client, desktop, account.InstallUrl);
        Repositories.PropertyChanged += OnRepositoriesChanged;
    }

    public Account.SignedIn Account { get; }

    public RepositoriesViewModel Repositories { get; }

    /// <summary>Up to two letters for the avatar.</summary>
    public string Initials
    {
        get
        {
            var words = (Account.Name ?? Account.Login)
                .Split([' ', '-', '_'], StringSplitOptions.RemoveEmptyEntries);
            var letters = words.Length >= 2
                ? $"{words[0][0]}{words[^1][0]}"
                : (words.FirstOrDefault() ?? "?")[..Math.Min(2, (words.FirstOrDefault() ?? "?").Length)];
            return letters.ToUpperInvariant();
        }
    }

    /// <summary>
    /// What the token is. A variable says so itself. Otherwise only an App's
    /// sign-in reaches its installations, so the repository list tells an App
    /// sign-in from another token, such as the GitHub CLI's.
    /// </summary>
    public string? SignedInWith => (Account.TokenVariable, Repositories.FromInstallations) switch
    {
        ({ } variable, _) => $"Signed in with {variable}.",
        (null, true) => Account.InstallUrl is null ? "Signed in with your GitHub App." : "Signed in with Repotted App.",
        (null, false) => "Signed in with a GitHub token.",
        (null, null) => null,
    };

    [ObservableProperty]
    public partial string Search { get; set; } = "";

    partial void OnSearchChanged(string value) => Repositories.Filter = value;

    private void OnRepositoriesChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(RepositoriesViewModel.FromInstallations))
        {
            OnPropertyChanged(nameof(SignedInWith));
        }
    }
}
