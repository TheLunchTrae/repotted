using CommunityToolkit.Mvvm.ComponentModel;

namespace Repotted.Desktop.ViewModels;

/// <summary>The heading over one owner's repositories in the list, which can't be selected.</summary>
/// <param name="Owner">The owner's login.</param>
/// <param name="Personal">Whether the owner is the signed-in account.</param>
/// <param name="Count">How many of the owner's repositories the list shows under it.</param>
internal sealed record OwnerHeading(string Owner, bool Personal, int Count)
{
    /// <summary>What a screen reader says for the heading.</summary>
    public string Description => $"{Owner}{(Personal ? ", personal" : "")}, {Count} {(Count == 1 ? "repository" : "repositories")}";
}

/// <summary>An owner in the owner filter, ticked when the list shows its repositories.</summary>
internal sealed partial class OwnerChoice(string owner, bool personal, int count, Action changed) : ObservableObject
{
    public string Owner { get; } = owner;

    /// <summary>Whether the owner is the signed-in account.</summary>
    public bool Personal { get; } = personal;

    /// <summary>How many repositories the owner has in the list, whatever the search.</summary>
    public int Count { get; } = count;

    /// <summary>What a screen reader says for the owner's checkbox.</summary>
    public string Description => $"{Owner}{(Personal ? ", personal" : "")}, {Count} {(Count == 1 ? "repository" : "repositories")}";

    [ObservableProperty]
    public partial bool Shown { get; set; }

    partial void OnShownChanged(bool value) => changed();
}
