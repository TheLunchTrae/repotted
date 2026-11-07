namespace Repotted.Desktop.ViewModels;

/// <summary>A page that waits on the CLI.</summary>
internal sealed class LoadingViewModel(string message) : ViewModelBase
{
    public string Message { get; } = message;
}
