using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.ViewModels;

/// <summary>What a diff line says: GitHub keeps it, loses it, or gains it, or a note about the line before.</summary>
internal enum DiffKind
{
    Same,
    Removed,
    Added,
    Note,
}

/// <summary>
/// One line of a plan's diff, as profile YAML. <see cref="Tag"/> marks a
/// one-off edit. A <see cref="DiffKind.Note"/> line says why Repotted can't
/// make the change above it, when <see cref="Locked"/>, or why it didn't
/// check a section.
/// </summary>
internal sealed record DiffLine(DiffKind Kind, string Text, string? Tag = null, bool Locked = false)
{
    public bool IsRemoved => Kind == DiffKind.Removed;

    public bool IsAdded => Kind == DiffKind.Added;

    public bool IsNote => Kind == DiffKind.Note;

    public bool HasTag => Tag is not null;

    /// <summary>The line's leading spaces, kept apart so a strike-through starts at the text.</summary>
    public string Indent => Text[..(Text.Length - Text.TrimStart(' ').Length)];

    /// <summary>The line without its leading spaces.</summary>
    public string Value => Text.TrimStart(' ');

    public string Sign => Kind switch
    {
        DiffKind.Removed => "−",
        DiffKind.Added => "+",
        _ => "",
    };

    /// <summary>The line as screen readers hear it, in place of the sign, the colors and the strike-through.</summary>
    public string AccessibleName => (Kind switch
    {
        DiffKind.Removed => $"GitHub loses: {Text.Trim()}",
        DiffKind.Added => $"GitHub gets: {Text.Trim()}",
        DiffKind.Note when Locked => $"GitHub will refuse this: {Text}",
        DiffKind.Note => Text,
        _ => $"Stays: {Text.Trim()}",
    }) + (Tag is null ? "" : $", {Tag.ToLowerInvariant()}");
}

/// <summary>
/// A plan as a diff of profile YAML: what GitHub has now against what it has
/// after the plan applies, for what the profile names. Both sides start from
/// the plan's resolved profile; each field a change writes takes GitHub's
/// value on one side and the written value on the other. GitHub's value keeps
/// only the keys the profile sets, as a plan compares them, so defaults GitHub
/// fills in never show. This only shapes what the app shows; the plan decides
/// what differs.
/// </summary>
internal static class PlanDiff
{
    private static readonly string[] SettingsSections = ["repository", "merge", "actions", "security", "custom_properties", "pages"];

    /// <summary>
    /// The plan's diff, one profile section after another. <paramref name="exclusion"/>
    /// gives what leaves out a change, by its index in the plan and its field,
    /// as for <see cref="PlanSections.Build"/>; an edited one tags its lines.
    /// </summary>
    public static IReadOnlyList<DiffLine> Lines(PlanDocument plan, Func<int, string?, RowExclusion?>? exclusion = null)
    {
        var desired = JsonNode.Parse(plan.Desired.GetRawText())?.AsObject() ?? [];
        var leaveOut = exclusion ?? ((_, _) => null);
        var changes = plan.Changes.Select((change, index) => new IndexedChange(change, index)).ToList();
        HashSet<int> noted = [];
        List<DiffLine> lines = [];
        foreach (var (name, value) in desired)
        {
            if (PlanSections.SectionSkip(plan, name) is { } skipped)
            {
                lines.AddRange(Yaml.Lines(name, value).Select(text => new DiffLine(DiffKind.Same, text)));
                lines.Add(new DiffLine(DiffKind.Note, $"Not checked: {skipped.Message}"));
                continue;
            }
            var section = changes.Where(item => item.Change.Section == name).ToList();
            List<Unit>? units = (name, value) switch
            {
                _ when SettingsSections.Contains(name) && value is JsonObject settings => SettingsUnits(name, settings, section, plan.Warnings),
                ("rulesets" or "environments" or "labels", JsonArray entries) =>
                    EntryUnits(entries, section, "name"),
                ("autolinks", JsonArray entries) => EntryUnits(entries, section, "key_prefix"),
                _ => null,
            };
            if (units is null)
            {
                lines.AddRange(Yaml.Lines(name, value).Select(text => new DiffLine(DiffKind.Same, text)));
                continue;
            }
            lines.Add(new DiffLine(DiffKind.Same, $"{name}:"));
            foreach (var unit in units)
            {
                lines.AddRange(Compare(unit, plan, leaveOut, noted));
            }
        }
        return lines;
    }

    private sealed record IndexedChange(PlanChangeDocument Change, int Index);

    /// <summary>
    /// One part of a section that is diffed by itself, so lines line up within
    /// it: a setting, or a list entry. <see cref="Now"/> is null when GitHub
    /// has none of it, and <see cref="After"/> null when the plan leaves none.
    /// </summary>
    private sealed record Unit(
        JsonNode? Now,
        JsonNode? After,
        IReadOnlyList<(IndexedChange Change, string? Field)> Owners,
        string? Key = null,
        string? Skipped = null);

    /// <summary>The settings of a section, one unit for each key the profile or a change names.</summary>
    private static List<Unit> SettingsUnits(string section, JsonObject desired, IReadOnlyList<IndexedChange> changes, IReadOnlyList<WarningDocument> warnings)
    {
        var now = (JsonObject)desired.DeepClone();
        var after = (JsonObject)desired.DeepClone();
        Dictionary<string, List<(IndexedChange, string?)>> owners = new(StringComparer.Ordinal);
        var created = false;
        foreach (var item in changes)
        {
            // Making or taking down a whole thing, such as a Pages site, changes no one field.
            if (item.Change.Fields.Count == 0)
            {
                foreach (var key in desired.Select(pair => pair.Key))
                {
                    Own(owners, key, item, null);
                }
                if (item.Change.Action == "delete")
                {
                    now.Remove("absent");
                }
            }
            created |= item.Change.Action == "create";
            foreach (var field in item.Change.Fields)
            {
                var path = field.Field.Split('.');
                Own(owners, path[0], item, field.Field);
                var wanted = field.To.ValueKind == JsonValueKind.Undefined ? null : AsProfile(desired, path, field.To);
                Write(after, path, wanted, remove: field.To.ValueKind == JsonValueKind.Undefined);
                Write(now, path, Project(Value(field.From), wanted), remove: field.From.ValueKind == JsonValueKind.Undefined);
            }
        }
        // A section GitHub doesn't have yet, such as a new Pages site, has nothing now.
        var keys = after.Select(pair => pair.Key).Concat(now.Select(pair => pair.Key)).Distinct(StringComparer.Ordinal);
        return [.. keys.Select(key => new Unit(
            created || !now.ContainsKey(key) ? null : Wrap(key, now[key]),
            after.ContainsKey(key) ? Wrap(key, after[key]) : null,
            owners.GetValueOrDefault(key) ?? [],
            key,
            SkipReason(warnings, section, key)))];
    }

    /// <summary>
    /// Why the plan didn't check a setting, from the warnings that name it or
    /// a field of it, which goes before its reason.
    /// </summary>
    private static string? SkipReason(IReadOnlyList<WarningDocument> warnings, string section, string key)
    {
        List<string> reasons =
        [
            .. warnings
                .Where(warning => warning.Cause is not null && warning.Section == section && warning.Key == key)
                .Select(warning => warning.Field is null ? warning.Message : $"{warning.Field}: {warning.Message}"),
        ];
        return reasons.Count == 0 ? null : string.Join("; ", reasons);
    }

    private static void Own(Dictionary<string, List<(IndexedChange, string?)>> owners, string key, IndexedChange change, string? field)
    {
        if (!owners.TryGetValue(key, out var list))
        {
            owners[key] = list = [];
        }
        list.Add((change, field));
    }

    /// <summary>
    /// The entries of a list, one unit each, with the changes that name each
    /// entry as the profile writes it. A created entry has nothing now, and a
    /// deleted one has its name now and <c>absent: true</c> after. An
    /// environment's branch policy is a change of its own; GitHub can't change
    /// an autolink, so the plan deletes one and makes it again with the fields
    /// that differ.
    /// </summary>
    private static List<Unit> EntryUnits(
        JsonArray entries,
        IReadOnlyList<IndexedChange> changes,
        string key)
    {
        List<Unit> units = [];
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var name = entry[key]?.GetValue<string>() ?? "";
            var named = changes.Where(item => item.Change.Entry?.Name == name).ToList();
            var own = named.Where(item => item.Change.Entry?.BranchPolicy is null).ToList();
            var branchPolicies = named.Where(item => item.Change.Entry?.BranchPolicy is not null).ToList();
            JsonObject? now = (JsonObject)entry.DeepClone();
            var after = (JsonObject)entry.DeepClone();
            var remade = own.Any(item => item.Change.Action == "create") && own.Any(item => item.Change.Action == "delete");
            foreach (var item in own)
            {
                switch (item.Change.Action)
                {
                    case "create" when !remade:
                        now = null;
                        break;
                    case "delete" when !remade:
                        now = new JsonObject { [key] = name };
                        break;
                    case "delete":
                        break;
                    default:
                        foreach (var field in item.Change.Fields)
                        {
                            var path = field.Field.Split('.');
                            var wanted = field.To.ValueKind == JsonValueKind.Undefined ? null : AsProfile(entry, path, field.To);
                            if (wanted is not null)
                            {
                                Write(after, path, wanted, remove: false);
                            }
                            if (now is not null)
                            {
                                Write(now, path, Project(Value(field.From), wanted), remove: field.From.ValueKind == JsonValueKind.Undefined);
                            }
                        }
                        break;
                }
            }
            foreach (var item in branchPolicies)
            {
                if (now is null || item.Change.Entry?.BranchPolicy is not { Name: var pattern, Type: var type })
                {
                    continue;
                }
                var list = now["branch_policies"] as JsonArray ?? [];
                now["branch_policies"] = list;
                if (item.Change.Action == "create")
                {
                    // GitHub doesn't have it yet.
                    var index = list.ToList().FindIndex(policy => policy?["name"]?.GetValue<string>() == pattern
                        && (policy["type"]?.GetValue<string>() ?? "branch") == type);
                    if (index >= 0)
                    {
                        list.RemoveAt(index);
                    }
                }
                else if (item.Change.Action == "delete")
                {
                    // GitHub has one the profile drops.
                    list.Add(new JsonObject { ["name"] = pattern, ["type"] = type });
                }
            }
            if (now?["branch_policies"] is JsonArray { Count: 0 } && entry["branch_policies"] is null)
            {
                now.Remove("branch_policies");
            }
            units.Add(new Unit(now, after, [.. own.Concat(branchPolicies).Select(item => (item, (string?)null))]));
        }
        return units;
    }

    /// <summary>
    /// A unit's lines: the same where both sides agree, removed and added where
    /// they don't, with a one-off edit's tag on its first added line and, once
    /// for each change, a note under its first line when Repotted can't make it.
    /// </summary>
    private static IEnumerable<DiffLine> Compare(
        Unit unit,
        PlanDocument plan,
        Func<int, string?, RowExclusion?> leaveOut,
        HashSet<int> noted)
    {
        var before = unit.Now is null ? [] : Yaml.Item(unit.Now, unit.Key);
        var after = unit.After is null ? [] : Yaml.Item(unit.After, unit.Key);
        var edited = unit.Owners.Any(owner => leaveOut(owner.Change.Index, owner.Field)?.Edited == true
            || leaveOut(owner.Change.Index, null)?.Edited == true);
        var locks = unit.Owners
            .Select(owner => owner.Change.Index)
            .Distinct()
            .Select(index => (Index: index, Reason: plan.Locks.FirstOrDefault(item => item.Change == index)?.Reason))
            .Where(item => item.Reason is not null && !noted.Contains(item.Index))
            .ToList();
        var tagged = false;
        var noting = false;
        // A lock's note goes under the whole run of lines its change makes, once.
        List<DiffLine> Notes()
        {
            noting = false;
            List<DiffLine> notes = [.. locks.Select(item => new DiffLine(DiffKind.Note, item.Reason!, Locked: true))];
            noted.UnionWith(locks.Select(item => item.Index));
            locks.Clear();
            return notes;
        }
        var diff = Diff(before, after).ToList();
        // The tag goes on the edit's first new line, or on its first dropped line when it only drops.
        var tagKind = diff.Any(line => line.Kind == DiffKind.Added) ? DiffKind.Added : DiffKind.Removed;
        foreach (var line in diff)
        {
            if (line.Kind == DiffKind.Same && noting)
            {
                foreach (var note in Notes())
                {
                    yield return note;
                }
            }
            if (line.Kind != DiffKind.Same)
            {
                noting = locks.Count > 0;
            }
            if (line.Kind == tagKind && edited && !tagged)
            {
                tagged = true;
                yield return line with { Tag = "One-off edit" };
            }
            else
            {
                yield return line;
            }
        }
        if (noting)
        {
            foreach (var note in Notes())
            {
                yield return note;
            }
        }
        if (unit.Skipped is not null)
        {
            yield return new DiffLine(DiffKind.Note, $"Not checked: {unit.Skipped}");
        }
    }

    /// <summary>
    /// The lines of <paramref name="after"/> against <paramref name="before"/>,
    /// by their longest common subsequence: within each run of changed lines,
    /// GitHub's lines come before the plan's.
    /// </summary>
    internal static IEnumerable<DiffLine> Diff(IReadOnlyList<string> before, IReadOnlyList<string> after)
    {
        var common = new int[before.Count + 1, after.Count + 1];
        for (var i = before.Count - 1; i >= 0; i--)
        {
            for (var j = after.Count - 1; j >= 0; j--)
            {
                common[i, j] = before[i] == after[j] ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
            }
        }
        var (x, y) = (0, 0);
        List<DiffLine> removed = [];
        List<DiffLine> added = [];
        List<DiffLine> lines = [];
        void Flush()
        {
            lines.AddRange(removed);
            lines.AddRange(added);
            removed.Clear();
            added.Clear();
        }
        while (x < before.Count || y < after.Count)
        {
            if (x < before.Count && y < after.Count && before[x] == after[y])
            {
                Flush();
                lines.Add(new DiffLine(DiffKind.Same, before[x]));
                x++;
                y++;
            }
            else if (y < after.Count && (x == before.Count || common[x, y + 1] >= common[x + 1, y]))
            {
                added.Add(new DiffLine(DiffKind.Added, after[y++]));
            }
            else
            {
                removed.Add(new DiffLine(DiffKind.Removed, before[x++]));
            }
        }
        Flush();
        return lines;
    }

    /// <summary>A member of a plan document as a node; JSON null is a null node.</summary>
    private static JsonNode? Value(JsonElement element) => CompareRows.Node(element);

    /// <summary>
    /// GitHub's value with only what the profile's value names: an object by
    /// the profile's keys, and a list in the profile's order, each item cut
    /// down to the profile item it matches. What GitHub has that matches no
    /// profile item comes last, whole.
    /// </summary>
    internal static JsonNode? Project(JsonNode? now, JsonNode? wanted)
    {
        switch (now, wanted)
        {
            case (JsonObject nowObject, JsonObject wantedObject):
                JsonObject kept = [];
                foreach (var (key, value) in wantedObject)
                {
                    if (nowObject.TryGetPropertyValue(key, out var live))
                    {
                        kept[key] = Project(live, value);
                    }
                }
                return kept;
            case (JsonArray nowList, JsonArray wantedList):
                var left = nowList.ToList();
                JsonArray ordered = [];
                foreach (var item in wantedList)
                {
                    var match = left.FindIndex(live => Matches(live, item));
                    if (match >= 0)
                    {
                        ordered.Add(Project(left[match], item));
                        left.RemoveAt(match);
                    }
                }
                foreach (var item in left)
                {
                    ordered.Add(item?.DeepClone());
                }
                return ordered;
            default:
                return now?.DeepClone();
        }
    }

    /// <summary>Keys that name a list item, such as a rule's type or a reviewer's type and id.</summary>
    private static readonly string[] Identity = ["type", "id", "name", "actor_id", "actor_type", "context", "integration_id", "key_prefix"];

    /// <summary>
    /// Whether GitHub's list item is the profile's: an object by the keys
    /// that name it, when the profile's item has any, and otherwise by value.
    /// </summary>
    private static bool Matches(JsonNode? live, JsonNode? wanted)
    {
        if (live is JsonObject liveObject && wanted is JsonObject wantedObject)
        {
            var keys = Identity.Where(wantedObject.ContainsKey).ToList();
            return keys.Count > 0
                ? keys.All(key => JsonNode.DeepEquals(liveObject[key], wantedObject[key]))
                : JsonNode.DeepEquals(Project(live, wanted), wanted);
        }
        return JsonNode.DeepEquals(live, wanted);
    }

    /// <summary>The value at a dotted field's path, if there is one.</summary>
    private static bool TryRead(JsonObject source, string[] path, out JsonNode? value)
    {
        value = null;
        var parent = source;
        foreach (var part in path[..^1])
        {
            if (parent[part] is not JsonObject next)
            {
                return false;
            }
            parent = next;
        }
        return parent.TryGetPropertyValue(path[^1], out value);
    }

    /// <summary>
    /// What a change sets, as the profile writes it: cut down to the
    /// profile's value at the path, when it has one, since GitHub's API body
    /// carries defaults the profile leaves out.
    /// </summary>
    private static JsonNode? AsProfile(JsonObject profile, string[] path, JsonElement to) =>
        TryRead(profile, path, out var written) ? Project(Value(to), written) : Value(to);

    /// <summary>Sets or removes the value at a dotted field's path, making the objects on the way.</summary>
    private static void Write(JsonObject target, string[] path, JsonNode? value, bool remove)
    {
        var parent = target;
        foreach (var part in path[..^1])
        {
            if (parent[part] is not JsonObject next)
            {
                if (remove)
                {
                    return;
                }
                parent[part] = next = [];
            }
            parent = next;
        }
        if (remove)
        {
            parent.Remove(path[^1]);
        }
        else
        {
            parent[path[^1]] = value?.DeepClone();
        }
    }

    private static JsonObject Wrap(string key, JsonNode? value) => new() { [key] = value?.DeepClone() };

    /// <summary>Profile values as YAML lines, as the profile files write them.</summary>
    internal static class Yaml
    {
        /// <summary>A section's lines, under its name.</summary>
        public static IEnumerable<string> Lines(string name, JsonNode? value)
        {
            List<string> lines = [];
            Member(lines, "", "", name, value);
            return lines;
        }

        /// <summary>
        /// A unit's lines, one level into its section: a setting as
        /// <c>key: value</c>, from the object that holds it alone, or a list
        /// entry as <c>- key: value</c> when <paramref name="key"/> is null.
        /// </summary>
        public static IReadOnlyList<string> Item(JsonNode node, string? key)
        {
            List<string> lines = [];
            if (key is null)
            {
                ListItem(lines, "  ", node);
                return lines;
            }
            foreach (var (name, value) in node.AsObject())
            {
                Member(lines, "  ", "  ", name, value);
            }
            return lines;
        }

        private static void Member(List<string> lines, string lead, string indent, string name, JsonNode? value)
        {
            var label = $"{lead}{Key(name)}:";
            switch (value)
            {
                case JsonObject { Count: > 0 } map:
                    lines.Add(label);
                    foreach (var (child, inner) in map)
                    {
                        Member(lines, $"{indent}  ", $"{indent}  ", child, inner);
                    }
                    break;
                case JsonArray { Count: > 0 } list:
                    lines.Add(label);
                    foreach (var item in list)
                    {
                        ListItem(lines, $"{indent}  ", item);
                    }
                    break;
                default:
                    lines.Add($"{label} {Scalar(value)}");
                    break;
            }
        }

        private static void ListItem(List<string> lines, string indent, JsonNode? item)
        {
            switch (item)
            {
                case JsonObject { Count: > 0 } map:
                    var first = true;
                    foreach (var (name, value) in map)
                    {
                        Member(lines, first ? $"{indent}- " : $"{indent}  ", $"{indent}  ", name, value);
                        first = false;
                    }
                    break;
                case JsonArray { Count: > 0 } list:
                    lines.Add($"{indent}-");
                    foreach (var inner in list)
                    {
                        ListItem(lines, $"{indent}  ", inner);
                    }
                    break;
                default:
                    lines.Add($"{indent}- {Scalar(item)}");
                    break;
            }
        }

        private static string Key(string name) => Plain(name) ? name : Quote(name);

        /// <summary>A scalar as YAML writes it: a string plain when it reads back as the same string, quoted otherwise.</summary>
        public static string Scalar(JsonNode? value) => value switch
        {
            null => "null",
            JsonObject => "{}",
            JsonArray => "[]",
            JsonValue text when text.GetValueKind() == JsonValueKind.String => Plain(text.GetValue<string>())
                ? text.GetValue<string>()
                : Quote(text.GetValue<string>()),
            _ => value.ToJsonString(),
        };

        private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
        {
            "true", "false", "yes", "no", "on", "off", "y", "n", "null", "~",
        };

        private static bool Plain(string text) =>
            text.Length > 0
            && !Reserved.Contains(text)
            && !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _)
            && !char.IsWhiteSpace(text[0]) && !char.IsWhiteSpace(text[^1])
            && "-?:,[]{}#&*!|>'\"%@`".IndexOf(text[0]) < 0
            && !text.Contains(": ", StringComparison.Ordinal)
            && !text.Contains(" #", StringComparison.Ordinal)
            && !text.EndsWith(':')
            && !text.Any(char.IsControl);

        private static string Quote(string text) =>
            text.Any(char.IsControl) ? JsonValue.Create(text).ToJsonString() : $"'{text.Replace("'", "''", StringComparison.Ordinal)}'";
    }
}
