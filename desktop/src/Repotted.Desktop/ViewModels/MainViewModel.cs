using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>Chooses the page: the sign-in until GitHub knows the account, then the app.</summary>
internal sealed partial class MainViewModel : ViewModelBase
{
    private readonly RepottedClient client;
    private readonly IDesktop desktop;
    private readonly AppSettings settings;

    public MainViewModel(RepottedClient client, IDesktop desktop, AppSettings settings)
    {
        this.client = client;
        this.desktop = desktop;
        this.settings = settings;
        // The client reports a lost sign-in from the thread that read it.
        var signInLost = OnContext<EventArgs>(_ => OnSignInLost());
        client.SignInLost += (_, e) => signInLost(e);
    }

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
                    var shell = new ShellViewModel(account, client, desktop, settings, SignOutAsync);
                    Page = shell;
                    await shell.RefreshAsync().ConfigureAwait(true);
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
        // Nothing awaits the start, so an unexpected failure is shown here
        // rather than lost behind the loading page.
        catch (Exception error)
        {
            Page = new ProblemViewModel($"Something unexpected went wrong: {error.Message}", StartAsync);
        }
    }

    /// <summary>
    /// A page of the signed-in app found the sign-in missing or rejected, so
    /// the app checks again, which leads to the sign-in page. The check
    /// replaces the app, so pages that fail together check once.
    /// </summary>
    private void OnSignInLost()
    {
        if (Page is ShellViewModel)
        {
            _ = StartAsync();
        }
    }

    /// <summary>Removes the Repotted sign-in, then checks again.</summary>
    private async Task SignOutAsync()
    {
        Page = new LoadingViewModel("Signing out");
        try
        {
            await client.SignOutAsync(CancellationToken.None).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Page = new ProblemViewModel(error.Message, StartAsync);
            return;
        }
        await StartAsync().ConfigureAwait(true);
    }

    /// <summary>Stops what still runs as the app closes, so no sign-in outlives it.</summary>
    public void Stop()
    {
        if (Page is SignInViewModel signIn)
        {
            signIn.Stop();
        }
    }
}
