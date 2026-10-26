export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasNoAccessors(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || Object.hasOwn(descriptor, "value");
  });
}

export function hasOnlyAllowedDataProperties(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
}
