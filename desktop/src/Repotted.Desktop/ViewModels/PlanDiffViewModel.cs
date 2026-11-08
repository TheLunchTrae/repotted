using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.Input;

namespace Repotted.Desktop.ViewModels;

/// <summary>Unchanged lines a diff folds away, until they are shown.</summary>
internal sealed record DiffFold(IReadOnlyList<DiffLine> Lines)
{
    public string Label => $"Show {Lines.Count} unchanged lines";
}

/// <summary>
/// One repository's plan as a diff of profile YAML, GitHub now against after
/// the plan applies, with runs of unchanged lines folded. It shows one
/// repository's plan.
/// </summary>
internal sealed partial class PlanDiffViewModel : ViewModelBase
{
    /// <summary>A run of unchanged lines folds when it is at least this long.</summary>
    private const int FoldAt = 3;

    public PlanDiffViewModel(IReadOnlyList<DiffLine> lines, string? footnote = null)
    {
        Changes = lines.Count(line => line.Kind is DiffKind.Added or DiffKind.Removed);
        Matches = Changes == 0 && lines.All(line => line.Kind != DiffKind.Note);
        Footnote = footnote;
        Items = [.. Fold(lines)];
    }

    /// <summary>The lines, and the folds that stand for unchanged runs.</summary>
    public ObservableCollection<object> Items { get; }

    /// <summary>How many lines GitHub loses or gains.</summary>
    public int Changes { get; }

    /// <summary>Whether GitHub already has all of it: nothing changes, and nothing went unchecked.</summary>
    public bool Matches { get; }

    /// <summary>What the diff leaves out, such as drafts and left-out changes, or null.</summary>
    public string? Footnote { get; }

    public bool HasFootnote => Footnote is not null;

    /// <summary>Shows a fold's lines in its place.</summary>
    [RelayCommand]
    private void Unfold(DiffFold fold)
    {
        var index = Items.IndexOf(fold);
        if (index < 0)
        {
            return;
        }
        Items.RemoveAt(index);
        foreach (var line in fold.Lines.Reverse())
        {
            Items.Insert(index, line);
        }
    }

    /// <summary>
    /// Keeps each section's name, each changed line's parents (the nearest
    /// line above it at each smaller indent, such as its ruleset's
    /// <c>- name:</c>), and the unchanged line on either side of a change,
    /// and folds every other run of unchanged lines that is long enough.
    /// </summary>
    internal static IEnumerable<object> Fold(IReadOnlyList<DiffLine> lines)
    {
        static bool Changed(DiffLine line) => line.Kind is DiffKind.Added or DiffKind.Removed;
        var keep = lines.Select(line => line.Kind != DiffKind.Same || !line.Text.StartsWith(' ')).ToArray();
        for (var index = 0; index < lines.Count; index++)
        {
            if (!Changed(lines[index]))
            {
                continue;
            }
            if (index > 0)
            {
                keep[index - 1] = true;
            }
            if (index + 1 < lines.Count)
            {
                keep[index + 1] = true;
            }
            var indent = lines[index].Indent.Length;
            for (var above = index - 1; above >= 0 && indent > 0; above--)
            {
                if (lines[above].Kind != DiffKind.Note && lines[above].Indent.Length < indent)
                {
                    keep[above] = true;
                    indent = lines[above].Indent.Length;
                }
            }
        }
        List<DiffLine> run = [];
        for (var index = 0; index < lines.Count; index++)
        {
            if (!keep[index])
            {
                run.Add(lines[index]);
                continue;
            }
            foreach (var item in Flush(run))
            {
                yield return item;
            }
            yield return lines[index];
        }
        foreach (var item in Flush(run))
        {
            yield return item;
        }
    }

    private static IEnumerable<object> Flush(List<DiffLine> run)
    {
        if (run.Count == 0)
        {
            return [];
        }
        IEnumerable<object> items = run.Count >= FoldAt ? [new DiffFold([.. run])] : [.. run];
        run.Clear();
        return items;
    }
}
