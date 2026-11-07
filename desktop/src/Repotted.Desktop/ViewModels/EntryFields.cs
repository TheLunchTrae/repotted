using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.Input;

namespace Repotted.Desktop.ViewModels;

/// <summary>
/// A segmented choice for one key of an entry. No option chosen means the
/// entry leaves the key out, so GitHub keeps what the repository has.
/// </summary>
internal sealed partial class ChoiceViewModel : ViewModelBase
{
    private readonly Action changed;

    /// <param name="label">What the choice sets, as the row names it.</param>
    /// <param name="options">Each option's label and the value it writes.</param>
    /// <param name="entry">The entry the choice starts from.</param>
    /// <param name="key">The entry's key the choice writes.</param>
    /// <param name="changed">Runs on every change.</param>
    /// <param name="fallback">The option GitHub uses when the key is left out, shown dimmed; -1 for none.</param>
    public ChoiceViewModel(string label, IReadOnlyList<(string Label, JsonNode? Value)> options, JsonObject entry, string key, Action changed, int fallback = -1)
    {
        Label = label;
        Fallback = fallback;
        Key = key;
        this.changed = changed;
        Values = [.. options.Select(option => option.Value)];
        Options = [.. options.Select((option, index) => new ChoiceOptionViewModel(this, index, option.Label))];
        if (entry.TryGetPropertyValue(key, out var value))
        {
            Chosen = Values.ToList().FindIndex(option => JsonNode.DeepEquals(option, value));
            // A value the options do not offer stays as it is until another is chosen.
            Kept = Chosen == -1 ? value?.DeepClone() : null;
            KeptSet = Chosen == -1;
        }
        else
        {
            Chosen = -1;
        }
    }

    public string Label { get; }

    public string Key { get; }

    /// <summary>The option GitHub uses when the key is left out, or -1.</summary>
    public int Fallback { get; }

    private IReadOnlyList<JsonNode?> Values { get; }

    public IReadOnlyList<ChoiceOptionViewModel> Options { get; }

    /// <summary>The chosen option, or -1 for none.</summary>
    public int Chosen { get; private set; }

    private JsonNode? Kept { get; set; }

    private bool KeptSet { get; set; }

    public bool IsSet => Chosen >= 0 || KeptSet;

    public string Note => (IsSet, Fallback) switch
    {
        (true, _) => "",
        (false, -1) => "Not set here, so the repository keeps its own",
        _ => $"Not set here, so the repository keeps its own, or {Options[Fallback].Label} when it is new",
    };

    public void Choose(int index)
    {
        Chosen = index;
        KeptSet = false;
        Refresh();
    }

    /// <summary>Leaves the key out of the entry again.</summary>
    [RelayCommand]
    private void Clear()
    {
        Chosen = -1;
        KeptSet = false;
        Refresh();
    }

    /// <summary>Writes the chosen value into <paramref name="entry"/>, or takes the key out.</summary>
    public void WriteTo(JsonObject entry)
    {
        entry.Remove(Key);
        if (Chosen >= 0)
        {
            entry[Key] = Values[Chosen]?.DeepClone();
        }
        else if (KeptSet)
        {
            entry[Key] = Kept?.DeepClone();
        }
    }

    public JsonNode? Value => Chosen >= 0 ? Values[Chosen] : Kept;

    private void Refresh()
    {
        OnPropertyChanged(nameof(IsSet));
        OnPropertyChanged(nameof(Note));
        foreach (var option in Options)
        {
            option.Refresh();
        }
        changed();
    }
}

/// <summary>One option of a <see cref="ChoiceViewModel"/>.</summary>
internal sealed partial class ChoiceOptionViewModel(ChoiceViewModel choice, int index, string label) : ViewModelBase
{
    public string Label => label;

    public bool Selected => choice.Chosen == index;

    /// <summary>Whether this is what GitHub uses while nothing is chosen.</summary>
    public bool Dim => !choice.IsSet && choice.Fallback == index;

    public bool Shown => Selected || Dim;

    public string AccessibleName => $"{choice.Label}: {label}";

    public string Note => choice.Note;

    [RelayCommand]
    private void Choose() => choice.Choose(index);

    public void Refresh()
    {
        OnPropertyChanged(nameof(Selected));
        OnPropertyChanged(nameof(Dim));
        OnPropertyChanged(nameof(Shown));
        OnPropertyChanged(nameof(Note));
    }
}

/// <summary>
/// One setting of a rule's parameters. A parameter the entry leaves out shows
/// GitHub's default, dimmed, and is written only once it is changed.
/// </summary>
internal abstract class ParameterViewModel<T> : ViewModelBase
{
    private readonly Action changed;
    private readonly T @default;

    protected ParameterViewModel(string label, string key, T @default, JsonObject? parameters, Action changed)
    {
        Label = label;
        Key = key;
        this.@default = @default;
        this.changed = changed;
        if (parameters?[key] is JsonValue value && value.TryGetValue<T>(out var saved))
        {
            current = saved;
            IsSet = true;
        }
        else
        {
            current = @default;
        }
    }

    private T current;

    public string Label { get; }

    public string Key { get; }

    public bool IsSet { get; private set; }

    public bool Dim => !IsSet;

    public string HelpText => IsSet ? "" : "Not set here, so the repository keeps its own";

    public T Value
    {
        get => current;
        set
        {
            if (EqualityComparer<T>.Default.Equals(current, value) && IsSet)
            {
                return;
            }
            current = value;
            IsSet = true;
            OnPropertyChanged(nameof(Value));
            OnValueChanged();
            OnPropertyChanged(nameof(IsSet));
            OnPropertyChanged(nameof(Dim));
            OnPropertyChanged(nameof(HelpText));
            changed();
        }
    }

    public T Default => @default;

    protected virtual void OnValueChanged()
    {
    }

    public void WriteTo(JsonObject parameters)
    {
        parameters.Remove(Key);
        if (IsSet)
        {
            parameters[Key] = JsonValue.Create(current);
        }
    }
}

/// <summary>A rule parameter that is on or off.</summary>
internal sealed class FlagViewModel(string label, string key, JsonObject? parameters, Action changed)
    : ParameterViewModel<bool>(label, key, false, parameters, changed);

/// <summary>A rule parameter that counts, such as required approvals.</summary>
internal sealed class CountViewModel(string label, string key, JsonObject? parameters, Action changed)
    : ParameterViewModel<int>(label, key, 0, parameters, changed)
{
    /// <summary>The count as the number box shows it.</summary>
    public decimal? Number
    {
        get => Value;
        set => Value = (int)(value ?? 0);
    }

    protected override void OnValueChanged() => OnPropertyChanged(nameof(Number));
}

/// <summary>The merge methods a pull request rule allows, written as one list.</summary>
internal sealed partial class MergeMethodsViewModel : ViewModelBase
{
    private const string Key = "allowed_merge_methods";

    private readonly Action changed;

    public MergeMethodsViewModel(JsonObject? parameters, Action changed)
    {
        this.changed = changed;
        if (parameters?[Key] is JsonArray methods)
        {
            IsSet = true;
            saved = methods;
            var names = methods.Select(method => method?.GetValue<string>()).ToHashSet();
            merge = names.Contains("merge");
            squash = names.Contains("squash");
            rebase = names.Contains("rebase");
        }
        else
        {
            merge = squash = rebase = true;
        }
    }

    private readonly JsonArray? saved;
    private bool merge;
    private bool squash;
    private bool rebase;

    public bool IsSet { get; private set; }

    public bool Dim => !IsSet;

    public string HelpText => IsSet ? "" : "Not set here, so the repository keeps its own";

    public bool Merge { get => merge; set => Set(ref merge, value); }

    public bool Squash { get => squash; set => Set(ref squash, value); }

    public bool Rebase { get => rebase; set => Set(ref rebase, value); }

    public bool None => !merge && !squash && !rebase;

    private void Set(ref bool field, bool value)
    {
        if (field == value)
        {
            return;
        }
        field = value;
        IsSet = true;
        OnPropertyChanged(nameof(Merge));
        OnPropertyChanged(nameof(Squash));
        OnPropertyChanged(nameof(Rebase));
        OnPropertyChanged(nameof(IsSet));
        OnPropertyChanged(nameof(Dim));
        OnPropertyChanged(nameof(HelpText));
        changed();
    }

    public void WriteTo(JsonObject parameters)
    {
        parameters.Remove(Key);
        if (!IsSet)
        {
            return;
        }
        var chosen = new[] { ("merge", merge), ("squash", squash), ("rebase", rebase) }
            .Where(method => method.Item2)
            .Select(method => method.Item1)
            .ToList();
        // The same methods keep the order the YAML lists them in.
        parameters[Key] = saved is not null
            && saved.Select(method => method?.GetValue<string>()).Order().SequenceEqual(chosen.Order())
            ? saved.DeepClone()
            : new JsonArray([.. chosen.Select(method => (JsonNode)JsonValue.Create(method))]);
    }
}
