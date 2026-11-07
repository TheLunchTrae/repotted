using System.Text.Json.Serialization;

namespace Repotted.Desktop.Services;

/// <summary>What <c>repotted status --json</c> prints.</summary>
internal sealed record StatusDocument(
    bool SignedIn,
    string? Login,
    string? Name,
    string? TokenVariable,
    string? Reason,
    string? Message,
    IReadOnlyList<string>? Problems);

/// <summary>A repository the account administers, from <c>repotted repos --json</c>.</summary>
internal sealed record RepositoryDocument(string FullName, bool Private, bool Archived);

/// <summary>What <c>repotted repos --json</c> prints.</summary>
internal sealed record RepositoryListDocument(string Source, IReadOnlyList<RepositoryDocument> Repositories);

/// <summary>The <c>error</c> member of a failure.</summary>
internal sealed record ErrorDetail(string Kind, string Message);

/// <summary>Any document that may hold a failure.</summary>
internal sealed record FailureDocument(ErrorDetail? Error);

/// <summary>One line of <c>repotted login --json</c>.</summary>
internal sealed record LoginEvent(
    string Event,
    string? VerificationUri,
    string? UserCode,
    DateTimeOffset? ExpiresAt,
    string? InstallUrl,
    string? TokenVariable,
    ErrorDetail? Error);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    PropertyNameCaseInsensitive = false)]
[JsonSerializable(typeof(StatusDocument))]
[JsonSerializable(typeof(RepositoryListDocument))]
[JsonSerializable(typeof(FailureDocument))]
[JsonSerializable(typeof(LoginEvent))]
internal sealed partial class CliJson : JsonSerializerContext;
