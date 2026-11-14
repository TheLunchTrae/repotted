/** One line of a diff: in both texts, only in the new one, or only in the old one. */
export interface DiffLine {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** A run of lines that are the same in both texts, folded away from the changes around it. */
export interface DiffFold {
  readonly kind: 'fold';
  readonly lines: readonly string[];
}

/**
 * The lines of `before` and `after` as one diff, by their longest common
 * run of lines, with each removed line ahead of the added lines that
 * replace it. It compares every line with every line, which suits texts
 * the size of a profile.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  // common[i][j] is how many lines the texts share from line i of before and line j of after on.
  const common = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = common[i];
      const next = common[i + 1];
      if (row !== undefined && next !== undefined) {
        row[j] = before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const old = before[i];
    const now = after[j];
    if (old !== undefined && old === now) {
      lines.push({ kind: 'same', text: old });
      i += 1;
      j += 1;
    } else if (old !== undefined && (now === undefined || (common[i + 1]?.[j] ?? 0) >= (common[i]?.[j + 1] ?? 0))) {
      lines.push({ kind: 'removed', text: old });
      i += 1;
    } else if (now !== undefined) {
      lines.push({ kind: 'added', text: now });
      j += 1;
    }
  }
  return lines;
}

/**
 * A diff with each run of unchanged lines folded, but for `context` lines
 * beside a change. A run too short to be worth a fold stays as it is.
 */
export function foldUnchanged(lines: readonly DiffLine[], context = 3): (DiffLine | DiffFold)[] {
  const folded: (DiffLine | DiffFold)[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    while (end < lines.length && lines[end]?.kind === 'same') {
      end += 1;
    }
    // The run keeps its lines beside a change: after one, when it isn't the first run, and before one, when it isn't the last.
    const from = start === 0 ? start : start + context;
    const to = end === lines.length ? end : end - context;
    if (to - from > 1) {
      folded.push(...lines.slice(start, from), {
        kind: 'fold',
        lines: lines.slice(from, to).map((line) => line.text),
      });
      folded.push(...lines.slice(to, end));
    } else {
      folded.push(...lines.slice(start, end));
    }
    const changed = lines[end];
    if (changed !== undefined) {
      folded.push(changed);
    }
    start = end + 1;
  }
  return folded;
}
