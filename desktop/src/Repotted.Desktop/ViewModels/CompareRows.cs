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
/// profile, or a note such as <c>new ruleset</c>.
/// </summary>
internal sealed record CompareRow(CompareKind Kind, string Label, string Key, string Now, string Wanted)
{
    public bool IsChange => Kind == CompareKind.Changes;

    public bool IsAdd => Kind == CompareKind.Adds;

    public bool IsRemove => Kind == CompareKind.Removes;

    public bool IsMatch => Kind == CompareKind.Matches;

    /// <summary>Whether GitHub's value goes away, so the row strikes it out.</summary>
    public bool NowGoes => Kind is CompareKind.Changes or CompareKind.Removes && Now != NotOnGitHub;

    public string AccessibleName => Kind switch
    {
        CompareKind.Changes => $"{Label}, {Key}: the profile changes {Now} to {Wanted}",
        CompareKind.Adds => $"{Label}, {Key}: the profile adds {Wanted}",
        CompareKind.Removes => $"{Label}, {Key}: the profile removes {Now}",
        _ => $"{Label}, {Key}: matches, {Wanted}",
    };

    public const string NotOnGitHub = "Not on GitHub";
}

/// <summary>
/// Turns a plan's field changes into rows. A plan names whole fields, such as
/// a ruleset's <c>rules</c>; a row names the part that differs, such as
/// <c>rules[pull_request].parameters.allowed_merge_methods</c>. This only
/// shapes what the app shows; the plan decides what differs.
/// </summary>
internal static class CompareRows
{
    /// <summary>The parts of <paramref name="wanted"/> that <paramref name="now"/> does not have, by path.</summary>
    public static IEnumerable<(string Path, JsonNode? Now, JsonNode? Wanted)> Differences(
        string path,
        JsonNode? now,
        JsonNode? wanted)
    {
        var parts = Parts(path, now, wanted).ToList();
        return parts.Count > 0 ? parts : [(path, now, wanted)];
    }

    private static IEnumerable<(string, JsonNode?, JsonNode?)> Parts(string path, JsonNode? now, JsonNode? wanted)
    {
        if (wanted is JsonObject wantedObject && now is JsonObject nowObject)
        {
            // A profile names only some keys; the rest are GitHub's and match.
            return wantedObject
                .Where(pair => !Matches(pair.Value, nowObject[pair.Key]))
                .SelectMany(pair => Differences($"{path}.{pair.Key}", nowObject[pair.Key], pair.Value));
        }
        if (Typed(wanted) is { } wantedItems && Typed(now) is { } nowItems)
        {
            // Rules are one of each type, so a rule is known by its type.
            var types = wantedItems.Keys.Concat(nowItems.Keys.Where(type => !wantedItems.ContainsKey(type)));
            return types
                .Where(type => !Matches(wantedItems.GetValueOrDefault(type), nowItems.GetValueOrDefault(type)))
                .SelectMany(type => Differences($"{path}[{type}]", nowItems.GetValueOrDefault(type), wantedItems.GetValueOrDefault(type)));
        }
        return [];
    }

    /// <summary>A list of objects that each name a distinct <c>type</c>, by type; otherwise null.</summary>
    private static Dictionary<string, JsonNode>? Typed(JsonNode? node)
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

    /// <summary>Whether <paramref name="now"/> has what <paramref name="wanted"/> names, as the plan judges it.</summary>
    private static bool Matches(JsonNode? wanted, JsonNode? now) => (wanted, now) switch
    {
        (JsonObject wantedObject, JsonObject nowObject) =>
            wantedObject.All(pair => Matches(pair.Value, nowObject[pair.Key])),
        (JsonArray wantedArray, JsonArray nowArray) =>
            wantedArray.Count == nowArray.Count && MatchItems(wantedArray, nowArray),
        (JsonObject or JsonArray, _) => false,
        _ => JsonNode.DeepEquals(wanted, now),
    };

    private static bool MatchItems(JsonArray wanted, JsonArray now)
    {
        var unused = now.ToList();
        foreach (var item in wanted)
        {
            var index = unused.FindIndex(candidate => Matches(item, candidate));
            if (index == -1)
            {
                return false;
            }
            unused.RemoveAt(index);
        }
        return true;
    }

    /// <summary>A value as one short line: a list of rules by type, a list as its items, an object as its pairs.</summary>
    public static string Show(JsonNode? value) => value switch
    {
        null => "none",
        JsonValue scalar when scalar.GetValueKind() == JsonValueKind.String => scalar.GetValue<string>(),
        JsonValue scalar => scalar.ToJsonString(),
        JsonArray { Count: 0 } => "none",
        JsonArray array when Typed(array) is { } typed => string.Join(", ", typed.Keys),
        JsonArray array => string.Join(", ", array.Select(Show)),
        JsonObject { Count: 0 } => "none",
        JsonObject entries => string.Join(", ", entries.Select(pair => $"{pair.Key}: {Show(pair.Value)}")),
        _ => value.ToJsonString(),
    };

    public static JsonNode? Node(JsonElement? element) =>
        element is { } value ? JsonNode.Parse(value.GetRawText()) : null;
}
