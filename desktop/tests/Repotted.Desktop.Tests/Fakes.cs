using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>Answers each command with canned output, and records what ran.</summary>
internal sealed class FakeCli : ICli
{
    private readonly Dictionary<string, Func<Action<string>?, CancellationToken, Task<CliRun>>> answers = [];

    public List<string> Calls { get; } = [];

    /// <summary>Answers <paramref name="command"/> with one document and an exit code.</summary>
    public FakeCli On(string command, string output, int exitCode = 0)
    {
        answers[command] = (onLine, _) =>
        {
            foreach (var line in output.Split('\n'))
            {
                onLine?.Invoke(line);
            }
            return Task.FromResult(new CliRun(exitCode, output));
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
            return new CliRun(exitCode, string.Join('\n', lines) + "\n");
        };
        return this;
    }

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

/// <summary>Records the links opened and the text copied.</summary>
internal sealed class FakeDesktop : IDesktop
{
    public List<Uri> Opened { get; } = [];

    public List<string> Copied { get; } = [];

    public void OpenUrl(Uri url) => Opened.Add(url);

    public Task CopyTextAsync(string text)
    {
        Copied.Add(text);
        return Task.CompletedTask;
    }
}

internal static class Documents
{
    public const string SignedIn =
        """{"signed_in":true,"login":"TheLunchTrae","name":"Trae","token_variable":null}""";

    public const string SignedOut =
        """{"signed_in":false,"reason":"not_signed_in","message":"Not signed in to GitHub. Run repotted login, or set GITHUB_TOKEN.","problems":[],"token_variable":null}""";

    public const string Rejected =
        """{"signed_in":false,"reason":"rejected","message":"GitHub rejected the sign-in. Run repotted login again.","problems":[],"token_variable":null}""";

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
