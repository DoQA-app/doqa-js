export function serializeParameter(value: unknown): string {
  // JSON turns all non-finite numbers into null, merging unrelated datasets.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}
