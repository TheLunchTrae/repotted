using System.Text.Json;
using System.Text.Json.Serialization;

namespace Repotted.Desktop.Services;

/// <summary>
/// What <c>repotted status --json</c> prints. Signed in, it has the login and
/// name; signed out, the reason, message and problems.
/// </summary>
internal sealed record StatusDocument(
    bool SignedIn,
    string? TokenVariable,
    string? InstallUrl,
    string? Login = null,
    string? Name = null,
    string? Reason = null,
    string? Message = null,
    IReadOnlyList<string>? Problems = null);

/// <summary>A repository the account administers, from <c>repotted repos --json</c>.</summary>
internal sealed record RepositoryDocument(string FullName, bool Private, bool Archived);

/// <summary>What <c>repotted repos --json</c> prints.</summary>
internal sealed record RepositoryListDocument(string Source, IReadOnlyList<RepositoryDocument> Repositories);

/// <summary>A profile in the profiles folder, from <c>repotted profiles --json</c>.</summary>
internal sealed record ProfileListingDocument(string Name, string File, string? Extends, string? Problem);

/// <summary>What <c>repotted profiles --json</c> prints.</summary>
internal sealed record ProfileListDocument(IReadOnlyList<ProfileListingDocument> Profiles);

/// <summary>The file behind each value of a resolved profile.</summary>
internal sealed record ProfileSourcesDocument(
    IReadOnlyDictionary<string, string> Repository,
    IReadOnlyDictionary<string, string> Merge,
    IReadOnlyDictionary<string, string> Actions,
    IReadOnlyDictionary<string, string> Rulesets,
    IReadOnlyDictionary<string, string> Environments);

/// <summary>
/// What <c>repotted profile --json</c> prints: the profile file, then each one
/// it extends; the resolved profile; and the file behind each value.
/// </summary>
internal sealed record ResolvedProfileDocument(
    IReadOnlyList<string> Chain,
    JsonElement Profile,
    ProfileSourcesDocument Sources);

/// <summary>
/// One field a change writes: what GitHub has and what the profile wants. A
/// member the CLI leaves out reads as <see cref="JsonValueKind.Undefined"/>,
/// apart from a JSON null: GitHub has no value at all, rather than a null one.
/// </summary>
internal sealed record FieldChangeDocument(string Field, JsonElement From = default, JsonElement To = default);

/// <summary>One write of a plan. The app shows it and never sends it.</summary>
internal sealed record PlanChangeDocument(
    string Section,
    string Action,
    string Target,
    IReadOnlyList<FieldChangeDocument> Fields);

/// <summary>What <c>repotted plan --json</c> prints: the resolved profile and the writes that bring the repository in line.</summary>
internal sealed record PlanDocument(
    string Repository,
    JsonElement Desired,
    IReadOnlyList<PlanChangeDocument> Changes,
    IReadOnlyList<string> Warnings);

/// <summary>What <c>repotted capture --json</c> prints: the repository's setup as a profile, and what it could not read.</summary>
internal sealed record CaptureDocument(string Repository, JsonElement Profile, IReadOnlyList<string> Warnings);

/// <summary>
/// What <c>repotted sync --json</c> prints: where the folder synced to, and
/// the files it pulled, pushed and left in conflict, by path in the folder.
/// </summary>
internal sealed record SyncDocument(
    string Repository,
    string Path,
    string Branch,
    string? Commit,
    IReadOnlyList<string> Pulled,
    IReadOnlyList<string> Pushed,
    IReadOnlyList<string> Conflicts);

/// <summary>The <c>error</c> member of a failure.</summary>
internal sealed record ErrorDetail(string Kind, string Message);

/// <summary>Any document that may hold a failure.</summary>
internal sealed record FailureDocument(ErrorDetail? Error = null);

/// <summary>What <c>repotted logout --json</c> prints: whether there was a sign-in to remove.</summary>
internal sealed record LogoutDocument(bool Removed);

/// <summary>One line of <c>repotted login --json</c>.</summary>
internal sealed record LoginEvent(
    string Event,
    string? VerificationUri = null,
    string? UserCode = null,
    DateTimeOffset? ExpiresAt = null,
    ErrorDetail? Error = null);

// Members the CLI always prints are required and keep their nullability, so a
// renamed or retyped field fails to parse instead of reading as missing.
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    PropertyNameCaseInsensitive = false,
    RespectRequiredConstructorParameters = true,
    RespectNullableAnnotations = true)]
[JsonSerializable(typeof(StatusDocument))]
[JsonSerializable(typeof(RepositoryListDocument))]
[JsonSerializable(typeof(ProfileListDocument))]
[JsonSerializable(typeof(ResolvedProfileDocument))]
[JsonSerializable(typeof(PlanDocument))]
[JsonSerializable(typeof(CaptureDocument))]
[JsonSerializable(typeof(SyncDocument))]
[JsonSerializable(typeof(FailureDocument))]
[JsonSerializable(typeof(LoginEvent))]
[JsonSerializable(typeof(LogoutDocument))]
internal sealed partial class CliJson : JsonSerializerContext;
