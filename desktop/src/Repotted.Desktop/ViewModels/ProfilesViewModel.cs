using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A profile in the sidebar list.</summary>
internal sealed class ProfileItemViewModel(ProfileListingDocument listing, string? baseName)
{
    public ProfileListingDocument Listing => listing;

    public string? BaseName => baseName;

    public string Name => Listing.Name;

    public bool Invalid => Listing.Problem is not null;

    /// <summary>The note beside the name: what it extends, or that it cannot be used.</summary>
    public string Note => Invalid ? "Has a problem" : BaseName is null ? "" : $"extends {BaseName}";
}

/// <summary>
/// The profiles in the profiles folder, which the user picks and the app
/// remembers. It starts as Documents/Repotted. Each profile opens in an editor,
/// and an editor keeps its unsaved edits while another profile is open.
/// </summary>
internal sealed partial class ProfilesViewModel(RepottedClient client, IDesktop desktop, AppSettings settings)
    : ViewModelBase
{
    private readonly Dictionary<string, ProfileViewModel> editors = [];

    private IReadOnlyList<ProfileItemViewModel> all = [];

    private int refreshes;

    public ObservableCollection<ProfileItemViewModel> Items { get; } = [];

    /// <summary>Every profile without a problem, whatever the search, for a compare.</summary>
    [ObservableProperty]
    public partial IReadOnlyList<ProfileItemViewModel> Usable { get; private set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile))]
    public partial string Folder { get; private set; } = settings.Load().ProfilesFolder ?? AppSettings.DefaultProfilesFolder();

    [ObservableProperty]
    public partial ProfileItemViewModel? Selected { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowProfile))]
    public partial ProfileViewModel? Current { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile))]
    public partial bool Loading { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowEmpty), nameof(ShowProfile))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowEmpty), nameof(ShowProfile), nameof(HasProfiles))]
    public partial int Count { get; set; }

    public bool HasProfiles => Count > 0;

    public bool ShowEmpty => !Loading && Error is null && Count == 0;

    public bool ShowProfile => !Loading && Error is null && Current is not null;

    public string EmptyMessage => $"No profiles in {Folder} yet.";

    /// <summary>Narrows the sidebar list by name.</summary>
    [ObservableProperty]
    public partial string Filter { get; set; } = "";

    partial void OnFilterChanged(string value) => ApplyFilter();

    /// <summary>Why the app could not remember the folder; the folder is still used until the app closes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNotice))]
    public partial string? Notice { get; set; }

    public bool HasNotice => Notice is not null;

    partial void OnSelectedChanged(ProfileItemViewModel? value)
    {
        if (value is not null)
        {
            Open(value.Listing);
        }
    }

    /// <summary>Shows a profile's editor, made and loaded the first time the profile opens.</summary>
    private void Open(ProfileListingDocument listing)
    {
        if (!editors.TryGetValue(listing.File, out var editor))
        {
            editor = new ProfileViewModel(client, listing);
            editors[listing.File] = editor;
            _ = editor.LoadCommand.ExecuteAsync(null);
        }
        Current = editor;
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        // A refresh started later, such as for a newly chosen folder, wins over one still running.
        var refresh = ++refreshes;
        var folder = Folder;
        Loading = true;
        Error = null;
        try
        {
            // The default folder is the app's to make; a folder the user picked already exists.
            if (settings.Load().ProfilesFolder is null)
            {
                Directory.CreateDirectory(folder);
            }
            var listings = await client.ProfilesAsync(folder, CancellationToken.None).ConfigureAwait(true);
            if (refresh != refreshes)
            {
                return;
            }
            // A linked file is listed under its real path, so two names can share one file.
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var listing in listings)
            {
                names.TryAdd(listing.File, listing.Name);
            }
            all =
            [
                .. listings.Select(listing => new ProfileItemViewModel(
                    listing,
                    listing.Extends is null ? null : names.GetValueOrDefault(listing.Extends) ?? Path.GetFileNameWithoutExtension(listing.Extends))),
            ];
            Count = all.Count;
            Usable = [.. all.Where(item => !item.Invalid)];
            // Editors start over from the file, which may have changed outside
            // the app, unless they hold edits that are not saved yet.
            foreach (var (file, editor) in editors.ToList())
            {
                if (!editor.HasChanges || !names.ContainsKey(file))
                {
                    editors.Remove(file);
                }
            }
            var keep = Current?.File;
            Current = null;
            ApplyFilter();
            if (Items.FirstOrDefault(item => item.Listing.File == keep) is { } shown)
            {
                Selected = shown;
                Open(shown.Listing);
            }
            else if (all.FirstOrDefault(item => item.Listing.File == keep) is { } hidden)
            {
                // The search hides it, but it stays open.
                Open(hidden.Listing);
            }
            else
            {
                Selected = Items.FirstOrDefault();
                if (Selected is not null)
                {
                    Open(Selected.Listing);
                }
            }
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            if (refresh == refreshes)
            {
                Error = error.Message;
            }
        }
        finally
        {
            if (refresh == refreshes)
            {
                Loading = false;
            }
        }
    }

    [RelayCommand]
    private async Task ChangeFolderAsync()
    {
        if (await desktop.PickFolderAsync("Choose the profiles folder").ConfigureAwait(true) is not { } folder)
        {
            return;
        }
        Notice = null;
        try
        {
            settings.Save(settings.Load() with { ProfilesFolder = folder });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Notice = $"Repotted could not remember this folder for next time: {error.Message}";
        }
        Folder = folder;
        OnPropertyChanged(nameof(EmptyMessage));
        Selected = null;
        await RefreshAsync().ConfigureAwait(true);
    }

    private void ApplyFilter()
    {
        var keep = Selected;
        Items.Clear();
        foreach (var item in all.Where(item => item.Name.Contains(Filter.Trim(), StringComparison.OrdinalIgnoreCase)))
        {
            Items.Add(item);
        }
        if (keep is not null && Items.Contains(keep))
        {
            Selected = keep;
        }
    }
}
