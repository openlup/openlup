import { describe, expect, it, vi } from "vitest";
import type { OutboxEventRow } from "../../domains/commerce/outboxDispatchContracts.js";
import {
  createManagedOutboxQueueDiagnostics,
  createManagedOutboxStore,
} from "./outboxStore.js";

function rpcClient(
  results: Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
  pendingEventIds: string[] = [],
) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    is: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: pendingEventIds.map((id) => ({ id })), error: null })),
  };
  return {
    query,
    rpc: vi.fn(async (name: string) => results[name] ?? { data: null, error: null }),
    from: vi.fn(() => query),
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
    event_type: "commerce.order_draft.created",
    idempotency_key: "key-1",
    status: "processing",
    attempts: 1,
    payload: {},
    error: null,
    metadata: { claimToken: "token-1" },
    ...overrides,
  };
}

describe("managed outbox store adapter", () => {
  it("probes status-authoritative unresolved rows even with a stale processed timestamp", async () => {
    const client = rpcClient({}, ["reward-1"]);
    const store = createManagedOutboxStore(client);

    await expect(store.hasPendingEventType?.("tester.feedback.reward_confirmation")).resolves.toBe(true);
    expect(client.from).toHaveBeenCalledWith("outbox_events");
    expect(client.query.is).not.toHaveBeenCalled();
  });

  it("claims a batch through outbox_claim_batch_v3 with the exact p_* args and maps rows", async () => {
    const rows = [eventRow(), eventRow({ id: "evt-2" })];
    const client = rpcClient({ outbox_claim_batch_v3: { data: rows, error: null } });
    const store = createManagedOutboxStore(client);

    const claimed = await store.claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      knownEventTypes: ["commerce.order_draft.created", "commerce.order.review_request"],
      batchSize: 25,
      visibilitySeconds: 300,
      maxAttempts: 8,
    });

    expect(client.rpc).toHaveBeenCalledWith("outbox_claim_batch_v3", {
      p_event_types: ["commerce.order_draft.created"],
      p_known_event_types: ["commerce.order_draft.created", "commerce.order.review_request"],
      p_batch_size: 25,
      p_visibility_seconds: 300,
      p_max_attempts: 8,
    });
    expect(claimed).toEqual(rows);
  });

  it("claims preview matrix proof rows through the scoped RPC", async () => {
    const rows = [eventRow({ metadata: { claimToken: "token-1", claimScope: "preview_matrix", runId: "run-1" } })];
    const client = rpcClient({ outbox_claim_preview_matrix_batch: { data: rows, error: null } });
    const store = createManagedOutboxStore(client, { previewRunId: "run-1" });

    await expect(store.claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      knownEventTypes: ["commerce.order_draft.created", "commerce.order.review_request"],
      batchSize: 5,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).resolves.toEqual(rows);

    expect(client.rpc).toHaveBeenCalledWith("outbox_claim_preview_matrix_batch", {
      p_run_id: "run-1",
      p_event_types: ["commerce.order_draft.created"],
      p_batch_size: 5,
      p_visibility_seconds: 300,
      p_max_attempts: 8,
    });
    expect(client.rpc).not.toHaveBeenCalledWith("outbox_claim_batch_v3", expect.anything());
  });

  it("returns an empty batch when claim data is null or not an array", async () => {
    const client = rpcClient({ outbox_claim_batch_v3: { data: null, error: null } });
    const store = createManagedOutboxStore(client);
    await expect(store.claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).resolves.toEqual([]);

    const weird = rpcClient({ outbox_claim_batch_v3: { data: { nope: true }, error: null } });
    await expect(createManagedOutboxStore(weird).claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).resolves.toEqual([]);
  });

  it("throws with the rpc name when any rpc errors", async () => {
    const error = { code: "P0001", message: "boom" };
    const client = rpcClient({
      outbox_claim_batch_v3: { data: null, error },
      outbox_mark_processed: { data: null, error },
      outbox_mark_failed: { data: null, error },
      outbox_release_unprocessed: { data: null, error },
      outbox_queue_stats: { data: null, error },
      outbox_claim_preview_matrix_batch: { data: null, error },
    });
    const store = createManagedOutboxStore(client);
    const previewStore = createManagedOutboxStore(client, { previewRunId: "run-1" });
    const diagnostics = createManagedOutboxQueueDiagnostics(client);

    await expect(store.claimBatch({
      eventTypes: ["t"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).rejects.toThrow(/outbox_claim_batch_v3.*boom/);
    await expect(previewStore.claimBatch({
      eventTypes: ["t"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).rejects.toThrow(/outbox_claim_preview_matrix_batch.*boom/);
    await expect(store.markProcessed({ eventId: "e", claimToken: "t" }))
      .rejects.toThrow(/outbox_mark_processed.*boom/);
    await expect(store.markFailed({
      eventId: "e",
      claimToken: "t",
      error: "x",
      outcome: "retry",
      baseDelaySeconds: 60,
      maxDelaySeconds: 3600,
      maxAttempts: 8,
      snoozeSeconds: 300,
    })).rejects.toThrow(/outbox_mark_failed.*boom/);
    await expect(store.releaseUnprocessed([{ eventId: "e", claimToken: "t" }], 0))
      .rejects.toThrow(/outbox_release_unprocessed.*boom/);
    await expect(diagnostics.queueStats()).rejects.toThrow(/outbox_queue_stats.*boom/);
  });

  it("marks processed with the claim token and maps boolean applied", async () => {
    const client = rpcClient({ outbox_mark_processed: { data: true, error: null } });
    const store = createManagedOutboxStore(client);

    await expect(store.markProcessed({
      eventId: "evt-1",
      claimToken: "token-1",
      metadata: { resendId: "re-1" },
    })).resolves.toEqual({ applied: true });
    expect(client.rpc).toHaveBeenCalledWith("outbox_mark_processed", {
      p_event_id: "evt-1",
      p_claim_token: "token-1",
      p_metadata: { resendId: "re-1" },
    });

    const stale = rpcClient({ outbox_mark_processed: { data: false, error: null } });
    await expect(createManagedOutboxStore(stale).markProcessed({
      eventId: "evt-1",
      claimToken: "stale-token",
    })).resolves.toEqual({ applied: false });
    expect(stale.rpc).toHaveBeenCalledWith("outbox_mark_processed", expect.objectContaining({
      p_metadata: {},
    }));
  });

  it("marks failed with all p_* policy args and validates the returned status", async () => {
    const client = rpcClient({ outbox_mark_failed: { data: "snoozed", error: null } });
    const store = createManagedOutboxStore(client);

    await expect(store.markFailed({
      eventId: "evt-1",
      claimToken: "token-1",
      error: "provider down",
      outcome: "snooze",
      baseDelaySeconds: 60,
      maxDelaySeconds: 3600,
      maxAttempts: 8,
      snoozeSeconds: 300,
    })).resolves.toEqual({ status: "snoozed" });
    expect(client.rpc).toHaveBeenCalledWith("outbox_mark_failed", {
      p_event_id: "evt-1",
      p_claim_token: "token-1",
      p_error: "provider down",
      p_outcome: "snooze",
      p_base_delay_seconds: 60,
      p_max_delay_seconds: 3600,
      p_max_attempts: 8,
      p_snooze_seconds: 300,
    });

    for (const status of ["failed", "discarded", "missed"]) {
      const ok = rpcClient({ outbox_mark_failed: { data: status, error: null } });
      await expect(createManagedOutboxStore(ok).markFailed({
        eventId: "e",
        claimToken: "t",
        error: "x",
        outcome: "retry",
        baseDelaySeconds: 60,
        maxDelaySeconds: 3600,
        maxAttempts: 8,
        snoozeSeconds: 300,
      })).resolves.toEqual({ status });
    }
  });

  it("throws on an illegal mark_failed status", async () => {
    const store = createManagedOutboxStore(
      rpcClient({ outbox_mark_failed: { data: "exploded", error: null } }),
    );
    await expect(store.markFailed({
      eventId: "e",
      claimToken: "t",
      error: "x",
      outcome: "retry",
      baseDelaySeconds: 60,
      maxDelaySeconds: 3600,
      maxAttempts: 8,
      snoozeSeconds: 300,
    })).rejects.toThrow(/outbox_mark_failed_unexpected_status.*exploded/);
  });

  it("releases unprocessed rows as paired id/token arrays and returns the count", async () => {
    const client = rpcClient({ outbox_release_unprocessed: { data: 2, error: null } });
    const store = createManagedOutboxStore(client);

    await expect(store.releaseUnprocessed([
      { eventId: "evt-1", claimToken: "token-1" },
      { eventId: "evt-2", claimToken: "token-2" },
    ], 300)).resolves.toBe(2);
    expect(client.rpc).toHaveBeenCalledWith("outbox_release_unprocessed", {
      p_event_ids: ["evt-1", "evt-2"],
      p_claim_tokens: ["token-1", "token-2"],
      p_delay_seconds: 300,
    });
  });

  it("short-circuits an empty release without an rpc call", async () => {
    const client = rpcClient({});
    const store = createManagedOutboxStore(client);
    await expect(store.releaseUnprocessed([], 0)).resolves.toBe(0);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns queue stats as an object and falls back to {} on non-object data", async () => {
    const stats = { pending: 3, oldestClaimableSeconds: 12 };
    const client = rpcClient({ outbox_queue_stats: { data: stats, error: null } });
    const diagnostics = createManagedOutboxQueueDiagnostics(client);
    await expect(diagnostics.queueStats()).resolves.toEqual(stats);
    expect(client.rpc).toHaveBeenCalledWith("outbox_queue_stats", {});

    const weird = rpcClient({ outbox_queue_stats: { data: "n/a", error: null } });
    await expect(createManagedOutboxQueueDiagnostics(weird).queueStats()).resolves.toEqual({});
  });
});
