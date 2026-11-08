using Repotted.Desktop.ViewModels;

namespace Repotted.Desktop.Tests;

public sealed class SerialQueueTests
{
    [Fact]
    public async Task Work_waits_for_the_work_queued_before_it_even_when_that_fails()
    {
        var queue = new SerialQueue();
        var release = new TaskCompletionSource();
        List<string> ran = [];
        async Task<int> First()
        {
            await release.Task;
            ran.Add("first");
            throw new InvalidOperationException("The first work failed.");
        }
        Task<int> Second()
        {
            ran.Add("second");
            return Task.FromResult(2);
        }

        var first = queue.RunAsync<int>(First);
        var second = queue.RunAsync<int>(Second);
        Assert.Empty(ran);
        Assert.False(queue.Idle.IsCompleted);

        release.SetResult();
        await Assert.ThrowsAsync<InvalidOperationException>(() => first);
        Assert.Equal(2, await second);
        Assert.True(queue.Idle.IsCompleted);
        Assert.Equal(["first", "second"], ran);
    }
}
