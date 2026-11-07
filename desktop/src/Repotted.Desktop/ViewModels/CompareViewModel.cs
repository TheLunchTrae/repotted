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
internal sealed partial class CompareViewModel(RepottedClient client, string repository, ProfileListingDocument profile)
    : ViewModelBase
{
    public string Repository => repository;

    public string ProfileName => profile.Name;

    public string Heading => $"{profile.Name} compared with {repository}";

    public IReadOnlyList<CompareSectionViewModel> Sections { get; private set; } = [];

    public IReadOnlyList<string> Warnings { get; private set; } = [];

    public bool HasWarnings => Warnings.Count > 0;

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
            OnPropertyChanged(nameof(Sections));
            OnPropertyChanged(nameof(Warnings));
            OnPropertyChanged(nameof(HasWarnings));
            OnPropertyChanged(nameof(Summary));
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
        if (desired["actions"] is JsonObject)
        {
            sections.Add(Settings("Actions", plan, desired, ["actions"]));
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
        List<CompareRow> differences = [];
        HashSet<string> changed = new(StringComparer.Ordinal);
        foreach (var change in plan.Changes.Where(change => names.Contains(change.Section)))
        {
            foreach (var field in change.Fields)
            {
                changed.Add($"{change.Section}.{field.Field}");
                foreach (var difference in Differences(field))
                {
                    var setting = Field(change.Section, difference.Path);
                    differences.Add(Row(difference, Label(setting, difference.Path), difference.Path, value => Show(setting, value)));
                }
            }
        }
        List<CompareRow> matching = [];
        foreach (var name in names)
        {
            foreach (var (key, value) in Flat(desired[name] as JsonObject))
            {
                // A plan skips what cannot apply, such as selected actions while all actions are allowed.
                if (changed.Contains($"{name}.{key}")
                    || plan.Warnings.Any(warning => warning.StartsWith($"Skipped {key.Split('.')[0]}:", StringComparison.Ordinal)))
                {
                    continue;
                }
                var setting = Field(name, key);
                matching.Add(new CompareRow(CompareKind.Matches, Label(setting, key), key, Show(setting, value), Show(setting, value)));
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
    private static CompareSectionViewModel Entries(string title, string noun, PlanDocument plan, JsonArray entries, string name)
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
        foreach (var change in plan.Changes.Where(change => change.Section == name))
        {
            touched.Add(change.Target);
            // An environment's branch policy is named "environment: type pattern".
            var policy = environments && change.Target.Contains(": ", StringComparison.Ordinal);
            switch (change.Action)
            {
                case "create":
                    var rules = change.Fields.FirstOrDefault(field => field.Field == "rules");
                    differences.Add(new CompareRow(
                        CompareKind.Adds,
                        change.Target,
                        policy ? "new branch policy" : $"new {noun}",
                        CompareRow.NotOnGitHub,
                        rules is null ? "Created" : CompareRows.Show(CompareRows.Node(rules.To))));
                    break;
                case "delete":
                    differences.Add(policy
                        ? new CompareRow(CompareKind.Removes, change.Target, "branch_policies", CompareRow.OnGitHub, Removed)
                        : new CompareRow(CompareKind.Removes, change.Target, "absent: true", CompareRow.OnGitHub, "Deleted"));
                    break;
                default:
                    foreach (var field in change.Fields)
                    {
                        foreach (var difference in Differences(field))
                        {
                            differences.Add(Row(difference, change.Target, difference.Path, CompareRows.Show));
                        }
                    }
                    break;
            }
        }
        List<CompareRow> matching = [];
        var absent = 0;
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var entryName = entry["name"]?.GetValue<string>() ?? "";
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
            matching.Add(new CompareRow(CompareKind.Matches, entryName, noun, "Same as the profile", "No change"));
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

    /// <summary>The parts of a plan's field change that differ. A field with no <c>from</c> is not on GitHub; a JSON null is.</summary>
    private static IEnumerable<Difference> Differences(FieldChangeDocument field) =>
        CompareRows.Differences(
            field.Field,
            CompareRows.Node(field.From),
            CompareRows.Node(field.To),
            onGitHub: field.From.ValueKind != JsonValueKind.Undefined,
            inProfile: field.To.ValueKind != JsonValueKind.Undefined);

    private static CompareRow Row(Difference difference, string label, string key, Func<JsonNode?, string> show) => difference.Kind switch
    {
        CompareKind.Adds => new CompareRow(CompareKind.Adds, label, key, CompareRow.NotOnGitHub, show(difference.Wanted)),
        CompareKind.Removes => new CompareRow(CompareKind.Removes, label, key, show(difference.Now), Removed),
        var kind => new CompareRow(kind, label, key, show(difference.Now), show(difference.Wanted)),
    };

    /// <summary>A section's settings by key, with <c>selected_actions</c> opened up as the editor shows it.</summary>
    private static IEnumerable<(string Key, JsonNode? Value)> Flat(JsonObject? section)
    {
        foreach (var (key, value) in section ?? [])
        {
            if (key == "selected_actions" && value is JsonObject selected)
            {
                foreach (var (inner, innerValue) in selected)
                {
                    yield return ($"{key}.{inner}", innerValue);
                }
            }
            else
            {
                yield return (key, value);
            }
        }
    }

    /// <summary>A setting's name as the editor shows it; the editor leaves allowed action patterns to the YAML.</summary>
    private static string Label(SettingField? setting, string key) =>
        setting?.Label ?? (key == "selected_actions.patterns_allowed" ? "Allowed action patterns" : key);

    private static SettingField? Field(string section, string key) =>
        ProfileFields.Sections.SelectMany(tab => tab.Groups).SelectMany(group => group.Fields)
            .FirstOrDefault(field => field.Section == section && field.Key == key);

    /// <summary>A value as the editor names it, such as On or Read and write, or as GitHub writes it.</summary>
    private static string Show(SettingField? field, JsonNode? value) =>
        field?.Options.FirstOrDefault(option => JsonNode.DeepEquals(option.Value, value))?.Label ?? CompareRows.Show(value);
}
