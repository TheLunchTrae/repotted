using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// The Preview sheet: what a profile applies now against what it applies once
/// Save runs, the draft and the unsaved changes together, as a diff of profile
/// YAML with runs of unchanged lines folded.
/// </summary>
internal sealed class ProfilePreviewViewModel
{
    public ProfilePreviewViewModel(string name, ProfilePreview preview, int drafts, int unsaved)
    {
        Title = $"Preview changes to {name}";
        var lines = PlanDiff.Diff(Lines(preview.Before), Lines(preview.After))
            .Select(line => line with { OfProfile = true })
            .ToList();
        Diff = new PlanDiffViewModel(lines);
        Message = (drafts, unsaved) switch
        {
            (0, _) => "What applies now against what applies once you save. Save as draft keeps these changes without applying them.",
            (_, 0) => "What applies now against what applies once you save the draft.",
            _ => $"What applies now against what applies once you save: the draft, and {Count(unsaved, "change")} not saved yet. Save as draft keeps them all without applying them.",
        };
    }

    public string Title { get; }

    public string Message { get; }

    public PlanDiffViewModel Diff { get; }

    /// <summary>Whether Save would apply nothing new, such as a change put back as it was.</summary>
    public bool Matches => Diff.Changes == 0;

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";

    private static List<string> Lines(string yaml) =>
        [.. yaml.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd('\n').Split('\n').Where(_ => yaml.Length > 0)];
}
