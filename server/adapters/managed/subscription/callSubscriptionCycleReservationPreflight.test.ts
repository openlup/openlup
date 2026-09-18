import { describe, expect, it, vi } from "vitest";
import { callSubscriptionCycleReservationPreflight } from "./callSubscriptionCycleReservationPreflight.js";

function client(response: { data: unknown; error: { message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(response);
  return { rpc };
}

describe("callSubscriptionCycleReservationPreflight", () => {
  it("maps a passing preflight with re-acquired holds", async () => {
    const c = client({ data: { ok: true, itemsChecked: 2, reacquired: 1 }, error: null });
    const result = await callSubscriptionCycleReservationPreflight(c, {
      orderId: "order-1",
      now: "2026-07-07T10:00:00.000Z",
    });
    expect(result).toEqual({ ok: true, reason: null, itemsChecked: 2, reacquired: 1 });
    expect(c.rpc).toHaveBeenCalledWith("subscription_cycle_reservation_preflight", {
      p_order_id: "order-1",
      p_now: "2026-07-07T10:00:00.000Z",
    });
  });

  it("maps a fail-closed block with its ledger reason", async () => {
    const c = client({
      data: { ok: false, reason: "reservation_preflight_blocked", detail: "inventory_insufficient", skuId: "sku-1" },
      error: null,
    });
    const result = await callSubscriptionCycleReservationPreflight(c, { orderId: "order-1", now: "2026-07-07T10:00:00.000Z" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reservation_preflight_blocked");
  });

  it("throws loudly on rpc transport errors (no silent charge path)", async () => {
    const c = client({ data: null, error: { message: "boom" } });
    await expect(
      callSubscriptionCycleReservationPreflight(c, { orderId: "order-1", now: "2026-07-07T10:00:00.000Z" }),
    ).rejects.toThrow("rpc_reservation_preflight: boom");
  });

  it("treats a malformed response as a block, never a pass", async () => {
    const c = client({ data: {}, error: null });
    const result = await callSubscriptionCycleReservationPreflight(c, { orderId: "order-1", now: "2026-07-07T10:00:00.000Z" });
    expect(result.ok).toBe(false);
  });
});
