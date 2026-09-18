import type { QueueHealthSnapshot } from "../../../src/domains/platform/observabilityContracts.js";
import { isDormantOutboxEventType } from "../../../src/lib/outboxDormantEventTypes.js";

export type OutboxEventEvidenceRow = Record<string, unknown> & {
  id: string;
  status: string;
  event_type: string;
  aggregate_type?: string | null;
  aggregate_id?: string | null;
  available_at?: string | null;
  created_at: string;
  processed_at?: string | null;
  attempts?: number | null;
};

export function summarizeOutboxQueue(
  rows: OutboxEventEvidenceRow[],
  dueCount: number,
  failedCount: number,
): QueueHealthSnapshot {
  const actionableRows = rows.filter((row) => !isDormantOutboxEventType(row.event_type));
  return {
    queueName: "outbox_events",
    jobName: "outbox-dispatch",
    queuedCount: dueCount,
    oldestQueuedAt: actionableRows.map((row) => row.available_at ?? row.created_at).filter(Boolean).sort()[0] ?? null,
    failedCount,
    skippedCount: 0,
  };
}
