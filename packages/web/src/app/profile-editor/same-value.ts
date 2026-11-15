function keyOrderIndependentText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(keyOrderIndependentText).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${keyOrderIndependentText(item)}`)
      .join(',')}}`;
  }
  // JSON has no undefined, and gives none back for one.
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** Key order doesn't count: a form writes a changed key last and the engine reads keys in the schema's order. */
export function sameValue(left: unknown, right: unknown): boolean {
  return keyOrderIndependentText(left) === keyOrderIndependentText(right);
}
