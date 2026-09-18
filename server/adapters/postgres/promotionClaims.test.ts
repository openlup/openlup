import { describe, expect, it, vi } from "vitest";

import {
  createPostgresCommercePromoDataPort,
  createPostgresPromotionClaimSweepPort,
} from "./promotionClaims.js";

describe("Postgres promotion claim adapters", () => {
  it("maps neutral evaluator evidence through parameterized public routines", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("active_definitions")) return { rows: [{ result: [{ id: "promo-1" }] }] };
      if (sql.includes("paid_order_counts")) {
        return { rows: [{ result: { oneTime: 2, subscription: 3 } }] };
      }
      if (sql.includes("redemption_counts")) {
        return { rows: [{ promotion_id: "promo-1", global_count: 4, per_customer_count: 1 }] };
      }
      if (sql.includes("device_first_order")) return { rows: [{ result: false }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const port = createPostgresCommercePromoDataPort({ query });

    await expect(port.listActivePromotions()).resolves.toEqual([{ id: "promo-1" }]);
    await expect(port.countPaidOrders("11111111-1111-4111-8111-111111111111"))
      .resolves.toBe(5);
    await expect(port.countPaidOrdersByMode("11111111-1111-4111-8111-111111111111"))
      .resolves.toEqual({ oneTime: 2, subscription: 3 });
    await expect(port.redemptionCounts("11111111-1111-4111-8111-111111111111"))
      .resolves.toEqual(new Map([["promo-1", { global: 4, perCustomer: 1 }]]));
    await expect(port.deviceFirstOrderRedeemed("visitor-1")).resolves.toBe(false);
    expect(query.mock.calls.some(([, values]) =>
      Array.isArray(values) && values.includes("11111111-1111-4111-8111-111111111111")))
      .toBe(true);
  });

  it("maps the bounded sweep and fails closed on malformed evidence", async () => {
    const query = vi.fn(async () => ({
      rows: [{ result: { checked: 5, cancelled: 2, skipped: 3 } }],
    }));
    const sweep = createPostgresPromotionClaimSweepPort({ query });
    await expect(sweep.sweep({
      now: "2026-08-17T12:00:00.000Z", limit: 50,
      claimLeaseMinutes: 15, graceMinutes: 5,
    })).resolves.toEqual({ checked: 5, cancelled: 2, skipped: 3 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("commerce_sweep_stale_promotion_claims"), [
      "2026-08-17T12:00:00.000Z", 50, 15, 5,
    ]);

    const malformed = createPostgresCommercePromoDataPort({
      query: vi.fn(async () => ({ rows: [{ result: { oneTime: -1, subscription: 0 } }] })),
    });
    await expect(malformed.countPaidOrdersByMode("client-1"))
      .rejects.toThrow("promotion_paid_order_counts_invalid_response");
  });
});
