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
internal sealed partial class NewProfileViewModel : ViewModelBase
{
    private static readonly SearchValues<char> Unsafe = SearchValues.Create("/\\:*?\"<>|");

    private readonly RepottedClient client;
    private readonly string folder;
    private readonly Func<string, IReadOnlyList<string>, Task> created;
    private readonly Action cancel;

    /// <param name="client">Captures a repository.</param>
    /// <param name="folder">The profiles folder, where the file goes.</param>
    /// <param name="bases">The profiles a new one can extend.</param>
    /// <param name="repositories">The repositories a new one can be captured from, by full name.</param>
    /// <param name="repository">A repository to capture, when the form opens for one.</param>
    /// <param name="created">Runs with the new file and what a capture could not read.</param>
    /// <param name="cancel">Closes the form.</param>
    public NewProfileViewModel(
        RepottedClient client,
        string folder,
        IReadOnlyList<ProfileItemViewModel> bases,
        IReadOnlyList<string> repositories,
        string? repository,
        Func<string, IReadOnlyList<string>, Task> created,
        Action cancel)
    {
        this.client = client;
        this.folder = folder;
        this.created = created;
        this.cancel = cancel;
        Bases = bases;
        Repositories = repositories;
        Base = bases.Count > 0 ? bases[0] : null;
        Repository = repository ?? (repositories.Count > 0 ? repositories[0] : null);
        Start = repository is null ? NewProfileStart.Empty : NewProfileStart.Capture;
        if (repository is not null)
        {
            Name = repository.Split('/')[^1];
        }
    }

    public IReadOnlyList<ProfileItemViewModel> Bases { get; }

    public IReadOnlyList<string> Repositories { get; }

    public bool HasBases => Bases.Count > 0;

    public bool HasRepositories => Repositories.Count > 0;

    /// <summary>The file name without its extension.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Problem), nameof(HasProblem), nameof(FileName), nameof(ShowFileName))]
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial string Name { get; set; } = "";

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
    [NotifyCanExecuteChangedFor(nameof(CreateCommand))]
    public partial bool Working { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? Error { get; private set; }

    public bool HasError => Error is not null;

    /// <summary>Why the name cannot be used; nothing while it is still empty.</summary>
    public string? Problem
    {
        get
        {
            var name = Name.Trim();
            if (name.Length == 0)
            {
                return null;
            }
            if (name.AsSpan().ContainsAny(Unsafe) || name.Any(char.IsControl) || name.StartsWith('.'))
            {
                return "A name cannot start with a dot or hold / \\ : * ? \" < > |.";
            }
            return Taken(name) is { } taken ? $"{taken} is already in this folder." : null;
        }
    }

    public bool HasProblem => Problem is not null;

    /// <summary>The file already in the folder under this name, as a .yaml or .yml file in any case.</summary>
    private string? Taken(string name)
    {
        if (!Directory.Exists(folder))
        {
            return null;
        }
        return Directory.EnumerateFileSystemEntries(folder)
            .Select(Path.GetFileName)
            .FirstOrDefault(entry => entry is not null
                && (string.Equals(entry, $"{name}.yaml", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(entry, $"{name}.yml", StringComparison.OrdinalIgnoreCase)));
    }

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
        var file = Path.Combine(folder, FileName);
        try
        {
            IReadOnlyList<string> warnings = [];
            switch (Start)
            {
                case NewProfileStart.Capture:
                    // Checked again here: the name was free when it was typed.
                    if (Taken(Name.Trim()) is { } taken)
                    {
                        Error = $"{taken} is already in this folder.";
                        return;
                    }
                    warnings = await client.CaptureAsync(Repository!, file, CancellationToken.None).ConfigureAwait(true);
                    break;
                case NewProfileStart.Extends:
                    Write(file, $"extends: {Quoted(Path.GetRelativePath(folder, Base!.Listing.File))}\n");
                    break;
                default:
                    Write(file, "");
                    break;
            }
            await created(file, warnings).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Error = error.Message;
        }
        finally
        {
            Working = false;
        }
    }

    [RelayCommand]
    private void Cancel() => cancel();

    /// <summary>Creates the file, and fails rather than replace one.</summary>
    private static void Write(string file, string text)
    {
        using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write);
        stream.Write(Encoding.UTF8.GetBytes(text));
    }

    /// <summary>A YAML double-quoted string; JSON's escapes are YAML's too.</summary>
    private static string Quoted(string text) =>
        $"\"{JsonEncodedText.Encode(text.Replace('\\', '/'), JavaScriptEncoder.UnsafeRelaxedJsonEscaping)}\"";
}
