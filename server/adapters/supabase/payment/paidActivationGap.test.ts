import { describe, expect, it, vi } from "vitest";
import { createSupabasePaidActivationGapPort } from "./paidActivationGap.js";

describe("paid activation gap reconciliation port", () => {
  it("maps the bounded scanner result and does not hide RPC failures", async () => {
    const rpc = vi.fn(async () => ({
      data: { paidActivationGapReconciliation: { enqueued: 1, overdue: 2 } },
      error: null,
    }));
    const port = createSupabasePaidActivationGapPort({ rpc, from: vi.fn() } as never);
    await expect(port.reconcile()).resolves.toEqual({ enqueued: 1, overdue: 2 });
    expect(rpc).toHaveBeenCalledWith("subscription_reconcile_paid_activation_gaps", { p_limit: 200 });
  });

  it("throws when the scanner/outbox RPC fails", async () => {
    const port = createSupabasePaidActivationGapPort({
      rpc: vi.fn(async () => ({ data: null, error: { message: "outbox down" } })),
      from: vi.fn(),
    } as never);
    await expect(port.reconcile()).rejects.toThrow("outbox down");
  });
});
