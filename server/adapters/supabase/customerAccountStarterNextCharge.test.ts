import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { nextCharge, readStarterNextCharges } from "./customerAccountStarterNextCharge.js";

const SUB = "00000000-0000-4000-8000-0000000000a1";
const NEXT = "2026-09-30T10:00:00+00:00";

/** Worked example: band 20 100, list 22 350, delivery 2 frozen at 14 528 (65% of list, rounded up). */
const MARKER = {
  schemaVersion: "1",
  starterIntervalDays: 7,
  basisTemplateVersion: 1,
  delivery2: { discountBps: 3500, discountMinor: 5572, basisSubtotalMinor: 20100 },
  graduation: {
    cadenceDays: 14,
    lines: [
      {
        sku: "VEL-BEEF-01",
        qty: 33,
        sortOrder: 0,
        isAddon: false,
        quoteLine: { lineSubtotalGross: { amountMinor: 44220, currency: "EUR" } },
      },
    ],
  },
};

const RECURRING = {
  subtotalGross: { amountMinor: 20100, currency: "EUR" },
  totalGross: { amountMinor: 20100, currency: "EUR" },
  currency: "EUR",
  source: "frozen_quote_line",
} as const;

function row(over: Record<string, unknown> = {}) {
  return { id: SUB, starter_pack: MARKER, template_version: 1, cadence_days: 7, next_cycle_at: NEXT, ...over };
}

function client(tables: Record<string, unknown[]>) {
  // `in(...)` is awaited directly for the lines and continued with `order(...)`
  // for the cycles, so the stub is a thenable that also carries `order`.
  const from = vi.fn((table: string) => ({
    select: () => ({
      in: () => {
        const result = { data: tables[table] ?? [], error: null };
        return { order: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
      },
    }),
  }));
  return { from, client: { from } as unknown as SupabaseClient };
}

const PAID_CYCLE_1 = { subscription_id: SUB, cycle_number: 1, status: "paid" };
const LINE = {
  subscription_id: SUB,
  line_metadata: {
    productSnapshot: {
      quoteLine: {
        lineSubtotalGross: { amountMinor: 20100, currency: "EUR" },
        pricingComponents: [{ componentType: "base_unit", amountMinor: 22350 }],
      },
    },
  },
};

describe("readStarterNextCharges + nextCharge", () => {
  it("costs no query for an account without a starter subscription", async () => {
    const { client: db, from } = client({});
    const map = await readStarterNextCharges(db, [row({ starter_pack: null })]);
    expect(map.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
    expect(nextCharge(RECURRING, undefined)).toEqual({ totalGross: RECURRING.totalGross, starterStage: null });
  });

  it("shows delivery 2 at the frozen 65% of list, not the regular band price (moved date, unchanged package)", async () => {
    const { client: db } = client({ subscription_cycles: [PAID_CYCLE_1], subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row()]);
    expect(nextCharge(RECURRING, map.get(SUB))).toEqual({
      totalGross: { amountMinor: 14528, currency: "EUR" },
      starterStage: "delivery2",
    });
  });

  it("keeps the frozen delivery-2 amount after a win-back reactivation bumped the template version", async () => {
    const { client: db } = client({ subscription_cycles: [PAID_CYCLE_1], subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row({ template_version: 2 })]);
    expect(nextCharge(RECURRING, map.get(SUB))?.totalGross.amountMinor).toBe(14528);
  });

  it("shows the graduation at the frozen steady package", async () => {
    const cycles = [PAID_CYCLE_1, { subscription_id: SUB, cycle_number: 2, status: "paid" }];
    const { client: db } = client({ subscription_cycles: cycles, subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row()]);
    expect(nextCharge(RECURRING, map.get(SUB))).toEqual({
      totalGross: { amountMinor: 44220, currency: "EUR" },
      starterStage: "graduation",
    });
  });

  it("keeps the retried cycle's own number, as the engine does", async () => {
    // Cycle 2 declined and waits for its retry: it is still delivery 2.
    const cycles = [PAID_CYCLE_1, { subscription_id: SUB, cycle_number: 2, status: "retry_scheduled" }];
    const { client: db } = client({ subscription_cycles: cycles, subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row()]);
    expect(nextCharge(RECURRING, map.get(SUB))?.starterStage).toBe("delivery2");
  });

  it("states no next charge when the reads fail, never breaking the page", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    const map = await readStarterNextCharges({ from } as unknown as SupabaseClient, [row()]);
    // Without the cycle and line evidence the engine's amount is unknown.
    expect(nextCharge(RECURRING, map.get(SUB))).toBeNull();
  });

  it("states a declined delivery 2 at the discount its retry keeps", async () => {
    // The first attempt stored 7 035 under an earlier rule; the retry charges 13 065.
    const cycles = [
      PAID_CYCLE_1,
      {
        subscription_id: SUB,
        cycle_number: 2,
        status: "retry_scheduled",
        pricing_snapshot: {
          provenance: { starterPack: { reasonCode: "starter_pack_delivery_2", discountMinor: 7035, basisTemplateVersion: 1 } },
        },
      },
    ];
    const { client: db } = client({ subscription_cycles: cycles, subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row({ template_version: 2 })]);
    expect(nextCharge(RECURRING, map.get(SUB))).toEqual({
      totalGross: { amountMinor: 13065, currency: "EUR" },
      starterStage: "delivery2",
    });
  });

  it("states no starter charge for a cancelled subscription", async () => {
    const { client: db, from } = client({ subscription_cycles: [PAID_CYCLE_1], subscription_lines: [LINE] });
    const map = await readStarterNextCharges(db, [row({ status: "cancelled" })]);
    expect(map.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("states no next charge when the lines read fails, instead of the regular price", async () => {
    const from = vi.fn((table: string) => ({
      select: () => ({
        in: () => {
          const result = table === "subscription_lines"
            ? { data: null, error: { message: "boom" } }
            : { data: [PAID_CYCLE_1], error: null };
          return { order: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
        },
      }),
    }));
    const map = await readStarterNextCharges({ from } as unknown as SupabaseClient, [row()]);
    // With both reads succeeding the same fixture would state 14 528 (delivery 2).
    expect(nextCharge(RECURRING, map.get(SUB))).toBeNull();
  });

  it("is null when the lines are unpriced", () => {
    expect(nextCharge(null, undefined)).toBeNull();
  });
});
