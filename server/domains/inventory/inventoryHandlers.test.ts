import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { INVENTORY_CONTRACT_VERSION, type InventoryStockListResponse } from "../../../src/domains/inventory/contracts.js";
import { InventoryConflictError } from "../../../src/domains/inventory/ports.js";
import {
  createAdminInventoryAtpCheckHandler,
  createAdminInventoryReservationsHandler,
  createAdminInventoryStockAdjustmentHandler,
  createAdminInventoryStockHandler,
  createAdminInventorySubscriptionForecastHandler,
} from "./inventoryHandlers.js";

describe("admin inventory handlers", () => {
  it("returns hidden stock reads through the shared envelope", async () => {
    const res = response();
    const port = { listStock: vi.fn().mockResolvedValue(stockResponse()) };

    await createAdminInventoryStockHandler({
      inventoryPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { page: "1" }), res);

    expect(port.listStock).toHaveBeenCalledWith({ page: 1, pageSize: 25, includeZero: false });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: stockResponse() });
  });

  it("rejects non-admin reads before touching the port", async () => {
    const res = response();
    const port = { listReservations: vi.fn() };

    await createAdminInventoryReservationsHandler({
      inventoryPort: port,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("GET"), res);

    expect(port.listReservations).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns subscription forecast reads without provider calls", async () => {
    const res = response();
    const port = { forecastSubscriptions: vi.fn().mockResolvedValue(subscriptionForecastResponse()) };

    await createAdminInventorySubscriptionForecastHandler({
      inventoryPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { horizonDays: "60", protectionDays: "45" }), res);

    expect(port.forecastSubscriptions).toHaveBeenCalledWith({ horizonDays: 60, protectionDays: 45 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: subscriptionForecastResponse() });
  });

  it("validates subscription forecast protection inside the horizon", async () => {
    const res = response();
    const port = { forecastSubscriptions: vi.fn() };

    await createAdminInventorySubscriptionForecastHandler({
      inventoryPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { horizonDays: "30", protectionDays: "45" }), res);

    expect(port.forecastSubscriptions).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("validates ATP checks before calling the port", async () => {
    const res = response();
    const port = { checkAtp: vi.fn() };

    await createAdminInventoryAtpCheckHandler({
      inventoryPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", { lines: [] }), res);

    expect(port.checkAtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("keeps stock adjustment mutations disabled by default", async () => {
    const res = response();
    const port = { adjustStock: vi.fn() };

    await createAdminInventoryStockAdjustmentHandler({
      inventoryPort: port,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
    })(request("POST", adjustmentRequest()), res);

    expect(port.adjustStock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("maps enabled stock adjustment conflicts to BFF CONFLICT", async () => {
    const res = response();

    await createAdminInventoryStockAdjustmentHandler({
      inventoryPort: {
        adjustStock: vi.fn().mockRejectedValue(new InventoryConflictError("Inventory mutation conflict")),
      },
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", adjustmentRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

function request(method: string, body?: unknown, query: Record<string, unknown> = {}): VercelRequest {
  return { method, body, query, headers: {} } as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function authorize(
  result:
    | { ok: true; userId: string }
    | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } = {
    ok: true,
    userId: "admin-user-1",
  },
) {
  return vi.fn().mockResolvedValue(result);
}

function stockResponse(): InventoryStockListResponse {
  return {
    contractVersion: INVENTORY_CONTRACT_VERSION,
    stock: [{
      skuId: "11111111-1111-4111-8111-111111111111",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      locationId: "22222222-2222-4222-8222-222222222222",
      locationCode: "pl-main",
      locationKind: "internal_warehouse",
      locationStatus: "active",
      fulfillable: true,
      lotId: null,
      lotCode: null,
      lotStatus: null,
      expiresAt: null,
      onHand: 20,
      reserved: 5,
      unavailable: 0,
      incoming: 0,
      safetyStock: 2,
      availableNow: 13,
    }],
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}

function subscriptionForecastResponse() {
  return {
    contractVersion: INVENTORY_CONTRACT_VERSION,
    generatedAt: "2026-06-30T10:00:00+00:00",
    stockMasterProvider: "omnipack",
    horizonDays: 60,
    protectionDays: 45,
    skus: [{
      skuId: "11111111-1111-4111-8111-111111111111",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      providerCurrentForSale: 20,
      providerStockLastSyncedAt: "2026-06-30T09:59:00+00:00",
      providerStockStaleAfter: "2026-06-30T11:59:00+00:00",
      stockStatus: "fresh",
      openHardReservations: 2,
      safetyStock: 3,
      sellableNow: 15,
      activeSubscriptionDemand30: 5,
      activeSubscriptionDemand45: 10,
      activeSubscriptionDemand60: 12,
      plannedSupply: 20,
      coverageDays: null,
      shortageDate: null,
      horizonMissingQty: 0,
      protectionMissingQty: 0,
      missingQty: 0,
      recommendedProductionQty: 0,
    }],
    totals: {
      activeSubscriptionCount: 1,
      excludedSubscriptionCount: 0,
      missingProviderStockSkuCount: 0,
      staleProviderStockSkuCount: 0,
      horizonShortageSkuCount: 0,
      protectionShortageSkuCount: 0,
      shortageSkuCount: 0,
      recommendedProductionQty: 0,
    },
  };
}

function adjustmentRequest() {
  return {
    idempotencyKey: "inventory-adjust-1",
    skuId: "11111111-1111-4111-8111-111111111111",
    locationId: "22222222-2222-4222-8222-222222222222",
    quantityDelta: 10,
    reason: "receipt",
  };
}
