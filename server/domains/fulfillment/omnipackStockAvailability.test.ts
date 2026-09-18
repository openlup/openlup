import { describe, expect, it } from "vitest";
import type { InventoryStockLine } from "../../../src/domains/inventory/contracts.js";
import { aggregateAtpCompatibleStock, stockMovementWindow } from "./omnipackStockAvailability.js";

describe("OmniPack stock availability helpers", () => {
  it("aggregates ATP-compatible stock and ignores unusable local inventory", () => {
    const balances = aggregateAtpCompatibleStock([
      stockLine({ onHand: 7, reserved: 1, unavailable: 1, safetyStock: 1 }),
      stockLine({ onHand: 99, fulfillable: false }),
      stockLine({ onHand: 99, locationStatus: "inactive" }),
      stockLine({ onHand: 99, lotStatus: "quarantined" }),
      stockLine({ onHand: 99, expiresAt: "2026-06-09T12:00:00.000Z" }),
    ], new Date("2026-06-10T12:00:00.000Z"));

    expect(balances.get("OPENLUP-BEEF-2KG")).toEqual({
      sku: "OPENLUP-BEEF-2KG",
      onHand: 7,
      reserved: 1,
      unavailable: 1,
      safetyStock: 1,
    });
  });

  it("formats OmniPack movement windows in the provider local date", () => {
    expect(stockMovementWindow({
      lastStockSyncedAt: "2026-06-09T08:00:00.000Z",
      lastMovementOccurredAt: "2026-06-08T22:15:00.000Z",
    }, new Date("2026-06-10T12:00:00.000Z"))).toEqual({
      startLocalDate: "2026-06-09",
      endLocalDate: "2026-06-10",
    });
  });

  it("caps the end date at the UTC calendar date during the Warsaw-ahead-of-UTC window", () => {
    // Incident (nightly 21-23 Jul 2026): between 22:00Z and 00:00Z Warsaw is
    // already on tomorrow's date; OmniPack rejected the future endLocalDate
    // with 400 ERR_DATE_INVALID every night and self-healed at UTC midnight.
    expect(stockMovementWindow({
      lastStockSyncedAt: "2026-07-23T21:00:00.000Z",
      lastMovementOccurredAt: "2026-07-20T17:25:57.330Z",
    }, new Date("2026-07-23T22:00:42.000Z"))).toEqual({
      startLocalDate: "2026-07-20",
      endLocalDate: "2026-07-23",
    });
  });

  it("keeps the Warsaw end date once UTC has caught up after midnight", () => {
    expect(stockMovementWindow({
      lastStockSyncedAt: null,
      lastMovementOccurredAt: "2026-07-22T10:00:00.000Z",
    }, new Date("2026-07-24T00:00:42.000Z"))).toEqual({
      startLocalDate: "2026-07-22",
      endLocalDate: "2026-07-24",
    });
  });

  it("never emits a start after the capped end when the cursor is already on Warsaw's tomorrow", () => {
    expect(stockMovementWindow({
      lastStockSyncedAt: null,
      lastMovementOccurredAt: "2026-07-23T22:30:00.000Z",
    }, new Date("2026-07-23T23:00:42.000Z"))).toEqual({
      startLocalDate: "2026-07-23",
      endLocalDate: "2026-07-23",
    });
  });

  it("falls back to the capped end date for an unparsable cursor timestamp", () => {
    expect(stockMovementWindow({
      lastStockSyncedAt: null,
      lastMovementOccurredAt: "not-a-date",
    }, new Date("2026-07-23T22:00:42.000Z"))).toEqual({
      startLocalDate: "2026-07-23",
      endLocalDate: "2026-07-23",
    });
  });
});

function stockLine(overrides: Partial<InventoryStockLine> = {}): InventoryStockLine {
  return {
    skuId: "11111111-1111-4111-8111-111111111111",
    sku: "OPENLUP-BEEF-2KG",
    locationId: "22222222-2222-4222-8222-222222222222",
    locationCode: "pl-main",
    locationKind: "third_party_logistics",
    locationStatus: "active",
    fulfillable: true,
    lotId: null,
    lotCode: null,
    lotStatus: "available",
    expiresAt: null,
    onHand: 10,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safetyStock: 0,
    ...overrides,
  };
}
