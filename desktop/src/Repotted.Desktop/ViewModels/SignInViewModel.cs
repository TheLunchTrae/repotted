using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Signs in with the Repotted GitHub App through the device flow: shows the
/// code the CLI prints, then hands back once the user has entered it on GitHub.
/// </summary>
internal sealed partial class SignInViewModel(
    RepottedClient client,
    IDesktop desktop,
    Account.SignedOut account,
    Func<Task> signedIn) : ViewModelBase
{
    /// <summary>
    /// What went wrong with an earlier sign-in: GitHub refused it, or it could
    /// not be read. Null when there simply was none.
    /// </summary>
    public string? Notice { get; } = account switch
    {
        { Rejected: false, Problems.Count: 0 } => null,
        { Rejected: false } => string.Join(' ', account.Problems),
        { TokenVariable: { } variable } =>
            $"GitHub rejected the token in {variable}. Repotted uses that variable before any sign-in, so fix or remove it and reopen Repotted.",
        _ => "GitHub no longer accepts your last sign-in. Sign in again.",
    };

    public bool HasNotice => Notice is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCode))]
    public partial DeviceCode? Code { get; set; }

    public bool HasCode => Code is not null;

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
                        Code = code;
                    }
                }),
                cancellationToken).ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            Code = null;
            return;
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Code = null;
            Error = error.Message;
            return;
        }
        finally
        {
            finished = true;
        }
        await signedIn().ConfigureAwait(true);
    }

    [RelayCommand]
    private void OpenGitHub()
    {
        if (Code is { } code)
        {
            desktop.OpenUrl(code.VerificationUri);
        }
    }

    [RelayCommand]
    private async Task CopyCodeAsync()
    {
        if (Code is { } code)
        {
            await desktop.CopyTextAsync(code.UserCode).ConfigureAwait(true);
            CodeCopied = true;
        }
    }
}
