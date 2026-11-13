using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Repotted.Desktop.ViewModels;

/// <summary>A row of the profiles tree in the sidebar: a profile, or a subfolder of the profiles folder.</summary>
internal abstract partial class ProfileTreeNode : ObservableObject
{
    /// <summary>Whether a subfolder shows what it holds; a profile holds nothing, so it stays as it is.</summary>
    [ObservableProperty]
    public partial bool IsExpanded { get; set; }

    /// <summary>What a screen reader says for the row.</summary>
    public abstract string SpokenName { get; }
}

/// <summary>A subfolder of the profiles folder, with the profiles and subfolders in it.</summary>
internal sealed partial class ProfileFolderNode : ProfileTreeNode
{
    /// <param name="path">The subfolder from the profiles folder, with <c>/</c> separators.</param>
    public ProfileFolderNode(string path)
    {
        Path = path;
        Name = path[(path.LastIndexOf('/') + 1)..];
    }

    /// <summary>The subfolder from the profiles folder, with <c>/</c> separators, such as <c>team/apps</c>.</summary>
    public string Path { get; }

    public string Name { get; }

    /// <summary>Its profiles first, then its subfolders.</summary>
    public ObservableCollection<ProfileTreeNode> Children { get; } = [];

    /// <summary>How many profiles it holds, its subfolders' included.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SpokenName))]
    public partial int Count { get; set; }

    public override string SpokenName => $"{Name}, {Count} {(Count == 1 ? "profile" : "profiles")}";
}
