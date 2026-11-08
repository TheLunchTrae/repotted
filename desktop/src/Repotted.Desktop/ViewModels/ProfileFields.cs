using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>One value a setting can take, with its label.</summary>
internal sealed record SettingOption(string Label, JsonNode Value);

/// <summary>How a setting is edited.</summary>
internal enum SettingKind
{
    /// <summary>One of a few values, in a segmented control.</summary>
    Choice,

    /// <summary>A whole number, at least <see cref="SettingField.Minimum"/>.</summary>
    Number,

    /// <summary>A line of text.</summary>
    Text,
}

/// <summary>
/// A profile setting the app edits: <paramref name="Key"/> is its name in the
/// profile, under <paramref name="Section"/>, such as <c>has_wiki</c> or
/// <c>selected_actions.verified_allowed</c>.
/// </summary>
internal sealed record SettingField(string Section, string Key, string Label, IReadOnlyList<SettingOption> Options)
{
    /// <summary>How the CLI names it, such as <c>repository.has_wiki</c>.</summary>
    public string Path => $"{Section}.{Key}";

    public SettingKind Kind { get; init; } = SettingKind.Choice;

    /// <summary>Whether it belongs to the setting above it, as GitHub's settings page shows it.</summary>
    public bool Nested { get; init; }

    /// <summary>A short note under the label, such as a sub-option GitHub offers no API for.</summary>
    public string? Note { get; init; }

    /// <summary>The smallest number a <see cref="SettingKind.Number"/> takes.</summary>
    public int Minimum { get; init; } = 1;

    /// <summary>Whether a <see cref="SettingKind.Text"/> may be empty, as a description may.</summary>
    public bool AllowsEmpty { get; init; }

    /// <summary>The setting as a sub-option of the one above it.</summary>
    public SettingField Under() => this with { Nested = true };

    public SettingField Noted(string note) => this with { Note = note };
}

internal sealed record SettingGroup(string Title, string Description, IReadOnlyList<SettingField> Fields);

/// <summary>A tab of settings: one profile section.</summary>
internal sealed record SettingSection(string Name, string Section, IReadOnlyList<SettingGroup> Groups);

/// <summary>
/// The settings the app edits, by tab, with the labels GitHub's settings pages
/// use. Keys are the profile's, which are the GitHub REST API's field names.
/// A sub-option follows the setting it belongs to, marked
/// <see cref="SettingField.Nested"/>. Lists, such as topics, are edited in the
/// YAML, and a group's description says so.
/// </summary>
internal static class ProfileFields
{
    private static readonly SettingOption[] OnOff = [new("On", true), new("Off", false)];

    /// <summary>A security and analysis feature, which GitHub writes as a status.</summary>
    private static readonly SettingOption[] Status =
    [
        new("On", new JsonObject { ["status"] = "enabled" }),
        new("Off", new JsonObject { ["status"] = "disabled" }),
    ];

    private static SettingField Switch(string section, string key, string label) => new(section, key, label, OnOff);

    private static SettingField Feature(string key, string label) =>
        new("security", $"security_and_analysis.{key}", label, Status);

    private static SettingField Choice(string section, string key, string label, params (string Label, string Value)[] options) =>
        new(section, key, label, [.. options.Select(option => new SettingOption(option.Label, option.Value))]);

    private static SettingField Number(string section, string key, string label) =>
        new(section, key, label, []) { Kind = SettingKind.Number };

    private static SettingField Text(string section, string key, string label, bool allowsEmpty = false) =>
        new(section, key, label, []) { Kind = SettingKind.Text, AllowsEmpty = allowsEmpty };

    public static IReadOnlyList<SettingSection> Sections { get; } =
    [
        new("Repository", "repository",
        [
            new("About", "The description, website, and visibility describe one repository, so a captured profile leaves them out. Topics, custom properties, and autolinks are edited in the YAML.",
            [
                Text("repository", "description", "Description", allowsEmpty: true),
                Text("repository", "homepage", "Website", allowsEmpty: true),
                Text("repository", "default_branch", "Default branch"),
                Choice("repository", "visibility", "Visibility", ("Public", "public"), ("Private", "private"))
                    .Noted("A plan says what a change of visibility does before it applies."),
                Switch("repository", "is_template", "Template repository"),
                Switch("repository", "allow_forking", "Allow forking"),
            ]),
            new("Features", "What the repository shows on GitHub.",
            [
                Switch("repository", "has_issues", "Issues")
                    .Noted("Limiting issues to collaborators has no API, so it is set on GitHub only."),
                Switch("repository", "has_projects", "Projects"),
                Switch("repository", "has_wiki", "Wiki")
                    .Noted("Restricting editing to collaborators has no API, so it is set on GitHub only."),
                Switch("repository", "has_discussions", "Discussions"),
                Switch("repository", "has_pull_requests", "Pull requests"),
                Choice("repository", "pull_request_creation_policy", "Who can create pull requests",
                    ("Everyone", "all"), ("Collaborators only", "collaborators_only")).Under(),
                Switch("repository", "pull_request_creation_cap.enabled", "Limit open pull requests per user").Under()
                    .Noted("Exemptions by account age or merged pull requests have no API, so they are set on GitHub only."),
                Number("repository", "pull_request_creation_cap.max_open_pull_requests", "Open pull requests allowed").Under(),
                Switch("repository", "pull_request_creation_cap.include_drafts", "Count draft pull requests").Under(),
            ]),
            new("Pull requests", "How branches update and clean up after a merge.",
            [
                Switch("repository", "allow_auto_merge", "Allow auto-merge"),
                Switch("repository", "allow_update_branch", "Suggest updating branches"),
                Switch("repository", "delete_branch_on_merge", "Delete head branches after merge"),
                Switch("repository", "web_commit_signoff_required", "Require sign-off on web commits"),
            ]),
            new("Releases", "Whether a published release's tag and assets are locked.",
            [
                Switch("repository", "immutable_releases", "Immutable releases"),
            ]),
        ]),
        new("Merge", "merge",
        [
            new("Merge methods", "How pull requests can merge, and what each kind of commit says. GitHub needs at least one method, and takes only the commit title and message pairs its settings page offers.",
            [
                Switch("merge", "allow_merge_commit", "Allow merge commits"),
                Choice("merge", "merge_commit_title", "Merge commit title",
                    ("Pull request title", "PR_TITLE"), ("Default message", "MERGE_MESSAGE")).Under(),
                Choice("merge", "merge_commit_message", "Merge commit message",
                    ("Pull request body", "PR_BODY"), ("Pull request title", "PR_TITLE"), ("Blank", "BLANK")).Under(),
                Switch("merge", "allow_squash_merge", "Allow squash merging"),
                Choice("merge", "squash_merge_commit_title", "Squash commit title",
                    ("Pull request title", "PR_TITLE"), ("Commit or pull request title", "COMMIT_OR_PR_TITLE")).Under(),
                Choice("merge", "squash_merge_commit_message", "Squash commit message",
                    ("Pull request body", "PR_BODY"), ("Commit messages", "COMMIT_MESSAGES"), ("Blank", "BLANK")).Under(),
                Switch("merge", "allow_rebase_merge", "Allow rebase merging"),
            ]),
        ]),
        new("Actions", "actions",
        [
            new("Policy", "Whether workflows run, and which actions they may use. Allowed action patterns are edited in the YAML.",
            [
                Switch("actions", "enabled", "Actions"),
                Choice("actions", "allowed_actions", "Allowed actions",
                    ("All", "all"), ("This owner's", "local_only"), ("Selected", "selected")).Under(),
                Switch("actions", "selected_actions.github_owned_allowed", "Actions by GitHub").Under(),
                Switch("actions", "selected_actions.verified_allowed", "Actions by verified creators").Under(),
                Switch("actions", "sha_pinning_required", "Require pinning to a full commit SHA").Under(),
            ]),
            new("Workflow permissions", "What the GITHUB_TOKEN may do.",
            [
                Choice("actions", "default_workflow_permissions", "Default permissions",
                    ("Read", "read"), ("Read and write", "write")),
                Switch("actions", "can_approve_pull_request_reviews", "Allow approving pull requests"),
            ]),
            new("Access", "Whether workflows in other private repositories can use this one's actions and reusable workflows. Private repositories only.",
            [
                Choice("actions", "access_level", "Accessible from",
                    ("Nowhere else", "none"), ("This user's repositories", "user"), ("This organization's repositories", "organization")),
            ]),
            new("Fork pull requests", "When workflows from forks run, and what they get.",
            [
                Choice("actions", "approval_policy", "Require approval for",
                    ("New GitHub users", "first_time_contributors_new_to_github"),
                    ("First-time contributors", "first_time_contributors"),
                    ("All outside contributors", "all_external_contributors")),
                Switch("actions", "fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests", "Run workflows from fork pull requests")
                    .Noted("Private repositories only."),
                Switch("actions", "fork_pr_workflows_private_repos.send_write_tokens_to_workflows", "Send write tokens to workflows").Under(),
                Switch("actions", "fork_pr_workflows_private_repos.send_secrets_and_variables", "Send secrets and variables").Under(),
                Switch("actions", "fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows", "Require approval for each run").Under(),
            ]),
            new("Artifacts and caches", "How long workflow output stays, and how much the cache holds.",
            [
                Number("actions", "artifact_and_log_retention.days", "Artifact and log retention, in days"),
                Number("actions", "max_cache_retention_days", "Cache retention, in days"),
                Number("actions", "max_cache_size_gb", "Cache size limit, in GB"),
            ]),
            new("OpenID Connect", "The subject claim in the tokens workflows get from GitHub. Claim keys are edited in the YAML.",
            [
                Switch("actions", "oidc_customization_sub.use_default", "Use the default subject claim"),
                Switch("actions", "oidc_customization_sub.use_immutable_subject", "Use immutable IDs in the subject"),
            ]),
        ]),
        new("Security", "security",
        [
            new("Advanced Security", "GitHub shows and changes these for repository admins only.",
            [
                Feature("advanced_security", "GitHub Advanced Security"),
                Feature("code_security", "GitHub Code Security"),
                Switch("security", "private_vulnerability_reporting", "Private vulnerability reporting"),
            ]),
            new("Dependabot", "Alerts and pull requests for vulnerable dependencies.",
            [
                Switch("security", "vulnerability_alerts", "Dependabot alerts")
                    .Noted("Malware alerts and Dependabot rules have no API, so they are set on GitHub only."),
                Switch("security", "automated_security_fixes", "Dependabot security updates").Under()
                    .Noted("Grouping security updates has no API; groups in dependabot.yml do it instead."),
                Choice("security", "dependabot_runner_settings.runner_type", "Dependabot runners",
                    ("Standard", "standard"), ("Labeled", "labeled")).Noted("Runner labels are edited in the YAML."),
            ]),
            new("Code scanning", "Finds problems in the code with CodeQL.",
            [
                Choice("security", "code_scanning_default_setup.state", "Default setup",
                    ("Configured", "configured"), ("Not configured", "not-configured"))
                    .Noted("Copilot Autofix has no API, so it is set on GitHub only."),
                Choice("security", "code_scanning_default_setup.query_suite", "Query suite",
                    ("Default", "default"), ("Extended", "extended")).Under(),
                Choice("security", "code_scanning_default_setup.threat_model", "Threat model",
                    ("Remote", "remote"), ("Remote and local", "remote_and_local")).Under(),
                Choice("security", "code_scanning_default_setup.runner_type", "Runner type",
                    ("Standard", "standard"), ("Labeled", "labeled")).Under(),
                Choice("security", "code_scanning_ai_scan.pr_scan", "AI Scan on pull requests",
                    ("On", "enabled"), ("Off", "disabled")),
            ]),
            new("Code quality", "Finds maintainability and reliability problems.",
            [
                Choice("security", "code_quality_setup.state", "Code quality",
                    ("Configured", "configured"), ("Not configured", "not-configured")),
                Choice("security", "code_quality_setup.ai_findings_option", "AI findings",
                    ("Off", "disabled"), ("On push", "on_push")).Under(),
            ]),
            new("Secret scanning", "Finds secrets pushed to the repository.",
            [
                Feature("secret_scanning", "Secret Protection"),
                Feature("secret_scanning_push_protection", "Push protection").Under(),
                Feature("secret_scanning_ai_detection", "AI detection").Under(),
                Feature("secret_scanning_non_provider_patterns", "Non-provider patterns").Under(),
                Feature("secret_scanning_validity_checks", "Validity checks").Under()
                    .Noted("GitHub Enterprise Cloud only."),
                Feature("secret_scanning_delegated_alert_dismissal", "Delegated alert dismissal").Under(),
                Feature("secret_scanning_delegated_bypass", "Delegated bypass").Under()
                    .Noted("Who can approve a bypass is edited in the YAML."),
            ]),
        ]),
        new("Pages", "pages",
        [
            new("GitHub Pages", "The site GitHub publishes from the repository. To take a site down, set pages to absent: true in the YAML.",
            [
                Choice("pages", "build_type", "Build from", ("A branch", "legacy"), ("GitHub Actions", "workflow")),
                Text("pages", "source.branch", "Branch").Under(),
                Choice("pages", "source.path", "Folder", ("/ (root)", "/"), ("/docs", "/docs")).Under(),
                Text("pages", "cname", "Custom domain"),
                Switch("pages", "https_enforced", "Enforce HTTPS"),
                new SettingField("pages", "public", "Who can see the site",
                    [new("Everyone", true), new("People with access", false)])
                    .Noted("GitHub Enterprise Cloud only."),
            ]),
        ]),
    ];
}
