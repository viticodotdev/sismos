/**
 * Dedupe — in-memory, single-request scope.
 *
 * The poller's no-overlap window means each event appears in exactly one poll,
 * so no external store is needed; this set only guards a single poll that
 * returns the same event twice (wide test windows).
 */

export interface DedupeStore {
  seen(unid: string): Promise<boolean>
  markSeen(unid: string): Promise<void>
}

export function dedupeInMemory(): DedupeStore {
  const seen = new Set<string>()
  return {
    async seen(unid: string) {
      return seen.has(unid)
    },
    async markSeen(unid: string) {
      seen.add(unid)
    },
  }
}