import { describe, expect, it } from "vitest";
import { calculateInventoryAtp, availableNow } from "./atp.js";
import { INVENTORY_CONTRACT_VERSION, type InventoryAtpRequest, type InventoryStockLine } from "./contracts.js";

const skuId = "11111111-1111-4111-8111-111111111111";
const otherSkuId = "11111111-1111-4111-8111-111111111112";
const locationId = "22222222-2222-4222-8222-222222222222";
const otherLocationId = "22222222-2222-4222-8222-222222222223";

describe("inventory ATP engine", () => {
  it("calculates available stock without counting incoming supply", () => {
    expect(availableNow(stock({ onHand: 20, reserved: 3, unavailable: 2, safetyStock: 4 }))).toBe(11);
  });

  it("fulfills an order from one active location using FEFO lots", () => {
    const result = calculateInventoryAtp({
      request: request(10),
      stock: [
        stock({ onHand: 4, lotId: "33333333-3333-4333-8333-333333333331", lotCode: "late", expiresAt: "2026-07-05T10:00:00+00:00" }),
        stock({ onHand: 8, lotId: "33333333-3333-4333-8333-333333333332", lotCode: "early", expiresAt: "2026-06-20T10:00:00+00:00" }),
      ],
    });

    expect(result.status).toBe("fulfillable");
    expect(result.lines[0].allocations.map((allocation) => allocation.lotCode)).toEqual(["early", "late"]);
    expect(result.lines[0].allocations.map((allocation) => allocation.quantity)).toEqual([8, 2]);
  });

  it("excludes expired and quarantined lots from ATP", () => {
    const result = calculateInventoryAtp({
      request: request(1),
      stock: [
        stock({ onHand: 10, expiresAt: "2026-06-01T10:00:00+00:00" }),
        stock({ onHand: 10, lotStatus: "quarantined" }),
      ],
    });

    expect(result.status).toBe("insufficient");
    expect(result.reason).toBe("insufficient_available_stock");
  });

  it("excludes lots that do not satisfy the minimum shelf-life policy", () => {
    const result = calculateInventoryAtp({
      request: { ...request(1), minShelfLifeDays: 21 },
      stock: [
        stock({ onHand: 10, lotCode: "short", expiresAt: "2026-06-20T10:00:00+00:00" }),
        stock({ onHand: 10, lotCode: "safe", expiresAt: "2026-07-05T10:00:00+00:00" }),
      ],
    });

    expect(result.status).toBe("fulfillable");
    expect(result.lines[0].allocations.map((allocation) => allocation.lotCode)).toEqual(["safe"]);
  });

  it("returns unsupported when caller asks for split shipment support", () => {
    const result = calculateInventoryAtp({
      request: { ...request(1), noSplitShipment: false },
      stock: [stock({ onHand: 10 })],
    });

    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("split_shipment_unsupported");
  });

  it("blocks when only incoming supply could satisfy the request", () => {
    const result = calculateInventoryAtp({
      request: request(1),
      stock: [stock({ onHand: 0, incoming: 99 })],
    });

    expect(result.status).toBe("insufficient");
  });

  it("returns review_required when stock exists only by splitting fulfillment locations", () => {
    const result = calculateInventoryAtp({
      request: request(10),
      stock: [
        stock({ onHand: 5 }),
        stock({ onHand: 5, locationId: otherLocationId, locationCode: "pl-3pl" }),
      ],
    });

    expect(result.status).toBe("review_required");
    expect(result.reason).toBe("stock_available_only_with_split_shipment");
  });

  it("requires every SKU in a multi-line request to fit the same location", () => {
    const result = calculateInventoryAtp({
      request: {
        ...request(1),
        lines: [
          { skuId, sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 },
          { skuId: otherSkuId, sku: "OPENLUP-DOG-BEEF-CAN-400G", quantity: 1 },
        ],
      },
      stock: [
        stock({ onHand: 1 }),
        stock({ skuId: otherSkuId, sku: "OPENLUP-DOG-BEEF-CAN-400G", onHand: 1, locationId: otherLocationId, locationCode: "pl-3pl" }),
      ],
    });

    expect(result.status).toBe("review_required");
  });
});

function request(quantity: number): InventoryAtpRequest {
  return {
    contractVersion: INVENTORY_CONTRACT_VERSION,
    orderMode: "one_time",
    region: "PL",
    noSplitShipment: true,
    requestedAt: "2026-06-05T10:00:00+00:00",
    lines: [{ skuId, sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity }],
  };
}

function stock(overrides: Partial<InventoryStockLine> = {}): InventoryStockLine {
  return {
    skuId,
    sku: "OPENLUP-DOG-LAMB-CAN-400G",
    locationId,
    locationCode: "pl-main",
    locationKind: "internal_warehouse",
    locationStatus: "active",
    fulfillable: true,
    lotId: null,
    lotCode: null,
    lotStatus: "available",
    expiresAt: "2026-07-05T10:00:00+00:00",
    onHand: 20,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safetyStock: 0,
    ...overrides,
  };
}
