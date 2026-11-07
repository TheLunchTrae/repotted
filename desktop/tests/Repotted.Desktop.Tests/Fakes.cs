using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>Answers each command with canned output, and records what ran.</summary>
internal sealed class FakeCli : ICli
{
    private readonly Dictionary<string, Func<Action<string>?, CancellationToken, Task<CliRun>>> answers = [];

    public List<string> Calls { get; } = [];

    /// <summary>Answers <paramref name="command"/> with one document, an exit code, and what it said on stderr.</summary>
    public FakeCli On(string command, string output, int exitCode = 0, string error = "")
    {
        answers[command] = (onLine, _) =>
        {
            foreach (var line in output.Split('\n'))
            {
                onLine?.Invoke(line);
            }
            return Task.FromResult(new CliRun(exitCode, output, error));
        };
        return this;
    }

    /// <summary>Answers <paramref name="command"/> with JSON Lines, waiting on <paramref name="between"/> after the first.</summary>
    public FakeCli OnLines(string command, IReadOnlyList<string> lines, Task? between = null, int exitCode = 0)
    {
        answers[command] = async (onLine, cancellationToken) =>
        {
            for (var index = 0; index < lines.Count; index++)
            {
                if (index == 1 && between is not null)
                {
                    await between.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                onLine?.Invoke(lines[index]);
            }
            return new CliRun(exitCode, string.Join('\n', lines) + "\n", "");
        };
        return this;
    }

    public bool Answers(string command) => answers.ContainsKey(command);

    public FakeCli Missing(string command)
    {
        answers[command] = (_, _) => throw new CliNotFoundException("Could not start the Repotted command line (repotted).");
        return this;
    }

    public Task<CliRun> RunAsync(IReadOnlyList<string> arguments, Action<string>? onLine, CancellationToken cancellationToken)
    {
        var command = string.Join(' ', arguments);
        Calls.Add(command);
        return answers.TryGetValue(command, out var answer)
            ? answer(onLine, cancellationToken)
            : throw new InvalidOperationException($"No answer for: {command}");
    }
}

/// <summary>Records the links opened and the text copied, and picks the folder it was given.</summary>
internal sealed class FakeDesktop : IDesktop
{
    public List<Uri> Opened { get; } = [];

    public List<string> Copied { get; } = [];

    /// <summary>The folder the next pick returns; null when the user cancels.</summary>
    public string? Folder { get; set; }

    public Task<string?> PickFolderAsync(string title) => Task.FromResult(Folder);

    public Task OpenUrlAsync(Uri url)
    {
        Opened.Add(url);
        return Task.CompletedTask;
    }

    public Task CopyTextAsync(string text)
    {
        Copied.Add(text);
        return Task.CompletedTask;
    }
}

/// <summary>
/// App settings in a folder of their own, with a profiles folder already
/// chosen, so tests never touch the user's settings or Documents.
/// </summary>
internal sealed class Folders : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("repotted-desktop-").FullName;

    public Folders()
    {
        Profiles = Path.Combine(root, "profiles");
        Directory.CreateDirectory(Profiles);
        Settings = new AppSettings(Path.Combine(root, "settings"));
        Settings.Save(new SettingsDocument(Profiles));
    }

    public string Profiles { get; }

    public AppSettings Settings { get; }

    /// <summary>The command that lists <paramref name="folder"/>, the profiles folder by default.</summary>
    public string List(string? folder = null) => $"profiles {folder ?? Profiles} --json";

    /// <summary>Writes a profile file, which the editor shows as its YAML.</summary>
    public string Write(string name, string yaml)
    {
        var file = Path.Combine(Profiles, name);
        File.WriteAllText(file, yaml);
        return file;
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}

internal static class Documents
{
    public const string NoProfiles = """{"profiles":[]}""";

    /// <summary>A listing of two profiles: one, and the base it extends.</summary>
    public static string Profiles(string own, string @base) =>
        $$$"""
        {"profiles":[
          {"name":"base","file":{{{Json(@base)}}},"extends":null,"problem":null},
          {"name":"orgs","file":{{{Json(own)}}},"extends":{{{Json(@base)}}},"problem":null}
        ]}
        """;

    /// <summary>
    /// orgs over base: the wiki and squash merges set in orgs, issues and
    /// rebase merges from base, and nothing else managed.
    /// </summary>
    public static string Resolved(string own, string @base, bool wiki = false) =>
        $$$"""
        {"chain":[{{{Json(own)}}},{{{Json(@base)}}}],
         "profile":{
           "repository":{"has_issues":true,"has_wiki":{{{(wiki ? "true" : "false")}}} },
           "merge":{"allow_rebase_merge":true,"allow_squash_merge":false},
           "rulesets":[{"name":"Protect main"},{"name":"Old tags","absent":true}],
           "environments":[{"name":"npm"}]},
         "sources":{
           "repository":{"has_issues":{{{Json(@base)}}},"has_wiki":{{{Json(own)}}} },
           "merge":{"allow_rebase_merge":{{{Json(@base)}}},"allow_squash_merge":{{{Json(own)}}} },
           "actions":{},
           "rulesets":{"Protect main":{{{Json(@base)}}},"Old tags":{{{Json(own)}}} },
           "environments":{"npm":{{{Json(own)}}} } } }
        """;

    /// <summary>base alone: issues on, set in base itself.</summary>
    public static string ResolvedBase(string @base) =>
        $$$"""
        {"chain":[{{{Json(@base)}}}],"profile":{"repository":{"has_issues":true}},
         "sources":{"repository":{"has_issues":{{{Json(@base)}}} },"merge":{},"actions":{},"rulesets":{},"environments":{} } }
        """;

    private static string Json(string text) => $"\"{System.Text.Encodings.Web.JavaScriptEncoder.Default.Encode(text)}\"";

    public static readonly Uri InstallUrl = new("https://github.com/apps/repotted-app/installations/new");

    public const string SignedIn =
        """{"signed_in":true,"login":"TheLunchTrae","name":"Trae","token_variable":null,"install_url":"https://github.com/apps/repotted-app/installations/new"}""";

    public const string SignedOut =
        """{"signed_in":false,"reason":"not_signed_in","message":"Not signed in to GitHub. Run repotted login, or set GITHUB_TOKEN.","problems":[],"token_variable":null,"install_url":"https://github.com/apps/repotted-app/installations/new"}""";

    public const string Rejected =
        """{"signed_in":false,"reason":"rejected","message":"GitHub rejected the sign-in. Run repotted login again.","problems":[],"token_variable":null,"install_url":"https://github.com/apps/repotted-app/installations/new"}""";

    public const string Repositories =
        """
        {"source":"installations","repositories":[
          {"full_name":"TheLunchTrae/github-setup","private":false,"archived":false},
          {"full_name":"TheLunchTrae/repotted","private":false,"archived":false},
          {"full_name":"TheLunchTrae/test-repo","private":true,"archived":false}
        ]}
        """;

    public const string Code =
        """{"event":"code","verification_uri":"https://github.com/login/device","user_code":"ABCD-1234","expires_at":"2026-11-07T08:00:00.000Z"}""";

    public const string Done =
        """{"event":"signed_in","install_url":"https://github.com/apps/repotted-app/installations/new","token_variable":null}""";
}
