import { describe, expect, it } from "vitest";
import {
  INVENTORY_CONTRACT_VERSION,
  availableNow,
  calculateInventoryAtp,
  type InventoryAtpRequest,
  type InventoryStockLine,
} from "@openlup/core/inventory";

const skuId = "11111111-1111-4111-8111-111111111111";
const locationId = "22222222-2222-4222-8222-222222222222";

describe("inventory ATP standalone smoke", () => {
  it("allocates neutral stock by available quantity and FEFO order", () => {
    expect(availableNow(stock({ onHand: 20, reserved: 2, unavailable: 3, safetyStock: 4 }))).toBe(11);

    const result = calculateInventoryAtp({
      request: request(6),
      stock: [
        stock({ onHand: 3, lotCode: "later", expiresAt: "2026-08-10T10:00:00+00:00" }),
        stock({ onHand: 4, lotCode: "earlier", expiresAt: "2026-07-10T10:00:00+00:00" }),
      ],
    });

    expect(result.status).toBe("fulfillable");
    expect(result.lines[0].allocations.map((allocation) => allocation.lotCode)).toEqual(["earlier", "later"]);
    expect(result.lines[0].allocations.map((allocation) => allocation.quantity)).toEqual([4, 2]);
  });
});

function request(quantity: number): InventoryAtpRequest {
  return {
    contractVersion: INVENTORY_CONTRACT_VERSION,
    orderMode: "one_time",
    region: "EXAMPLE",
    noSplitShipment: true,
    requestedAt: "2026-07-01T10:00:00+00:00",
    lines: [{ skuId, sku: "CORE-SKU-ALPHA", quantity }],
  };
}

function stock(overrides: Partial<InventoryStockLine> = {}): InventoryStockLine {
  return {
    skuId,
    sku: "CORE-SKU-ALPHA",
    locationId,
    locationCode: "main",
    locationKind: "internal_warehouse",
    locationStatus: "active",
    fulfillable: true,
    lotId: null,
    lotCode: null,
    lotStatus: "available",
    expiresAt: "2026-08-10T10:00:00+00:00",
    onHand: 20,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safetyStock: 0,
    ...overrides,
  };
}
