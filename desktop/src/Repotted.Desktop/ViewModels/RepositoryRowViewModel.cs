using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A section of a repository's setup, as the row and the detail panel show it.
/// Until the repository follows a profile, no section is managed.
/// </summary>
internal sealed record SectionStatus(string Name);

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

    public IReadOnlyList<SectionStatus> Sections { get; } = [.. SectionNames.Select(name => new SectionStatus(name))];

    /// <summary>What a screen reader says for the row.</summary>
    public string Description => $"{FullName}, {(Private ? "private" : "public")}{(Archived ? ", archived" : "")}, no profile";

    public Uri GitHubUrl => new($"https://github.com/{FullName}");
}
