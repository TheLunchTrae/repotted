using CommunityToolkit.Mvvm.Input;

namespace Repotted.Desktop.ViewModels;

/// <summary>The app cannot go on, such as when the CLI is missing; says why and offers to try again.</summary>
internal sealed partial class ProblemViewModel(string message, Func<Task> retry) : ViewModelBase
{
    public string Message { get; } = message;

    [RelayCommand]
    private Task TryAgainAsync() => retry();
}
