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

/// <summary>
/// The file behind each value of a resolved profile. <c>Drafts</c> gives the
/// same for drafts, by section and then key or name; it is null from a CLI
/// without drafts.
/// </summary>
internal sealed record ProfileSourcesDocument(
    IReadOnlyDictionary<string, string> Repository,
    IReadOnlyDictionary<string, string> Merge,
    IReadOnlyDictionary<string, string> Actions,
    IReadOnlyDictionary<string, string> Security,
    IReadOnlyDictionary<string, string> CustomProperties,
    IReadOnlyDictionary<string, string> Pages,
    IReadOnlyDictionary<string, string> Autolinks,
    IReadOnlyDictionary<string, string> Rulesets,
    IReadOnlyDictionary<string, string> Environments,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? Drafts = null);

/// <summary>
/// What <c>repotted profile --json</c> prints: the profile file, then each one
/// it extends; the resolved profile, which leaves out its drafts; the drafts,
/// by section, and what stops each from applying; and the file behind each
/// value.
/// </summary>
internal sealed record ResolvedProfileDocument(
    IReadOnlyList<string> Chain,
    JsonElement Profile,
    ProfileSourcesDocument Sources,
    JsonElement Drafts = default,
    IReadOnlyList<string>? Warnings = null);

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

/// <summary>
/// What the GitHub App may do on the repository: <paramref name="Status"/> is
/// <c>installed</c>, <c>not_installed</c> or <c>unknown</c>, and
/// <paramref name="SettingsUrl"/> is the installation's settings page, when installed.
/// </summary>
internal sealed record AppAccessDocument(string Status, string? SettingsUrl = null);

/// <summary>What the account and its App may change on the repository; a null role is one GitHub did not report.</summary>
internal sealed record AccessDocument(string? Role, AppAccessDocument App);

/// <summary>A change Repotted cannot make, by its index in the plan's changes, and why.</summary>
internal sealed record LockDocument(int Change, string Reason);

/// <summary>
/// What <c>repotted plan --json</c> prints: the resolved profile, the writes
/// that bring the repository in line, and the writes Repotted cannot make.
/// </summary>
internal sealed record PlanDocument(
    string Repository,
    JsonElement Desired,
    IReadOnlyList<PlanChangeDocument> Changes,
    IReadOnlyList<string> Warnings,
    AccessDocument Access,
    IReadOnlyList<LockDocument> Locks,
    IReadOnlyList<SkippedDocument>? Skipped = null);

/// <summary>A draft a plan leaves out: a setting by its section and key, or an entry by its list and name.</summary>
internal sealed record SkippedDocument(string Section, string Target);

/// <summary>
/// What a staged apply holds, from <c>repotted stage --json</c>: the repository
/// it applies to, the profile it starts from, or null when it starts from the
/// repository as it is, and what it leaves out. <paramref name="Chain"/>,
/// <paramref name="Profile"/> and <paramref name="Sources"/> are as in a
/// resolved profile, with the staged file first.
/// </summary>
internal sealed record StagedApplyDocument(
    string File,
    string Repository,
    string? Base,
    IReadOnlyList<string> Exclude,
    IReadOnlyList<string> Chain,
    JsonElement Profile,
    ProfileSourcesDocument Sources);

/// <summary>The staged apply a plan was made from, as <c>repotted plan --staged --json</c> names it.</summary>
internal sealed record StagedSummaryDocument(string File, string Repository, string? Base, IReadOnlyList<string> Exclude);

/// <summary>
/// What leaves one change of a staged plan out, or one field of it:
/// <paramref name="Key"/> is what <c>stage --exclude</c> takes. An
/// <paramref name="Edited"/> value is a one-off edit, which is undone rather
/// than excluded.
/// </summary>
internal sealed record PlanExclusionDocument(int Change, string? Field, string Key, bool Edited);

/// <summary>What <c>repotted plan --staged --json</c> prints: the plan, the staged apply it was made from, and what leaves out each change.</summary>
internal sealed record StagedPlanDocument(
    string Repository,
    JsonElement Desired,
    IReadOnlyList<PlanChangeDocument> Changes,
    IReadOnlyList<string> Warnings,
    AccessDocument Access,
    IReadOnlyList<LockDocument> Locks,
    StagedSummaryDocument Staged,
    IReadOnlyList<PlanExclusionDocument> Exclusions)
{
    /// <summary>The plan alone, as a compare shows it, with what Repotted can't change.</summary>
    public PlanDocument Plan => new(Repository, Desired, Changes, Warnings, Access, Locks);
}

/// <summary>What <c>repotted apply --json</c> prints once every change is written.</summary>
internal sealed record ApplyDocument(string Repository, IReadOnlyList<PlanChangeDocument> Applied);

/// <summary>
/// The <c>error</c> member of a failed apply: <c>stale_plan</c> when the
/// repository changed since the plan, which writes nothing, and
/// <c>apply_failed</c> when a write failed after <paramref name="Applied"/>.
/// </summary>
internal sealed record ApplyErrorDetail(
    string Kind,
    string Message,
    IReadOnlyList<PlanChangeDocument>? Applied = null,
    PlanChangeDocument? Failed = null);

/// <summary>A failed apply.</summary>
internal sealed record ApplyFailureDocument(ApplyErrorDetail? Error = null);

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
[JsonSerializable(typeof(StagedApplyDocument))]
[JsonSerializable(typeof(StagedPlanDocument))]
[JsonSerializable(typeof(ApplyDocument))]
[JsonSerializable(typeof(ApplyFailureDocument))]
[JsonSerializable(typeof(SyncDocument))]
[JsonSerializable(typeof(FailureDocument))]
[JsonSerializable(typeof(LoginEvent))]
[JsonSerializable(typeof(LogoutDocument))]
internal sealed partial class CliJson : JsonSerializerContext;
