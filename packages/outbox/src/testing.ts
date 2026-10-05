import type { OutboxStore, OutboxEventRow } from "./contracts.js";
/** @beta Framework-free refusal suite. The caller supplies a real processing row. */
export async function assertOutboxStoreFences(store: OutboxStore, processing: OutboxEventRow): Promise<void> {
  const token = processing.metadata.claimToken;
  if (processing.status !== "processing" || typeof token !== "string" || !token) throw new Error("conformance_requires_processing_row");
  if ((await store.markProcessed({ eventId: processing.id, claimToken: `stale-${token}` })).applied) throw new Error("conformance_stale_processed_applied");
  if ((await store.markFailed({ eventId: processing.id, claimToken: `stale-${token}`, error: "synthetic", outcome: "retry", baseDelaySeconds: 5, maxDelaySeconds: 10, maxAttempts: 3, snoozeSeconds: 60 })).status !== "missed") throw new Error("conformance_stale_failure_applied");
  if (await store.releaseUnprocessed([{ eventId: processing.id, claimToken: `stale-${token}` }], 0) !== 0) throw new Error("conformance_stale_release_applied");
}
/** @beta Synthetic envelope; never use for deployed queue observations. */
export function syntheticOutboxRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return { id: "00000000-0000-4000-8000-000000000001", created_at: "2026-01-01T00:00:00.000001Z", available_at: "2026-01-01T00:00:00.000001Z", processed_at: null, aggregate_type: "example", aggregate_id: "00000000-0000-4000-8000-000000000002", event_type: "example.created", idempotency_key: "synthetic-1", status: "processing", attempts: 1, payload: {}, error: null, metadata: { claimToken: "synthetic-token" }, ...overrides };
}
