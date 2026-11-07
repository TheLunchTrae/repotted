using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>The signed-in app: the sidebar, the header with its search, and the page.</summary>
internal sealed partial class ShellViewModel : ViewModelBase
{
    public ShellViewModel(Account.SignedIn account, RepottedClient client, IDesktop desktop)
    {
        Account = account;
        Repositories = new RepositoriesViewModel(client, desktop);
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

    /// <summary>What the token is: the App's sign-in, or a variable that overrides it.</summary>
    public string SignedInWith => Account.TokenVariable is { } variable
        ? $"Signed in with {variable}."
        : "Signed in with Repotted App.";

    [ObservableProperty]
    public partial string Search { get; set; } = "";

    partial void OnSearchChanged(string value) => Repositories.Filter = value;
}
