using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>One value a setting can take, with its label.</summary>
internal sealed record SettingOption(string Label, JsonNode Value);

/// <summary>
/// A profile setting the app edits: <paramref name="Key"/> is its name in the
/// profile, under <paramref name="Section"/>, such as <c>has_wiki</c> or
/// <c>selected_actions.verified_allowed</c>.
/// </summary>
internal sealed record SettingField(string Section, string Key, string Label, IReadOnlyList<SettingOption> Options)
{
    /// <summary>How the CLI names it, such as <c>repository.has_wiki</c>.</summary>
    public string Path => $"{Section}.{Key}";
}

internal sealed record SettingGroup(string Title, string Description, IReadOnlyList<SettingField> Fields);

/// <summary>A tab of settings: one profile section.</summary>
internal sealed record SettingSection(string Name, string Section, IReadOnlyList<SettingGroup> Groups);

/// <summary>
/// The settings the app edits, by tab, with the labels GitHub's settings pages
/// use. Keys are the profile's, which are the GitHub REST API's field names.
/// </summary>
internal static class ProfileFields
{
    private static readonly SettingOption[] OnOff = [new("On", true), new("Off", false)];

    private static SettingField Switch(string section, string key, string label) => new(section, key, label, OnOff);

    private static SettingField Choice(string section, string key, string label, params (string Label, string Value)[] options) =>
        new(section, key, label, [.. options.Select(option => new SettingOption(option.Label, option.Value))]);

    public static IReadOnlyList<SettingSection> Sections { get; } =
    [
        new("Repository", "repository",
        [
            new("Features", "What the repository shows on GitHub.",
            [
                Switch("repository", "has_issues", "Issues"),
                Switch("repository", "has_projects", "Projects"),
                Switch("repository", "has_wiki", "Wiki"),
                Switch("repository", "has_discussions", "Discussions"),
            ]),
            new("Pull requests", "How branches update and clean up after a merge.",
            [
                Switch("repository", "allow_auto_merge", "Allow auto-merge"),
                Switch("repository", "allow_update_branch", "Suggest updating branches"),
                Switch("repository", "delete_branch_on_merge", "Delete head branches after merge"),
                Switch("repository", "web_commit_signoff_required", "Require sign-off on web commits"),
            ]),
        ]),
        new("Merge", "merge",
        [
            new("Merge methods", "How pull requests can merge. GitHub needs at least one.",
            [
                Switch("merge", "allow_merge_commit", "Allow merge commits"),
                Switch("merge", "allow_squash_merge", "Allow squash merging"),
                Switch("merge", "allow_rebase_merge", "Allow rebase merging"),
            ]),
            new("Commit messages", "What a merge or squash commit says. GitHub takes only the pairs its settings page offers.",
            [
                Choice("merge", "merge_commit_title", "Merge commit title",
                    ("Pull request title", "PR_TITLE"), ("Default message", "MERGE_MESSAGE")),
                Choice("merge", "merge_commit_message", "Merge commit message",
                    ("Pull request body", "PR_BODY"), ("Pull request title", "PR_TITLE"), ("Blank", "BLANK")),
                Choice("merge", "squash_merge_commit_title", "Squash commit title",
                    ("Pull request title", "PR_TITLE"), ("Commit or pull request title", "COMMIT_OR_PR_TITLE")),
                Choice("merge", "squash_merge_commit_message", "Squash commit message",
                    ("Pull request body", "PR_BODY"), ("Commit messages", "COMMIT_MESSAGES"), ("Blank", "BLANK")),
            ]),
        ]),
        new("Actions", "actions",
        [
            new("Policy", "Whether workflows run, and which actions they may use. Allowed action patterns are edited in the YAML.",
            [
                Switch("actions", "enabled", "Actions"),
                Choice("actions", "allowed_actions", "Allowed actions",
                    ("All", "all"), ("This owner's", "local_only"), ("Selected", "selected")),
                Switch("actions", "selected_actions.github_owned_allowed", "Actions by GitHub"),
                Switch("actions", "selected_actions.verified_allowed", "Actions by verified creators"),
                Switch("actions", "sha_pinning_required", "Require pinning to a full commit SHA"),
            ]),
            new("Workflow permissions", "What the GITHUB_TOKEN may do.",
            [
                Choice("actions", "default_workflow_permissions", "Default permissions",
                    ("Read", "read"), ("Read and write", "write")),
                Switch("actions", "can_approve_pull_request_reviews", "Allow approving pull requests"),
            ]),
        ]),
    ];
}
