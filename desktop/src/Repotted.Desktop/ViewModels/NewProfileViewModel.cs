using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>What a new profile starts from.</summary>
internal enum NewProfileStart
{
    /// <summary>Nothing: the profile manages nothing until it is edited.</summary>
    Empty,

    /// <summary>Another profile in the folder, which it extends.</summary>
    Extends,

    /// <summary>A repository's setup as it is on GitHub now.</summary>
    Capture,
}

/// <summary>
/// A new profile file in the profiles folder: empty, extending another
/// profile, or captured from a repository. It never replaces a file, and a
/// capture only reads from GitHub.
/// </summary>
internal sealed partial class NewProfileViewModel : ViewModelBase, IDisposable
{
    private static readonly SearchValues<char> Unsafe = SearchValues.Create("/\\:*?\"<>|");

    private static readonly HashSet<string> Reserved = new(
        ["CON", "PRN", "AUX", "NUL", .. Enumerable.Range(1, 9).SelectMany(n => new[] { $"COM{n}", $"LPT{n}" })],
        StringComparer.OrdinalIgnoreCase);

    private readonly RepottedClient client;

    /// <summary>The folder's path when the form opened, where the file goes.</summary>
    private readonly string folder;

    /// <summary>Where moving a finished capture to its name takes its turn with saves and syncs.</summary>
    private readonly ProfileFolder profileFolder;

    private readonly Func<string, IReadOnlyList<string>, Task> created;
    private readonly Action cancel;
    private readonly Action released;
    private readonly ISet<string> captures;

    /// <summary>The profile file this form's capture will make, while it runs.</summary>
    private string? capturing;

    /// <summary>Stops a capture once the form closes, however it closes.</summary>
    private readonly CancellationTokenSource closed = new();

    private bool disposed;

    /// <param name="client">Captures a repository.</param>
    /// <param name="folder">The profiles folder, where the file goes, and which runs the move of a capture apart from saves and syncs.</param>
    /// <param name="bases">The profiles a new one can extend.</param>
    /// <param name="repositories">The repositories a new one can be captured from, by full name.</param>
    /// <param name="repository">A repository to capture, when the form opens for one.</param>
    /// <param name="created">Runs with the new file and what a capture could not read.</param>
    /// <param name="cancel">Closes the form.</param>
    /// <param name="released">Runs once the form gives up a name it held, so another form can take it.</param>
    /// <param name="captures">The profile files that captures still running will make, which every form shares.</param>
    public NewProfileViewModel(
        RepottedClient client,
        ProfileFolder folder,
        IReadOnlyList<ProfileItemViewModel> bases,
        IReadOnlyList<string> repositories,
        string? repository,
        Func<string, IReadOnlyList<string>, Task> created,
        Action cancel,
        Action released,
        ISet<string> captures)
    {
        this.client = client;
        this.folder = folder.Path;
        profileFolder = folder;
        this.created = created;
        this.cancel = cancel;
        this.released = released;
        this.captures = captures;
        Bases = bases;
        Repositories = repositories;
        Base = bases.Count > 0 ? bases[0] : null;
        Repository = repository ?? (repositories.Count > 0 ? repositories[0] : null);
        Start = repository is null ? NewProfileStart.Empty : NewProfileStart.Capture;
        if (repository is not null)
        {
            // A repository such as .github has a name a file cannot start with.
            Name = repository.Split('/')[^1].TrimStart('.');
        }
    }

    public IReadOnlyList<ProfileItemViewModel> Bases { get; }

    public IReadOnlyList<string> Repositories { get; }

    public bool HasBases => Bases.Count > 0;

    public bool HasRepositories => Repositories.Count > 0;

    public string ExtendsHelp => HasBases
        ? "Extends it, so it gets every setting the other one sets."
        : "There is no other profile in this folder to extend yet.";

    public string CaptureHelp => HasRepositories
        ? "Captures its settings, rulesets and environments as they are on GitHub now. This only reads from GitHub."
        : "No repositories are listed. Add the Repotted App to one, then start a new profile again.";

    /// <summary>The file name without its extension.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FileName), nameof(ShowFileName))]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial string Name { get; set; } = "";

    partial void OnNameChanged(string value) => Problem = Check(value.Trim());

    public string FileName => $"{Name.Trim()}.yaml";

    /// <summary>Whether the file name shows: once there is a name, and it can be used.</summary>
    public bool ShowFileName => Name.Trim().Length > 0 && Problem is null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StartsEmpty), nameof(Extends), nameof(Captures), nameof(CreateLabel))]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial NewProfileStart Start { get; set; }

    // Radio buttons bind one of these each.
    public bool StartsEmpty
    {
        get => Start == NewProfileStart.Empty;
        set => Choose(value, NewProfileStart.Empty);
    }

    public bool Extends
    {
        get => Start == NewProfileStart.Extends;
        set => Choose(value, NewProfileStart.Extends);
    }

    public bool Captures
    {
        get => Start == NewProfileStart.Capture;
        set => Choose(value, NewProfileStart.Capture);
    }

    private void Choose(bool chosen, NewProfileStart start)
    {
        if (chosen)
        {
            Start = start;
        }
    }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial ProfileItemViewModel? Base { get; set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial string? Repository { get; set; }

    public string CreateLabel => Captures ? "Capture" : "Create";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Editable))]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial bool Working { get; private set; }

    /// <summary>Whether the name and what the profile starts from can change: not while it is being made.</summary>
    public bool Editable => !Working;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? Error { get; private set; }

    public bool HasError => Error is not null;

    /// <summary>Why the name cannot be used; nothing while it is still empty.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProblem), nameof(ShowFileName))]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial string? Problem { get; private set; }

    private string? Check(string name)
    {
        if (name.Length == 0)
        {
            return null;
        }
        if (name.AsSpan().ContainsAny(Unsafe) || name.Any(char.IsControl) || name.StartsWith('.'))
        {
            return "A name cannot start with a dot or hold / \\ : * ? \" < > |.";
        }
        // Windows keeps these names for devices, so a profile under one cannot be shared.
        if (Reserved.Contains(name.Split('.')[0].TrimEnd()))
        {
            return $"Windows keeps the name {name} for itself, so it cannot be a file there.";
        }
        return InUse(name);
    }

    /// <summary>Why the folder has no room for <paramref name="name"/>: a file of that name, or another capture making one.</summary>
    private string? InUse(string name) =>
        Taken(name) is { } taken ? $"{taken} is already in this folder."
        : Path.Combine(folder, $"{name}.yaml") is var file && captures.Contains(file) && !string.Equals(file, capturing, StringComparison.OrdinalIgnoreCase)
            ? $"Another capture is making {name}.yaml."
        : null;

    public bool HasProblem => Problem is not null;

    /// <summary>Checks the name again, since the folder may have changed under it.</summary>
    public void Recheck() => Problem = Check(Name.Trim());

    /// <summary>
    /// A file of its own for a capture to write before it takes
    /// <paramref name="fileName"/>. It starts with a dot and is not a .yaml
    /// file, so neither a sync nor the list reads it. Only a capture still
    /// running holds the name, through <see cref="captures"/>, and another
    /// copy of the app capturing the same name writes a file of its own.
    /// </summary>
    private string Hold(string fileName) => Path.Combine(folder, $".{fileName}.{Path.GetRandomFileName()}.repotted-capture");

    /// <summary>The file already in the folder under this name, as a .yaml or .yml file in any case.</summary>
    private string? Taken(string name) =>
        Entries().FirstOrDefault(entry =>
            string.Equals(entry, $"{name}.yaml", StringComparison.OrdinalIgnoreCase)
            || string.Equals(entry, $"{name}.yml", StringComparison.OrdinalIgnoreCase));

    /// <summary>The profile file named <paramref name="name"/> as the folder lists it, which is how the CLI names it.</summary>
    private string? Entry(string name) =>
        Entries().FirstOrDefault(entry =>
            string.Equals(entry, $"{name}.yaml", StringComparison.Ordinal)
            || string.Equals(entry, $"{name}.yml", StringComparison.Ordinal))
        ?? Taken(name);

    private IEnumerable<string> Entries() =>
        Directory.Exists(folder)
            ? Directory.EnumerateFileSystemEntries(folder).Select(entry => Path.GetFileName(entry))
            : [];

    private bool CanCreate() =>
        !Working
        && Name.Trim().Length > 0
        && Problem is null
        && Start switch
        {
            NewProfileStart.Extends => Base is not null,
            NewProfileStart.Capture => Repository is not null,
            _ => true,
        };

    [RelayCommand(CanExecute = nameof(CanCreate))]
    private async Task CreateAsync()
    {
        Working = true;
        Error = null;
        // The name as it was when Create was pressed, which the whole capture keeps.
        var name = Name.Trim();
        var fileName = $"{name}.yaml";
        var file = Path.Combine(folder, fileName);
        string? hold = null;
        try
        {
            // The name was free when it was typed; the folder may have changed since.
            if (InUse(name) is { } problem)
            {
                Error = problem;
                return;
            }
            IReadOnlyList<string> warnings = [];
            switch (Start)
            {
                case NewProfileStart.Capture:
                    // The profile takes its name only once it is whole, so no sync
                    // commits, and no list shows, a capture still under way.
                    hold = Hold(fileName);
                    captures.Add(file);
                    capturing = file;
                    warnings = await client.CaptureAsync(Repository!, hold, closed.Token).ConfigureAwait(true);
                    // Apart from saves and syncs, so a pull cannot write the name between
                    // the check and the move: on macOS and Linux a move that does not
                    // overwrite checks and then renames, which replaces a file written
                    // in between. Only reading GitHub runs outside, since it takes long.
                    var placed = false;
                    await profileFolder.WriteAsync(() =>
                    {
                        if (!disposed)
                        {
                            Error = Place(name, hold, file);
                            placed = Error is null;
                        }
                        return Task.CompletedTask;
                    }).ConfigureAwait(true);
                    if (!placed)
                    {
                        return;
                    }
                    break;
                case NewProfileStart.Extends:
                    // The base's own name in the folder: the CLI follows it from the
                    // new file's real folder, which a path from the folder as picked may not reach.
                    var entry = Entry(Base!.Name) ?? throw new FileNotFoundException($"{Base.Name} is no longer in this folder.");
                    Write(file, $"extends: {Quoted(entry)}\n");
                    break;
                default:
                    Write(file, "");
                    break;
            }
            await created(file, warnings).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (disposed)
        {
            // The form closed; the user has moved on.
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Error = error.Message;
        }
        finally
        {
            Working = false;
            if (hold is not null)
            {
                // Any capture gives up the name once it ends.
                captures.Remove(file);
                capturing = null;
                released();
                // A capture that failed or was stopped leaves nothing behind, unless the
                // file cannot go; it then holds no name, as when the app quits.
                try
                {
                    File.Delete(hold);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
    }

    /// <summary>
    /// Moves a finished capture to the profile's name, and says why it cannot:
    /// a sync may have brought in a file of that name while GitHub was read.
    /// One of the same name makes the move fail; one that differs only in case
    /// would not on every disk, so it is checked first.
    /// </summary>
    private string? Place(string name, string hold, string file)
    {
        if (Taken(name) is { } other && other != Path.GetFileName(file))
        {
            return $"{other} is already in this folder.";
        }
        try
        {
            File.Move(hold, file, overwrite: false);
            return null;
        }
        catch (IOException) when (Taken(name) is { } taken)
        {
            return $"{taken} is already in this folder.";
        }
    }

    [RelayCommand]
    private void Cancel() => cancel();

    /// <summary>Closes the form, which stops a capture still running.</summary>
    public void Dispose()
    {
        if (!disposed)
        {
            disposed = true;
            closed.Cancel();
            closed.Dispose();
        }
    }

    /// <summary>Creates the file, and fails rather than replace one.</summary>
    private static void Write(string file, string text)
    {
        using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write);
        stream.Write(Encoding.UTF8.GetBytes(text));
    }

    /// <summary>A YAML double-quoted string; JSON's escapes are YAML's too.</summary>
    private static string Quoted(string text) =>
        $"\"{JsonEncodedText.Encode(text, JavaScriptEncoder.UnsafeRelaxedJsonEscaping)}\"";
}
