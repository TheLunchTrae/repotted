using Repotted.Desktop.Theme;

namespace Repotted.Desktop.Tests;

public sealed class ControlLabelTests
{
    [Theory]
    [InlineData("Keep mine", "Keep Mine")]
    [InlineData("Sign in with GitHub", "Sign In with GitHub")]
    [InlineData("Remove it from the repository", "Remove It from the Repository")]
    [InlineData("Take out of profile", "Take Out of Profile")]
    [InlineData("Capture as a profile", "Capture as a Profile")]
    [InlineData("Back to rulesets", "Back to Rulesets")]
    [InlineData("Use a GitHub repository", "Use a GitHub Repository")]
    [InlineData("Use GitHub's", "Use GitHub's")]
    [InlineData("Commit or pull request title", "Commit or Pull Request Title")]
    [InlineData("This owner's", "This Owner's")]
    [InlineData("Show YAML", "Show YAML")]
    [InlineData("Open the macOS settings", "Open the macOS Settings")]
    [InlineData("Log in", "Log In")]
    public void TitleStyleCapitalizesAsAppleDoes(string label, string expected) =>
        Assert.Equal(expected, ControlLabel.TitleStyle(label));
}
