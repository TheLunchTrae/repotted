using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>Chooses the page: the sign-in until GitHub knows the account, then the app.</summary>
internal sealed partial class MainViewModel(RepottedClient client, IDesktop desktop) : ViewModelBase
{
    [ObservableProperty]
    public partial ViewModelBase? Page { get; set; }

    /// <summary>Asks the CLI who is signed in, and shows the page that fits.</summary>
    public async Task StartAsync()
    {
        Page = new LoadingViewModel("Checking your GitHub sign-in");
        try
        {
            switch (await client.StatusAsync(CancellationToken.None).ConfigureAwait(true))
            {
                case Account.SignedIn account:
                    var shell = new ShellViewModel(account, client, desktop);
                    Page = shell;
                    await shell.Repositories.LoadAsync().ConfigureAwait(true);
                    break;
                case Account.SignedOut signedOut:
                    Page = new SignInViewModel(client, desktop, signedOut, StartAsync);
                    break;
            }
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Page = new ProblemViewModel(error.Message, StartAsync);
        }
    }
}
