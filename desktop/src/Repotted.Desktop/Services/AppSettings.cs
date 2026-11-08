using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Repotted.Desktop.Services;

/// <summary>
/// What the app remembers between runs. With <paramref name="ConfigRepository"/>
/// set, as <c>owner/name</c>, profiles live in that repository, in
/// <paramref name="ConfigPath"/> or at its root, and the app keeps its working
/// copy in the app data folder; otherwise they live in
/// <paramref name="ProfilesFolder"/>.
/// </summary>
internal sealed record SettingsDocument(
    string? ProfilesFolder = null,
    string? ConfigRepository = null,
    string? ConfigPath = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower, WriteIndented = true)]
[JsonSerializable(typeof(SettingsDocument))]
internal sealed partial class SettingsJson : JsonSerializerContext;

/// <summary>
/// The app's settings, kept in <c>settings.json</c> in the per-user app data
/// folder: <c>~/Library/Application Support/Repotted</c> on macOS and
/// <c>%APPDATA%\Repotted</c> on Windows. Never beside the app, which an update
/// replaces and which may not be writable.
/// </summary>
internal sealed partial class AppSettings(string folder)
{
    private string File => Path.Combine(folder, "settings.json");

    public static AppSettings ForUser()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var data = OperatingSystem.IsMacOS()
            ? Path.Combine(home, "Library", "Application Support")
            : Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return new AppSettings(Path.Combine(data, "Repotted"));
    }

    /// <summary>The visible folder profiles go in until the user picks another: Documents/Repotted.</summary>
    public static string DefaultProfilesFolder()
    {
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (string.IsNullOrEmpty(documents))
        {
            documents = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Documents");
        }
        return Path.Combine(documents, "Repotted");
    }

    /// <summary>
    /// Where the app keeps its working copy of a config repository's profiles,
    /// one folder for each repository and folder in it. The CLI's sync record
    /// in it remembers which.
    /// </summary>
    public string ConfigFolder(string repository, string path)
    {
        if (!IsRepositoryName(repository))
        {
            throw new ArgumentException($"Expected a repository as owner/name, not {repository}.", nameof(repository));
        }
        var parts = repository.ToLowerInvariant().Split('/');
        // A folder in the repository could not be told from the root's own subfolders, so it gets a name of its own.
        var where = path.Length == 0
            ? "root"
            : $"folder-{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(path)))[..12]}";
        return Path.Combine([folder, "config", .. parts, where]);
    }

    /// <summary>
    /// Where the app keeps the staged apply to <paramref name="repository"/>:
    /// one for each repository, so an apply left unfinished is there to pick
    /// up again. The plan under review sits beside it.
    /// </summary>
    public string StagedFile(string repository)
    {
        if (!IsRepositoryName(repository))
        {
            throw new ArgumentException($"Expected a repository as owner/name, not {repository}.", nameof(repository));
        }
        var parts = repository.ToLowerInvariant().Split('/');
        return Path.Combine(folder, "staged", parts[0], $"{parts[1]}.yaml");
    }

    /// <summary>The folder that holds every staged apply the app starts, one for each repository.</summary>
    public string StagedFolder => Path.Combine(folder, "staged");

    /// <summary>
    /// Where the app keeps its batch: one profile applied to several
    /// repositories, through a staged apply for each in <see cref="StagedFolder"/>.
    /// The app keeps one batch at a time.
    /// </summary>
    public string BatchFolder => Path.Combine(folder, "batch");

    /// <summary>The batch's plan under review, beside the batch folder.</summary>
    public string BatchPlanFile => Path.Combine(folder, "batch.plan.json");

    /// <summary>Whether the app's batch is there, unfinished.</summary>
    public bool HasBatch => System.IO.File.Exists(Path.Combine(BatchFolder, "batch.yaml"));

    /// <summary>The plan under review for the staged apply in <paramref name="stagedFile"/>.</summary>
    public static string PlanFile(string stagedFile) => Path.ChangeExtension(stagedFile, ".plan.json");

    /// <summary>
    /// Whether <paramref name="repository"/> is an owner and a name as GitHub
    /// allows them. Neither is only dots, so a working copy never leaves the
    /// folder that holds them.
    /// </summary>
    public static bool IsRepositoryName(string repository) => RepositoryName().IsMatch(repository);

    [GeneratedRegex(@"^(?!\.+/)[\w.-]+/(?!\.+$)[\w.-]+$")]
    private static partial Regex RepositoryName();

    /// <summary>
    /// The saved settings, or none when there are none yet or they cannot be
    /// read. A config repository that is not a repository name is left out.
    /// </summary>
    public SettingsDocument Load()
    {
        try
        {
            using var stream = System.IO.File.OpenRead(File);
            var saved = JsonSerializer.Deserialize(stream, SettingsJson.Default.SettingsDocument) ?? new SettingsDocument();
            return saved.ConfigRepository is { } repository && !IsRepositoryName(repository)
                ? saved with { ConfigRepository = null, ConfigPath = null }
                : saved;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return new SettingsDocument();
        }
    }

    /// <summary>Replaces the settings file whole; throws an IO or access error when it cannot.</summary>
    public void Save(SettingsDocument settings)
    {
        Directory.CreateDirectory(folder);
        var temporary = $"{File}.tmp";
        try
        {
            System.IO.File.WriteAllText(temporary, JsonSerializer.Serialize(settings, SettingsJson.Default.SettingsDocument));
            System.IO.File.Move(temporary, File, overwrite: true);
        }
        catch
        {
            System.IO.File.Delete(temporary);
            throw;
        }
    }
}
