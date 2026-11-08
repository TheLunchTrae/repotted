using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Repotted.Desktop.Services;

namespace Repotted.Desktop.Tests;

/// <summary>
/// Reads the documents the CLI's own tests print against their in-memory
/// GitHub, which they save in Fixtures, each with the type the app reads it
/// with. A change to one that the app can't read fails here. Run the CLI's
/// tests, such as with <c>pnpm vitest run -u</c>, to write them again.
/// </summary>
public sealed class CliFixtureTests
{
    private static readonly string Folder = Path.Combine(AppContext.BaseDirectory, "Fixtures");

    /// <summary>Each fixture, by its file name, and how the app reads it.</summary>
    private static readonly Dictionary<string, Func<string, object?>> Readers = new(StringComparer.Ordinal)
    {
        ["status"] = Reader(CliJson.Default.StatusDocument),
        ["repos"] = Reader(CliJson.Default.RepositoryListDocument),
        ["plan"] = Reader(CliJson.Default.PlanDocument),
        ["plan-locked"] = Reader(CliJson.Default.PlanDocument),
        ["capture"] = Reader(CliJson.Default.CaptureDocument),
        ["apply"] = Reader(CliJson.Default.ApplyDocument),
        ["apply-stale"] = Failure,
        ["apply-failed"] = Failure,
        ["sync"] = Reader(CliJson.Default.SyncDocument),
        ["sync-conflict"] = Reader(CliJson.Default.SyncDocument),
        ["stage"] = Reader(CliJson.Default.StagedApplyDocument),
        ["staged-plan"] = Reader(CliJson.Default.StagedPlanDocument),
        ["batch"] = Reader(CliJson.Default.BatchDocument),
        ["batch-everywhere"] = Reader(CliJson.Default.EverywhereDocument),
        ["batch-plan"] = Reader(CliJson.Default.BatchPlanDocument),
        ["batch-apply"] = Reader(CliJson.Default.BatchApplyDocument),
    };

    public static TheoryData<string> Names => [.. Readers.Keys];

    private static Func<string, object?> Reader<T>(JsonTypeInfo<T> type) => json => JsonSerializer.Deserialize(json, type);

    /// <summary>A failed apply, which the app reads for its error.</summary>
    private static object? Failure(string json) => JsonSerializer.Deserialize(json, CliJson.Default.ApplyFailureDocument)?.Error;

    [Fact]
    public void Every_fixture_has_a_reader_and_every_reader_a_fixture()
    {
        var files = Directory.GetFiles(Folder, "*.json").Select(file => Path.GetFileNameWithoutExtension(file)).Order(StringComparer.Ordinal);

        Assert.Equal(Readers.Keys.Order(StringComparer.Ordinal), files);
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void The_app_reads_what_the_cli_prints(string name)
    {
        var json = File.ReadAllText(Path.Combine(Folder, $"{name}.json"));

        Assert.NotNull(Readers[name](json));
    }
}
