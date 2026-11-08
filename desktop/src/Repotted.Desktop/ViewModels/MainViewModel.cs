using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>Chooses the page: the sign-in until GitHub knows the account, then the app.</summary>
internal sealed partial class MainViewModel : ViewModelBase
{
    private readonly ICli cli;
    private readonly RepottedClient client;
    private readonly IDesktop desktop;
    private readonly AppSettings settings;

    public MainViewModel(ICli cli, IDesktop desktop, AppSettings settings)
    {
        this.cli = cli;
        client = new RepottedClient(cli);
        this.desktop = desktop;
        this.settings = settings;
    }

    [ObservableProperty]
    public partial ViewModelBase? Page { get; set; }

    // Whatever replaces the signed-in app, its captures and connects stop with it.
    partial void OnPageChanged(ViewModelBase? oldValue, ViewModelBase? newValue)
    {
        if (oldValue is ShellViewModel shell)
        {
            shell.Stop();
        }
    }

    /// <summary>Asks the CLI who is signed in, and shows the page that fits.</summary>
    public async Task StartAsync()
    {
        Page = new LoadingViewModel("Checking your GitHub sign-in");
        try
        {
            switch (await client.StatusAsync(CancellationToken.None).ConfigureAwait(true))
            {
                case Account.SignedIn account:
                    // Each app gets a client of its own, so a lost sign-in that an app
                    // replaced since then reports can't replace the app showing now.
                    var shellClient = new RepottedClient(cli);
                    var shell = new ShellViewModel(account, shellClient, desktop, settings, SignOutAsync);
                    var signInLost = OnContext<EventArgs>(_ => OnSignInLost(shell));
                    shellClient.SignInLost += (_, e) => signInLost(e);
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
    /// A page of <paramref name="shell"/> found the sign-in missing or
    /// rejected, so the app checks again, which leads to the sign-in page. The
    /// check replaces the app, so pages that fail together check once, and
    /// an app already replaced checks nothing.
    /// </summary>
    private void OnSignInLost(ShellViewModel shell)
    {
        if (Page == shell)
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

    /// <summary>Stops what still runs as the app closes, so no sign-in or capture outlives it.</summary>
    public void Stop()
    {
        switch (Page)
        {
            case SignInViewModel signIn:
                signIn.Stop();
                break;
            case ShellViewModel shell:
                shell.Stop();
                break;
        }
    }
}
