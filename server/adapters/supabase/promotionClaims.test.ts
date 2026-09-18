import { describe, expect, it, vi } from "vitest";

import {
  createManagedCommercePromoDataPort,
  createManagedPromotionClaimSweepPort,
} from "./promotionClaims.js";

function query(result: { data?: unknown; count?: number | null; error?: unknown }) {
  const value = Promise.resolve({ data: result.data ?? null, count: result.count ?? null, error: result.error ?? null });
  const chain = Object.assign(value, {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
  });
  return chain;
}

describe("managed commerce promo data adapter", () => {
  it("preserves the managed promotion and paid-order query contract", async () => {
    const promotions = query({ data: [{ id: "promo-1" }] });
    const counts = [query({ count: 4 }), query({ count: 2 }), query({ count: 3 })];
    const from = vi.fn((table: string) => table === "promotions" ? promotions : counts.shift()!);
    const rpc = vi.fn(async (name: string) => name.includes("redemption")
      ? { data: [{ promotion_id: "promo-1", global_count: 5, per_customer_count: 1 }], error: null }
      : { data: true, error: null });
    const port = createManagedCommercePromoDataPort({ from, rpc });

    await expect(port.listActivePromotions()).resolves.toEqual([{ id: "promo-1" }]);
    await expect(port.countPaidOrders("client-1")).resolves.toBe(4);
    await expect(port.countPaidOrdersByMode("client-1"))
      .resolves.toEqual({ oneTime: 2, subscription: 3 });
    await expect(port.redemptionCounts("client-1"))
      .resolves.toEqual(new Map([["promo-1", { global: 5, perCustomer: 1 }]]));
    await expect(port.deviceFirstOrderRedeemed("visitor-1")).resolves.toBe(true);
    expect(promotions.select).toHaveBeenCalledWith("*");
    expect(promotions.eq).toHaveBeenCalledWith("status", "active");
    expect(rpc).toHaveBeenCalledWith("commerce_promotion_redemption_counts", { p_client_id: "client-1" });
    expect(rpc).toHaveBeenCalledWith("commerce_device_first_order_redeemed", { p_visitor_id: "visitor-1" });
  });

  it("does not manufacture absent visitor evidence", async () => {
    const rpc = vi.fn();
    const port = createManagedCommercePromoDataPort({ from: vi.fn() as never, rpc });
    await expect(port.deviceFirstOrderRedeemed("  ")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("managed promotion claim sweep port", () => {
  it("pins the bounded lease/grace RPC contract", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { checked: 3, cancelled: 1, skipped: 2 }, error: null,
    });
    await expect(createManagedPromotionClaimSweepPort({ rpc }).sweep({
      now: "2026-07-16T00:00:00.000Z",
      limit: 50,
      claimLeaseMinutes: 15,
      graceMinutes: 5,
    })).resolves.toEqual({ checked: 3, cancelled: 1, skipped: 2 });
    expect(rpc).toHaveBeenCalledWith("commerce_sweep_stale_promotion_claims", {
      p_now: "2026-07-16T00:00:00.000Z",
      p_limit: 50,
      p_claim_lease_minutes: 15,
      p_grace_minutes: 5,
    });
  });

  it("fails closed on malformed responses", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { checked: 1 }, error: null });
    await expect(createManagedPromotionClaimSweepPort({ rpc }).sweep({
      now: "2026-07-16T00:00:00.000Z", limit: 50, claimLeaseMinutes: 15, graceMinutes: 5,
    })).rejects.toThrow("promotion_claim_sweep_invalid_response");
  });
});
