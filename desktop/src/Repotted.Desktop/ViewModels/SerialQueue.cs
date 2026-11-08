namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Runs work one at a time, in the order it was queued: each waits for the
/// one before it to end, whether that one succeeded or failed. Work is queued
/// from the UI thread. Queued work must not await <see cref="Idle"/> or queue
/// more work and await it, since that work waits for the queued work to end.
/// </summary>
internal sealed class SerialQueue
{
    private Task last = Task.CompletedTask;

    /// <summary>Ends once everything queued so far has ended.</summary>
    public Task Idle => last;

    /// <summary>Runs <paramref name="work"/> once everything queued before it has ended, and holds what is queued after it until it ends.</summary>
    public async Task<T> RunAsync<T>(Func<Task<T>> work)
    {
        var previous = last;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Taken before the first await, so work queued next waits for this.
        last = done.Task;
        try
        {
            await previous.ConfigureAwait(true);
            return await work().ConfigureAwait(true);
        }
        finally
        {
            done.SetResult();
        }
    }

    /// <summary>Runs <paramref name="work"/> once everything queued before it has ended, and holds what is queued after it until it ends.</summary>
    public Task RunAsync(Func<Task> work) => RunAsync<bool>(async () =>
    {
        await work().ConfigureAwait(true);
        return true;
    });
}
