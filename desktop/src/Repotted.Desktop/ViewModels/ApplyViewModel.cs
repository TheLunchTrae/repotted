using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>Where a staged apply stands on the Apply page. docs/developer/state-machines.md has the transitions.</summary>
internal enum ApplyStep
{
    /// <summary>Starting the staged apply file, or reading the one already there.</summary>
    Starting,

    /// <summary>A staged apply to the repository was already there, and waits to be resumed or started over.</summary>
    Unfinished,

    /// <summary>Planning the staged apply against GitHub.</summary>
    Planning,

    /// <summary>The plan is on screen, to edit, leave parts out of, or apply.</summary>
    Reviewing,

    /// <summary>Asking whether to write the reviewed plan to GitHub.</summary>
    Confirming,

    /// <summary>Writing the reviewed plan to GitHub.</summary>
    Applying,

    /// <summary>Every change was written, and the staged apply is gone.</summary>
    Applied,

    /// <summary>The repository changed after review, so nothing was written.</summary>
    Stale,

    /// <summary>A write failed partway, so only some changes were written.</summary>
    PartlyApplied,

    /// <summary>Something failed, such as a plan GitHub would not read.</summary>
    Failed,

    /// <summary>Asking whether to throw the staged apply away.</summary>
    ConfirmingDiscard,

    /// <summary>The staged apply was thrown away, and the page closes.</summary>
    Discarded,
}

/// <summary>Something the staged apply leaves out, which can be put back.</summary>
internal sealed record ExcludedViewModel(string Key);

/// <summary>
/// One apply to one repository, as its own flow: the plan of a staged apply
/// as a diff, with one-off edits and parts left out on top of the profile it
/// starts from, then an apply of exactly the reviewed plan. The staged apply
/// lives in a file of its own in the app data folder, so an unfinished one
/// is there to resume. Nothing here writes to GitHub but the confirmed apply.
/// </summary>
/// <param name="client">Runs the CLI.</param>
/// <param name="settings">Says where the staged apply lives.</param>
/// <param name="repository">The repository, as owner/name.</param>
/// <param name="profile">The profile to start from, or null to start from the repository as it is.</param>
/// <param name="close">Leaves the page.</param>
/// <param name="profileSaved">Runs after one-off edits are saved to the profile, such as to list and sync the profiles again.</param>
/// <param name="exclusive">Runs a write to the profiles folder, such as saving one-off edits to a profile, where no sync runs meanwhile.</param>
/// <param name="desktop">Opens the App's installation settings, to grant what a locked change needs.</param>
/// <param name="installUrl">Where the App is installed, for a repository it isn't installed on.</param>
internal sealed partial class ApplyViewModel(
    RepottedClient client,
    AppSettings settings,
    string repository,
    ProfileListingDocument? profile,
    Action close,
    Func<Task>? profileSaved = null,
    Func<Func<Task>, Task>? exclusive = null,
    IDesktop? desktop = null,
    Uri? installUrl = null) : ViewModelBase
{
    private readonly string file = settings.StagedFile(repository);

    private string PlanFile => AppSettings.PlanFile(file);

    public string Repository => repository;

    public string Heading => $"Apply to {repository}";

    /// <summary>The profile the staged apply starts from, by name, or null when it starts from the repository.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary), nameof(HasBase))]
    public partial string? BaseName { get; private set; }

    public bool HasBase => BaseName is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(
        nameof(Summary), nameof(ShowStarting), nameof(ShowUnfinished), nameof(ShowPlanning), nameof(ShowReview),
        nameof(Confirming), nameof(ShowApplying), nameof(ShowResult), nameof(ShowFailed), nameof(ConfirmingDiscard),
        nameof(CanLeave), nameof(ShowActions), nameof(CanRetry), nameof(CanEdit))]
    [NotifyCanExecuteChangedFor(
        nameof(ResumeCommand), nameof(StartOverCommand), nameof(ReviewAgainCommand), nameof(LeaveOutCommand), nameof(PutBackCommand),
        nameof(ApplyCommand), nameof(ConfirmApplyCommand), nameof(CancelApplyCommand), nameof(DiscardCommand),
        nameof(ConfirmDiscardCommand), nameof(KeepCommand), nameof(SaveToProfileCommand), nameof(CloseCommand))]
    public partial ApplyStep Step { get; private set; }

    /// <summary>
    /// Whether a change to the staged apply runs, such as leaving a row out,
    /// until the plan after it starts; nothing else starts meanwhile.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanLeave), nameof(CanEdit))]
    [NotifyCanExecuteChangedFor(
        nameof(LeaveOutCommand), nameof(PutBackCommand), nameof(ApplyCommand), nameof(DiscardCommand),
        nameof(SaveToProfileCommand), nameof(ReviewAgainCommand), nameof(CloseCommand))]
    public partial bool Working { get; private set; }

    /// <summary>The step to go back to when a discard is not confirmed.</summary>
    private ApplyStep beforeDiscard = ApplyStep.Reviewing;

    public bool ShowStarting => Step == ApplyStep.Starting;

    public bool ShowUnfinished => Step == ApplyStep.Unfinished;

    public bool ShowPlanning => Step == ApplyStep.Planning;

    /// <summary>Whether the reviewed plan shows, which it does while it waits to be confirmed too.</summary>
    public bool ShowReview => Step is ApplyStep.Reviewing or ApplyStep.Confirming
        || (Step == ApplyStep.ConfirmingDiscard && beforeDiscard is ApplyStep.Reviewing);

    public bool Confirming => Step == ApplyStep.Confirming;

    public bool ShowApplying => Step == ApplyStep.Applying;

    /// <summary>Whether the outcome of an apply shows.</summary>
    public bool ShowResult => Step is ApplyStep.Applied or ApplyStep.Stale or ApplyStep.PartlyApplied;

    public bool ShowFailed => Step == ApplyStep.Failed;

    /// <summary>Whether an apply that did not finish can be reviewed again or discarded from its outcome.</summary>
    public bool CanRetry => Step is ApplyStep.Stale or ApplyStep.PartlyApplied;

    public bool ConfirmingDiscard => Step == ApplyStep.ConfirmingDiscard;

    /// <summary>Whether the review's actions show: while it is on screen, and not while it asks about an apply or a discard.</summary>
    public bool ShowActions => Step == ApplyStep.Reviewing;

    /// <summary>The line under the heading.</summary>
    public string Summary => Step switch
    {
        ApplyStep.Applied => $"Applied to {repository}.",
        ApplyStep.PartlyApplied => $"Starts from {From}. Some of its changes are on GitHub.",
        _ => $"Starts from {From}. Nothing changes on GitHub until you apply.",
    };

    private string From => BaseName ?? "the repository as it is";

    /// <summary>What the unfinished staged apply starts from, for the question whether to resume it.</summary>
    [ObservableProperty]
    public partial string UnfinishedMessage { get; private set; } = "";

    public IReadOnlyList<CompareSectionViewModel> Sections { get; private set; } = [];

    public IReadOnlyList<string> Warnings { get; private set; } = [];

    public bool HasWarnings => Warnings.Count > 0;

    /// <summary>What the staged apply leaves out of the profile it starts from.</summary>
    public IReadOnlyList<ExcludedViewModel> Excluded { get; private set; } = [];

    public bool HasExcluded => Excluded.Count > 0;

    /// <summary>How many changes the reviewed plan writes.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ApplyLabel), nameof(ConfirmMessage), nameof(ReviewSummary), nameof(HasChanges))]
    [NotifyCanExecuteChangedFor(nameof(ApplyCommand))]
    public partial int ChangeCount { get; private set; }

    public bool HasChanges => ChangeCount > 0;

    /// <summary>
    /// How many rows the plan's locks say GitHub will refuse. Apply waits until
    /// none is left, since a write that stops at one leaves the rest unwritten.
    /// </summary>
    public int Locked => Sections.Sum(section => section.Differences.Count(row => row.IsLocked));

    public bool HasLocks => Locked > 0;

    public string LockSummary => Locked == 1
        ? "GitHub will refuse 1 of the changes below, marked with what it needs. Apply waits until you leave it out, or give the App that access and review again."
        : $"GitHub will refuse {Locked} of the changes below, each marked with what it needs. Apply waits until you leave them out, or give the App that access and review again.";

    /// <summary>Where to grant what the locks need, as the compare has it.</summary>
    public Uri? AccessUrl { get; private set; }

    public string AccessLabel { get; private set; } = "Review App access";

    public bool HasAccessUrl => HasLocks && AccessUrl is not null && desktop is not null;

    public string ApplyLabel => ChangeCount switch
    {
        0 => "Nothing to apply",
        1 => "Apply 1 change",
        var count => $"Apply {count} changes",
    };

    public string ConfirmMessage => $"Write {Count(ChangeCount, "change")} to {repository} on GitHub now?";

    public string ReviewSummary => ChangeCount == 0
        ? $"{repository} already has everything this apply sets."
        : $"{Count(ChangeCount, "change")} to {repository}, in {Count(Sections.Count(section => section.HasChanges), "section")}.";

    /// <summary>The one-off edits, in the profile editor, over the profile the staged apply starts from.</summary>
    [ObservableProperty]
    public partial ProfileViewModel? Edits { get; private set; }

    /// <summary>The tab on screen: 0 for the changes, 1 for the one-off edits.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingChanges), nameof(ShowingEdits))]
    public partial int Tab { get; set; }

    public bool ShowingChanges => Tab == 0;

    public bool ShowingEdits => Tab == 1;

    /// <summary>Whether the one-off edits hold changes not saved yet, which the plan does not have.</summary>
    public bool EditsUnsaved => Edits?.HasChanges == true;

    /// <summary>Whether the one-off edits are being read or saved, which runs the command line.</summary>
    private bool EditsBusy => Edits is { Loading: true } or { Saving: true };

    /// <summary>
    /// Whether the one-off edits can change: only while the plan is on
    /// screen to change, so an edit never waits under a plan about to be applied.
    /// </summary>
    public bool CanEdit => Step == ApplyStep.Reviewing && !Working;

    /// <summary>Why a change to the staged apply failed, such as an edit the profile makes invalid; the review stays.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? Error { get; private set; }

    public bool HasError => Error is not null;

    /// <summary>What happened, after an apply or a failure.</summary>
    [ObservableProperty]
    public partial string Outcome { get; private set; } = "";

    /// <summary>
    /// Whether the page can close: not while the command line runs for it,
    /// since a run must not outlive the page, nor with one-off edits not saved.
    /// A discarded apply has closed, and its edits went with it.
    /// </summary>
    public bool CanLeave => Step == ApplyStep.Discarded || (!Busy && !EditsUnsaved);

    /// <summary>Whether the command line runs for the page, which can't be stopped partway.</summary>
    private bool Busy =>
        Step is ApplyStep.Starting or ApplyStep.Planning or ApplyStep.Applying || Working || EditsBusy;

    /// <summary>Opens the staged apply to the repository: an unfinished one waits for a choice, and otherwise a new one starts.</summary>
    public async Task OpenAsync()
    {
        Step = ApplyStep.Starting;
        if (!File.Exists(file))
        {
            await StartAsync().ConfigureAwait(true);
            return;
        }
        try
        {
            var staged = await client.StagedAsync(file, CancellationToken.None).ConfigureAwait(true);
            BaseName = staged.Base is null ? null : Path.GetFileNameWithoutExtension(staged.Base);
            UnfinishedMessage = $"An apply to {repository} from {From} is not finished. Resume it, or start over from {Requested}?";
        }
        // A staged apply the CLI cannot read can still be started over.
        catch (CliException error)
        {
            UnfinishedMessage = $"An apply to {repository} is not finished, but Repotted cannot read it: {error.Message} Start over from {Requested}?";
        }
        Step = ApplyStep.Unfinished;
    }

    private string Requested => profile?.Name ?? "the repository as it is";

    [RelayCommand(CanExecute = nameof(CanChooseUnfinished))]
    private Task ResumeAsync() => ReviewAsync();

    [RelayCommand(CanExecute = nameof(CanChooseUnfinished))]
    private async Task StartOverAsync()
    {
        Step = ApplyStep.Starting;
        try
        {
            File.Delete(file);
            File.Delete(PlanFile);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Fail(error.Message);
            return;
        }
        await StartAsync().ConfigureAwait(true);
    }

    private bool CanChooseUnfinished() => Step == ApplyStep.Unfinished;

    private async Task StartAsync()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await client.StartStagedAsync(file, repository, profile?.File, CancellationToken.None).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Fail(error.Message);
            return;
        }
        await ReviewAsync().ConfigureAwait(true);
    }

    /// <summary>Plans the staged apply again, as it is now, and shows the plan.</summary>
    [RelayCommand(CanExecute = nameof(CanReviewAgain))]
    private Task ReviewAgainAsync() => ReviewAsync();

    private bool CanReviewAgain() =>
        !Working && Step is ApplyStep.Reviewing or ApplyStep.Stale or ApplyStep.PartlyApplied or ApplyStep.Failed && File.Exists(file);

    private async Task ReviewAsync()
    {
        Step = ApplyStep.Planning;
        Error = null;
        try
        {
            var plan = await client.PlanStagedAsync(file, PlanFile, CancellationToken.None).ConfigureAwait(true);
            Show(plan);
            if (Edits is null)
            {
                Edits = new ProfileViewModel(client, Listing(), EditsSavedAsync, store: Store());
                Edits.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName is nameof(ProfileViewModel.ChangeCount) or nameof(ProfileViewModel.Saving)
                        or nameof(ProfileViewModel.Loading))
                    {
                        OnEditsChanged();
                    }
                };
                await Edits.LoadAsync().ConfigureAwait(true);
                OnEditsChanged();
            }
            Step = ApplyStep.Reviewing;
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Fail(error.Message);
        }
    }

    private void Show(StagedPlanDocument plan)
    {
        BaseName = plan.Staged.Base is null ? null : Path.GetFileNameWithoutExtension(plan.Staged.Base);
        var exclusions = plan.Exclusions.ToDictionary(exclusion => (exclusion.Change, exclusion.Field));
        Sections = CompareViewModel.Build(plan.Plan, (change, field) =>
            exclusions.TryGetValue((change, field), out var found) ? new RowExclusion(found.Key, found.Edited) : null);
        Warnings = [.. plan.Warnings.Where(warning => !Sections.Any(section => section.SkippedBy == warning))];
        Excluded = [.. plan.Staged.Exclude.Select(key => new ExcludedViewModel(key))];
        (AccessLabel, AccessUrl) = CompareViewModel.Access(plan.Plan, installUrl);
        ChangeCount = plan.Changes.Count;
        OnPropertyChanged(nameof(Sections));
        OnPropertyChanged(nameof(Locked));
        OnPropertyChanged(nameof(HasLocks));
        OnPropertyChanged(nameof(LockSummary));
        OnPropertyChanged(nameof(AccessUrl));
        OnPropertyChanged(nameof(AccessLabel));
        OnPropertyChanged(nameof(HasAccessUrl));
        ApplyCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(Warnings));
        OnPropertyChanged(nameof(HasWarnings));
        OnPropertyChanged(nameof(Excluded));
        OnPropertyChanged(nameof(HasExcluded));
        OnPropertyChanged(nameof(ReviewSummary));
    }

    /// <summary>The staged file as the profile editor lists it.</summary>
    private ProfileListingDocument Listing() => new("One-off edits", file, profile?.File, null);

    /// <summary>The editor reads and saves the staged file through <c>stage</c>, which takes the same edits as <c>profile</c>.</summary>
    private ProfileStore Store() => new(
        async (path, cancellationToken) => (await client.StagedAsync(path, cancellationToken).ConfigureAwait(true)).Layers,
        client.SaveStagedEditsAsync,
        "Save edits",
        "One-off edit",
        (@base, _) => @base is null
            ? "For this apply only, over the repository as it is."
            : $"For this apply only, over {@base}, which stays as it is unless you save these edits to it.",
        Drafts: false);

    /// <summary>
    /// Saved one-off edits change the plan, so it is made again; a plan
    /// reviewed before the save is never applied. A question about leaving
    /// waits for that plan, so the page never stays behind with an old one.
    /// </summary>
    private async Task EditsSavedAsync()
    {
        if (Step is ApplyStep.Reviewing or ApplyStep.Confirming or ApplyStep.ConfirmingDiscard)
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
        ApplyCommand.NotifyCanExecuteChanged();
        ConfirmApplyCommand.NotifyCanExecuteChanged();
        SaveToProfileCommand.NotifyCanExecuteChanged();
        DiscardCommand.NotifyCanExecuteChanged();
        CloseCommand.NotifyCanExecuteChanged();
        SettleLeave();
    }

    partial void OnStepChanged(ApplyStep value) => SettleLeave();

    partial void OnWorkingChanged(bool value) => SettleLeave();

    /// <summary>
    /// The question about leaving settles once its edits are saved, and
    /// planned again, or undone, or the apply is discarded. A wait to leave
    /// goes on once nothing runs, and the note that it waited goes.
    /// </summary>
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

    private bool CanChange() => Step == ApplyStep.Reviewing && !Working && !EditsUnsaved && !EditsBusy;

    /// <summary>Leaves a row's change out of this apply; the profile keeps it.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task LeaveOutAsync(CompareRow? row) =>
        row?.LeaveOut is { Edited: false } exclusion ? ChangeAsync(() => client.ExcludeAsync(file, exclusion.Key, true, CancellationToken.None)) : Task.CompletedTask;

    /// <summary>Puts something left out back into this apply.</summary>
    [RelayCommand(CanExecute = nameof(CanChange))]
    private Task PutBackAsync(ExcludedViewModel? excluded) =>
        excluded is null ? Task.CompletedTask : ChangeAsync(() => client.ExcludeAsync(file, excluded.Key, false, CancellationToken.None));

    /// <summary>Saves the one-off edits to the profile the apply starts from, which then sets them itself.</summary>
    [RelayCommand(CanExecute = nameof(CanSaveToProfile))]
    private Task SaveToProfileAsync() => ChangeAsync(async () =>
    {
        StagedApply? staged = null;
        // The profile is a file of the profiles folder, so no sync reads it while it is written.
        async Task Save() => staged = await client.SaveStagedToProfileAsync(file, CancellationToken.None).ConfigureAwait(true);
        await (exclusive is null ? Save() : exclusive(Save)).ConfigureAwait(true);
        if (profileSaved is not null)
        {
            await profileSaved().ConfigureAwait(true);
        }
        return staged!;
    });

    private bool CanSaveToProfile() => CanChange() && HasBase && Edits?.SetsAnything == true;

    /// <summary>Changes the staged apply, then reads the edits and plans again; a refused change leaves the review as it was.</summary>
    private async Task ChangeAsync(Func<Task<StagedApply>> change)
    {
        Working = true;
        Error = null;
        try
        {
            await change().ConfigureAwait(true);
            if (Edits is not null)
            {
                await Edits.LoadAsync().ConfigureAwait(true);
                OnEditsChanged();
            }
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            Error = error.Message;
            Working = false;
            return;
        }
        // The plan starts at once, so the old plan is never there to act on between the two.
        Working = false;
        await ReviewAsync().ConfigureAwait(true);
    }

    [RelayCommand(CanExecute = nameof(CanApply))]
    private void Apply() => Step = ApplyStep.Confirming;

    [RelayCommand]
    private Task ReviewAccessAsync() => AccessUrl is { } url && desktop is not null ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    private bool CanApply() => CanChange() && ChangeCount > 0 && !HasLocks;

    [RelayCommand(CanExecute = nameof(IsConfirming))]
    private void CancelApply() => Step = ApplyStep.Reviewing;

    private bool IsConfirming() => Step == ApplyStep.Confirming;

    /// <summary>The reviewed plan is applied only while it still is what the edits say.</summary>
    private bool CanConfirmApply() => IsConfirming() && !EditsUnsaved && !EditsBusy && !HasLocks;

    /// <summary>Writes the reviewed plan, which the CLI checks against GitHub first.</summary>
    [RelayCommand(CanExecute = nameof(CanConfirmApply))]
    private async Task ConfirmApplyAsync()
    {
        Step = ApplyStep.Applying;
        var total = ChangeCount;
        ApplyResult result;
        try
        {
            result = await client.ApplyAsync(PlanFile, CancellationToken.None).ConfigureAwait(true);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException)
        {
            // The run may have written some changes before it failed.
            Fail($"{error.Message} Some changes may already be on GitHub, so review again before you apply.");
            return;
        }
        switch (result)
        {
            case ApplyResult.Applied applied:
                Outcome = $"Applied {Count(applied.Changes.Count, "change")} to {repository}.";
                // The apply is done, so its staged file goes; a failure to remove it only leaves it to resume.
                try
                {
                    await client.DiscardStagedAsync(file, CancellationToken.None).ConfigureAwait(true);
                    File.Delete(PlanFile);
                }
                catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
                {
                    Outcome += $" Repotted could not remove the finished apply, so it will offer to resume it: {error.Message}";
                }
                Step = ApplyStep.Applied;
                break;
            case ApplyResult.Stale:
                Outcome = $"{repository} changed on GitHub after you reviewed this apply, so nothing was applied. Review it again to see what it needs now.";
                Step = ApplyStep.Stale;
                break;
            case ApplyResult.PartlyApplied partly:
                // The CLI's first line says which change failed and why; the rest lists what this page already counts.
                var reason = partly.Message.Split('\n')[0].TrimEnd('.');
                Outcome = $"Applied {partly.Changes.Count} of {total} changes to {repository}, then stopped. {reason}. Nothing after it was written, so review again to see what is left.";
                Step = ApplyStep.PartlyApplied;
                break;
        }
    }

    /// <summary>Asks before throwing the staged apply away, since its one-off edits go with it.</summary>
    [RelayCommand(CanExecute = nameof(CanDiscard))]
    private void Discard()
    {
        beforeDiscard = Step;
        Step = ApplyStep.ConfirmingDiscard;
    }

    private bool CanDiscard() =>
        !Working && !EditsBusy
        && (Step is ApplyStep.Reviewing or ApplyStep.Stale or ApplyStep.PartlyApplied
            || (Step == ApplyStep.Failed && File.Exists(file)));

    [RelayCommand(CanExecute = nameof(IsConfirmingDiscard))]
    private void Keep() => Step = beforeDiscard;

    private bool IsConfirmingDiscard() => Step == ApplyStep.ConfirmingDiscard;

    /// <summary>Removes the staged apply, then leaves; the profile it starts from stays as it is.</summary>
    [RelayCommand(CanExecute = nameof(IsConfirmingDiscard))]
    private async Task ConfirmDiscardAsync()
    {
        Working = true;
        try
        {
            if (File.Exists(file))
            {
                await client.DiscardStagedAsync(file, CancellationToken.None).ConfigureAwait(true);
            }
            File.Delete(PlanFile);
        }
        catch (Exception error) when (error is CliException or CliNotFoundException or IOException or UnauthorizedAccessException)
        {
            Working = false;
            Step = beforeDiscard;
            Error = error.Message;
            return;
        }
        Working = false;
        Step = ApplyStep.Discarded;
        close();
    }

    /// <summary>Leaves the page; an unfinished staged apply stays to resume.</summary>
    [RelayCommand(CanExecute = nameof(CanLeave))]
    private void Close() => close();

    private TaskCompletionSource<bool>? leave;

    /// <summary>What the app waits to do while the page asks about its unsaved edits, such as "quit", or null.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(LeavingMessage), nameof(AskingToLeave))]
    public partial string? Leaving { get; private set; }

    public bool AskingToLeave => Leaving is not null;

    public string LeavingMessage => $"To {Leaving}, save or undo your one-off edits first.";

    /// <summary>
    /// Whether the app may leave the page to <paramref name="act"/>, such as
    /// "sign out". While the command line runs for the page, it says so and
    /// stays, since the run can't be stopped partway, or with
    /// <paramref name="wait"/> waits for the run to end, as a lost sign-in
    /// does. Unsaved one-off edits wait on a question until they are saved and
    /// planned again, or undone, or the apply is discarded, or the question
    /// is put aside.
    /// </summary>
    public async Task<bool> ConfirmLeaveAsync(string act, bool wait = false)
    {
        while (Busy)
        {
            if (!wait)
            {
                busyNote = $"Repotted is still working on this apply, so you can {act} once it is done.";
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
        Tab = 1;
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

    /// <summary>The note that leaving waits for a run, which goes once the run ends.</summary>
    private string? busyNote;

    /// <summary>Puts the question about leaving aside; the edits stay as they are.</summary>
    [RelayCommand]
    private void StayHere() => leave?.TrySetResult(false);

    private void Fail(string message)
    {
        Outcome = message;
        Step = ApplyStep.Failed;
    }

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";
}
