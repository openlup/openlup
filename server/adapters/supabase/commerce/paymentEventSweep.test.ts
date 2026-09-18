import { describe, expect, it, vi } from "vitest";
import { createSupabasePaymentEventSweepPort } from "./paymentEventSweep.js";

describe("createSupabasePaymentEventSweepPort", () => {
  it("calls the orphan payment event sweep RPC and maps both counts", async () => {
    const rpc = vi.fn(async () => ({
      data: { orphanEventSweep: { eventsIgnored: 7, staleSetupReceived: 2 } },
      error: null,
    }));

    await expect(createSupabasePaymentEventSweepPort({ rpc }).sweep({
      now: "2026-06-28T00:00:00.000Z",
      graceMinutes: 120,
      limit: 200,
    })).resolves.toEqual({ eventsIgnored: 7, staleSetupReceived: 2 });

    expect(rpc).toHaveBeenCalledWith("commerce_sweep_orphan_payment_events", {
      p_idempotency_prefix: "commerce-payment-event-sweep-run",
      p_now: "2026-06-28T00:00:00.000Z",
      p_grace_minutes: 120,
      p_limit: 200,
    });
  });

  it("defaults missing counts to zero and throws RPC errors", async () => {
    await expect(createSupabasePaymentEventSweepPort({
      rpc: vi.fn(async () => ({ data: {}, error: null })),
    }).sweep({ now: "now", graceMinutes: 1, limit: 2 })).resolves.toEqual({
      eventsIgnored: 0,
      staleSetupReceived: 0,
    });

    // A pre-fix DB whose sweep RPC does not report the field yet.
    await expect(createSupabasePaymentEventSweepPort({
      rpc: vi.fn(async () => ({ data: { orphanEventSweep: { eventsIgnored: 3 } }, error: null })),
    }).sweep({ now: "now", graceMinutes: 1, limit: 2 })).resolves.toEqual({
      eventsIgnored: 3,
      staleSetupReceived: 0,
    });

    await expect(createSupabasePaymentEventSweepPort({
      rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
    }).sweep({ now: "now", graceMinutes: 1, limit: 2 })).rejects.toThrow("rpc_sweep: boom");
  });
});
