/**
 * Whether two values of the plain data that YAML and JSON give, which is
 * scalars, arrays, and objects with string keys, are the same all the way
 * down. Scalars compare with `Object.is`, an object's key order doesn't
 * count, and a key set to `undefined` differs from a key left out.
 */
export function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isDeepEqual(item, right[index]))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && isDeepEqual(Reflect.get(left, key), Reflect.get(right, key)))
  );
}
