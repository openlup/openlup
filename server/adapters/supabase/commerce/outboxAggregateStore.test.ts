import { describe, expect, it, vi } from "vitest";
import type { OutboxEventRow } from "../../../domains/commerce/outboxDispatchContracts.js";
import { createSupabaseOutboxAggregateStorePort } from "./outboxAggregateStore.js";

function rpcClient(results: Record<string, { data: unknown; error: { code?: string; message?: string } | null }>) {
  return {
    rpc: vi.fn(async (name: string) => results[name] ?? { data: null, error: null }),
  };
}

function eventRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "evt-1",
    created_at: "2026-06-12T10:00:00Z",
    available_at: "2026-06-12T10:05:00Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "order-1",
    event_type: "commerce.order.paid.email",
    idempotency_key: "key-1",
    status: "processing",
    attempts: 1,
    payload: {},
    error: null,
    metadata: { claimToken: "token-1" },
    ...overrides,
  };
}

describe("supabase aggregate outbox store port", () => {
  it("claims only the requested aggregate through outbox_claim_aggregate_batch", async () => {
    const rows = [eventRow()];
    const client = rpcClient({ outbox_claim_aggregate_batch: { data: rows, error: null } });
    const store = createSupabaseOutboxAggregateStorePort(client, {
      aggregateType: "commerce_order",
      aggregateId: "order-1",
    });

    await expect(store.claimBatch({
      eventTypes: ["commerce.order.paid.email", "subscription.created"],
      knownEventTypes: ["ignored"],
      batchSize: 5,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).resolves.toEqual(rows);

    expect(client.rpc).toHaveBeenCalledWith("outbox_claim_aggregate_batch", {
      p_aggregate_type: "commerce_order",
      p_aggregate_id: "order-1",
      p_event_types: ["commerce.order.paid.email", "subscription.created"],
      p_batch_size: 5,
      p_visibility_seconds: 300,
      p_max_attempts: 8,
    });
  });

  it("uses the same mark/release RPC contracts as the global outbox store", async () => {
    const client = rpcClient({
      outbox_mark_processed: { data: true, error: null },
      outbox_mark_failed: { data: "failed", error: null },
      outbox_release_unprocessed: { data: 1, error: null },
    });
    const store = createSupabaseOutboxAggregateStorePort(client, {
      aggregateType: "commerce_order",
      aggregateId: "order-1",
    });

    await expect(store.markProcessed({ eventId: "evt-1", claimToken: "tok", metadata: { ok: true } }))
      .resolves.toEqual({ applied: true });
    await expect(store.markFailed({
      eventId: "evt-1",
      claimToken: "tok",
      error: "down",
      outcome: "retry",
      baseDelaySeconds: 60,
      maxDelaySeconds: 3600,
      maxAttempts: 8,
      snoozeSeconds: 300,
    })).resolves.toEqual({ status: "failed" });
    await expect(store.releaseUnprocessed([{ eventId: "evt-1", claimToken: "tok" }], 0))
      .resolves.toBe(1);
  });
});
