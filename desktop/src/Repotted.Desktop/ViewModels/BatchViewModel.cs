using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>Where a batch stands on its page. docs/developer/state-machines.md has the transitions.</summary>
internal enum BatchStep
{
    /// <summary>Starting the batch, or reading the one already there.</summary>
    Starting,

    /// <summary>A batch was already there, and waits to be resumed or started over.</summary>
    Unfinished,

    /// <summary>Planning every repository of the batch against GitHub.</summary>
    Planning,

    /// <summary>The plans are on screen, to edit, leave parts or repositories out of, or apply.</summary>
    Reviewing,

    /// <summary>Asking whether to write the reviewed plans to GitHub.</summary>
    Confirming,

    /// <summary>Writing the reviewed plans to GitHub, one repository at a time.</summary>
    Applying,

    /// <summary>The apply ran, and each repository says how it went.</summary>
    Done,

    /// <summary>Something failed, such as a batch the CLI could not read.</summary>
    Failed,

    /// <summary>Asking whether to throw the batch away.</summary>
    ConfirmingDiscard,

    /// <summary>The batch was thrown away, and the page closes.</summary>
    Discarded,
}

/// <summary>
/// One profile applied to several repositories, as a flow of its own: a
/// staged apply for each repository, reviewed one at a time as the Apply page
/// reviews one, then applied one repository after another. The batch lives in
/// the app data folder, so an unfinished one is there to resume. Nothing here
/// writes to GitHub but the confirmed apply.
/// </summary>
/// <param name="client">Runs the CLI.</param>
/// <param name="settings">Says where the batch and its staged applies live.</param>
/// <param name="repositories">The repositories to start a batch for, or empty to resume the one there.</param>
/// <param name="profile">The profile to start from, or null to resume.</param>
/// <param name="close">Leaves the page.</param>
/// <param name="desktop">Opens the App's installation settings, to grant what a locked change needs.</param>
/// <param name="installUrl">Where the App is installed, for a repository it isn't installed on.</param>
internal sealed partial class BatchViewModel(
    RepottedClient client,
    AppSettings settings,
    IReadOnlyList<string> repositories,
    ProfileListingDocument? profile,
    Action close,
    IDesktop? desktop = null,
    Uri? installUrl = null) : ViewModelBase
{
    private string Folder => settings.BatchFolder;

    private string PlanFile => settings.BatchPlanFile;

    /// <summary>The profile the batch starts each repository from, by name, or null while it isn't known.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary))]
    public partial string? ProfileName { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(
        nameof(Summary), nameof(ShowStarting), nameof(ShowUnfinished), nameof(ShowPlanning), nameof(ShowReview),
        nameof(Confirming), nameof(ShowApplying), nameof(ShowDone), nameof(ShowFailed), nameof(ConfirmingDiscard),
        nameof(CanLeave), nameof(ShowActions), nameof(CanEdit), nameof(ShowResults))]
    [NotifyCanExecuteChangedFor(
        nameof(ResumeCommand), nameof(StartOverCommand), nameof(ReviewAgainCommand), nameof(LeaveOutCommand), nameof(PutBackCommand),
        nameof(LeaveOutEverywhereCommand), nameof(PutBackEverywhereCommand), nameof(IncludeCommand), nameof(ApplyCommand),
        nameof(ConfirmApplyCommand), nameof(CancelApplyCommand), nameof(StopCommand), nameof(DiscardCommand),
        nameof(ConfirmDiscardCommand), nameof(KeepCommand), nameof(CloseCommand))]
    public partial BatchStep Step { get; private set; }

    /// <summary>Whether a change to the batch runs, until the plan after it starts; nothing else starts meanwhile.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanLeave), nameof(CanEdit))]
    [NotifyCanExecuteChangedFor(
        nameof(LeaveOutCommand), nameof(PutBackCommand), nameof(LeaveOutEverywhereCommand), nameof(PutBackEverywhereCommand),
        nameof(IncludeCommand), nameof(ApplyCommand), nameof(DiscardCommand), nameof(ReviewAgainCommand), nameof(CloseCommand),
        nameof(KeepCommand), nameof(ConfirmDiscardCommand))]
    public partial bool Working { get; private set; }

    /// <summary>The step to go back to when a discard is not confirmed.</summary>
    private BatchStep beforeDiscard = BatchStep.Reviewing;

    public bool ShowStarting => Step == BatchStep.Starting;

    public bool ShowUnfinished => Step == BatchStep.Unfinished;

    public bool ShowPlanning => Step == BatchStep.Planning;

    /// <summary>Whether the reviewed plans show, which they do while they wait to be confirmed too.</summary>
    public bool ShowReview => Step is BatchStep.Reviewing or BatchStep.Confirming
        || (Step == BatchStep.ConfirmingDiscard && beforeDiscard is BatchStep.Reviewing);

    public bool Confirming => Step == BatchStep.Confirming;

    public bool ShowApplying => Step == BatchStep.Applying;

    public bool ShowDone => Step == BatchStep.Done
        || (Step == BatchStep.ConfirmingDiscard && beforeDiscard is BatchStep.Done);

    /// <summary>Whether each repository's result shows: while the apply runs, and after.</summary>
    public bool ShowResults => ShowApplying || ShowDone;

    public bool ShowFailed => Step == BatchStep.Failed;

    public bool ConfirmingDiscard => Step == BatchStep.ConfirmingDiscard;

    /// <summary>Whether the review's actions show: while it is on screen, and not while it asks about an apply or a discard.</summary>
    public bool ShowActions => Step == BatchStep.Reviewing;

    public string Summary => Step switch
    {
        BatchStep.Applying => "Applying to GitHub, one repository at a time.",
        BatchStep.Done when !BatchRemains => "The batch is finished.",
        BatchStep.Done when HasUnfinished => "Some repositories didn't finish. Their staged applies stay, to review again.",
        BatchStep.Done => "The repositories that weren't in this apply stay in the batch, to review again.",
        _ when ProfileName is null => "Nothing changes on GitHub until you apply.",
        // A staged apply that joined the batch keeps what it started from.
        _ when Members.Any(member => member.Joined) =>
            $"Starts each new repository from {ProfileName}. Nothing changes on GitHub until you apply.",
        _ => $"Starts each repository from {ProfileName}. Nothing changes on GitHub until you apply.",
    };

    /// <summary>Whether the batch is still there after an apply, with repositories that didn't finish or weren't in it.</summary>
    public bool BatchRemains => settings.HasBatch;

    /// <summary>Whether, after an apply, only repositories that weren't in it stay in the batch.</summary>
    public bool OnlyNotAppliedRemain => BatchRemains && !HasUnfinished;

    /// <summary>What the unfinished batch holds, for the question whether to resume it.</summary>
    [ObservableProperty]
    public partial string UnfinishedMessage { get; private set; } = "";

    /// <summary>Every repository of the batch, in its order.</summary>
    public ObservableCollection<BatchMemberViewModel> Members { get; } = [];

    /// <summary>The list down the side: all the repositories, then each one.</summary>
    public ObservableCollection<BatchEntry> Entries { get; } = [];

    public AllRepositoriesViewModel All { get; } = new();

    /// <summary>The entry on screen: all the repositories, or one.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Member), nameof(ShowingAll), nameof(ShowingMember), nameof(ShowingPlanned), nameof(Position))]
    [NotifyCanExecuteChangedFor(nameof(PreviousCommand), nameof(NextCommand))]
    public partial BatchEntry? Selected { get; set; }

    /// <summary>The repository on screen, or null while all of them are.</summary>
    public BatchMemberViewModel? Member => Selected as BatchMemberViewModel;

    public bool ShowingAll => Selected is AllRepositoriesViewModel;

    public bool ShowingMember => Member is not null;

    /// <summary>Whether the repository on screen has a plan to show.</summary>
    public bool ShowingPlanned => Member is { IsPlanned: true };

    /// <summary>Where the repository on screen is in the batch, such as "2 of 5".</summary>
    public string Position => Member is { } member ? $"{Members.IndexOf(member) + 1} of {Members.Count}" : "";

    /// <summary>The tab on screen for a repository: 0 for the changes, 1 for the one-off edits.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingChanges), nameof(ShowingEdits))]
    public partial int Tab { get; set; }

    public bool ShowingChanges => Tab == 0;

    public bool ShowingEdits => Tab == 1;

    /// <summary>Whether any repository's one-off edits hold changes not saved yet, which its plan does not have.</summary>
    public bool EditsUnsaved => Members.Any(member => member.EditsUnsaved);

    private bool EditsBusy => Members.Any(member => member.EditsBusy);

    /// <summary>Whether the one-off edits can change: only while the plans are on screen to change.</summary>
    public bool CanEdit => Step == BatchStep.Reviewing && !Working;

    /// <summary>Why a change to the batch failed; the review stays.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? Error { get; private set; }

    public bool HasError => Error is not null;

    /// <summary>What a change to every repository left as it was, and why.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNotice))]
    public partial string? Notice { get; private set; }

    public bool HasNotice => Notice is not null;

    /// <summary>What happened, after a failure.</summary>
    [ObservableProperty]
    public partial string Outcome { get; private set; } = "";

    /// <summary>The repositories the apply writes to, or reports as already in line: planned, with nothing locked.</summary>
    private IEnumerable<BatchMemberViewModel> Ready => Members.Where(member => member.IsPlanned && !member.HasLocks);

    /// <summary>How many repositories the apply writes changes to.</summary>
    public int ApplyCount => Ready.Count(member => member.ChangeCount > 0);

    public int ChangeCount => Ready.Sum(member => member.ChangeCount);

    /// <summary>How many planned repositories wait for access GitHub would refuse.</summary>
    public int LockedCount => Members.Count(member => member.IsPlanned && member.HasLocks);

    public bool HasLocked => LockedCount > 0;

    public string ApplyLabel => ApplyCount switch
    {
        0 => "Nothing to apply",
        1 => "Apply to 1 repository",
        var count => $"Apply to {count} repositories",
    };

    public string ConfirmMessage => $"Write {Count(ChangeCount, "change")} to {Count(ApplyCount, "repository")} on GitHub now?";

    public string ConfirmDetail
    {
        get
        {
            var waiting = LockedCount switch
            {
                0 => "",
                1 => " 1 repository waits for access, so it is left as it is.",
                var count => $" {count} repositories wait for access, so they are left as they are.",
            };
            return "Repotted applies one repository at a time. It checks each on GitHub first, and writes nothing to one that changed since this review." + waiting;
        }
    }

    public string LockedNote => LockedCount == 1
        ? "1 repository has changes GitHub will refuse, so it waits. Leave them out, or give the App that access and review again."
        : $"{LockedCount} repositories have changes GitHub will refuse, so they wait. Leave them out, or give the App that access and review again.";

    /// <summary>The repositories that didn't finish, after an apply, which stay in the batch.</summary>
    public IReadOnlyList<BatchMemberViewModel> Unfinished => [.. Members.Where(member => member.Outcome == MemberOutcome.Unfinished)];

    /// <summary>The repositories that finished, after an apply, which left the batch.</summary>
    public IReadOnlyList<BatchMemberViewModel> Finished => [.. Members.Where(member => member.Outcome == MemberOutcome.Finished)];

    /// <summary>The repositories not in the apply, such as one left out, with why.</summary>
    public IReadOnlyList<BatchMemberViewModel> NotApplied => [.. Members.Where(member => member.Outcome == MemberOutcome.None)];

    public bool HasUnfinished => Unfinished.Count > 0;

    public bool HasFinished => Finished.Count > 0;

    public bool HasNotApplied => NotApplied.Count > 0;

    /// <summary>Whether the apply stops once the repository it writes to now is done.</summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(StopCommand))]
    public partial bool Stopping { get; private set; }

    /// <summary>Whether the page can close: not while the command line runs for it, nor with one-off edits not saved.</summary>
    public bool CanLeave => Step == BatchStep.Discarded || (!Busy && !EditsUnsaved);

    private bool Busy =>
        Step is BatchStep.Starting or BatchStep.Planning or BatchStep.Applying || Working || EditsBusy;

    /// <summary>
    /// Opens the batch: the one there resumes when no repositories are given,
    /// and otherwise waits for a choice; with none there, a new one starts.
    /// </summary>
    public async Task OpenAsync()
    {
        Step = BatchStep.Starting;
        if (!settings.HasBatch)
        {
            if (repositories.Count == 0)
            {
                Fail("There is no batch to resume.");
                return;
            }
            await StartAsync().ConfigureAwait(true);
            return;
        }
        if (repositories.Count == 0)
        {
            await ReviewAsync().ConfigureAwait(true);
            return;
        }
        try
        {
            var batch = await client.BatchAsync(Folder, CancellationToken.None).ConfigureAwait(true);
            var from = batch.Profile is null ? "" : $" from {Path.GetFileNameWithoutExtension(batch.Profile)}";
            UnfinishedMessage =
                $"A batch apply to {Count(batch.Members.Count, "repository")}{from} is not finished. Resume it, or start over with the {Count(repositories.Count, "repository")} you chose?";
        }
        // A batch the CLI cannot read can still be started over.
        catch (CliException error)
        {
            UnfinishedMessage = $"A batch apply is not finished, but Repotted cannot read it: {error.Message} Start over?";
        }
        Step = BatchStep.Unfinished;
    }

    [RelayCommand(CanExecute = nameof(CanChooseUnfinished))]
    private Task ResumeAsync() => ReviewAsync();

    /// <summary>Discards the batch there, keeping staged applies that joined it, and starts a new one.</summary>
    [RelayCommand(CanExecute = nameof(CanChooseUnfinished))]
    private async Task StartOverAsync()
    {
        Step = BatchStep.Starting;
        string? note;
        try
        {
            note = await DiscardBatchAsync().ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Fail(error.Message);
            return;
        }
        await StartAsync(note).ConfigureAwait(true);
    }

    private bool CanChooseUnfinished() => Step == BatchStep.Unfinished;

    /// <summary>
    /// Starts the batch: a new staged apply for each repository, and each
    /// repository's unfinished apply as it is, since a repository has one apply at a time.
    /// </summary>
    private async Task StartAsync(string? note = null)
    {
        var join = repositories.Where(repository => File.Exists(settings.StagedFile(repository))).ToList();
        var fresh = repositories.Except(join, StringComparer.Ordinal).ToList();
        try
        {
            Directory.CreateDirectory(settings.StagedFolder);
            File.Delete(PlanFile);
            // A joined apply is planned with the batch from now on, so its own plan is never applied.
            join.ForEach(repository => File.Delete(AppSettings.PlanFile(settings.StagedFile(repository))));
            await client.StartBatchAsync(
                Folder, settings.StagedFolder, fresh, [.. join.Select(settings.StagedFile)], profile?.File, CancellationToken.None)
                .ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Fail(error.Message);
            return;
        }
        var joined = join.Count switch
        {
            0 => null,
            1 => $"{join[0]} had an apply that wasn't finished, so it joined the batch as it was.",
            _ => $"{string.Join(", ", join)} had applies that weren't finished, so they joined the batch as they were.",
        };
        Notice = string.Join(" ", new[] { note, joined }.OfType<string>()) is { Length: > 0 } notice ? notice : null;
        await ReviewAsync(keepNotice: true).ConfigureAwait(true);
    }

    /// <summary>Plans every repository of the batch again, as it is now, and shows the plans.</summary>
    [RelayCommand(CanExecute = nameof(CanReviewAgain))]
    private Task ReviewAgainAsync() => ReviewAsync();

    private bool CanReviewAgain() =>
        !Working && !EditsBusy && !EditsUnsaved
        && (Step is BatchStep.Reviewing or BatchStep.Failed or BatchStep.Done)
        && settings.HasBatch;

    private async Task ReviewAsync(bool keepNotice = false)
    {
        Step = BatchStep.Planning;
        Error = null;
        if (!keepNotice)
        {
            Notice = null;
        }
        BatchPlanDocument plan;
        BatchDocument batch;
        try
        {
            // The batch says which staged applies joined it; the plan says nothing of that.
            batch = await client.BatchAsync(Folder, CancellationToken.None).ConfigureAwait(true);
            plan = await client.PlanBatchAsync(Folder, PlanFile, CancellationToken.None).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Fail(error.Message);
            return;
        }
        Show(batch, plan);
        Step = BatchStep.Reviewing;
        await OpenEditsAsync().ConfigureAwait(true);
    }

    /// <summary>
    /// Shows the plans, keeping each repository's entry, and its one-off
    /// edits, from the plan before; a repository that left the batch goes.
    /// </summary>
    private void Show(BatchDocument batch, BatchPlanDocument plan)
    {
        ProfileName = batch.Profile is null ? null : Path.GetFileNameWithoutExtension(batch.Profile);
        var selected = Selected;
        var kept = Members.ToDictionary(member => member.Repository, StringComparer.OrdinalIgnoreCase);
        var plans = plan.Plans.ToDictionary(member => member.Repository, StringComparer.OrdinalIgnoreCase);
        var leftOut = plan.LeftOut.ToDictionary(member => member.Repository, StringComparer.OrdinalIgnoreCase);
        var failures = plan.Failures.ToDictionary(member => member.Repository, StringComparer.OrdinalIgnoreCase);
        List<BatchMemberViewModel> members = [];
        foreach (var listed in batch.Members)
        {
            if (!kept.TryGetValue(listed.Repository, out var member))
            {
                member = new BatchMemberViewModel(listed.Repository, listed.File, listed.Joined);
                member.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(BatchMemberViewModel.Edits))
                    {
                        OnEditsChanged();
                    }
                };
            }
            member.Listed(listed);
            member.ClearResult();
            if (plans.TryGetValue(listed.Repository, out var planned))
            {
                member.Planned(planned, installUrl);
            }
            else if (failures.TryGetValue(listed.Repository, out var failure))
            {
                member.Failed(failure.File, failure.Error.Message);
            }
            else if (leftOut.TryGetValue(listed.Repository, out var left))
            {
                member.LeftOut(left.File);
            }
            else
            {
                member.Failed(listed.File, "The plan has nothing for this repository. Review again.");
            }
            members.Add(member);
        }
        var tab = Tab;
        showing = true;
        try
        {
            Members.Clear();
            Entries.Clear();
            Entries.Add(All);
            foreach (var member in members)
            {
                Members.Add(member);
                Entries.Add(member);
            }
            All.Show(members, plan.Plans);
            Selected = selected switch
            {
                BatchMemberViewModel member when members.Contains(member) => member,
                _ => All,
            };
        }
        finally
        {
            showing = false;
        }
        Tab = Selected is BatchMemberViewModel ? tab : 0;
        OnPropertyChanged(nameof(Summary));
        NotifyCounts();
    }

    /// <summary>Whether the list is being rebuilt from a new plan, which moves the selection on its way.</summary>
    private bool showing;

    private void NotifyCounts()
    {
        OnPropertyChanged(nameof(ApplyCount));
        OnPropertyChanged(nameof(ChangeCount));
        OnPropertyChanged(nameof(LockedCount));
        OnPropertyChanged(nameof(HasLocked));
        OnPropertyChanged(nameof(LockedNote));
        OnPropertyChanged(nameof(ApplyLabel));
        OnPropertyChanged(nameof(ConfirmMessage));
        OnPropertyChanged(nameof(ConfirmDetail));
        OnPropertyChanged(nameof(Position));
        OnPropertyChanged(nameof(ShowingPlanned));
        ApplyCommand.NotifyCanExecuteChanged();
        PreviousCommand.NotifyCanExecuteChanged();
        NextCommand.NotifyCanExecuteChanged();
    }

    partial void OnSelectedChanged(BatchEntry? value)
    {
        // Rebuilding the list clears the selection on the way; the entry it had comes back with its tab.
        if (showing)
        {
            return;
        }
        if (value is not BatchMemberViewModel)
        {
            Tab = 0;
        }
        _ = OpenEditsAsync();
    }

    /// <summary>Opens the one-off edits of the repository on screen, the first time it shows with a plan.</summary>
    private async Task OpenEditsAsync()
    {
        if (Step != BatchStep.Reviewing || showing || Member is not { IsPlanned: true, Edits: null, Review: { } review } member)
        {
            return;
        }
        var edits = new ProfileViewModel(
            client, StagedReview.Listing(member.File, member.Base), StagedReview.Store(client), EditsSavedAsync)
        {
            Diff = review.Diff,
        };
        edits.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(ProfileViewModel.ChangeCount) or nameof(ProfileViewModel.Saving)
                or nameof(ProfileViewModel.Loading))
            {
                OnEditsChanged();
            }
        };
        member.Edits = edits;
        await edits.LoadAsync().ConfigureAwait(true);
        OnEditsChanged();
    }

    /// <summary>
    /// Saved one-off edits change one repository's plan, and a plan of the
    /// batch is applied whole, so every repository is planned again.
    /// </summary>
    private async Task EditsSavedAsync()
    {
        if (Step is BatchStep.Reviewing or BatchStep.Confirming or BatchStep.ConfirmingDiscard)
        {
            await ReviewAsync().ConfigureAwait(true);
        }
    }

    private void OnEditsChanged()
    {
        OnPropertyChanged(nameof(EditsUnsaved));
        OnPropertyChanged(nameof(CanLeave));
        LeaveOutCommand.NotifyCanExecuteChanged();
        PutBackCommand.NotifyCanExecuteChanged();
        LeaveOutEverywhereCommand.NotifyCanExecuteChanged();
        PutBackEverywhereCommand.NotifyCanExecuteChanged();
        IncludeCommand.NotifyCanExecuteChanged();
        ApplyCommand.NotifyCanExecuteChanged();
        ConfirmApplyCommand.NotifyCanExecuteChanged();
        DiscardCommand.NotifyCanExecuteChanged();
        CloseCommand.NotifyCanExecuteChanged();
        ReviewAgainCommand.NotifyCanExecuteChanged();
        SettleLeave();
    }

    partial void OnStepChanged(BatchStep value) => SettleLeave();

    partial void OnWorkingChanged(bool value) => SettleLeave();

    private void SettleLeave()
    {
        if (leave is { } answer && CanLeave)
        {
            answer.TrySetResult(true);
        }
        if (!Busy)
        {
            if (idle is { } done)
            {
                idle = null;
                done.TrySetResult();
            }
            if (busyNote is not null && Error == busyNote)
            {
                Error = null;
            }
            busyNote = null;
        }
    }

    private bool CanChange() => Step == BatchStep.Reviewing && !Working && !EditsUnsaved && !EditsBusy;

    /// <summary>Shows the repository before the one on screen.</summary>
    [RelayCommand(CanExecute = nameof(HasPrevious))]
    private void Previous() => Selected = Member is { } member && Members.IndexOf(member) is > 0 and var index ? Members[index - 1] : All;

    private bool HasPrevious() => Member is not null;

    /// <summary>Shows the repository after the one on screen, or the first after all of them.</summary>
    [RelayCommand(CanExecute = nameof(HasNext))]
    private void Next() => Selected = Member is { } member ? Members[Members.IndexOf(member) + 1] : Members[0];

    private bool HasNext() => Members.Count > 0 && (Member is not { } member || Members.IndexOf(member) < Members.Count - 1);

    /// <summary>Leaves a row's change out of the repository on screen; the profile keeps it.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task LeaveOutAsync(CompareRow? row) =>
        Member is { } member && row?.LeaveOut is { Edited: false } exclusion
            ? ChangeAsync(() => client.ExcludeAsync(member.File, exclusion.Key, true, CancellationToken.None))
            : Task.CompletedTask;

    /// <summary>Puts something left out back into the repository on screen.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task PutBackAsync(ExcludedViewModel? excluded) =>
        Member is { } member && excluded is not null
            ? ChangeAsync(() => client.ExcludeAsync(member.File, excluded.Key, false, CancellationToken.None))
            : Task.CompletedTask;

    /// <summary>Leaves a change out of every repository whose profile sets it.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task LeaveOutEverywhereAsync(SharedChange? change) =>
        change is null ? Task.CompletedTask : EverywhereAsync(change.Key, true);

    /// <summary>Puts something back into every repository that leaves it out.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task PutBackEverywhereAsync(SharedChange? change) =>
        change is null ? Task.CompletedTask : EverywhereAsync(change.Key, false);

    private Task EverywhereAsync(string key, bool excluded) => ChangeAsync(async () =>
    {
        var result = await client.ExcludeEverywhereAsync(Folder, key, excluded, CancellationToken.None).ConfigureAwait(true);
        // A repository whose one-off edits set it keeps them, and says so.
        return result.Refused.Count == 0
            ? null
            : string.Join(" ", result.Refused.Select(refused => $"{refused.Repository} kept it: {refused.Message}"));
    });

    /// <summary>Leaves a repository out of the batch's plans and applies, or puts it back; its staged apply stays either way.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task IncludeAsync(BatchMemberViewModel? member)
    {
        if (member is null)
        {
            return Task.CompletedTask;
        }
        // The tick has changed the box already; the plan after the change says what it is.
        member.RefreshIncluded();
        return ChangeAsync(() => client.LeaveOutOfBatchAsync(Folder, member.Repository, member.Included, CancellationToken.None));
    }

    /// <summary>
    /// Changes the batch, then plans it again; a refused change leaves the
    /// review as it was. A change that answers a note shows it over the plans.
    /// </summary>
    private async Task ChangeAsync(Func<Task<string?>> change)
    {
        Working = true;
        Error = null;
        Notice = null;
        string? note;
        try
        {
            note = await change().ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Error = error.Message;
            Working = false;
            Members.ToList().ForEach(member => member.RefreshIncluded());
            return;
        }
        // The change rewrote staged files under any open one-off edits, which hold none unsaved
        // while a change runs, so each is read again the next time it shows.
        foreach (var member in Members)
        {
            member.Edits = null;
        }
        // The plan starts at once, so the old plan is never there to act on between the two.
        Working = false;
        Notice = note;
        await ReviewAsync(keepNotice: true).ConfigureAwait(true);
    }

    private async Task ChangeAsync(Func<Task> change) =>
        await ChangeAsync(async () =>
        {
            await change().ConfigureAwait(true);
            return null;
        }).ConfigureAwait(true);

    [RelayCommand(CanExecute = nameof(CanApply))]
    private void Apply() => Step = BatchStep.Confirming;

    [RelayCommand]
    private Task ReviewAccessAsync() =>
        Member?.Review?.AccessUrl is { } url && desktop is not null ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    private bool CanApply() => CanChange() && ApplyCount > 0;

    [RelayCommand(CanExecute = nameof(IsConfirming))]
    private void CancelApply()
    {
        Step = BatchStep.Reviewing;
        _ = OpenEditsAsync();
    }

    private bool IsConfirming() => Step == BatchStep.Confirming;

    private bool CanConfirmApply() => IsConfirming() && !EditsUnsaved && !EditsBusy;

    /// <summary>
    /// Writes the reviewed plans, one repository at a time, in the batch's
    /// order. The CLI checks each against GitHub first, so one that changed
    /// since the review gets nothing. A repository already in line ends its
    /// staged apply too, and one waiting for access stays as it is.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanConfirmApply))]
    private async Task ConfirmApplyAsync()
    {
        Step = BatchStep.Applying;
        Stopping = false;
        var queue = Ready.ToList();
        foreach (var member in Members)
        {
            member.ClearResult();
            if (member.IsPlanned && member.HasLocks)
            {
                member.Finish(MemberOutcome.Unfinished, "Waits for access GitHub would refuse, so nothing was written.");
            }
        }
        foreach (var member in queue)
        {
            if (Stopping)
            {
                member.Finish(MemberOutcome.Unfinished, "Not applied, since the apply stopped before it.");
                continue;
            }
            member.Applying = true;
            try
            {
                var result = await client.ApplyBatchMemberAsync(PlanFile, member.Repository, CancellationToken.None).ConfigureAwait(true);
                Record(member, result);
            }
            catch (SignInLostException error)
            {
                // Every repository after it would fail the same way, so the apply stops here.
                member.Finish(MemberOutcome.Unfinished, $"{error.Message} Sign in again and review it, since some changes may already be on GitHub.");
                Stopping = true;
            }
            catch (Exception error) when (error is CliException or CliNotFoundException)
            {
                // The run may have written some changes before it failed.
                member.Finish(MemberOutcome.Unfinished, $"{error.Message} Some changes may already be on GitHub, so review it again.");
            }
            finally
            {
                member.Applying = false;
            }
        }
        if (!settings.HasBatch)
        {
            TryDelete(PlanFile);
        }
        PruneStagedFolder();
        Stopping = false;
        OnPropertyChanged(nameof(Unfinished));
        OnPropertyChanged(nameof(Finished));
        OnPropertyChanged(nameof(NotApplied));
        OnPropertyChanged(nameof(HasUnfinished));
        OnPropertyChanged(nameof(HasFinished));
        OnPropertyChanged(nameof(HasNotApplied));
        OnPropertyChanged(nameof(BatchRemains));
        OnPropertyChanged(nameof(OnlyNotAppliedRemain));
        Step = BatchStep.Done;
        OnPropertyChanged(nameof(Summary));
    }

    private static void Record(BatchMemberViewModel member, MemberResultDocument result)
    {
        var first = result.Message?.Split('\n')[0].TrimEnd('.');
        var (outcome, text) = result.Status switch
        {
            // Ended says the batch let the repository go; if it couldn't, its staged apply stays.
            "applied" when !result.Ended => (MemberOutcome.Unfinished,
                $"Applied {Count(result.Applied?.Count ?? 0, "change")}, but its staged apply stays in the batch, so review it again."),
            "in_line" when !result.Ended => (MemberOutcome.Unfinished,
                "Already in line, but its staged apply stays in the batch, so review it again."),
            "applied" => (MemberOutcome.Finished, $"Applied {Count(result.Applied?.Count ?? 0, "change")}."),
            "in_line" => (MemberOutcome.Finished, "Already in line, so nothing was written."),
            "locked" => (MemberOutcome.Unfinished, "Waits for access GitHub would refuse, so nothing was written."),
            "left_out" => (MemberOutcome.Unfinished, "Left out of the batch since the review, so nothing was written."),
            "changed" => (MemberOutcome.Unfinished, "Its staged apply changed since the review, so nothing was written."),
            "stopped" => (MemberOutcome.Unfinished, "Not applied, since the apply stopped before it."),
            "stale" => (MemberOutcome.Unfinished, "Changed on GitHub since the review, so nothing was written."),
            "apply_failed" => (MemberOutcome.Unfinished,
                $"Applied {Count(result.Applied?.Count ?? 0, "change")}, then stopped. {first}. Nothing after it was written."),
            _ => (MemberOutcome.Unfinished, $"Couldn't apply: {result.Error?.Message ?? first ?? result.Status}"),
        };
        member.Finish(outcome, text);
    }

    /// <summary>Stops the apply once the repository it writes to now is done; the rest stay to review again.</summary>
    [RelayCommand(CanExecute = nameof(CanStop))]
    private void Stop() => Stopping = true;

    private bool CanStop() => Step == BatchStep.Applying && !Stopping;

    /// <summary>Asks before throwing the batch away, since the staged applies it started go with it.</summary>
    [RelayCommand(CanExecute = nameof(CanDiscard))]
    private void Discard()
    {
        beforeDiscard = Step;
        Step = BatchStep.ConfirmingDiscard;
    }

    private bool CanDiscard() =>
        !Working && !EditsBusy && settings.HasBatch
        && Step is BatchStep.Reviewing or BatchStep.Done or BatchStep.Failed;

    [RelayCommand(CanExecute = nameof(IsConfirmingDiscard))]
    private void Keep()
    {
        Step = beforeDiscard;
        _ = OpenEditsAsync();
    }

    private bool IsConfirmingDiscard() => Step == BatchStep.ConfirmingDiscard && !Working;

    /// <summary>Removes the batch and the staged applies it started, then leaves; one that joined it stays, as do the profiles.</summary>
    [RelayCommand(CanExecute = nameof(IsConfirmingDiscard))]
    private async Task ConfirmDiscardAsync()
    {
        Working = true;
        try
        {
            await DiscardBatchAsync().ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Working = false;
            Step = beforeDiscard;
            Error = error.Message;
            return;
        }
        Working = false;
        Step = BatchStep.Discarded;
        close();
    }

    /// <summary>
    /// Discards the batch and its plan, keeping staged applies that joined it.
    /// A batch the CLI cannot read is removed as it is, and the note says that
    /// staged applies it started stay, to resume or discard one at a time.
    /// </summary>
    private async Task<string?> DiscardBatchAsync()
    {
        string? note = null;
        if (settings.HasBatch)
        {
            try
            {
                await client.DiscardBatchAsync(Folder, CancellationToken.None).ConfigureAwait(true);
            }
            catch (CliException error) when (error is not SignInLostException)
            {
                if (await CanReadBatchAsync().ConfigureAwait(true))
                {
                    throw;
                }
                Directory.Delete(Folder, recursive: true);
                note = "Repotted couldn't read the batch, so it removed it as it was. Any apply it started stays on its own, to resume or discard.";
            }
        }
        File.Delete(PlanFile);
        return note;
    }

    private async Task<bool> CanReadBatchAsync()
    {
        try
        {
            await client.BatchAsync(Folder, CancellationToken.None).ConfigureAwait(true);
            return true;
        }
        catch (CliException error) when (error is not SignInLostException)
        {
            return false;
        }
    }

    /// <summary>Leaves the page; an unfinished batch stays to resume.</summary>
    [RelayCommand(CanExecute = nameof(CanLeave))]
    private void Close() => close();

    private TaskCompletionSource<bool>? leave;

    /// <summary>What the app waits to do while the page asks about unsaved edits, such as "quit", or null.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(LeavingMessage), nameof(AskingToLeave))]
    public partial string? Leaving { get; private set; }

    public bool AskingToLeave => Leaving is not null;

    public string LeavingMessage => $"To {Leaving}, save or undo your one-off edits first.";

    /// <summary>
    /// Whether the app may leave the page to <paramref name="act"/>, as the
    /// Apply page answers: not while the command line runs for it, unless
    /// <paramref name="wait"/> waits for the run, and with unsaved one-off
    /// edits, once they are saved and planned again, undone, or the batch is
    /// discarded. The repository with the edits comes on screen.
    /// </summary>
    public async Task<bool> ConfirmLeaveAsync(string act, bool wait = false)
    {
        while (Busy)
        {
            if (!wait)
            {
                busyNote = $"Repotted is still working on this batch, so you can {act} once it is done.";
                Error = busyNote;
                return false;
            }
            idle ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await idle.Task.ConfigureAwait(true);
        }
        if (CanLeave)
        {
            return true;
        }
        leave?.TrySetResult(false);
        var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        leave = answer;
        Leaving = act;
        if (Members.FirstOrDefault(member => member.EditsUnsaved) is { } unsaved)
        {
            Selected = unsaved;
            Tab = 1;
        }
        try
        {
            return await answer.Task.ConfigureAwait(true);
        }
        finally
        {
            if (leave == answer)
            {
                leave = null;
                Leaving = null;
            }
        }
    }

    private TaskCompletionSource? idle;

    private string? busyNote;

    [RelayCommand]
    private void StayHere() => leave?.TrySetResult(false);

    private void Fail(string message)
    {
        Outcome = message;
        Step = BatchStep.Failed;
    }

    /// <summary>Removes the owner folders that ended staged applies left empty in the staged folder.</summary>
    private void PruneStagedFolder()
    {
        try
        {
            if (!Directory.Exists(settings.StagedFolder))
            {
                return;
            }
            foreach (var owner in Directory.EnumerateDirectories(settings.StagedFolder))
            {
                if (!Directory.EnumerateFileSystemEntries(owner).Any())
                {
                    Directory.Delete(owner);
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // An empty folder left behind holds nothing to resume.
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // A plan left behind is planned again before anything applies it.
        }
    }

    private static string Count(int count, string noun) => count == 1
        ? $"1 {noun}"
        : noun.EndsWith('y') ? $"{count} {noun[..^1]}ies" : $"{count} {noun}s";
}
