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

/// <summary>The <c>error</c> member of a failure.</summary>
internal sealed record ErrorDetail(string Kind, string Message);

/// <summary>Any document that may hold a failure.</summary>
internal sealed record FailureDocument(ErrorDetail? Error = null);

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
[JsonSerializable(typeof(FailureDocument))]
[JsonSerializable(typeof(LoginEvent))]
internal sealed partial class CliJson : JsonSerializerContext;
