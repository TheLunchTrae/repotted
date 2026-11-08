using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>A rule type the editor offers, with what it does in GitHub's words.</summary>
internal sealed record RuleKind(string Type, string Label, string Description);

/// <summary>
/// One rule a ruleset can hold. A rule the entry names keeps its parameters,
/// including ones the editor does not show, apart from what is changed here.
/// </summary>
internal partial class RuleViewModel : ViewModelBase
{
    private readonly Action changed;

    public RuleViewModel(RuleKind kind, JsonObject? saved, Action changed)
    {
        Kind = kind;
        Saved = saved;
        this.changed = changed;
        enabled = saved is not null;
    }

    public RuleKind Kind { get; }

    public string Label => Kind.Label;

    public string Description => Kind.Description;

    /// <summary>The rule as the entry holds it, or null when it does not.</summary>
    protected JsonObject? Saved { get; }

    private bool enabled;

    public bool Enabled
    {
        get => enabled;
        set
        {
            if (SetProperty(ref enabled, value))
            {
                Changed();
            }
        }
    }

    protected void Changed() => changed();

    /// <summary>The rule to write, or null when it is off.</summary>
    public JsonObject? Build()
    {
        if (!Enabled)
        {
            return null;
        }
        var rule = Saved?.DeepClone().AsObject() ?? new JsonObject { ["type"] = Kind.Type };
        var parameters = rule["parameters"] as JsonObject ?? [];
        WriteParameters(parameters);
        rule.Remove("parameters");
        if (parameters.Count > 0)
        {
            rule["parameters"] = parameters;
        }
        return EntryEditorViewModel.Ordered(rule, Saved);
    }

    protected virtual void WriteParameters(JsonObject parameters)
    {
    }

    /// <summary>Why the rule cannot be saved as it is, if anything.</summary>
    public virtual string? Problem => null;
}

/// <summary>The pull request rule, with the review settings the editor shows.</summary>
internal sealed partial class PullRequestRuleViewModel : RuleViewModel
{
    public PullRequestRuleViewModel(RuleKind kind, JsonObject? saved, Action changed)
        : base(kind, saved, changed)
    {
        var parameters = saved?["parameters"] as JsonObject;
        Approvals = new("Required approvals", "required_approving_review_count", parameters, Changed);
        DismissStale = new("Dismiss approvals when new commits are pushed", "dismiss_stale_reviews_on_push", parameters, Changed);
        CodeOwners = new("Require review from code owners", "require_code_owner_review", parameters, Changed);
        LastPush = new("Require approval of the most recent push", "require_last_push_approval", parameters, Changed);
        Threads = new("Require conversations to be resolved", "required_review_thread_resolution", parameters, Changed);
        Methods = new(parameters, Changed);
    }

    public CountViewModel Approvals { get; }

    public FlagViewModel DismissStale { get; }

    public FlagViewModel CodeOwners { get; }

    public FlagViewModel LastPush { get; }

    public FlagViewModel Threads { get; }

    public MergeMethodsViewModel Methods { get; }

    public IReadOnlyList<FlagViewModel> Checks => [DismissStale, CodeOwners, LastPush, Threads];

    protected override void WriteParameters(JsonObject parameters)
    {
        Approvals.WriteTo(parameters);
        foreach (var check in Checks)
        {
            check.WriteTo(parameters);
        }
        Methods.WriteTo(parameters);
    }

    public override string? Problem =>
        Enabled && Methods.None ? "A pull request rule needs at least one merge method." : null;
}

/// <summary>The status checks rule: the checks that must pass, one per line.</summary>
internal sealed partial class StatusChecksRuleViewModel : RuleViewModel
{
    private const string ChecksKey = "required_status_checks";

    private readonly IReadOnlyList<JsonObject> savedChecks;
    private readonly string savedContexts;

    public StatusChecksRuleViewModel(RuleKind kind, JsonObject? saved, Action changed)
        : base(kind, saved, changed)
    {
        var parameters = saved?["parameters"] as JsonObject;
        savedChecks = parameters?[ChecksKey] is JsonArray checks ? [.. checks.OfType<JsonObject>()] : [];
        savedContexts = contexts = string.Join('\n', savedChecks.Select(check => check["context"].AsText()).OfType<string>());
        Strict = new("Require branches to be up to date before merging", "strict_required_status_checks_policy", parameters, Changed);
    }

    private string contexts;

    /// <summary>The check names, one per line.</summary>
    public string Contexts
    {
        get => contexts;
        set
        {
            if (SetProperty(ref contexts, value))
            {
                Changed();
            }
        }
    }

    public FlagViewModel Strict { get; }

    protected override void WriteParameters(JsonObject parameters)
    {
        Strict.WriteTo(parameters);
        if (Lines(contexts).SequenceEqual(Lines(savedContexts)) && Saved is not null)
        {
            return;
        }
        // A check keeps what else it named, such as the app that must report it.
        var byContext = savedChecks
            .Where(check => check["context"].AsText() is not null)
            .GroupBy(check => check["context"].AsText()!)
            .ToDictionary(group => group.Key, group => group.First());
        parameters[ChecksKey] = new JsonArray(
        [
            .. Lines(contexts).Distinct().Select(context =>
                (JsonNode)(byContext.GetValueOrDefault(context)?.DeepClone() ?? new JsonObject { ["context"] = context })),
        ]);
    }

    public override string? Problem =>
        Enabled && Lines(contexts).Count == 0 ? "Name at least one status check that must pass." : null;

    private static IReadOnlyList<string> Lines(string text) => EntryEditorViewModel.Lines(text);
}
