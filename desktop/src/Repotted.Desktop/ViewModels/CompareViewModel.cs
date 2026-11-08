using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>A section of a compare: the rows that differ, the rows that match, and a line for the rest.</summary>
internal sealed partial class CompareSectionViewModel(
    string title,
    IReadOnlyList<CompareRow> differences,
    IReadOnlyList<CompareRow> matching,
    string summary,
    string? skippedBy = null)
    : ViewModelBase
{
    public string Title => title;

    public IReadOnlyList<CompareRow> Differences => differences;

    public bool InLine => !Skipped && differences.Count == 0;

    /// <summary>Whether the plan could not read this section, so nothing about it is known.</summary>
    public bool Skipped => skippedBy is not null;

    /// <summary>The plan's warning that says why this section was not read, which shows here and not with the other warnings.</summary>
    public string? SkippedBy => skippedBy;

    public bool HasChanges => differences.Count > 0;

    public string Status => (Skipped, differences.Count) switch
    {
        (true, _) => "Not checked",
        (_, 0) => "In line",
        (_, 1) => "1 change",
        (_, var count) => $"{count} changes",
    };

    /// <summary>The rows on screen: the differences, and the matching rows when everything shows.</summary>
    public IReadOnlyList<CompareRow> Rows => ShowEverything ? [.. differences, .. matching] : differences;

    public string Summary => summary;

    public bool HasSummary => summary.Length > 0;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Rows))]
    public partial bool ShowEverything { get; set; }
}

/// <summary>
/// A profile compared with a repository: what the profile would change, by
/// section, as the plan has it. It only reads; nothing here writes to GitHub.
/// </summary>
internal sealed partial class CompareViewModel(
    RepottedClient client,
    IDesktop desktop,
    string repository,
    ProfileListingDocument profile,
    Uri? installUrl = null)
    : ViewModelBase
{

    public string Repository => repository;

    public string ProfileName => profile.Name;

    public string Heading => $"{profile.Name} compared with {repository}";

    public IReadOnlyList<CompareSectionViewModel> Sections { get; private set; } = [];

    public IReadOnlyList<string> Warnings { get; private set; } = [];

    public bool HasWarnings => Warnings.Count > 0;

    /// <summary>What the profile holds as drafts, which the compare leaves out, or null for none.</summary>
    public string? DraftsNote { get; private set; }

    /// <summary>How many differences Repotted cannot change, as the plan's locks have it.</summary>
    public int Locked => Sections.Sum(section => section.Differences.Count(row => row.IsLocked));

    public bool HasLocks => Locked > 0;

    public string LockSummary => Locked == 1
        ? "Repotted can't change 1 difference below. It says what it needs."
        : $"Repotted can't change {Locked} differences below. Each says what it needs.";

    /// <summary>
    /// Where to grant what's missing: the settings page of the GitHub App's
    /// installation on the repository, or the App's install page when it isn't installed there.
    /// </summary>
    public Uri? AccessUrl { get; private set; }

    public string AccessLabel { get; private set; } = "Review App access";

    public bool HasAccessUrl => HasLocks && AccessUrl is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowResult))]
    public partial bool Loading { get; set; }

    /// <summary>Whether a plan has come back, so the result can show, even when the profile sets nothing to compare.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowResult))]
    public partial bool Loaded { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(ShowResult))]
    public partial string? Error { get; set; }

    public bool HasError => Error is not null;

    public bool ShowResult => !Loading && Error is null && Loaded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EverythingLabel), nameof(Summary))]
    public partial bool ShowEverything { get; set; }

    public string EverythingLabel => ShowEverything ? "Show differences only" : "Show everything";

    partial void OnShowEverythingChanged(bool value)
    {
        foreach (var section in Sections)
        {
            section.ShowEverything = value;
        }
    }

    public string Summary
    {
        get
        {
            var differences = Sections.Sum(section => section.Differences.Count);
            var sections = Sections.Count(section => section.HasChanges);
            if (Sections.Count == 0)
            {
                return $"{profile.Name} does not set anything Repotted compares.";
            }
            var rest = ShowEverything ? "Matching settings show below them." : "Matching settings are folded away.";
            return (differences, Sections.Any(section => section.Skipped)) switch
            {
                (0, false) => $"{repository} already has everything {profile.Name} sets.",
                (0, true) => "No differences in the sections Repotted could read.",
                _ => $"{Count(differences, "difference")} in {Count(sections, "section")}. {rest}",
            };
        }
    }

    [RelayCommand]
    private void ToggleEverything() => ShowEverything = !ShowEverything;

    /// <summary>A draft as the plan names it: the ruleset Later, or a setting's path.</summary>
    private static string Describe(SkippedDocument draft) => draft.Section switch
    {
        "rulesets" => $"the ruleset {draft.Target}",
        "environments" => $"the environment {draft.Target}",
        "autolinks" => $"the autolink {draft.Target}",
        _ => $"{draft.Section}.{draft.Target}",
    };

    [RelayCommand]
    public async Task LoadAsync()
    {
        Loading = true;
        Error = null;
        try
        {
            var plan = await client.PlanAsync(repository, profile.File, CancellationToken.None).ConfigureAwait(true);
            Sections = Build(plan);
            // A section the plan could not read says so in its own place.
            Warnings = [.. plan.Warnings.Where(warning => !Sections.Any(section => section.SkippedBy == warning))];
            foreach (var section in Sections)
            {
                section.ShowEverything = ShowEverything;
            }
            var installed = plan.Access.App.Status != "not_installed";
            AccessLabel = installed ? "Review App access" : "Install the App";
            AccessUrl = Https(installed ? plan.Access.App.SettingsUrl : installUrl?.ToString());
            OnPropertyChanged(nameof(Sections));
            OnPropertyChanged(nameof(Warnings));
            OnPropertyChanged(nameof(HasWarnings));
            DraftsNote = plan.Skipped is { Count: > 0 } skipped
                ? $"Left out as {(skipped.Count == 1 ? "a draft" : "drafts")}: {string.Join(", ", skipped.Select(Describe))}."
                : null;
            OnPropertyChanged(nameof(DraftsNote));
            OnPropertyChanged(nameof(Summary));
            OnPropertyChanged(nameof(Locked));
            OnPropertyChanged(nameof(HasLocks));
            OnPropertyChanged(nameof(LockSummary));
            OnPropertyChanged(nameof(AccessUrl));
            OnPropertyChanged(nameof(AccessLabel));
            OnPropertyChanged(nameof(HasAccessUrl));
            Loaded = true;
        }
        // A compare runs unawaited when it opens, so every failure shows here.
        catch (Exception error)
        {
            Error = error.Message;
        }
        finally
        {
            Loading = false;
        }
    }

    [RelayCommand]
    private Task ReviewAccessAsync() => AccessUrl is { } url ? desktop.OpenUrlAsync(url) : Task.CompletedTask;

    private static Uri? Https(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps ? url : null;

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";

    /// <summary>The sections the profile names, in the editor's order.</summary>
    internal static IReadOnlyList<CompareSectionViewModel> Build(PlanDocument plan)
    {
        var desired = JsonNode.Parse(plan.Desired.GetRawText())?.AsObject() ?? [];
        List<CompareSectionViewModel> sections = [];
        if (desired["repository"] is JsonObject || desired["merge"] is JsonObject)
        {
            sections.Add(Settings("Repository and merge settings", plan, desired, ["repository", "merge"]));
        }
        foreach (var (title, name) in (ReadOnlySpan<(string, string)>)[
            ("Actions", "actions"), ("Security", "security"), ("Custom properties", "custom_properties"), ("GitHub Pages", "pages"),
        ])
        {
            if (desired[name] is JsonObject)
            {
                sections.Add(Settings(title, plan, desired, [name]));
            }
        }
        if (desired["autolinks"] is JsonArray autolinks)
        {
            sections.Add(Entries("Autolinks", "autolink", plan, autolinks, "autolinks", key: "key_prefix"));
        }
        if (desired["rulesets"] is JsonArray rulesets)
        {
            sections.Add(Entries("Rulesets", "ruleset", plan, rulesets, "rulesets"));
        }
        if (desired["environments"] is JsonArray environments)
        {
            sections.Add(Entries("Environments", "environment", plan, environments, "environments"));
        }
        return sections;
    }

    /// <summary>A section of single settings, one row for each that differs.</summary>
    private static CompareSectionViewModel Settings(string title, PlanDocument plan, JsonObject desired, string[] names)
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
        foreach (var (change, locked) in Changes(plan).Where(item => names.Contains(item.Change.Section)))
        {
            // Making or taking down a whole thing, such as a Pages site, changes no one field.
            if (change.Fields.Count == 0)
            {
                differences.Add(change.Action == "delete"
                    ? new CompareRow(CompareKind.Removes, change.Target, "absent: true", CompareRow.OnGitHub, "Deleted", locked)
                    : new CompareRow(CompareKind.Adds, change.Target, $"new {change.Target}", CompareRow.NotOnGitHub, CompareRow.Created, locked));
                changed.Add($"{change.Section}.absent");
                continue;
            }
            foreach (var field in change.Fields)
            {
                changed.Add($"{change.Section}.{field.Field}");
                foreach (var difference in Differences(field))
                {
                    var setting = Field(change.Section, difference.Path);
                    differences.Add(Row(difference, Label(setting, difference.Path), difference.Path, value => Show(setting, difference.Path, value), locked));
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
        return new CompareSectionViewModel(title, differences, matching, summary);
    }

    /// <summary>
    /// A section of named entries: rulesets or environments. A new entry is
    /// one row, a changed one a row for each part that differs, and an entry
    /// the profile removes one row.
    /// </summary>
    private static CompareSectionViewModel Entries(
        string title, string noun, PlanDocument plan, JsonArray entries, string name, string key = "name")
    {
        if (plan.Warnings.FirstOrDefault(warning => warning.StartsWith($"Skipped {name}: ", StringComparison.Ordinal)) is { } skipped)
        {
            return new CompareSectionViewModel(title, [], [], $"Repotted could not read the {name}: {skipped[$"Skipped {name}: ".Length..]}", skippedBy: skipped);
        }
        // GitHub matches environment names without regard to case, and a
        // branch policy's target starts with its environment's name.
        var environments = name == "environments";
        var comparer = environments ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        List<CompareRow> differences = [];
        HashSet<string> touched = new(comparer);
        var section = Changes(plan).Where(item => item.Change.Section == name).ToList();
        foreach (var (change, locked) in section)
        {
            touched.Add(change.Target);
            // GitHub can't change an autolink, so the plan deletes one and makes it
            // again, and the row shows what differs.
            var remade = change.Action == "delete"
                && section.Any(other => other.Change.Action == "create" && other.Change.Target == change.Target && other.Change.Fields.Count > 0);
            if (remade)
            {
                continue;
            }
            // An environment's branch policy is named "environment: type pattern".
            var policy = environments && change.Target.Contains(": ", StringComparison.Ordinal);
            switch (change.Action)
            {
                case "create" when name == "autolinks" && change.Fields.Count > 0:
                    foreach (var field in change.Fields)
                    {
                        foreach (var difference in Differences(field))
                        {
                            differences.Add(Row(difference, change.Target, difference.Path, CompareRows.Show, locked));
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
                        locked));
                    break;
                case "delete":
                    differences.Add(policy
                        ? new CompareRow(CompareKind.Removes, change.Target, "branch_policies", CompareRow.OnGitHub, Removed, locked)
                        : new CompareRow(CompareKind.Removes, change.Target, "absent: true", CompareRow.OnGitHub, "Deleted", locked));
                    break;
                default:
                    foreach (var field in change.Fields)
                    {
                        foreach (var difference in Differences(field))
                        {
                            differences.Add(Row(difference, change.Target, difference.Path, CompareRows.Show, locked));
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
            if (touched.Contains(entryName)
                || (environments && touched.Any(target => target.StartsWith($"{entryName}: ", StringComparison.OrdinalIgnoreCase))))
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

    /// <summary>The plan's changes, each with the reason Repotted cannot make it, or null when it can.</summary>
    private static IEnumerable<(PlanChangeDocument Change, string? Locked)> Changes(PlanDocument plan) =>
        plan.Changes.Select((change, index) => (change, plan.Locks.FirstOrDefault(item => item.Change == index)?.Reason));

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
    /// object it is part of, or its section. Actions alone names a setting
    /// without its section, as in "Skipped allowed_actions:".
    /// </summary>
    private static bool Skips(PlanDocument plan, string section, string key)
    {
        var top = key.Split('.')[0];
        string[] prefixes = section == "actions"
            ? [$"Skipped {section}.{key}:", $"Skipped {section}.{top}:", $"Skipped {top}:", $"Skipped {section}:"]
            : [$"Skipped {section}.{key}:", $"Skipped {section}.{top}:", $"Skipped {section}:"];
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
