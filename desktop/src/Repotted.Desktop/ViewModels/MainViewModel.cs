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

    /// <summary>The save or sync a replaced app still runs, which the next app waits for before it syncs the same folder.</summary>
    private Task retired = Task.CompletedTask;

    /// <summary>The app whose lost sign-in is being checked, so pages that fail together check once.</summary>
    private ShellViewModel? checking;

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
            retired = shell.Stop();
        }
    }

    /// <summary>Asks the CLI who is signed in, and shows the page that fits.</summary>
    public async Task StartAsync()
    {
        Page = new LoadingViewModel("Checking your GitHub sign-in");
        try
        {
            await ShowAsync(await client.StatusAsync(CancellationToken.None).ConfigureAwait(true)).ConfigureAwait(true);
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

    /// <summary>Shows the app for a signed-in account, or the sign-in for a signed-out one, in place of the loading page.</summary>
    private async Task ShowAsync(Account account)
    {
        switch (account)
        {
            case Account.SignedIn signedIn:
                // A replaced app may still save or sync the folder this one syncs first.
                await retired.ConfigureAwait(true);
                // Each app gets a client of its own, so a lost sign-in that an app
                // replaced since then reports can't replace the app showing now.
                var shellClient = new RepottedClient(cli);
                var shell = new ShellViewModel(signedIn, shellClient, desktop, settings, SignOutAsync);
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

    private void OnSignInLost(ShellViewModel shell) => _ = CheckSignInAsync(shell);

    /// <summary>
    /// A page of <paramref name="shell"/> found the sign-in missing or
    /// rejected. The app stays while the check runs, and after it when the
    /// same account is still signed in, such as when another run refreshed
    /// the token first, so a compare, a capture and unsaved edits stay too.
    /// Otherwise the page the check finds replaces the app. Pages that fail
    /// together check once, and an app already replaced checks nothing.
    /// </summary>
    private async Task CheckSignInAsync(ShellViewModel shell)
    {
        if (Page != shell || checking == shell)
        {
            return;
        }
        checking = shell;
        try
        {
            var account = await client.StatusAsync(CancellationToken.None).ConfigureAwait(true);
            if (Page == shell && !account.Equals(shell.Account))
            {
                Page = new LoadingViewModel("Checking your GitHub sign-in");
                await ShowAsync(account).ConfigureAwait(true);
            }
        }
        // The check itself failed, so nothing says the sign-in is gone; the
        // page that met the failure shows it.
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
        }
        catch (Exception error)
        {
            Page = new ProblemViewModel($"Something unexpected went wrong: {error.Message}", StartAsync);
        }
        finally
        {
            checking = null;
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
                _ = shell.Stop();
                break;
        }
    }
}
