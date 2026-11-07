using System.Text.Json.Nodes;

namespace Repotted.Desktop.ViewModels;

/// <summary>A ruleset: where it applies, how it is enforced, who bypasses it, and its rules.</summary>
internal sealed partial class RulesetEditorViewModel : EntryEditorViewModel
{
    public static readonly IReadOnlyList<RuleKind> Kinds =
    [
        new("deletion", "Restrict deletions", "Only people who can bypass the ruleset can delete matching refs."),
        new("non_fast_forward", "Block force pushes", "Nobody can force push to matching refs."),
        new("creation", "Restrict creations", "Only people who can bypass the ruleset can create matching refs."),
        new("update", "Restrict updates", "Only people who can bypass the ruleset can push to matching refs."),
        new("required_linear_history", "Require linear history", "Merge commits cannot be pushed to matching refs."),
        new("required_signatures", "Require signed commits", "Commits pushed to matching refs must be signed."),
        new("pull_request", "Require a pull request before merging", "Changes reach matching branches only through a pull request."),
        new("required_status_checks", "Require status checks to pass", "The checks below must pass before a change reaches matching refs."),
    ];

    private readonly JsonObject? savedRefName;
    private readonly IReadOnlyList<JsonObject> savedRules;

    public RulesetEditorViewModel(JsonObject? saved, bool renamable, Func<string, bool> taken, Action changed)
        : base(saved, renamable, taken, changed)
    {
        var start = Start;
        Target = new("Applies to", [("Branches", "branch"), ("Tags", "tag"), ("Pushes", "push")], start, "target", Touched, fallback: 0);
        Enforcement = new("Enforcement", [("Active", "active"), ("Evaluate", "evaluate"), ("Disabled", "disabled")], start, "enforcement", Touched, fallback: 0);
        var bypass = start["bypass_actors"] as JsonArray;
        Bypass = new(
            "Bypass",
            bypass is { Count: > 0 }
                ? [("Nobody", new JsonArray()), (bypass.Count == 1 ? "1 actor, as in the YAML" : $"{bypass.Count} actors, as in the YAML", bypass.DeepClone())]
                : [("Nobody", new JsonArray())],
            start,
            "bypass_actors",
            Touched);
        savedRefName = (start["conditions"] as JsonObject)?["ref_name"] as JsonObject;
        include = Text(savedRefName?["include"]);
        exclude = Text(savedRefName?["exclude"]);
        savedRules = start["rules"] is JsonArray rules ? [.. rules.OfType<JsonObject>()] : [];
        RulesSet = start.ContainsKey("rules");
        Rules =
        [
            .. Kinds.Select(kind =>
            {
                var rule = savedRules.FirstOrDefault(candidate => candidate["type"]?.GetValue<string>() == kind.Type);
                return kind.Type switch
                {
                    "pull_request" => new PullRequestRuleViewModel(kind, rule, Touched),
                    "required_status_checks" => new StatusChecksRuleViewModel(kind, rule, Touched),
                    _ => new RuleViewModel(kind, rule, Touched),
                };
            }),
        ];
        Others = string.Join(", ", savedRules
            .Select(rule => rule["type"]?.GetValue<string>())
            .OfType<string>()
            .Where(type => Kinds.All(kind => kind.Type != type)));
    }

    public override string Kind => "ruleset";

    public ChoiceViewModel Target { get; }

    public ChoiceViewModel Enforcement { get; }

    public ChoiceViewModel Bypass { get; }

    private string include;

    /// <summary>The ref name patterns the ruleset applies to, one per line.</summary>
    public string Include
    {
        get => include;
        set
        {
            if (include == value)
            {
                return;
            }
            include = value;
            OnPropertyChanged();
            Touched();
        }
    }

    private string exclude;

    public string Exclude
    {
        get => exclude;
        set
        {
            if (exclude == value)
            {
                return;
            }
            exclude = value;
            OnPropertyChanged();
            Touched();
        }
    }

    /// <summary>Whether the entry names its rules; when it does not, GitHub keeps the ruleset's.</summary>
    private bool RulesSet { get; }

    public IReadOnlyList<RuleViewModel> Rules { get; }

    /// <summary>Whether GitHub keeps the ruleset's rules, which the editor then cannot show.</summary>
    public bool LeavesRules => !RulesSet && Saved is not null;

    /// <summary>Rules the editor does not show, which stay as they are.</summary>
    public string Others { get; }

    public bool HasOthers => Others.Length > 0;

    public string OthersNote => $"Also keeps these rules from the YAML: {Others}.";

    protected override string? FieldProblem =>
        Rules.Select(rule => rule.Problem).FirstOrDefault(problem => problem is not null);

    protected override JsonObject Build()
    {
        var entry = Start.DeepClone().AsObject();
        Target.WriteTo(entry);
        Enforcement.WriteTo(entry);
        Bypass.WriteTo(entry);
        WriteRefName(entry);
        WriteRules(entry);
        return entry;
    }

    private void WriteRefName(JsonObject entry)
    {
        var conditions = entry["conditions"] as JsonObject ?? [];
        var includes = Lines(include);
        var excludes = Lines(exclude);
        var same = includes.SequenceEqual(Lines(Text(savedRefName?["include"])))
            && excludes.SequenceEqual(Lines(Text(savedRefName?["exclude"])));
        if (same)
        {
            return;
        }
        conditions.Remove("ref_name");
        if (includes.Count > 0 || excludes.Count > 0)
        {
            conditions["ref_name"] = new JsonObject
            {
                ["include"] = new JsonArray([.. includes.Select(line => (JsonNode)JsonValue.Create(line))]),
                ["exclude"] = new JsonArray([.. excludes.Select(line => (JsonNode)JsonValue.Create(line))]),
            };
        }
        entry.Remove("conditions");
        if (conditions.Count > 0)
        {
            entry["conditions"] = conditions;
        }
    }

    private void WriteRules(JsonObject entry)
    {
        var built = Rules.ToDictionary(rule => rule.Kind.Type, rule => rule.Build());
        // Rules keep their order; one turned on goes after the rest.
        List<JsonNode> rules = [];
        foreach (var rule in savedRules)
        {
            var type = rule["type"]?.GetValue<string>();
            if (type is null || !built.TryGetValue(type, out var replacement))
            {
                rules.Add(rule.DeepClone());
            }
            else if (replacement is not null)
            {
                rules.Add(replacement);
                built.Remove(type);
            }
            else
            {
                built.Remove(type);
            }
        }
        rules.AddRange(built.Values.OfType<JsonObject>());
        entry.Remove("rules");
        if (RulesSet || rules.Count > 0)
        {
            entry["rules"] = new JsonArray([.. rules]);
        }
    }
}
