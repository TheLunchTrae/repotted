using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The form that makes a GitHub repository, or a folder in it, the place
/// profiles live. It syncs once before anything is remembered, so a
/// repository Repotted cannot reach never replaces the profiles in use.
/// </summary>
internal sealed partial class ConfigRepositoryViewModel : ViewModelBase, IDisposable
{
    private readonly RepottedClient client;
    private readonly AppSettings settings;
    private readonly string? localFolder;
    private readonly Func<string, string, SyncDocument, IReadOnlyList<string>, Task> connected;
    private readonly Action cancel;

    /// <summary>Stops the first sync once the form closes, however it closes.</summary>
    private readonly CancellationTokenSource closed = new();

    private bool disposed;

    /// <param name="client">Runs the first sync.</param>
    /// <param name="settings">Where the working copy goes.</param>
    /// <param name="repositories">The repositories Repotted can reach, by full name.</param>
    /// <param name="current">The repository and folder in use, if profiles already live in one.</param>
    /// <param name="localFolder">The local profiles folder in use, whose profiles can start the repository; null when there are none.</param>
    /// <param name="connected">Runs with the repository, the folder in it, the first sync once it succeeds, and the local profiles left out because the repository has a file of that name.</param>
    /// <param name="cancel">Closes the form.</param>
    public ConfigRepositoryViewModel(
        RepottedClient client,
        AppSettings settings,
        IReadOnlyList<string> repositories,
        (string Repository, string Path)? current,
        string? localFolder,
        Func<string, string, SyncDocument, IReadOnlyList<string>, Task> connected,
        Action cancel)
    {
        this.client = client;
        this.settings = settings;
        this.localFolder = localFolder;
        this.connected = connected;
        this.cancel = cancel;
        Repositories = repositories;
        Repository = current?.Repository ?? "";
        Path = current?.Path ?? "";
        CopyLocal = localFolder is not null;
    }

    public IReadOnlyList<string> Repositories { get; }

    /// <summary>The repository as <c>owner/name</c>, picked from the list or typed.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ConnectCommand))]
    public partial string Repository { get; set; }

    /// <summary>The folder in the repository; empty for its root.</summary>
    [ObservableProperty]
    public partial string Path { get; set; }

    /// <summary>Whether a new working copy starts with the local folder's profiles, which the sync then commits.</summary>
    [ObservableProperty]
    public partial bool CopyLocal { get; set; }

    public bool CanCopyLocal => localFolder is not null;

    public string CopyLocalLabel => $"Add the profiles from {localFolder}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? Error { get; private set; }

    public bool HasError => Error is not null;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ConnectCommand))]
    public partial bool Working { get; private set; }

    private string Name => Repository.Trim();

    /// <summary>The folder in the repository as the CLI records it: no slashes at either end.</summary>
    private string Folder => Path.Trim().Trim('/');

    private bool CanConnect() => !Working && AppSettings.IsRepositoryName(Name);

    [RelayCommand(CanExecute = nameof(CanConnect))]
    private async Task ConnectAsync()
    {
        Working = true;
        Error = null;
        var name = Name;
        var path = Folder;
        var folder = settings.ConfigFolder(name, path);
        // A working copy that has never synced is this form's to start, and to clear if the sync fails.
        var fresh = !File.Exists(System.IO.Path.Combine(folder, ".repotted-sync.json"));
        List<string> copied = [];
        List<string> skipped = [];
        try
        {
            if (CopyLocal && localFolder is not null)
            {
                Directory.CreateDirectory(folder);
                foreach (var file in ProfileFolder.ProfileFiles(localFolder))
                {
                    var target = ProfileFolder.Native(folder, file);
                    if (File.Exists(target))
                    {
                        skipped.Add(file);
                    }
                    else
                    {
                        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
                        File.Copy(ProfileFolder.Native(localFolder, file), target);
                        copied.Add(target);
                    }
                }
            }
            var result = await client.SyncAsync(folder, name, path, null, null, closed.Token).ConfigureAwait(true);
            await connected(name, path, result, skipped).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException or OperationCanceledException)
        {
            var stopped = error is OperationCanceledException && disposed;
            // Nothing synced, so the copies would otherwise go up the next time.
            try
            {
                if (fresh)
                {
                    Directory.Delete(folder, recursive: true);
                }
                else
                {
                    copied.ForEach(File.Delete);
                }
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            {
                // The next connect finds the same files and copies nothing over them.
            }
            if (!stopped)
            {
                Error = error.Message;
            }
        }
        finally
        {
            Working = false;
        }
    }

    [RelayCommand]
    private void Cancel() => cancel();

    /// <summary>Closes the form, which stops a first sync still running.</summary>
    public void Dispose()
    {
        if (!disposed)
        {
            disposed = true;
            closed.Cancel();
            closed.Dispose();
        }
    }

}
