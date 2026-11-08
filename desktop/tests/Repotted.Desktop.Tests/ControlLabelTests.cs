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
    [InlineData("Open the macOS settings", "Open the macOS Settings")]
    [InlineData("Save as", "Save As")]
    [InlineData("_Save as", "_Save As")]
    [InlineData("_save _as", "_Save _As")]
    [InlineData("A ruleset to start from", "A Ruleset to Start From")]
    [InlineData("/ (root)", "/ (root)")]
    [InlineData("/docs", "/docs")]
    public void TitleStyleCapitalizesAsAppleDoes(string label, string expected) =>
        Assert.Equal(expected, ControlLabel.TitleStyle(label));
}
