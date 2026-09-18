import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseAbandonedCartReminderEnqueuePort,
  createSupabaseCheckoutRecoveryReminderEnqueuePort,
  createSupabaseExpiredCheckoutRecoveryPort,
  createSupabaseOutboxPrunePort,
  type ExpiredCheckoutRecoveryRpcClient,
} from "./checkoutRecoveryOperations.js";
import { ExpiredCheckoutRecoveryConflictError } from "../../domains/commerce/checkoutRecoveryOperations.js";

describe("createSupabaseExpiredCheckoutRecoveryPort", () => {
  it("maps the atomic RPC response and forwards stable identifiers", async () => {
    const rpc = vi.fn(async () => ({
      data: { replacementOrderId: "replacement-1", replayed: true },
      error: null,
    }));
    const port = createSupabaseExpiredCheckoutRecoveryPort({ rpc } as ExpiredCheckoutRecoveryRpcClient);

    await expect(port.prepareReplacement({
      idempotencyKey: "expired-recovery:source-1",
      sourceOrderId: "source-1",
      replacementOrderId: "replacement-1",
    })).resolves.toEqual({ replacementOrderId: "replacement-1", replayed: true });
    expect(rpc).toHaveBeenCalledWith("commerce_prepare_expired_checkout_recovery", {
      p_idempotency_key: "expired-recovery:source-1",
      p_source_order_id: "source-1",
      p_replacement_order_id: "replacement-1",
    });
  });

  it("maps declared recovery conflicts without leaking database details", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "commerce_expired_recovery_order_changed internal detail" },
    }));
    const port = createSupabaseExpiredCheckoutRecoveryPort({ rpc } as ExpiredCheckoutRecoveryRpcClient);

    const error = await port.prepareReplacement({
      idempotencyKey: "key",
      sourceOrderId: "source",
      replacementOrderId: "replacement",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExpiredCheckoutRecoveryConflictError);
    expect((error as ExpiredCheckoutRecoveryConflictError).reason).toBe("order_changed");
  });

  it("fails closed for unknown RPC failures and malformed success payloads", async () => {
    const failedRpc = vi.fn(async () => ({ data: null, error: { details: "network error" } }));
    const failedPort = createSupabaseExpiredCheckoutRecoveryPort(
      { rpc: failedRpc } as ExpiredCheckoutRecoveryRpcClient,
    );
    await expect(failedPort.prepareReplacement({
      idempotencyKey: "key-1",
      sourceOrderId: "source-1",
      replacementOrderId: "replacement-1",
    })).rejects.toThrow("expired_checkout_recovery_rpc_failed");

    const malformedRpc = vi.fn(async () => ({ data: [], error: null }));
    const malformedPort = createSupabaseExpiredCheckoutRecoveryPort(
      { rpc: malformedRpc } as ExpiredCheckoutRecoveryRpcClient,
    );
    await expect(malformedPort.prepareReplacement({
      idempotencyKey: "key-2",
      sourceOrderId: "source-2",
      replacementOrderId: "replacement-2",
    })).rejects.toThrow("expired_checkout_recovery_invalid_response");
  });
});

describe("createSupabaseAbandonedCartReminderEnqueuePort", () => {
  it("maps the abandoned-cart reminder enqueue RPC payload", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { enqueued_1h: 1, enqueued_24h: 2, enqueued_72h: 3 },
      error: null,
    });

    await expect(createSupabaseAbandonedCartReminderEnqueuePort({ rpc }).enqueue(200, "https://prod.example.supabase.co")).resolves.toEqual({
      enqueued1h: 1,
      enqueued24h: 2,
      enqueued72h: 3,
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_abandoned_cart_reminders_from_vercel", {
      p_limit: 200,
      p_runtime_supabase_url: "https://prod.example.supabase.co",
    });
  });

  it("throws sanitized RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(createSupabaseAbandonedCartReminderEnqueuePort({ rpc }).enqueue(10, "https://prod.example.supabase.co")).rejects.toThrow("boom");
  });

  it("surfaces a clone-guard (or other) skip reason instead of discarding it (CJ01-AB)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { enqueued_1h: 0, enqueued_24h: 0, enqueued_72h: 0, skipped: "clone_guard" },
      error: null,
    });

    await expect(createSupabaseAbandonedCartReminderEnqueuePort({ rpc }).enqueue(200, "https://prod.example.supabase.co")).resolves.toEqual({
      enqueued1h: 0,
      enqueued24h: 0,
      enqueued72h: 0,
      skipped: "clone_guard",
    });
  });

  it("omits skipped when the RPC payload doesn't set it", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { enqueued_1h: 0, enqueued_24h: 0, enqueued_72h: 0 },
      error: null,
    });

    const result = await createSupabaseAbandonedCartReminderEnqueuePort({ rpc }).enqueue(200, "https://prod.example.supabase.co");
    expect(result).not.toHaveProperty("skipped");
  });
});

describe("createSupabaseCheckoutRecoveryReminderEnqueuePort", () => {
  it("calls the recovery enqueue RPC and maps wave counts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { enqueued_1h: 2, enqueued_20h: 1 },
      error: null,
    });

    await expect(createSupabaseCheckoutRecoveryReminderEnqueuePort({ rpc }).enqueue(200)).resolves.toEqual({
      enqueued1h: 2,
      enqueued20h: 1,
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_checkout_recovery_reminders", { p_limit: 200 });
  });

  it("defaults malformed counts to zero", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { enqueued_1h: "2", enqueued_20h: Number.NaN },
      error: null,
    });

    await expect(createSupabaseCheckoutRecoveryReminderEnqueuePort({ rpc }).enqueue(200)).resolves.toEqual({
      enqueued1h: 0,
      enqueued20h: 0,
    });
  });

  it("throws bounded RPC messages for the cron error mapper", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "enqueue failed" },
    });

    await expect(createSupabaseCheckoutRecoveryReminderEnqueuePort({ rpc }).enqueue(200)).rejects.toThrow(
      "enqueue failed",
    );
  });
});

describe("createSupabaseOutboxPrunePort", () => {
  it("calls outbox_prune and maps compacted counts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { compacted: 3, processed: 2, discarded: 1 },
      error: null,
    });

    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneOutbox(500)).resolves.toEqual({
      compacted: 3,
      processed: 2,
      discarded: 1,
    });
    expect(rpc).toHaveBeenCalledWith("outbox_prune", { p_limit: 500 });
  });

  it("calls communication_email_deliveries_prune and maps deleted counts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { stale_deleted: 5, orphan_deleted: 2 },
      error: null,
    });

    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneDeliveries(500)).resolves.toEqual({
      ok: true,
      result: { staleDeleted: 5, orphanDeleted: 2 },
    });
    expect(rpc).toHaveBeenCalledWith("communication_email_deliveries_prune", { p_limit: 500 });
  });

  it("defaults malformed payloads to zero counts", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneOutbox(500)).resolves.toEqual({
      compacted: 0,
      processed: 0,
      discarded: 0,
    });
    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneDeliveries(500)).resolves.toEqual({
      ok: true,
      result: { staleDeleted: 0, orphanDeleted: 0 },
    });
  });

  it("throws primary RPC failures for the cron error mapper", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneOutbox(500)).rejects.toThrow("boom");
  });

  it("returns best-effort delivery prune RPC failures for stable cron logging", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "delivery boom" } });

    await expect(createSupabaseOutboxPrunePort({ rpc }).pruneDeliveries(500)).resolves.toEqual({
      ok: false,
      message: "delivery boom",
    });
  });
});
