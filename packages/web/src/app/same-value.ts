/** A value as text that reads the same whatever order its objects' keys are in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  // JSON has no undefined, and gives none back for one.
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * Whether two values of a profile's plain data are the same. The order of an
 * object's keys doesn't count, since a form writes a changed key last and
 * the engine reads keys in the schema's order.
 */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
