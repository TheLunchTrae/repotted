using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// Reads a value from profile JSON without throwing when it has another type,
/// as a draft's may, since a draft is saved before it is valid.
/// </summary>
internal static class JsonValues
{
    /// <summary>The node's text, or null when it is missing or not a string.</summary>
    public static string? AsText(this JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// <summary>The node's flag, or null when it is missing or not true or false.</summary>
    public static bool? AsFlag(this JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
}
