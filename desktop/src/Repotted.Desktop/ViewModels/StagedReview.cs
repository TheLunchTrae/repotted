using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// What a review shows of one staged apply's plan: the rows to leave out or
/// put back, the plan as a diff, and the notes beside them. The Apply page and
/// each repository of a batch show it the same way.
/// </summary>
internal sealed record StagedReview(
    string? BaseName,
    IReadOnlyList<CompareSectionViewModel> Sections,
    PlanDiffViewModel Diff,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<ExcludedViewModel> Excluded,
    string AccessLabel,
    Uri? AccessUrl,
    string? DraftsNote,
    int ChangeCount)
{
    /// <summary>How many rows the plan's locks say GitHub will refuse.</summary>
    public int Locked => Sections.Sum(section => section.Differences.Count(row => row.IsLocked));

    /// <summary>How many sections have a change.</summary>
    public int ChangedSections => Sections.Count(section => section.HasChanges);

    public static StagedReview Of(StagedPlanDocument plan, Uri? installUrl)
    {
        var exclusions = plan.Exclusions.ToDictionary(exclusion => (exclusion.Change, exclusion.Field));
        RowExclusion? Exclusion(int change, string? field) =>
            exclusions.TryGetValue((change, field), out var found) ? new RowExclusion(found.Key, found.Edited) : null;
        var sections = PlanSections.Build(plan.Plan, Exclusion);
        var (accessLabel, accessUrl) = PlanSections.Access(plan.Plan, installUrl);
        return new StagedReview(
            plan.Staged.Base is null ? null : Path.GetFileNameWithoutExtension(plan.Staged.Base),
            sections,
            new PlanDiffViewModel(PlanDiff.Lines(plan.Plan, Exclusion), DiffFootnote(plan)),
            [.. plan.Warnings.Where(warning => !sections.Any(section => section.SkippedBy == warning)).Select(warning => warning.Text)],
            [.. plan.Staged.Exclude.Select(key => new ExcludedViewModel(key))],
            accessLabel,
            accessUrl,
            PlanSections.Drafts(plan.Plan),
            plan.Changes.Count);
    }

    /// <summary>What the diff leaves out: the drafts, and what this apply leaves as GitHub has it.</summary>
    private static string? DiffFootnote(StagedPlanDocument plan)
    {
        // An exclusion that leaves nothing out has a warning of its own, so it isn't counted.
        var count = plan.Staged.Exclude.Count(key => !plan.Warnings.Any(warning => warning.Exclusion == key));
        var excluded = count switch
        {
            0 => null,
            1 => "1 setting or entry is left out of this apply, so GitHub keeps it as it is.",
            _ => $"{count} settings or entries are left out of this apply, so GitHub keeps them as they are.",
        };
        string[] notes = [.. new[] { PlanSections.Drafts(plan.Plan), excluded }.OfType<string>()];
        return notes.Length == 0 ? null : string.Join(" ", notes);
    }

    /// <summary>A staged file as the profile editor lists it, for its one-off edits.</summary>
    public static ProfileListingDocument Listing(string file, string? profile) => new("One-off edits", file, profile, null);

    /// <summary>The editor reads and saves a staged file through <c>stage</c>, which takes the same edits as <c>profile</c>.</summary>
    public static ProfileStore Store(RepottedClient client) => new(
        async (path, cancellationToken) => (await client.StagedAsync(path, cancellationToken).ConfigureAwait(true)).Layers,
        client.SaveStagedEditsAsync,
        // Only the app writes the staged file, which is not in the profiles folder, so a save waits for no sync.
        write => write(),
        "Save edits",
        "One-off edit",
        (@base, _) => @base is null
            ? "For this apply only, over the repository as it is."
            : $"For this apply only, over {@base}, which stays as it is unless you save these edits to it.",
        Drafts: false);
}
