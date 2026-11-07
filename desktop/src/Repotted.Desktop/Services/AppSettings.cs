using System.Text.Json;
using System.Text.Json.Serialization;

namespace Repotted.Desktop.Services;

/// <summary>What the app remembers between runs.</summary>
internal sealed record SettingsDocument(string? ProfilesFolder = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower, WriteIndented = true)]
[JsonSerializable(typeof(SettingsDocument))]
internal sealed partial class SettingsJson : JsonSerializerContext;

/// <summary>
/// The app's settings, kept in <c>settings.json</c> in the per-user app data
/// folder: <c>~/Library/Application Support/Repotted</c> on macOS and
/// <c>%APPDATA%\Repotted</c> on Windows. Never beside the app, which an update
/// replaces and which may not be writable.
/// </summary>
internal sealed class AppSettings(string folder)
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

    /// <summary>The saved settings, or none when there are none yet or they cannot be read.</summary>
    public SettingsDocument Load()
    {
        try
        {
            using var stream = System.IO.File.OpenRead(File);
            return JsonSerializer.Deserialize(stream, SettingsJson.Default.SettingsDocument) ?? new SettingsDocument();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return new SettingsDocument();
        }
    }

    public void Save(SettingsDocument settings)
    {
        Directory.CreateDirectory(folder);
        var temporary = $"{File}.tmp";
        System.IO.File.WriteAllText(temporary, JsonSerializer.Serialize(settings, SettingsJson.Default.SettingsDocument));
        System.IO.File.Move(temporary, File, overwrite: true);
    }
}
