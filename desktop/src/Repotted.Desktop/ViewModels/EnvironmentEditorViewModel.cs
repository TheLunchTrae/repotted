using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>An environment: its wait timer, reviewers, and which branches and tags may deploy.</summary>
internal sealed partial class EnvironmentEditorViewModel : EntryEditorViewModel
{
    private const string Policy = "deployment_branch_policy";
    private const string Patterns = "branch_policies";

    private static readonly JsonObject Protected = new() { ["protected_branches"] = true, ["custom_branch_policies"] = false };
    private static readonly JsonObject Custom = new() { ["protected_branches"] = false, ["custom_branch_policies"] = true };

    private readonly JsonArray? savedPatterns;

    public EnvironmentEditorViewModel(JsonObject? saved, bool renamable, Func<string, bool> taken, Action changed)
        : base(saved, renamable, taken, changed)
    {
        var start = Start;
        waitTimer = start["wait_timer"]?.ToJsonString() ?? "";
        SelfReview = new("Prevent self-review", [("On", true), ("Off", false)], start, "prevent_self_review", Touched);
        var reviewers = start["reviewers"] as JsonArray;
        Reviewers = new(
            "Required reviewers",
            reviewers is { Count: > 0 }
                ? [("None", new JsonArray()), (reviewers.Count == 1 ? "1 reviewer, as in the YAML" : $"{reviewers.Count} reviewers, as in the YAML", reviewers.DeepClone())]
                : [("None", new JsonArray())],
            start,
            "reviewers",
            Touched);
        Deployments = new(
            "Deployment branches",
            [("Any branch", null), ("Protected branches", Protected), ("Chosen branches and tags", Custom)],
            start,
            Policy,
            OnDeploymentsChanged);
        savedPatterns = start[Patterns] as JsonArray;
        branches = PatternText("branch");
        tags = PatternText("tag");
    }

    public override string Kind => "environment";

    private string waitTimer;

    /// <summary>Minutes to wait before a deployment; empty leaves the repository's own.</summary>
    public string WaitTimer
    {
        get => waitTimer;
        set
        {
            if (waitTimer == value)
            {
                return;
            }
            waitTimer = value;
            OnPropertyChanged();
            Touched();
        }
    }

    public ChoiceViewModel SelfReview { get; }

    public ChoiceViewModel Reviewers { get; }

    public ChoiceViewModel Deployments { get; }

    /// <summary>Whether name patterns apply: only under chosen branches and tags.</summary>
    public bool ShowPatterns => JsonNode.DeepEquals(Deployments.Value, Custom) && Deployments.IsSet;

    private string branches;

    /// <summary>Branch name patterns that may deploy, one per line.</summary>
    public string Branches
    {
        get => branches;
        set
        {
            if (branches == value)
            {
                return;
            }
            branches = value;
            OnPropertyChanged();
            Touched();
        }
    }

    private string tags;

    public string Tags
    {
        get => tags;
        set
        {
            if (tags == value)
            {
                return;
            }
            tags = value;
            OnPropertyChanged();
            Touched();
        }
    }

    private void OnDeploymentsChanged()
    {
        OnPropertyChanged(nameof(ShowPatterns));
        Touched();
    }

    protected override string? FieldProblem
    {
        get
        {
            var text = WaitTimer.Trim();
            if (text.Length > 0 && (!int.TryParse(text, out var minutes) || minutes is < 0 or > 43_200))
            {
                return "The wait timer is a whole number of minutes, from 0 to 43200.";
            }
            if (ShowPatterns && (Lines(Branches).Distinct().Count() < Lines(Branches).Count || Lines(Tags).Distinct().Count() < Lines(Tags).Count))
            {
                return "Each branch or tag pattern can be listed once.";
            }
            if (SelfReview.Value?.GetValue<bool>() == true && Reviewers.Value is JsonArray { Count: 0 })
            {
                return "Prevent self-review needs at least one required reviewer.";
            }
            return null;
        }
    }

    protected override JsonObject Build()
    {
        var entry = Start.DeepClone().AsObject();
        var text = WaitTimer.Trim();
        if (text != (Start["wait_timer"]?.ToJsonString() ?? ""))
        {
            entry.Remove("wait_timer");
            if (int.TryParse(text, out var minutes))
            {
                entry["wait_timer"] = minutes;
            }
        }
        SelfReview.WriteTo(entry);
        Reviewers.WriteTo(entry);
        Deployments.WriteTo(entry);
        WritePatterns(entry);
        return entry;
    }

    private void WritePatterns(JsonObject entry)
    {
        entry.Remove(Patterns);
        // GitHub takes name patterns only under chosen branches and tags.
        if (!ShowPatterns)
        {
            return;
        }
        if (Branches == PatternText("branch") && Tags == PatternText("tag") && savedPatterns is not null)
        {
            entry[Patterns] = savedPatterns.DeepClone();
            return;
        }
        var patterns = Lines(Branches).Select(name => (JsonNode)new JsonObject { ["name"] = name })
            .Concat(Lines(Tags).Select(name => (JsonNode)new JsonObject { ["name"] = name, ["type"] = "tag" }))
            .ToList();
        if (patterns.Count > 0 || savedPatterns is not null)
        {
            entry[Patterns] = new JsonArray([.. patterns]);
        }
    }

    private string PatternText(string type) =>
        string.Join('\n', (savedPatterns ?? [])
            .OfType<JsonObject>()
            .Where(policy => (policy["type"]?.GetValue<string>() ?? "branch") == type)
            .Select(policy => policy["name"]?.GetValue<string>())
            .OfType<string>());
}
