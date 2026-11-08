using System.Text.Json;
using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>What a compare row says about one value.</summary>
internal enum CompareKind
{
    /// <summary>GitHub has another value, and the profile changes it.</summary>
    Changes,

    /// <summary>GitHub has nothing, and the profile adds it.</summary>
    Adds,

    /// <summary>GitHub has it, and the profile removes it.</summary>
    Removes,

    /// <summary>GitHub already has what the profile wants.</summary>
    Matches,
}

/// <summary>
/// One row of a compare: a value the profile names, what GitHub has now, and
/// what the profile wants. <see cref="Key"/> is the value's path in the
/// profile, or a note such as <c>new ruleset</c>. <see cref="Lock"/> says why
/// Repotted cannot make the change, such as <c>Needs Pages write</c>, or is null.
/// </summary>
internal sealed record CompareRow(CompareKind Kind, string Label, string Key, string Now, string Wanted, string? Lock = null)
{
    public const string NotOnGitHub = "Not on GitHub";

    /// <summary>What GitHub has of a whole ruleset, environment or branch policy that the profile removes.</summary>
    public const string OnGitHub = "On GitHub";

    /// <summary>What the profile has of a whole environment or branch policy it adds.</summary>
    public const string Created = "Created";

    /// <summary>What GitHub has of a whole ruleset or environment that already matches.</summary>
    public const string SameAsProfile = "Same as the profile";

    public bool IsChange => Kind == CompareKind.Changes;

    public bool IsAdd => Kind == CompareKind.Adds;

    public bool IsRemove => Kind == CompareKind.Removes;

    public bool IsMatch => Kind == CompareKind.Matches;

    public bool IsLocked => Lock is not null;

    /// <summary>Whether GitHub's value goes away, so the row strikes it out.</summary>
    public bool NowGoes => Kind is CompareKind.Changes or CompareKind.Removes;

    /// <summary>The row as one sentence, which screen readers hear in place of the struck-out text, the colors and the lock.</summary>
    public string AccessibleName => Lock is null ? Said : $"{Said}. Repotted can't change it: {Lock}";

    private string Said => Kind switch
    {
        CompareKind.Changes => $"{Label}, {Key}: GitHub has {Now}, the profile sets {Wanted}",
        CompareKind.Adds when Wanted == Created => $"{Label}, {Key}: not on GitHub, the profile creates it",
        CompareKind.Adds => $"{Label}, {Key}: not on GitHub, the profile adds {Wanted}",
        CompareKind.Removes when Now == OnGitHub => $"{Label}, {Key}: on GitHub, the profile removes it",
        CompareKind.Removes => $"{Label}, {Key}: GitHub has {Now}, the profile removes it",
        _ when Now == SameAsProfile => $"{Label}, {Key}: matches the profile",
        _ => $"{Label}, {Key}: {Now}, matches the profile",
    };
}

/// <summary>One part of a field that differs, and what the profile does to it.</summary>
internal sealed record Difference(CompareKind Kind, string Path, JsonNode? Now, JsonNode? Wanted);

/// <summary>
/// Turns a plan's field changes into rows. A plan names whole fields, such as
/// a ruleset's <c>rules</c>; a row names the part that differs, such as
/// <c>rules[pull_request].parameters.allowed_merge_methods</c>. This only
/// shapes what the app shows; the plan decides what differs.
/// </summary>
internal static class CompareRows
{
    /// <summary>
    /// The parts of <paramref name="wanted"/> that differ from <paramref name="now"/>.
    /// <paramref name="onGitHub"/> is false when GitHub has no value at all, and
    /// <paramref name="inProfile"/> false when the profile drops it.
    /// </summary>
    public static IEnumerable<Difference> Differences(
        string path,
        JsonNode? now,
        JsonNode? wanted,
        bool onGitHub = true,
        bool inProfile = true)
    {
        var parts = onGitHub && inProfile ? Parts(path, now, wanted).ToList() : [];
        if (parts.Count > 0)
        {
            return parts;
        }
        var kind = (onGitHub, inProfile) switch
        {
            (false, _) => CompareKind.Adds,
            (_, false) => CompareKind.Removes,
            _ => CompareKind.Changes,
        };
        return [new Difference(kind, path, now, wanted)];
    }

    private static IEnumerable<Difference> Parts(string path, JsonNode? now, JsonNode? wanted)
    {
        if (wanted is JsonObject wantedObject && now is JsonObject nowObject)
        {
            // A profile names only some keys; the rest are GitHub's and match.
            return wantedObject
                .Where(pair => !Same(pair.Value, nowObject[pair.Key]))
                .SelectMany(pair => Differences($"{path}.{pair.Key}", nowObject[pair.Key], pair.Value));
        }
        // A ruleset holds one rule of each type, so a rule is known by its type.
        if ((path == "rules" || path.EndsWith(".rules", StringComparison.Ordinal))
            && ByType(wanted) is { } wantedRules
            && ByType(now) is { } nowRules)
        {
            var types = wantedRules.Keys.Concat(nowRules.Keys.Where(type => !wantedRules.ContainsKey(type)));
            return types
                .Where(type => !Same(wantedRules.GetValueOrDefault(type), nowRules.GetValueOrDefault(type)))
                .SelectMany(type => Differences(
                    $"{path}[{type}]",
                    nowRules.GetValueOrDefault(type),
                    wantedRules.GetValueOrDefault(type),
                    onGitHub: nowRules.ContainsKey(type),
                    inProfile: wantedRules.ContainsKey(type)));
        }
        return [];
    }

    /// <summary>A list of objects that each name a distinct <c>type</c>, by type; otherwise null.</summary>
    private static Dictionary<string, JsonNode>? ByType(JsonNode? node)
    {
        if (node is not JsonArray array)
        {
            return null;
        }
        var items = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        foreach (var item in array)
        {
            if (item is not JsonObject { } entry
                || entry["type"] is not JsonValue type
                || !type.TryGetValue<string>(out var name)
                || !items.TryAdd(name, entry))
            {
                return null;
            }
        }
        return items;
    }

    /// <summary>
    /// Whether <paramref name="now"/> has what <paramref name="wanted"/> names:
    /// an object by the keys the profile sets, anything else exactly, lists in
    /// order. A ruleset or environment write differs when its order does.
    /// </summary>
    private static bool Same(JsonNode? wanted, JsonNode? now) => (wanted, now) switch
    {
        (JsonObject wantedObject, JsonObject nowObject) =>
            wantedObject.All(pair => Same(pair.Value, nowObject[pair.Key])),
        _ => JsonNode.DeepEquals(wanted, now),
    };

    /// <summary>A value as one short line: a rule or list of rules by type, a list as its items, an object as its pairs.</summary>
    public static string Show(JsonNode? value) => value switch
    {
        null => "none",
        JsonValue scalar when scalar.GetValueKind() == JsonValueKind.String => scalar.GetValue<string>(),
        JsonValue scalar => scalar.ToJsonString(),
        JsonArray { Count: 0 } => "none",
        JsonArray array when IsRules(array) => string.Join(", ", array.Select(item => item!["type"]!.GetValue<string>())),
        JsonObject rule when IsRule(rule) => rule["parameters"] is JsonObject { Count: > 0 } parameters
            ? $"{rule["type"]!.GetValue<string>()}: {Show(parameters)}"
            : rule["type"]!.GetValue<string>(),
        JsonArray array when array.All(item => item is JsonObject) => string.Join("; ", array.Select(Show)),
        JsonArray array => string.Join(", ", array.Select(Show)),
        JsonObject { Count: 0 } => "none",
        JsonObject entries => string.Join(", ", entries.Select(pair => $"{pair.Key}: {Show(pair.Value)}")),
        _ => value.ToJsonString(),
    };

    /// <summary>A list of rules, shown by type: each item a rule of its own type.</summary>
    private static bool IsRules(JsonArray array) =>
        ByType(array) is not null && array.All(item => IsRule(item!.AsObject()));

    /// <summary>A ruleset's rule: a type and at most its parameters.</summary>
    private static bool IsRule(JsonObject entry) =>
        entry["type"] is JsonValue type && type.GetValueKind() == JsonValueKind.String
        && entry.All(pair => pair.Key is "type" or "parameters");

    /// <summary>A member of a plan document as a node; JSON null is a null node.</summary>
    public static JsonNode? Node(JsonElement element) =>
        element.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? null : JsonNode.Parse(element.GetRawText());
}
