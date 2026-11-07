using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Repotted.Desktop.Services;

/// <summary>The CLI ran but reported a failure, or printed something the app cannot read.</summary>
internal sealed class CliException(string message) : Exception(message);

/// <summary>Who Repotted signs in as, or why it is signed out.</summary>
internal abstract record Account
{
    internal sealed record SignedIn(string Login, string? Name, string? TokenVariable) : Account;

    /// <summary>
    /// <paramref name="Rejected"/> is true when GitHub refused a token, rather
    /// than there being none; <paramref name="TokenVariable"/> names the variable
    /// that holds it, if one does. <paramref name="Problems"/> says why a
    /// sign-in could not be read, such as an unreadable keychain.
    /// </summary>
    internal sealed record SignedOut(bool Rejected, string? TokenVariable, IReadOnlyList<string> Problems) : Account;
}

/// <summary>The code to enter on GitHub while a sign-in waits.</summary>
internal sealed record DeviceCode(Uri VerificationUri, string UserCode, DateTimeOffset ExpiresAt);

/// <summary>A finished sign-in.</summary>
internal sealed record SignInResult(Uri? InstallUrl, string? TokenVariable);

/// <summary>The repositories Repotted can manage, and how it found them.</summary>
internal sealed record RepositoryList(bool FromInstallations, IReadOnlyList<RepositoryDocument> Repositories);

/// <summary>Reads the CLI's JSON output into what the views show.</summary>
internal sealed class RepottedClient(ICli cli)
{
    public async Task<Account> StatusAsync(CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["status", "--json"], null, cancellationToken).ConfigureAwait(false);
        var status = Read(run, CliJson.Default.StatusDocument);
        if (status.SignedIn && status.Login is { } login)
        {
            return new Account.SignedIn(login, status.Name, status.TokenVariable);
        }
        return new Account.SignedOut(status.Reason == "rejected", status.TokenVariable, status.Problems ?? []);
    }

    public async Task<RepositoryList> RepositoriesAsync(CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["repos", "--json"], null, cancellationToken).ConfigureAwait(false);
        var list = Read(run, CliJson.Default.RepositoryListDocument);
        return new RepositoryList(list.Source == "installations", list.Repositories);
    }

    /// <summary>
    /// Starts the device flow. <paramref name="onCode"/> gets the code to show as
    /// soon as the CLI prints it; the task finishes once the user has entered it.
    /// </summary>
    public async Task<SignInResult> SignInAsync(Action<DeviceCode> onCode, CancellationToken cancellationToken)
    {
        LoginEvent? last = null;
        var run = await cli.RunAsync(
            ["login", "--json"],
            line =>
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    return;
                }
                var parsed = Parse(line, CliJson.Default.LoginEvent);
                last = parsed;
                if (parsed is { Event: "code", VerificationUri: { } uri, UserCode: { } code, ExpiresAt: { } expires })
                {
                    onCode(new DeviceCode(new Uri(uri), code, expires));
                }
            },
            cancellationToken).ConfigureAwait(false);

        switch (last)
        {
            case { Event: "signed_in" }:
                return new SignInResult(
                    last.InstallUrl is { } install ? new Uri(install) : null,
                    last.TokenVariable);
            // A failure after the code is an error event; one before it is a
            // failure document, which reads the same way.
            case { Error: { } error }:
                throw new CliException(error.Message);
            case null:
                throw new CliException(FailureMessage(run.Output) ?? "The sign-in did not start.");
            default:
                throw new CliException("The sign-in ended without signing in.");
        }
    }

    /// <summary>
    /// Reads one document. A failure document becomes a <see cref="CliException"/>
    /// with its message; so does output the app cannot read.
    /// </summary>
    private static T Read<T>(CliRun run, JsonTypeInfo<T> type)
        where T : class
    {
        if (FailureMessage(run.Output) is { } message)
        {
            throw new CliException(message);
        }
        return Parse(run.Output, type);
    }

    private static string? FailureMessage(string output)
    {
        try
        {
            return JsonSerializer.Deserialize(output, CliJson.Default.FailureDocument)?.Error?.Message;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static T Parse<T>(string json, JsonTypeInfo<T> type)
        where T : class
    {
        try
        {
            return JsonSerializer.Deserialize(json, type)
                ?? throw new CliException("The Repotted command line printed nothing.");
        }
        catch (JsonException error)
        {
            throw new CliException($"Could not read what the Repotted command line printed: {error.Message}");
        }
    }
}
