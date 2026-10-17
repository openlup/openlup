import { runOutboxDispatchWorker, uniqueRegistry, type OutboxEventRow, type OutboxStore } from "@openlup/outbox";
import { describe, expect, it, vi } from "vitest";

import { KNOWN_OUTBOX_EVENT_TYPES } from "../../../src/lib/outboxKnownEventTypes.js";
import { PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE } from "../../../src/lib/personalizationDeclensionOutboxContract.js";
import { createRetiredOutboxEventHandlers, RETIRED_OUTBOX_EVENT_REASON, RETIRED_OUTBOX_EVENT_TYPES } from "./retiredEventHandlers.js";

const config = {
  batchSize: 10, visibilitySeconds: 300, maxAttempts: 8, softBudgetMs: 10_000, backoffBaseSeconds: 30,
  backoffCapSeconds: 3600, snoozeSeconds: 300, maxSnoozes: 3,
} as Parameters<typeof runOutboxDispatchWorker>[0]["config"];

function row(): OutboxEventRow {
  return {
    id: "event-1", aggregate_type: "client", aggregate_id: "client-1",
    event_type: PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE, idempotency_key: "client-1:hash",
    payload: { clientId: "client-1", inputHash: "hash" }, metadata: { claimToken: "claim-1" },
    status: "processing", attempts: 1, available_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(),
  } as unknown as OutboxEventRow;
}

describe("retired outbox event types", () => {
  it("stay known, so a pending row never blocks its aggregate", () => {
    for (const eventType of RETIRED_OUTBOX_EVENT_TYPES) expect(KNOWN_OUTBOX_EVENT_TYPES).toContain(eventType);
  });

  it("are discarded once, benign and with the retirement reason, never retried or processed", async () => {
    let claims = 0;
    const store: OutboxStore = {
      claimBatch: vi.fn(async () => (claims++ === 0 ? [row()] : [])),
      markProcessed: vi.fn(async () => ({ applied: true })),
      markFailed: vi.fn(async () => ({ status: "discarded" as const })),
      releaseUnprocessed: vi.fn(async () => 0),
    };
    const result = await runOutboxDispatchWorker({ store, registry: uniqueRegistry(createRetiredOutboxEventHandlers()), config,
      knownEventTypes: KNOWN_OUTBOX_EVENT_TYPES });
    expect(store.claimBatch).toHaveBeenCalledWith(expect.objectContaining({ eventTypes: [PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE] }));
    expect(store.markFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      eventId: "event-1", claimToken: "claim-1", outcome: "discard",
      error: `${RETIRED_OUTBOX_EVENT_REASON}:${PERSONALIZATION_DECLENSION_REQUESTED_EVENT_TYPE}`,
    }));
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, retried: 0, discarded: 1 });
  });
});
