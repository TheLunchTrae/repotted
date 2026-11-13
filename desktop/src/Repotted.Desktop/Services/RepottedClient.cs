using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Repotted.Desktop.Services;

/// <summary>The CLI ran but reported a failure, or printed something the app cannot read.</summary>
internal class CliException(string message) : Exception(message);

/// <summary>A command failed because there is no sign-in, or GitHub rejected it.</summary>
internal sealed class SignInLostException(string message) : CliException(message);

/// <summary>GitHub's rate limit refused a command, which a later try passes.</summary>
internal sealed class RateLimitedException(string message) : CliException(message);

/// <summary>The command line printed something the app could not read, such as after a crash, rather than a failure it explains.</summary>
internal sealed class CliOutputException(string message) : CliException(message);

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

/// <summary>What a profile applies before edits and after them, as profile YAML.</summary>
internal sealed record ProfilePreview(string Before, string After);

/// <summary>The repositories Repotted can manage, and how it found them.</summary>
internal sealed record RepositoryList(bool FromInstallations, IReadOnlyList<RepositoryDocument> Repositories);

/// <summary>
/// A change to one profile setting: <paramref name="Key"/> is its section and
/// key, such as <c>repository.has_wiki</c>, or a draft's under <c>drafts</c>,
/// such as <c>drafts.repository.has_wiki</c>, and <paramref name="Value"/> is the
/// new value, or null to stop managing it. <paramref name="SetsNull"/> sets the
/// value to JSON <c>null</c> instead, as an empty runner label is saved; its
/// <paramref name="Value"/> is null.
/// </summary>
internal sealed record ProfileChange(string Key, JsonNode? Value, bool SetsNull = false);

/// <summary>
/// A change to one ruleset, environment or label in a profile file, by name:
/// <paramref name="List"/> is <c>rulesets</c>, <c>environments</c> or <c>labels</c>, and
/// <paramref name="Entry"/> is the entry to write, or null to stop naming it
/// in the file. <paramref name="Draft"/> says whether a drop takes out the
/// file's draft of that name rather than its entry; a write is a draft when
/// the entry has <c>draft: true</c>.
/// </summary>
internal sealed record EntryChange(string List, string Name, JsonObject? Entry, bool Draft = false);

/// <summary>
/// A profile resolved over the profiles it extends. <paramref name="Chain"/> is
/// the file, then each one it extends; <paramref name="Sources"/> names the file
/// behind each value, by section and then by key or entry name.
/// <paramref name="Drafts"/> holds what <paramref name="Values"/> leaves out:
/// draft settings by section, and draft entries by list.
/// <paramref name="DraftSources"/> names the file behind each draft, and
/// <paramref name="Warnings"/> says what stops each draft from applying as it
/// stands.
/// </summary>
internal sealed record ResolvedProfile(
    IReadOnlyList<string> Chain,
    JsonElement Values,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Sources,
    JsonElement Drafts,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> DraftSources,
    IReadOnlyList<string> Warnings)
{
    public string File => Chain[0];

    /// <summary>The file behind one draft, by section and key or name, or null.</summary>
    public string? DraftSource(string section, string key) =>
        DraftSources.TryGetValue(section, out var files) && files.TryGetValue(key, out var file) ? file : null;
}

/// <summary>
/// A staged apply: one apply to <paramref name="Repository"/>, prepared in a
/// file of its own. <paramref name="Layers"/> is it resolved as a profile, with
/// the staged file first; <paramref name="Base"/> is the profile it starts
/// from, or null when it starts from the repository as it is.
/// </summary>
internal sealed record StagedApply(ResolvedProfile Layers, string Repository, string? Base, IReadOnlyList<string> Exclude);

/// <summary>How an apply of a reviewed plan ended.</summary>
internal abstract record ApplyResult
{
    /// <summary>Every change was written.</summary>
    internal sealed record Applied(IReadOnlyList<PlanChangeDocument> Changes) : ApplyResult;

    /// <summary>The repository changed since the plan was made, so nothing was written.</summary>
    internal sealed record Stale(string Message) : ApplyResult;

    /// <summary>A write failed after <paramref name="Changes"/> were written; the rest were not.</summary>
    internal sealed record PartlyApplied(string Message, IReadOnlyList<PlanChangeDocument> Changes, PlanChangeDocument? Failed) : ApplyResult;
}

/// <summary>Reads the CLI's JSON output into what the views show.</summary>
internal sealed class RepottedClient(ICli cli)
{
    /// <summary>
    /// Raised, on the thread that read the failure, just before a command
    /// throws <see cref="SignInLostException"/>, so the app can return to the
    /// sign-in whichever page ran it.
    /// </summary>
    public event EventHandler? SignInLost;

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

    /// <summary>
    /// Checks what each of <paramref name="patterns"/>, allowed action patterns,
    /// matches on GitHub, and answers a check for each, in order. It only reads.
    /// </summary>
    public async Task<IReadOnlyList<ActionCheckDocument>> CheckActionsAsync(
        IReadOnlyList<string> patterns,
        CancellationToken cancellationToken)
    {
        // After --, so a pattern that starts with a dash stays a pattern. The
        // command exits 1 when a pattern matches nothing, and still prints.
        var run = await cli.RunAsync(["check-actions", "--json", "--", .. patterns], null, cancellationToken).ConfigureAwait(false);
        var checks = Read(run, CliJson.Default.ActionChecksDocument).Checks;
        return checks.Count == patterns.Count
            ? checks
            : throw Unreadable(run, $"it checked {checks.Count} of {patterns.Count} patterns.");
    }

    /// <summary>
    /// Searches GitHub's repositories for <paramref name="words"/>, most
    /// starred first. It only reads. GitHub's search limit throws <see cref="RateLimitedException"/>.
    /// </summary>
    public async Task<IReadOnlyList<FoundActionDocument>> FindActionsAsync(string words, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["find-actions", "--json", "--", words], null, cancellationToken).ConfigureAwait(false);
        return Read(run, CliJson.Default.FoundActionsDocument).Results;
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
        return [.. Read(run, CliJson.Default.CaptureDocument).Warnings.Select(warning => warning.Text)];
    }

    /// <summary>
    /// Syncs the profiles in <paramref name="folder"/> with a config repository:
    /// <paramref name="repository"/> and <paramref name="path"/> name it the
    /// first time, and the folder remembers them. <paramref name="prefer"/>,
    /// <c>local</c> or <c>remote</c>, settles files that changed on both sides.
    /// </summary>
    public async Task<SyncDocument> SyncAsync(
        string folder,
        string? repository,
        string? path,
        string? prefer,
        IReadOnlyList<string>? only,
        CancellationToken cancellationToken)
    {
        List<string> arguments = ["sync", folder];
        if (repository is not null)
        {
            arguments.Add($"--repository={repository}");
        }
        if (!string.IsNullOrEmpty(path))
        {
            arguments.Add($"--path={path}");
        }
        // An empty list settles nothing, which no --only at all would not mean.
        if (prefer is not null && only is not { Count: 0 })
        {
            arguments.Add($"--prefer={prefer}");
            arguments.AddRange((only ?? []).Select(file => $"--only={file}"));
        }
        arguments.Add("--json");
        // A sync that leaves conflicts exits 1 and still prints its document.
        var run = await cli.RunAsync(arguments, null, cancellationToken).ConfigureAwait(false);
        return Read(run, CliJson.Default.SyncDocument);
    }

    /// <summary>Writes <paramref name="changes"/> and <paramref name="entries"/> to the profile file, which the CLI checks first.</summary>
    public async Task<ResolvedProfile> SaveProfileAsync(
        string file,
        IReadOnlyList<ProfileChange> changes,
        IReadOnlyList<EntryChange> entries,
        CancellationToken cancellationToken) =>
        await ProfileAsync(["profile", file, .. Edits(changes, entries), "--json"], cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// What <paramref name="file"/> applies now and what it would apply with
    /// <paramref name="changes"/> and <paramref name="entries"/> made, as
    /// profile YAML, without saving them.
    /// </summary>
    public async Task<ProfilePreview> PreviewProfileAsync(
        string file,
        IReadOnlyList<ProfileChange> changes,
        IReadOnlyList<EntryChange> entries,
        CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["profile", file, .. Edits(changes, entries), "--preview", "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        var preview = Read(run, CliJson.Default.ProfilePreviewDocument);
        return new ProfilePreview(preview.Before, preview.After);
    }

    /// <summary>The options that write <paramref name="changes"/> and <paramref name="entries"/>, as <c>profile</c> and <c>stage</c> take them.</summary>
    private static List<string> Edits(IReadOnlyList<ProfileChange> changes, IReadOnlyList<EntryChange> entries)
    {
        List<string> arguments = [];
        foreach (var change in changes)
        {
            arguments.AddRange(change is { Value: null, SetsNull: false }
                ? ["--unset", change.Key]
                : ["--set", $"{change.Key}={change.Value?.ToJsonString() ?? "null"}"]);
        }
        foreach (var entry in entries)
        {
            // --ruleset, --environment, --label and their --drop- options, the draft ones
            // included, joined to their value so a name that starts with a dash
            // stays a value. A write finds the draft or entry its own marker
            // says, or, right after a drop, the one dropped.
            var flag = entry.List[..^1];
            arguments.Add(entry.Entry is null
                ? $"--drop-{(entry.Draft ? "draft-" : "")}{flag}={entry.Name}"
                : $"--{flag}={entry.Entry.ToJsonString()}");
        }
        return arguments;
    }

    /// <summary>
    /// Starts a staged apply to <paramref name="repository"/> in the new file
    /// <paramref name="file"/>, from the profile in <paramref name="profile"/>,
    /// or from the repository as it is when that is null. The CLI never
    /// replaces a file that is already there.
    /// </summary>
    public Task<StagedApply> StartStagedAsync(string file, string repository, string? profile, CancellationToken cancellationToken) =>
        StagedAsync(
            ["stage", file, $"--new={repository}", .. profile is null ? Array.Empty<string>() : [$"--profile={profile}"], "--json"],
            cancellationToken);

    /// <summary>Reads the staged apply in <paramref name="file"/>.</summary>
    public Task<StagedApply> StagedAsync(string file, CancellationToken cancellationToken) =>
        StagedAsync(["stage", file, "--json"], cancellationToken);

    /// <summary>Writes one-off edits to the staged apply in <paramref name="file"/>, as a profile edit writes them to a profile.</summary>
    public async Task<ResolvedProfile> SaveStagedEditsAsync(
        string file,
        IReadOnlyList<ProfileChange> changes,
        IReadOnlyList<EntryChange> entries,
        CancellationToken cancellationToken) =>
        (await StagedAsync(["stage", file, .. Edits(changes, entries), "--json"], cancellationToken).ConfigureAwait(false)).Layers;

    /// <summary>Leaves out what <paramref name="key"/> names, such as <c>rulesets/Main</c>, or stops leaving it out.</summary>
    public Task<StagedApply> ExcludeAsync(string file, string key, bool excluded, CancellationToken cancellationToken) =>
        StagedAsync(["stage", file, excluded ? $"--exclude={key}" : $"--include={key}", "--json"], cancellationToken);

    /// <summary>Writes the staged apply's one-off edits to the profile it starts from, and clears them from it.</summary>
    public Task<StagedApply> SaveStagedToProfileAsync(string file, CancellationToken cancellationToken) =>
        StagedAsync(["stage", file, "--save-to-profile", "--json"], cancellationToken);

    /// <summary>Removes the staged apply file; the profile it starts from stays as it is.</summary>
    public async Task DiscardStagedAsync(string file, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["stage", file, "--discard", "--json"], null, cancellationToken).ConfigureAwait(false);
        if (Failure(run.Output) is { } failure)
        {
            throw Raise(failure);
        }
        if (run.ExitCode != 0)
        {
            throw Unreadable(run, "it did not say the staged apply was removed.");
        }
    }

    private async Task<StagedApply> StagedAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(arguments, null, cancellationToken).ConfigureAwait(false);
        var staged = Read(run, CliJson.Default.StagedApplyDocument);
        if (staged.Chain.Count == 0 || staged.Profile.ValueKind != JsonValueKind.Object)
        {
            throw Unreadable(run, "the staged apply is incomplete.");
        }
        // One-off edits can't be drafts, so their editor gets none.
        return new StagedApply(
            Resolved(staged.Chain, staged.Profile, staged.Sources, NoDrafts, ReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>.Empty, []),
            staged.Repository,
            staged.Base,
            staged.Exclude);
    }

    /// <summary>
    /// Plans the staged apply in <paramref name="file"/>, and saves the plan to
    /// <paramref name="planFile"/>, which <see cref="ApplyAsync"/> applies. It
    /// only reads from GitHub.
    /// </summary>
    public async Task<StagedPlanDocument> PlanStagedAsync(string file, string planFile, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["plan", $"--staged={file}", $"--out={planFile}", "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        var plan = Read(run, CliJson.Default.StagedPlanDocument);
        if (plan.Desired.ValueKind != JsonValueKind.Object)
        {
            throw Unreadable(run, "the plan has no profile.");
        }
        return plan;
    }

    /// <summary>
    /// Applies the reviewed plan in <paramref name="planFile"/>. The CLI plans
    /// again first and writes only if the result is the reviewed plan; a
    /// repository that changed since gives <see cref="ApplyResult.Stale"/>.
    /// This writes to GitHub.
    /// </summary>
    public async Task<ApplyResult> ApplyAsync(string planFile, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["apply", planFile, "--yes", "--json"], null, cancellationToken).ConfigureAwait(false);
        ApplyErrorDetail? error;
        try
        {
            error = JsonSerializer.Deserialize(run.Output, CliJson.Default.ApplyFailureDocument)?.Error;
        }
        catch (JsonException)
        {
            error = null;
        }
        return error switch
        {
            { Kind: "stale_plan" } => new ApplyResult.Stale(error.Message),
            { Kind: "apply_failed" } => new ApplyResult.PartlyApplied(error.Message, error.Applied ?? [], error.Failed),
            { } => throw Raise(new ErrorDetail(error.Kind, error.Message)),
            null => new ApplyResult.Applied(Read(run, CliJson.Default.ApplyDocument).Applied),
        };
    }

    /// <summary>
    /// Starts a batch in the new folder <paramref name="folder"/>: a staged apply
    /// in <paramref name="stagedFolder"/> for each of <paramref name="repositories"/>,
    /// from the profile in <paramref name="profile"/>, or from each repository as
    /// it is when that is null, and each staged apply in <paramref name="join"/>
    /// as it is. A failed start leaves no file behind.
    /// </summary>
    public Task<BatchDocument> StartBatchAsync(
        string folder,
        string stagedFolder,
        IReadOnlyList<string> repositories,
        IReadOnlyList<string> join,
        string? profile,
        CancellationToken cancellationToken) =>
        BatchAsync(
            [
                "stage", folder, "--batch",
                // Only new staged applies need a place; the CLI refuses one for a batch that only joins.
                .. repositories.Count == 0 ? Array.Empty<string>() : [$"--staged-dir={stagedFolder}"],
                .. repositories.Select(repository => $"--new={repository}"),
                .. join.Select(file => $"--join={file}"),
                .. profile is null ? Array.Empty<string>() : [$"--profile={profile}"],
                "--json",
            ],
            cancellationToken);

    /// <summary>Reads the batch in <paramref name="folder"/>.</summary>
    public Task<BatchDocument> BatchAsync(string folder, CancellationToken cancellationToken) =>
        BatchAsync(["stage", folder, "--json"], cancellationToken);

    /// <summary>Leaves <paramref name="repository"/> out of the batch's plans and applies, or puts it back.</summary>
    public Task<BatchDocument> LeaveOutOfBatchAsync(string folder, string repository, bool leftOut, CancellationToken cancellationToken) =>
        BatchAsync(["stage", folder, leftOut ? $"--leave-out={repository}" : $"--put-back={repository}", "--json"], cancellationToken);

    private async Task<BatchDocument> BatchAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(arguments, null, cancellationToken).ConfigureAwait(false);
        return Read(run, CliJson.Default.BatchDocument);
    }

    /// <summary>
    /// Leaves out what <paramref name="key"/> names in every repository of the
    /// batch whose profile sets it, or stops leaving it out in each. A
    /// repository whose one-off edits set it keeps its staged apply, and is
    /// named in the answer.
    /// </summary>
    public async Task<EverywhereDocument> ExcludeEverywhereAsync(string folder, string key, bool excluded, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(
            ["stage", folder, excluded ? $"--exclude={key}" : $"--include={key}", "--everywhere", "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        return Read(run, CliJson.Default.EverywhereDocument);
    }

    /// <summary>
    /// Plans every repository of the batch in <paramref name="folder"/>, and
    /// saves the plan to <paramref name="planFile"/>, which
    /// <see cref="ApplyBatchMemberAsync"/> applies. It only reads from GitHub.
    /// </summary>
    public async Task<BatchPlanDocument> PlanBatchAsync(string folder, string planFile, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["plan", $"--staged={folder}", $"--out={planFile}", "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        var plan = Read(run, CliJson.Default.BatchPlanDocument);
        if (plan.Plans.Any(member => member.Desired.ValueKind != JsonValueKind.Object))
        {
            throw Unreadable(run, "a repository's plan has no profile.");
        }
        // A lost sign-in fails every repository alike, so it is the app's to handle, not one repository's.
        if (plan.Failures.FirstOrDefault(failure => failure.Error.Kind == "signed_out") is { } signedOut)
        {
            throw Raise(new ErrorDetail(signedOut.Error.Kind, signedOut.Error.Message));
        }
        return plan;
    }

    /// <summary>
    /// Applies one repository of the reviewed batch plan in
    /// <paramref name="planFile"/>. The CLI plans it again first, and writes
    /// only if its changes are the reviewed ones and its staged apply is still
    /// the one reviewed. This writes to GitHub.
    /// </summary>
    public async Task<MemberResultDocument> ApplyBatchMemberAsync(string planFile, string repository, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["apply", planFile, $"--only={repository}", "--yes", "--json"], null, cancellationToken)
            .ConfigureAwait(false);
        var results = Read(run, CliJson.Default.BatchApplyDocument).Results;
        if (results.Count != 1)
        {
            throw Unreadable(run, $"it did not say how {repository} went.");
        }
        return results[0].Error is { Kind: "signed_out" } signedOut
            ? throw Raise(new ErrorDetail(signedOut.Kind, signedOut.Message))
            : results[0];
    }

    /// <summary>Ends the batch: discards the staged applies it started; one that joined it stays, as do the profiles.</summary>
    public async Task DiscardBatchAsync(string folder, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["stage", folder, "--discard", "--json"], null, cancellationToken).ConfigureAwait(false);
        if (Failure(run.Output) is { } failure)
        {
            throw Raise(failure);
        }
        if (run.ExitCode != 0)
        {
            throw Unreadable(run, "it did not say the batch was removed.");
        }
    }

    private async Task<ResolvedProfile> ProfileAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(arguments, null, cancellationToken).ConfigureAwait(false);
        var profile = Read(run, CliJson.Default.ResolvedProfileDocument);
        if (profile.Chain.Count == 0
            || profile.Profile.ValueKind != JsonValueKind.Object
            || profile.Drafts.ValueKind != JsonValueKind.Object)
        {
            throw Unreadable(run, "the profile is incomplete.");
        }
        return Resolved(profile.Chain, profile.Profile, profile.Sources, profile.Drafts, profile.Sources.Drafts, profile.Warnings);
    }

    /// <summary>No drafts, for the one-off edits of a staged apply.</summary>
    private static readonly JsonElement NoDrafts = EmptyObject();

    private static JsonElement EmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static ResolvedProfile Resolved(
        IReadOnlyList<string> chain,
        JsonElement values,
        ProfileSourcesDocument sources,
        JsonElement drafts,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> draftSources,
        IReadOnlyList<string> warnings) =>
        new(
            chain,
            values,
            new Dictionary<string, IReadOnlyDictionary<string, string>>
            {
                ["repository"] = sources.Repository,
                ["merge"] = sources.Merge,
                ["actions"] = sources.Actions,
                ["security"] = sources.Security,
                ["custom_properties"] = sources.CustomProperties,
                ["pages"] = sources.Pages,
                ["autolinks"] = sources.Autolinks,
                ["rulesets"] = sources.Rulesets,
                ["environments"] = sources.Environments,
                ["labels"] = sources.Labels,
            },
            drafts,
            draftSources,
            warnings);

    /// <summary>Removes the Repotted sign-in from the keychain, if there is one.</summary>
    public async Task SignOutAsync(CancellationToken cancellationToken)
    {
        var run = await cli.RunAsync(["logout", "--json"], null, cancellationToken).ConfigureAwait(false);
        Read(run, CliJson.Default.LogoutDocument);
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
                if (Failure(line) is { } failure)
                {
                    throw Raise(failure);
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
                throw Failure(run.Output) is { } failure
                    ? Raise(failure)
                    : new CliException(Crash(run) ?? "The sign-in did not start.");
            default:
                throw new CliException("The sign-in ended without signing in.");
        }
    }

    /// <summary>An https link, or null for anything else.</summary>
    private static Uri? Link(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? uri : null;

    /// <summary>
    /// Reads one document. A failure document becomes a <see cref="CliException"/>
    /// with its message, or a <see cref="SignInLostException"/> for a lost
    /// sign-in; output the app cannot read becomes a <see cref="CliException"/>.
    /// </summary>
    private T Read<T>(CliRun run, JsonTypeInfo<T> type)
        where T : class
    {
        if (Failure(run.Output) is { } failure)
        {
            throw Raise(failure);
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

    private static ErrorDetail? Failure(string output)
    {
        try
        {
            return JsonSerializer.Deserialize(output, CliJson.Default.FailureDocument)?.Error;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The exception a failure document stands for; a lost sign-in raises <see cref="SignInLost"/> first.</summary>
    private CliException Raise(ErrorDetail failure)
    {
        if (failure.Kind != "signed_out")
        {
            return failure.RateLimited ? new RateLimitedException(failure.Message) : new CliException(failure.Message);
        }
        SignInLost?.Invoke(this, EventArgs.Empty);
        return new SignInLostException(failure.Message);
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

    private static CliOutputException Unreadable(CliRun run, string detail) =>
        new(Crash(run) ?? $"Could not read what the Repotted command line printed: {detail}");
}
