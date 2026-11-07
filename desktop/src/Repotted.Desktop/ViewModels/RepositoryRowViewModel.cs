using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>One managed section's bar in the Sections column.</summary>
internal enum SectionState
{
    InLine,
    Differs,
    NotManaged,
}

/// <summary>A section of a repository's setup, as the row and the detail panel show it.</summary>
internal sealed record SectionStatus(string Name, SectionState State)
{
    public bool InLine => State == SectionState.InLine;

    public bool Differs => State == SectionState.Differs;

    public bool NotManaged => State == SectionState.NotManaged;
}

/// <summary>A repository in the list. Until it follows a profile, every section is unmanaged.</summary>
internal sealed class RepositoryRowViewModel(RepositoryDocument repository) : ViewModelBase
{
    /// <summary>The sections a profile can manage, in the order the app shows them.</summary>
    internal static readonly string[] SectionNames =
        ["Repository settings", "Merge methods", "Actions", "Rulesets", "Environments"];

    public string FullName { get; } = repository.FullName;

    public string Owner { get; } = repository.FullName.Split('/')[0] + "/";

    public string Name { get; } = repository.FullName.Split('/') is [_, var name] ? name : repository.FullName;

    public bool Private { get; } = repository.Private;

    public bool Archived { get; } = repository.Archived;

    public string Visibility => (Private, Archived) switch
    {
        (true, true) => "Private, archived.",
        (true, false) => "Private.",
        (false, true) => "Public, archived.",
        _ => "Public.",
    };

    public IReadOnlyList<SectionStatus> Sections { get; } =
        [.. SectionNames.Select(name => new SectionStatus(name, SectionState.NotManaged))];

    public Uri GitHubUrl => new($"https://github.com/{FullName}");
}
