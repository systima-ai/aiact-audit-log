/**
 * Deterministic JSON serialisation.
 *
 * Produces identical output for identical data regardless of object key
 * insertion order. This is critical for hash chain integrity: the same
 * log entry must always produce the same SHA-256 hash.
 */
export function deterministicStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer)
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }

  const sorted: Record<string, unknown> = {}
  const keys = Object.keys(value as Record<string, unknown>).sort()
  for (const k of keys) {
    sorted[k] = (value as Record<string, unknown>)[k]
  }
  return sorted
}
