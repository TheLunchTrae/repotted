using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Repotted.Desktop.Services;

/// <summary>What a finished CLI run printed on stdout and stderr, and how it exited.</summary>
internal sealed record CliRun(int ExitCode, string Output, string Error);

/// <summary>Runs the Repotted CLI, which does all the reading and writing on GitHub.</summary>
internal interface ICli
{
    /// <summary>
    /// Runs the CLI with <paramref name="arguments"/>. Each line of stdout goes to
    /// <paramref name="onLine"/> as it arrives, for commands that print JSON Lines.
    /// </summary>
    Task<CliRun> RunAsync(IReadOnlyList<string> arguments, Action<string>? onLine, CancellationToken cancellationToken);
}

/// <summary>The CLI could not be started, so nothing it would print exists.</summary>
internal sealed class CliNotFoundException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Starts the CLI as a child process. REPOTTED_CLI names it: a .js file runs
/// with node, a .ts file with bun, and anything else directly. Without it, the
/// app runs the repotted-cli that ships beside it, then repotted on the PATH.
/// </summary>
internal sealed class RepottedCli(string fileName, IReadOnlyList<string> prefix) : ICli
{
    public static RepottedCli Locate() =>
        Locate(Environment.GetEnvironmentVariable("REPOTTED_CLI"), AppContext.BaseDirectory);

    /// <param name="configured">REPOTTED_CLI, if set.</param>
    /// <param name="directory">The folder the app runs from.</param>
    internal static RepottedCli Locate(string? configured, string directory)
    {
        configured = configured?.Trim();
        if (!string.IsNullOrEmpty(configured))
        {
            return FromPath(configured);
        }
        // The shipped CLI cannot be named repotted: where file names ignore case,
        // as on macOS and Windows, that is the app's own Repotted.
        var executable = OperatingSystem.IsWindows() ? "repotted-cli.exe" : "repotted-cli";
        var bundled = Path.Combine(directory, executable);
        return new RepottedCli(File.Exists(bundled) ? bundled : "repotted", []);
    }

    internal static RepottedCli FromPath(string path) =>
        Path.GetExtension(path).ToUpperInvariant() switch
        {
            ".JS" or ".MJS" => new RepottedCli("node", [path]),
            ".TS" => new RepottedCli("bun", [path]),
            _ => new RepottedCli(path, []),
        };

    internal string FileName => fileName;

    internal IReadOnlyList<string> Prefix => prefix;

    public async Task<CliRun> RunAsync(
        IReadOnlyList<string> arguments,
        Action<string>? onLine,
        CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in prefix.Concat(arguments))
        {
            start.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = start };
        try
        {
            process.Start();
        }
        catch (Win32Exception error)
        {
            throw new CliNotFoundException(
                $"Could not start the Repotted command line ({fileName}). Set REPOTTED_CLI to its path.",
                error);
        }
        // The CLI never prompts in JSON mode; a closed stdin makes sure it cannot wait.
        process.StandardInput.Close();

        var output = new StringBuilder();
        var stderr = process.StandardError.ReadToEndAsync(CancellationToken.None);
        // The process must not outlive the run, whether it is cancelled or a
        // line handler throws: a sign-in left running could finish on its own.
        using var stop = cancellationToken.Register(() => Stop(process));
        try
        {
            while (await process.StandardOutput.ReadLineAsync(cancellationToken).ConfigureAwait(false) is { } line)
            {
                output.AppendLine(line);
                onLine?.Invoke(line);
            }
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (!process.HasExited)
            {
                Stop(process);
            }
        }
        var errors = await stderr.ConfigureAwait(false);
        return new CliRun(process.ExitCode, output.ToString(), errors);
    }

    private static void Stop(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // It exited first.
        }
    }
}
