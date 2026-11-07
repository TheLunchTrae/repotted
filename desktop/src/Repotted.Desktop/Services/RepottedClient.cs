using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Repotted.Desktop.Services;

/// <summary>The CLI ran but reported a failure, or printed something the app cannot read.</summary>
internal sealed class CliException(string message) : Exception(message);

/// <summary>Who Repotted signs in as, or why it is signed out.</summary>
internal abstract record Account
{
    /// <summary>
    /// <paramref name="InstallUrl"/> is where to install the Repotted App on more
    /// repositories; null when Repotted signs in with another GitHub App.
    /// </summary>
    internal sealed record SignedIn(string Login, string? Name, string? TokenVariable, Uri? InstallUrl) : Account;

    /// <summary>
    /// <paramref name="Rejected"/> is true when GitHub refused a token, rather
    /// than there being none; <paramref name="TokenVariable"/> names the variable
    /// that holds it, if one does. <paramref name="Problems"/> says why a
    /// sign-in could not be used, such as an unreadable keychain.
    /// </summary>
    internal sealed record SignedOut(bool Rejected, string? TokenVariable, IReadOnlyList<string> Problems) : Account;
}

/// <summary>The code to enter on GitHub while a sign-in waits.</summary>
internal sealed record DeviceCode(Uri VerificationUri, string UserCode, DateTimeOffset ExpiresAt);

/// <summary>The repositories Repotted can manage, and how it found them.</summary>
internal sealed record RepositoryList(bool FromInstallations, IReadOnlyList<RepositoryDocument> Repositories);

/// <summary>
/// A change to one profile setting: <paramref name="Key"/> is its section and
/// key, such as <c>repository.has_wiki</c>, and <paramref name="Value"/> is the
/// new value, or null to stop managing it.
/// </summary>
internal sealed record ProfileChange(string Key, JsonNode? Value);

/// <summary>
/// A profile resolved over the profiles it extends. <paramref name="Chain"/> is
/// the file, then each one it extends; <paramref name="Sources"/> names the file
/// behind each value, by section and then by key or entry name.
/// </summary>
internal sealed record ResolvedProfile(
    IReadOnlyList<string> Chain,
    JsonElement Values,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Sources)
{
    public string File => Chain[0];
}

/// <summary>Reads the CLI's JSON output into what the views show.</summary>
internal sealed class RepottedClient(ICli cli)
{
    public async Task<Account> StatusAsync(CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["status", "--json"], null, cancellationToken).ConfigureAwait(false);
        var status = Read(run, CliJson.Default.StatusDocument);
        return status switch
        {
            { SignedIn: true, Login: { } login } =>
                new Account.SignedIn(login, status.Name, status.TokenVariable, Link(status.InstallUrl)),
            { SignedIn: false, Reason: "not_signed_in" or "rejected", Problems: { } problems } =>
                new Account.SignedOut(status.Reason == "rejected", status.TokenVariable, problems),
            _ => throw Unreadable(run, "the sign-in status is incomplete."),
        };
    }

    public async Task<RepositoryList> RepositoriesAsync(CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["repos", "--json"], null, cancellationToken).ConfigureAwait(false);
        var list = Read(run, CliJson.Default.RepositoryListDocument);
        return list.Source switch
        {
            "installations" => new RepositoryList(true, list.Repositories),
            "admin" => new RepositoryList(false, list.Repositories),
            _ => throw Unreadable(run, $"unknown repository source \"{list.Source}\"."),
        };
    }

    public async Task<IReadOnlyList<ProfileListingDocument>> ProfilesAsync(
        string folder,
        CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["profiles", folder, "--json"], null, cancellationToken).ConfigureAwait(false);
        return Read(run, CliJson.Default.ProfileListDocument).Profiles;
    }

    public async Task<ResolvedProfile> ProfileAsync(string file, CancellationToken cancellationToken) =>
        await ProfileAsync(["profile", file, "--json"], cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// Compares <paramref name="repository"/> with the profile in <paramref name="file"/>.
    /// It only reads: the CLI writes nothing to GitHub without <c>apply</c>.
    /// </summary>
    public async Task<PlanDocument> PlanAsync(string repository, string file, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["plan", repository, "--profile", file, "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        var plan = Read(run, CliJson.Default.PlanDocument);
        if (plan.Desired.ValueKind != JsonValueKind.Object)
        {
            throw Unreadable(run, "the plan has no profile.");
        }
        return plan;
    }

    /// <summary>
    /// Writes <paramref name="repository"/>'s setup to <paramref name="file"/>
    /// as a profile. It only reads from GitHub. The warnings say what it could not read.
    /// </summary>
    public async Task<IReadOnlyList<string>> CaptureAsync(string repository, string file, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["capture", repository, "--output", file, "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        return Read(run, CliJson.Default.CaptureDocument).Warnings;
    }

    /// <summary>Writes <paramref name="changes"/> to the profile file, which the CLI checks first.</summary>
    public async Task<ResolvedProfile> SaveProfileAsync(
        string file,
        IReadOnlyList<ProfileChange> changes,
        CancellationToken cancellationToken)
    {
        List<string> arguments = ["profile", file];
        foreach (var change in changes)
        {
            arguments.AddRange(change.Value is null
                ? ["--unset", change.Key]
                : ["--set", $"{change.Key}={change.Value.ToJsonString()}"]);
        }
        arguments.Add("--json");
        return await ProfileAsync(arguments, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ResolvedProfile> ProfileAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(arguments, null, cancellationToken).ConfigureAwait(false);
        var profile = Read(run, CliJson.Default.ResolvedProfileDocument);
        if (profile.Chain.Count == 0 || profile.Profile.ValueKind != JsonValueKind.Object)
        {
            throw Unreadable(run, "the profile is incomplete.");
        }
        var sources = profile.Sources;
        return new ResolvedProfile(
            profile.Chain,
            profile.Profile,
            new Dictionary<string, IReadOnlyDictionary<string, string>>
            {
                ["repository"] = sources.Repository,
                ["merge"] = sources.Merge,
                ["actions"] = sources.Actions,
                ["rulesets"] = sources.Rulesets,
                ["environments"] = sources.Environments,
            });
    }

    /// <summary>
    /// Starts the device flow. <paramref name="onCode"/> gets the code to show as
    /// soon as the CLI prints it; the task finishes once the user has entered it.
    /// </summary>
    public async Task SignInAsync(Action<DeviceCode> onCode, CancellationToken cancellationToken)
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
                // A failure before the code is a failure document, not an event.
                if (FailureMessage(line) is { } failure)
                {
                    throw new CliException(failure);
                }
                var parsed = Parse(line, CliJson.Default.LoginEvent);
                last = parsed;
                if (parsed is { Event: "code", VerificationUri: { } uri, UserCode: { } code, ExpiresAt: { } expires })
                {
                    onCode(new DeviceCode(
                        Link(uri) ?? throw new CliException($"The sign-in gave a link that is not an https address: {uri}"),
                        code,
                        expires));
                }
            },
            cancellationToken).ConfigureAwait(false);

        switch (last)
        {
            case { Event: "signed_in" }:
                return;
            case null:
                throw new CliException(FailureMessage(run.Output) ?? Crash(run) ?? "The sign-in did not start.");
            default:
                throw new CliException("The sign-in ended without signing in.");
        }
    }

    /// <summary>An https link, or null for anything else.</summary>
    private static Uri? Link(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? uri : null;

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
        try
        {
            return JsonSerializer.Deserialize(run.Output, type) ?? throw Unreadable(run, "it printed null.");
        }
        catch (JsonException error)
        {
            throw Unreadable(run, error.Message);
        }
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
                ?? throw new CliException("The Repotted command line printed null.");
        }
        catch (JsonException error)
        {
            throw new CliException($"Could not read what the Repotted command line printed: {error.Message}");
        }
    }

    /// <summary>
    /// What a failed run that printed no readable document said on stderr,
    /// which is where a crash ends up. A run that succeeded may still warn
    /// there, so its stderr says nothing about unreadable output.
    /// </summary>
    private static string? Crash(CliRun run)
    {
        var lines = run.Error.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return run.ExitCode == 0 || lines.Length == 0
            ? null
            : $"The Repotted command line failed (exit code {run.ExitCode}): {string.Join(' ', lines.TakeLast(3))}";
    }

    private static CliException Unreadable(CliRun run, string detail) =>
        new(Crash(run) ?? $"Could not read what the Repotted command line printed: {detail}");
}
