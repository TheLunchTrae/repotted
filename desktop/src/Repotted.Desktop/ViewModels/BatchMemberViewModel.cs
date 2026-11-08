using CommunityToolkit.Mvvm.ComponentModel;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>An entry in the list down the side of a batch's review: all its repositories, or one.</summary>
internal abstract partial class BatchEntry : ViewModelBase
{
    public abstract string Name { get; }

    /// <summary>What the entry stands at, under its name.</summary>
    public abstract string Status { get; }
}

/// <summary>What a repository of a batch stands at in its review.</summary>
internal enum MemberState
{
    /// <summary>Planned: it has changes to write, or none.</summary>
    Planned,

    /// <summary>Left out of the batch's plans and applies, until it is put back.</summary>
    LeftOut,

    /// <summary>It could not be planned, such as one the App isn't installed on.</summary>
    Failed,
}

/// <summary>How applying one repository of a batch went.</summary>
internal enum MemberOutcome
{
    /// <summary>Not applied yet, or not in this apply.</summary>
    None,

    /// <summary>Its changes are on GitHub, or it needed none, and its staged apply is gone.</summary>
    Finished,

    /// <summary>Nothing or only part was written, and its staged apply stays to review again.</summary>
    Unfinished,
}

/// <summary>
/// One repository of a batch: its staged apply, its plan as the review shows
/// it, its one-off edits once they are opened, and how its apply went.
/// </summary>
internal sealed partial class BatchMemberViewModel(string repository, string file, bool joined) : BatchEntry
{
    public string Repository => repository;

    public override string Name => repository;

    /// <summary>The staged apply file, which its one-off edits and what it leaves out go into.</summary>
    public string File { get; private set; } = file;

    /// <summary>Whether the staged apply was there before the batch, and stays when the batch is discarded.</summary>
    public bool Joined { get; private set; } = joined;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status), nameof(Included), nameof(IsPlanned), nameof(IsFailed), nameof(IsLeftOut))]
    public partial MemberState State { get; private set; }

    /// <summary>The plan as the review shows it, while the repository is planned.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status), nameof(ChangeCount), nameof(Locked), nameof(HasLocks), nameof(Summary), nameof(LockSummary), nameof(HasExcluded))]
    public partial StagedReview? Review { get; private set; }

    /// <summary>Why it could not be planned.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status))]
    public partial string? Problem { get; private set; }

    /// <summary>The digest the plan recorded, so a plan that changes it is a new plan.</summary>
    public string? Digest { get; private set; }

    /// <summary>The profile its staged apply starts from, or null when it starts from the repository as it is.</summary>
    public string? Base { get; private set; }

    /// <summary>The one-off edits, in the profile editor, once the repository has been opened.</summary>
    [ObservableProperty]
    public partial ProfileViewModel? Edits { get; set; }

    /// <summary>Whether the one-off edits hold changes not saved yet.</summary>
    public bool EditsUnsaved => Edits?.HasChanges == true;

    /// <summary>Whether the one-off edits are being read or saved.</summary>
    public bool EditsBusy => Edits is { Loading: true } or { Saving: true };

    public bool IsPlanned => State == MemberState.Planned;

    public bool IsFailed => State == MemberState.Failed;

    public bool IsLeftOut => State == MemberState.LeftOut;

    /// <summary>Whether it is in the batch's plans and applies; unticking it leaves it out.</summary>
    public bool Included => State != MemberState.LeftOut;

    public int ChangeCount => Review?.ChangeCount ?? 0;

    public int Locked => Review?.Locked ?? 0;

    public bool HasLocks => Locked > 0;

    /// <summary>Whether its staged apply leaves anything of the profile out.</summary>
    public bool HasExcluded => Review is { Excluded.Count: > 0 };

    public override string Status => State switch
    {
        MemberState.LeftOut => "Left out",
        MemberState.Failed => "Couldn't compare",
        _ when HasLocks => "Needs access",
        _ when ChangeCount == 0 => "Already in line",
        _ => ChangeCount == 1 ? "1 change" : $"{ChangeCount} changes",
    };

    /// <summary>The line above the repository's changes.</summary>
    public string Summary => ChangeCount == 0
        ? $"{repository} already has everything this apply sets."
        : $"{Plural(ChangeCount, "change")} to {repository}, in {Plural(Review?.ChangedSections ?? 0, "section")}.";

    public string LockSummary => Locked == 1
        ? "GitHub will refuse 1 of the changes below, marked with what it needs. This repository waits until you leave it out, or give the App that access and review again."
        : $"GitHub will refuse {Locked} of the changes below, each marked with what it needs. This repository waits until you leave them out, or give the App that access and review again.";

    /// <summary>How applying it went, after an apply.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasResult), nameof(Progress))]
    public partial string? Result { get; private set; }

    public bool HasResult => Result is not null;

    [ObservableProperty]
    public partial MemberOutcome Outcome { get; private set; }

    /// <summary>Whether the apply runs for this repository now.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Progress))]
    public partial bool Applying { get; set; }

    /// <summary>Where the repository is in a running apply.</summary>
    public string Progress => Applying ? "Applying now" : Result ?? "Waiting";

    public void Planned(BatchMemberPlanDocument plan, Uri? installUrl)
    {
        File = plan.File;
        Digest = plan.Digest;
        Base = plan.Staged.Base;
        Problem = null;
        Review = StagedReview.Of(plan.AsStaged, installUrl);
        State = MemberState.Planned;
        if (Edits is not null)
        {
            Edits.Diff = Review.Diff;
        }
    }

    public void LeftOut(string file)
    {
        File = file;
        Digest = null;
        Review = null;
        Problem = null;
        State = MemberState.LeftOut;
    }

    public void Failed(string file, string problem)
    {
        File = file;
        Digest = null;
        Review = null;
        Problem = problem;
        State = MemberState.Failed;
    }

    public void Listed(BatchMemberDocument member)
    {
        File = member.File;
        Joined = member.Joined;
        OnPropertyChanged(nameof(Joined));
    }

    public void Finish(MemberOutcome outcome, string result)
    {
        Outcome = outcome;
        Result = result;
    }

    public void ClearResult()
    {
        Outcome = MemberOutcome.None;
        Result = null;
    }

    /// <summary>Says again what <see cref="Included"/> is, such as after a tick that did not change it.</summary>
    public void RefreshIncluded() => OnPropertyChanged(nameof(Included));

    private static string Plural(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";
}

/// <summary>
/// Something set in several repositories of a batch, by what leaves it out:
/// <see cref="Key"/> is what <c>stage --exclude</c> takes.
/// </summary>
internal sealed record SharedChange(string Key, string What, int Repositories)
{
    public string Count => Repositories == 1 ? "1 repository" : $"{Repositories} repositories";
}

/// <summary>
/// The first entry of a batch's review: every repository at once, with each
/// change by what it changes and how many repositories it reaches, to leave
/// out of all of them together.
/// </summary>
internal sealed partial class AllRepositoriesViewModel : BatchEntry
{
    public override string Name => "All repositories";

    public override string Status => Summary;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Status))]
    public partial string Summary { get; private set; } = "";

    /// <summary>The changes the plans write, each with how many repositories it reaches.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasChanges))]
    public partial IReadOnlyList<SharedChange> Changes { get; private set; } = [];

    public bool HasChanges => Changes.Count > 0;

    /// <summary>What repositories leave out, each with how many leave it out.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasExcluded))]
    public partial IReadOnlyList<SharedChange> Excluded { get; private set; } = [];

    public bool HasExcluded => Excluded.Count > 0;

    public void Show(IReadOnlyList<BatchMemberViewModel> members, IReadOnlyList<BatchMemberPlanDocument> plans)
    {
        var planned = members.Count(member => member.IsPlanned);
        var changes = members.Sum(member => member.ChangeCount);
        var repositories = planned == 1 ? "1 repository" : $"{planned} repositories";
        Summary = changes switch
        {
            0 => $"{repositories}, already in line",
            1 => $"1 change in {repositories}",
            _ => $"{changes} changes in {repositories}",
        };
        // One-off edits are undone in their own repository, so only what a profile sets is shared.
        Changes =
        [
            .. plans
                .SelectMany(plan => plan.Exclusions.Where(exclusion => !exclusion.Edited).Select(exclusion => (plan, exclusion)))
                .GroupBy(pair => pair.exclusion.Key, StringComparer.Ordinal)
                .Select(group => new SharedChange(
                    group.Key,
                    Describe(group.First().plan.Changes[group.First().exclusion.Change], group.First().exclusion.Field),
                    group.Select(pair => pair.plan.Repository).Distinct(StringComparer.OrdinalIgnoreCase).Count()))
                .OrderByDescending(change => change.Repositories)
                .ThenBy(change => change.Key, StringComparer.Ordinal),
        ];
        Excluded =
        [
            .. plans
                .SelectMany(plan => plan.Staged.Exclude.Select(key => (plan.Repository, key)))
                .GroupBy(pair => pair.key, StringComparer.Ordinal)
                .Select(group => new SharedChange(group.Key, group.Key, group.Count()))
                .OrderByDescending(change => change.Repositories)
                .ThenBy(change => change.Key, StringComparer.Ordinal),
        ];
    }

    private static string Describe(PlanChangeDocument change, string? field) => field is null
        ? $"{Capitalized(change.Action)} {change.Target}"
        : $"{Capitalized(change.Target)}: {field}";

    private static string Capitalized(string text) =>
        text.Length == 0 ? text : string.Concat(text[..1].ToUpperInvariant(), text[1..]);
}
