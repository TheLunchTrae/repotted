namespace Repotted.Desktop.ViewModels;

/// <summary>Who has a setting or one of its values: only personal accounts, only organizations, or only organizations on GitHub Enterprise Cloud.</summary>
internal enum OwnerNeed
{
    User,
    Organization,
    Enterprise,
}

/// <summary>One of a profile's owner types, as its <c>owner_type</c> holds it, or null for any owner, with how the app names it.</summary>
internal sealed record OwnerTypeChoice(string? Type, string Label, string Help);

/// <summary>
/// The owner types a profile can be for, and the settings and values only
/// some owners have, as the CLI's JSON Schema marks them with
/// <c>x-repotted-owner</c> and <c>x-repotted-owner-values</c>.
/// </summary>
internal static class Owners
{
    public static IReadOnlyList<OwnerTypeChoice> Choices { get; } =
    [
        new("user", "Personal accounts", "Settings only organizations have stay hidden."),
        new("organization", "Organizations", "Every setting. The ones only GitHub Enterprise Cloud has are marked."),
        new(null, "Any owner", "For a base profile that both kinds extend. GitHub skips what a repository doesn't have."),
    ];

    /// <summary>The settings only some owners have, by path; a path stands for everything under it.</summary>
    public static IReadOnlyDictionary<string, OwnerNeed> Settings { get; } = new Dictionary<string, OwnerNeed>(StringComparer.Ordinal)
    {
        ["repository.allow_forking"] = OwnerNeed.Organization,
        ["actions.fork_pr_workflows_private_repos"] = OwnerNeed.Organization,
        ["security.security_and_analysis.advanced_security"] = OwnerNeed.Organization,
        ["security.security_and_analysis.code_security"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_ai_detection"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_non_provider_patterns"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_delegated_alert_dismissal"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_delegated_bypass"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_delegated_bypass_options"] = OwnerNeed.Organization,
        ["security.security_and_analysis.secret_scanning_validity_checks"] = OwnerNeed.Enterprise,
        ["security.code_quality_setup"] = OwnerNeed.Organization,
        ["custom_properties"] = OwnerNeed.Organization,
        ["pages.public"] = OwnerNeed.Enterprise,
    };

    /// <summary>The values only some owners have, by setting path and then value.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyDictionary<string, OwnerNeed>> Values { get; } =
        new Dictionary<string, IReadOnlyDictionary<string, OwnerNeed>>(StringComparer.Ordinal)
        {
            ["actions.access_level"] = new Dictionary<string, OwnerNeed>(StringComparer.Ordinal)
            {
                ["user"] = OwnerNeed.User,
                ["organization"] = OwnerNeed.Organization,
            },
        };

    /// <summary>Ruleset targets only organizations have.</summary>
    public static IReadOnlySet<string> OrganizationTargets { get; } = new HashSet<string>(StringComparer.Ordinal) { "push" };

    /// <summary>Who has the setting at <paramref name="path"/>, or null when every owner does.</summary>
    public static OwnerNeed? Need(string path)
    {
        foreach (var (prefix, need) in Settings)
        {
            if (path == prefix || path.StartsWith(prefix + ".", StringComparison.Ordinal))
            {
                return need;
            }
        }
        return null;
    }

    /// <summary>Who has <paramref name="value"/> of the setting at <paramref name="path"/>, or null when every owner does.</summary>
    public static OwnerNeed? Need(string path, string? value) =>
        value is not null && Values.TryGetValue(path, out var values) && values.TryGetValue(value, out var need) ? need : null;

    /// <summary>Whether an owner of <paramref name="type"/> has what <paramref name="need"/> asks for. A profile for any owner has everything.</summary>
    public static bool Has(string? type, OwnerNeed? need) => need switch
    {
        null => true,
        _ when type is null => true,
        OwnerNeed.User => type == "user",
        _ => type == "organization",
    };

    /// <summary>The label of an owner type, such as Personal accounts.</summary>
    public static string Label(string? type) => Choices.First(choice => choice.Type == type).Label;
}
