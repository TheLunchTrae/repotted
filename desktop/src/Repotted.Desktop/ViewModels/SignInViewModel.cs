using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Signs in with the Repotted GitHub App through the device flow: shows the
/// code the CLI prints, then checks the sign-in again once the user has
/// entered it on GitHub. <paramref name="checkAgain"/> does that check.
/// </summary>
internal sealed partial class SignInViewModel(
    RepottedClient client,
    IDesktop desktop,
    Account.SignedOut account,
    Func<Task> checkAgain) : ViewModelBase
{
    /// <summary>
    /// What went wrong with an earlier sign-in: GitHub refused it, or it could
    /// not be used. Null when there simply was none.
    /// </summary>
    public string? Notice { get; } = account switch
    {
        { Rejected: false, Problems.Count: 0 } => null,
        { Rejected: false } => string.Join(' ', account.Problems),
        { TokenVariable: { } variable } =>
            $"GitHub rejected the token in {variable}. Repotted uses that variable before any sign-in: fix the token on GitHub and check again, or remove the variable and reopen Repotted.",
        _ => "GitHub no longer accepts your last sign-in. Sign in again.",
    };

    public bool HasNotice => Notice is not null;

    /// <summary>
    /// A rejected token variable comes before any sign-in, so signing in would
    /// change nothing until the variable is fixed.
    /// </summary>
    public bool CanSignIn { get; } = account is not { Rejected: true, TokenVariable: not null };

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowStart))]
    public partial bool Starting { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCode), nameof(ShowStart))]
    public partial DeviceCode? Code { get; set; }

    public bool HasCode => Code is not null;

    /// <summary>The first step: nothing has started yet.</summary>
    public bool ShowStart => !Starting && !HasCode;

    [ObservableProperty]
    public partial string? Error { get; set; }

    [ObservableProperty]
    public partial bool CodeCopied { get; set; }

    [RelayCommand(IncludeCancelCommand = true)]
    private async Task SignInAsync(CancellationToken cancellationToken)
    {
        Error = null;
        Code = null;
        CodeCopied = false;
        Starting = true;
        // The code arrives on this context after a delay, so it may come after
        // the sign-in has already failed or been cancelled.
        var finished = false;
        try
        {
            await client.SignInAsync(
                OnContext<DeviceCode>(code =>
                {
                    if (!finished)
                    {
                        Starting = false;
                        Code = code;
                    }
                }),
                cancellationToken).ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Error = error.Message;
            return;
        }
        finally
        {
            finished = true;
            Starting = false;
            Code = null;
        }
        await checkAgain().ConfigureAwait(true);
    }

    [RelayCommand]
    private Task CheckAgainAsync() => checkAgain();

    [RelayCommand]
    private Task OpenGitHubAsync() => Code is { } code ? desktop.OpenUrlAsync(code.VerificationUri) : Task.CompletedTask;

    [RelayCommand]
    private async Task CopyCodeAsync()
    {
        if (Code is { } code)
        {
            await desktop.CopyTextAsync(code.UserCode).ConfigureAwait(true);
            CodeCopied = true;
        }
    }

    /// <summary>Stops a sign-in that is still waiting, such as when the app closes.</summary>
    public void Stop()
    {
        if (SignInCommand.IsRunning)
        {
            SignInCancelCommand.Execute(null);
        }
    }
}
