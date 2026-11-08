using System.Text.Json;
using System.Text.Json.Nodes;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A plan as rows by section, which the compare and the apply both show:
/// what differs, what matches, and where to grant what the locks need.
/// </summary>
internal static class PlanSections
{
    /// <summary>What the profile holds as drafts, which a plan leaves out, or null for none.</summary>
    internal static string? Drafts(PlanDocument plan) => plan.Skipped.Count == 0
        ? null
        : $"Left out as {(plan.Skipped.Count == 1 ? "a draft" : "drafts")}: {string.Join(", ", plan.Skipped.Select(Describe))}.";

    /// <summary>A draft as the plan names it: the ruleset Later, or a setting's path.</summary>
    private static string Describe(SkippedDocument draft) => draft.Section switch
    {
        "rulesets" => $"the ruleset {draft.Target}",
        "environments" => $"the environment {draft.Target}",
        "autolinks" => $"the autolink {draft.Target}",
        "labels" => $"the label {draft.Target}",
        _ => $"{draft.Section}.{draft.Target}",
    };

    /// <summary>
    /// Where to grant what a plan's locks need: the settings page of the App's
    /// installation on the repository, or the App's install page when it isn't installed there.
    /// </summary>
    internal static (string Label, Uri? Url) Access(PlanDocument plan, Uri? installUrl) =>
        plan.Access.App.Status != "not_installed"
            ? ("Review App access", Https(plan.Access.App.SettingsUrl))
            : ("Install the App", Https(installUrl?.ToString()));

    private static Uri? Https(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps ? url : null;

    /// <summary>
    /// The sections the profile names, in the editor's order.
    /// <paramref name="exclusion"/> gives what leaves out a change, by its
    /// index in the plan and its field, or null for a whole change.
    /// </summary>
    internal static IReadOnlyList<CompareSectionViewModel> Build(PlanDocument plan, Func<int, string?, RowExclusion?>? exclusion = null)
    {
        var desired = JsonNode.Parse(plan.Desired.GetRawText())?.AsObject() ?? [];
        var leaveOut = exclusion ?? ((_, _) => null);
        List<CompareSectionViewModel> sections = [];
        if (desired["repository"] is JsonObject || desired["merge"] is JsonObject)
        {
            sections.Add(Settings("Repository and merge settings", plan, desired, ["repository", "merge"], leaveOut));
        }
        foreach (var (title, name) in (ReadOnlySpan<(string, string)>)[
            ("Actions", "actions"), ("Security", "security"), ("Custom properties", "custom_properties"), ("GitHub Pages", "pages"),
        ])
        {
            if (desired[name] is JsonObject)
            {
                sections.Add(Settings(title, plan, desired, [name], leaveOut));
            }
        }
        if (desired["autolinks"] is JsonArray autolinks)
        {
            sections.Add(Entries("Autolinks", "autolink", plan, autolinks, "autolinks", leaveOut, key: "key_prefix"));
        }
        if (desired["rulesets"] is JsonArray rulesets)
        {
            sections.Add(Entries("Rulesets", "ruleset", plan, rulesets, "rulesets", leaveOut));
        }
        if (desired["environments"] is JsonArray environments)
        {
            sections.Add(Entries("Environments", "environment", plan, environments, "environments", leaveOut));
        }
        if (desired["labels"] is JsonArray labels)
        {
            sections.Add(Entries("Labels", "label", plan, labels, "labels", leaveOut));
        }
        return sections;
    }

    /// <summary>A section of single settings, one row for each that differs.</summary>
    private static CompareSectionViewModel Settings(
        string title,
        PlanDocument plan,
        JsonObject desired,
        string[] names,
        Func<int, string?, RowExclusion?> leaveOut)
    {
        // A section GitHub doesn't offer or show at all, such as Pages, is skipped whole.
        if (names is [var only]
            && plan.Warnings.FirstOrDefault(warning => warning.StartsWith($"Skipped {only}: ", StringComparison.Ordinal)) is { } skipped)
        {
            // A read GitHub refused or doesn't offer says so; anything else is the profile's to fix.
            var reason = skipped[$"Skipped {only}: ".Length..];
            var why = reason.StartsWith("GitHub ", StringComparison.Ordinal)
                ? $"Repotted could not read it: {reason}"
                : $"Not checked: {reason}";
            return new CompareSectionViewModel(title, [], [], why, skippedBy: skipped);
        }
        List<CompareRow> differences = [];
        HashSet<string> changed = new(StringComparer.Ordinal);
        foreach (var (change, index, locked) in Changes(plan).Where(item => names.Contains(item.Change.Section)))
        {
            // Making or taking down a whole thing, such as a Pages site, changes no one field.
            if (change.Fields.Count == 0)
            {
                differences.Add((change.Action == "delete"
                    ? new CompareRow(CompareKind.Removes, change.Target, "absent: true", CompareRow.OnGitHub, "Deleted", locked)
                    : new CompareRow(CompareKind.Adds, change.Target, $"new {change.Target}", CompareRow.NotOnGitHub, CompareRow.Created, locked))
                    with
                { LeaveOut = leaveOut(index, null) });
                changed.Add($"{change.Section}.absent");
                continue;
            }
            foreach (var field in change.Fields)
            {
                changed.Add($"{change.Section}.{field.Field}");
                foreach (var difference in Differences(field))
                {
                    var setting = Field(change.Section, difference.Path);
                    // A field leaves out by itself, or with its whole change, such as a Pages site's.
                    differences.Add(Row(difference, Label(setting, difference.Path), difference.Path, value => Show(setting, difference.Path, value), locked)
                        with
                    { LeaveOut = leaveOut(index, field.Field) ?? leaveOut(index, null) });
                }
            }
        }
        List<CompareRow> matching = [];
        foreach (var name in names)
        {
            var created = plan.Changes.Any(change => change.Section == name && change.Action == "create" && change.Fields.Count == 0);
            foreach (var (key, value) in Flat(name, desired[name] as JsonObject))
            {
                // A plan skips what cannot apply, such as selected actions while
                // all actions are allowed, and a new site's settings come with it.
                if (Covers(changed, name, key) || created || Skips(plan, name, key))
                {
                    continue;
                }
                var setting = Field(name, key);
                var shown = key == "absent" ? "Yes" : Show(setting, key, value);
                matching.Add(new CompareRow(CompareKind.Matches, Label(setting, key), key, shown, shown));
            }
        }
        var summary = matching.Count switch
        {
            0 => "",
            1 => "1 setting matches.",
            var count => $"{count} settings match.",
        };
        // A row is found by what the editor's setting is found by, such as its description and synonyms.
        return new CompareSectionViewModel(title, differences, matching, summary, terms: row =>
            names.Select(name => Field(name, row.Key)).OfType<SettingField>().Select(SettingSearch.Terms).FirstOrDefault() ?? title);
    }

    /// <summary>
    /// A section of named entries: autolinks, rulesets, environments or
    /// labels. A new entry is one row, a changed one a row for each part that
    /// differs, and an entry the profile removes one row.
    /// </summary>
    private static CompareSectionViewModel Entries(
        string title,
        string noun,
        PlanDocument plan,
        JsonArray entries,
        string name,
        Func<int, string?, RowExclusion?> leaveOut,
        string key = "name")
    {
        if (plan.Warnings.FirstOrDefault(warning => warning.StartsWith($"Skipped {name}: ", StringComparison.Ordinal)) is { } skipped)
        {
            return new CompareSectionViewModel(title, [], [], $"Repotted could not read the {name}: {skipped[$"Skipped {name}: ".Length..]}", skippedBy: skipped);
        }
        // Each change names its entry as the profile writes it.
        List<CompareRow> differences = [];
        HashSet<string> touched = new(StringComparer.Ordinal);
        var section = Changes(plan).Where(item => item.Change.Section == name).ToList();
        foreach (var (change, index, locked) in section)
        {
            var exclusion = leaveOut(index, null);
            var named = change.Entry;
            if (named is not null)
            {
                touched.Add(named.Name);
            }
            // GitHub can't change an autolink, so the plan deletes one and makes it
            // again, and the create's row shows what differs.
            var remade = named is not null
                && section.Any(other => other.Change.Action == "delete" && other.Change.Entry == named)
                && section.Any(other => other.Change.Action == "create" && other.Change.Entry == named);
            if (remade && change.Action == "delete")
            {
                continue;
            }
            var policy = named?.BranchPolicy is not null;
            switch (change.Action)
            {
                case "create" when remade:
                    foreach (var field in change.Fields)
                    {
                        foreach (var difference in Differences(field))
                        {
                            differences.Add(Row(difference, change.Target, difference.Path, CompareRows.Show, locked) with { LeaveOut = exclusion });
                        }
                    }
                    break;
                case "create":
                    var rules = change.Fields.FirstOrDefault(field => field.Field == "rules");
                    differences.Add(new CompareRow(
                        CompareKind.Adds,
                        change.Target,
                        policy ? "new branch policy" : $"new {noun}",
                        CompareRow.NotOnGitHub,
                        rules is null ? CompareRow.Created : Rules(CompareRows.Node(rules.To)),
                        locked)
                    { LeaveOut = exclusion });
                    break;
                case "delete":
                    differences.Add((policy
                        ? new CompareRow(CompareKind.Removes, change.Target, "branch_policies", CompareRow.OnGitHub, Removed, locked)
                        : new CompareRow(CompareKind.Removes, change.Target, "absent: true", CompareRow.OnGitHub, "Deleted", locked))
                        with
                    { LeaveOut = exclusion });
                    break;
                default:
                    foreach (var field in change.Fields)
                    {
                        foreach (var difference in Differences(field))
                        {
                            differences.Add(Row(difference, change.Target, difference.Path, CompareRows.Show, locked) with { LeaveOut = exclusion });
                        }
                    }
                    break;
            }
        }
        List<CompareRow> matching = [];
        var absent = 0;
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var entryName = entry[key]?.GetValue<string>() ?? "";
            if (touched.Contains(entryName))
            {
                continue;
            }
            if (entry["absent"]?.GetValue<bool>() == true)
            {
                absent++;
                continue;
            }
            matching.Add(new CompareRow(CompareKind.Matches, entryName, noun, CompareRow.SameAsProfile, "No change"));
        }
        List<string> parts = [];
        if (matching.Count > 0)
        {
            parts.Add(matching.Count == 1 ? $"1 {noun} matches." : $"{matching.Count} {noun}s match.");
        }
        if (absent > 0)
        {
            parts.Add(absent == 1 ? $"1 removed {noun} is already gone." : $"{absent} removed {noun}s are already gone.");
        }
        return new CompareSectionViewModel(title, differences, matching, string.Join(" ", parts));
    }

    private const string Removed = "Removed";

    /// <summary>A new ruleset's rules, each with what it sets.</summary>
    private static string Rules(JsonNode? rules) =>
        rules is JsonArray { Count: > 0 } list ? string.Join("; ", list.Select(CompareRows.Show)) : CompareRows.Show(rules);

    /// <summary>The parts of a plan's field change that differ. A field with no <c>from</c> is not on GitHub; a JSON null is.</summary>
    private static IEnumerable<Difference> Differences(FieldChangeDocument field) =>
        CompareRows.Differences(
            field.Field,
            CompareRows.Node(field.From),
            CompareRows.Node(field.To),
            onGitHub: field.From.ValueKind != JsonValueKind.Undefined,
            inProfile: field.To.ValueKind != JsonValueKind.Undefined);

    private static CompareRow Row(Difference difference, string label, string key, Func<JsonNode?, string> show, string? locked) =>
        difference.Kind switch
        {
            CompareKind.Adds => new CompareRow(CompareKind.Adds, label, key, CompareRow.NotOnGitHub, show(difference.Wanted), locked),
            CompareKind.Removes => new CompareRow(CompareKind.Removes, label, key, show(difference.Now), Removed, locked),
            var kind => new CompareRow(kind, label, key, show(difference.Now), show(difference.Wanted), locked),
        };

    /// <summary>The plan's changes, each with its index and the reason Repotted cannot make it, or null when it can.</summary>
    private static IEnumerable<(PlanChangeDocument Change, int Index, string? Locked)> Changes(PlanDocument plan) =>
        plan.Changes.Select((change, index) => (change, index, plan.Locks.FirstOrDefault(item => item.Change == index)?.Reason));

    /// <summary>
    /// Whether a change covers a setting: it names the setting, or an object
    /// the setting is part of, as Pages names <c>source</c> for <c>source.branch</c>.
    /// </summary>
    private static bool Covers(HashSet<string> changed, string section, string key)
    {
        var parts = key.Split('.');
        return Enumerable.Range(1, parts.Length).Any(count => changed.Contains($"{section}.{string.Join('.', parts[..count])}"));
    }

    /// <summary>
    /// Whether the plan skipped a setting, with a warning that names it, the
    /// object it is part of, or its section.
    /// </summary>
    private static bool Skips(PlanDocument plan, string section, string key)
    {
        var top = key.Split('.')[0];
        string[] prefixes = [$"Skipped {section}.{key}:", $"Skipped {section}.{top}:", $"Skipped {section}:"];
        return plan.Warnings.Any(warning => prefixes.Any(prefix => warning.StartsWith(prefix, StringComparison.Ordinal)));
    }

    private static readonly IReadOnlyList<SettingField> Fields =
        [.. ProfileFields.Sections.SelectMany(tab => tab.Groups).SelectMany(group => group.Fields)];

    /// <summary>
    /// A section's settings by key, with an object opened up where the editor
    /// shows its parts as settings of their own, such as <c>selected_actions</c>.
    /// </summary>
    private static IEnumerable<(string Key, JsonNode? Value)> Flat(string section, JsonObject? values, string prefix = "")
    {
        foreach (var (name, value) in values ?? [])
        {
            var key = prefix + name;
            var opens = value is JsonObject
                && !Fields.Any(field => field.Section == section && field.Key == key)
                && Fields.Any(field => field.Section == section && field.Key.StartsWith($"{key}.", StringComparison.Ordinal));
            if (opens)
            {
                foreach (var inner in Flat(section, (JsonObject)value!, $"{key}."))
                {
                    yield return inner;
                }
            }
            else
            {
                yield return (key, value);
            }
        }
    }

    /// <summary>A setting's name as the editor shows it, or its key for one the editor leaves to the YAML.</summary>
    private static string Label(SettingField? setting, string key) => setting?.Label ?? key switch
    {
        "selected_actions.patterns_allowed" => "Allowed action patterns",
        "absent" => "No Pages site",
        _ => key,
    };

    /// <summary>
    /// The editor's setting at a key, or the one a part of a value belongs to,
    /// as <c>security_and_analysis.secret_scanning.status</c> is part of Secret
    /// Protection.
    /// </summary>
    private static SettingField? Field(string section, string key) =>
        Fields.FirstOrDefault(field => field.Section == section && field.Key == key)
        ?? Fields.Where(field => field.Section == section && key.StartsWith($"{field.Key}.", StringComparison.Ordinal))
            .MaxBy(field => field.Key.Length);

    /// <summary>A value as the editor names it, such as On or Read and write, or as GitHub writes it.</summary>
    private static string Show(SettingField? field, string key, JsonNode? value)
    {
        // A part of a value is matched against the same part of each option.
        var rest = field is null || key == field.Key ? [] : key[(field.Key.Length + 1)..].Split('.');
        return field?.Options.FirstOrDefault(option => JsonNode.DeepEquals(Part(option.Value, rest), value))?.Label
            ?? CompareRows.Show(value);
    }

    private static JsonNode? Part(JsonNode? value, string[] path) =>
        path.Aggregate(value, (node, part) => node is JsonObject inner ? inner[part] : null);
}
