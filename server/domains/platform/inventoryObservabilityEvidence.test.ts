import { describe, expect, it } from "vitest";
import { summarizeReservedBalanceDrift } from "./inventoryObservabilityEvidence.js";

const now = new Date("2026-06-06T10:00:00.000Z");

describe("reserved balance drift evidence", () => {
  it("reports drift when the balance counts an expired lease", () => {
    const result = summarizeReservedBalanceDrift(
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, reserved: 23 }],
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, quantity: 23, expires_at: "2026-06-06T08:00:00.000Z" }],
      now,
    );
    expect(result.reservedBalanceDriftCount).toBe(1);
    expect(result.reservedBalanceDriftEvidence).toEqual([
      { skuId: "sku-1", locationId: "loc-1", lotKey: null, balanceReserved: 23, activeReserved: 0, drift: 23 },
    ]);
  });

  it("treats NULL-expiry (paid/pinned) leases as active — no drift", () => {
    const result = summarizeReservedBalanceDrift(
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, reserved: 5 }],
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, quantity: 5, expires_at: null }],
      now,
    );
    expect(result.reservedBalanceDriftCount).toBe(0);
    expect(result.reservedBalanceDriftEvidence).toEqual([]);
  });

  it("compares per (sku, location, lot) and sums live leases within a slot", () => {
    const result = summarizeReservedBalanceDrift(
      [
        { sku_id: "sku-1", location_id: "loc-1", lot_key: "lot-a", reserved: 8 },
        { sku_id: "sku-1", location_id: "loc-2", lot_key: "lot-a", reserved: 4 },
      ],
      [
        { sku_id: "sku-1", location_id: "loc-1", lot_key: "lot-a", quantity: 3, expires_at: null },
        { sku_id: "sku-1", location_id: "loc-1", lot_key: "lot-a", quantity: 5, expires_at: "2026-06-06T12:00:00.000Z" },
        // Different location — must not leak into loc-1's slot.
        { sku_id: "sku-1", location_id: "loc-2", lot_key: "lot-a", quantity: 1, expires_at: null },
      ],
      now,
    );
    expect(result.reservedBalanceDriftEvidence).toEqual([
      { skuId: "sku-1", locationId: "loc-2", lotKey: "lot-a", balanceReserved: 4, activeReserved: 1, drift: 3 },
    ]);
  });

  it("reports negative drift when the balance under-counts live leases", () => {
    const result = summarizeReservedBalanceDrift(
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, reserved: 2 }],
      [{ sku_id: "sku-1", location_id: "loc-1", lot_key: null, quantity: 7, expires_at: null }],
      now,
    );
    expect(result.reservedBalanceDriftEvidence).toEqual([
      { skuId: "sku-1", locationId: "loc-1", lotKey: null, balanceReserved: 2, activeReserved: 7, drift: -5 },
    ]);
  });

  it("caps evidence samples at 10 while counting all drifted slots", () => {
    const balances = Array.from({ length: 12 }, (_, index) => ({
      sku_id: `sku-${index}`,
      location_id: "loc-1",
      lot_key: null,
      reserved: 1,
    }));
    const result = summarizeReservedBalanceDrift(balances, [], now);
    expect(result.reservedBalanceDriftCount).toBe(12);
    expect(result.reservedBalanceDriftEvidence).toHaveLength(10);
  });
});
