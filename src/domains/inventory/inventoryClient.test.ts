import { describe, expect, it, vi } from "vitest";
import {
  checkAdminInventoryAtp,
  createAdminInventoryStockAdjustment,
  getAdminInventoryReservations,
  getAdminInventoryStock,
  getAdminInventorySubscriptionForecast,
} from "./inventoryClient";
import { INVENTORY_CONTRACT_VERSION, type InventoryAtpRequest } from "./contracts";

describe("admin inventory BFF client", () => {
  it("fetches stock with bearer auth", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { contractVersion: INVENTORY_CONTRACT_VERSION, stock: [], totalCount: 0, page: 1, pageSize: 25 },
    }));

    await getAdminInventoryStock("token-1", { page: 1, pageSize: 25, includeZero: true }, { fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/inventory/stock?page=1&pageSize=25&includeZero=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("fetches reservations", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { contractVersion: INVENTORY_CONTRACT_VERSION, reservations: [], totalCount: 0, page: 1, pageSize: 25 },
    }));

    await getAdminInventoryReservations("token-1", { page: 1, pageSize: 25 }, { fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/inventory/reservations?page=1&pageSize=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches subscription forecast with horizon and protection windows", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        generatedAt: "2026-06-30T10:00:00+00:00",
        stockMasterProvider: "omnipack",
        horizonDays: 60,
        protectionDays: 45,
        skus: [],
        totals: {
          activeSubscriptionCount: 0,
          excludedSubscriptionCount: 0,
          missingProviderStockSkuCount: 0,
          staleProviderStockSkuCount: 0,
          horizonShortageSkuCount: 0,
          protectionShortageSkuCount: 0,
          shortageSkuCount: 0,
          recommendedProductionQty: 0,
        },
      },
    }));

    await getAdminInventorySubscriptionForecast("token-1", { horizonDays: 60, protectionDays: 45 }, { fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/inventory/subscription-forecast?horizonDays=60&protectionDays=45",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts ATP checks", async () => {
    const request = atpRequest();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        status: "insufficient",
        reason: "insufficient_available_stock",
        locationId: null,
        locationCode: null,
        lines: [{
          skuId: request.lines[0].skuId,
          sku: request.lines[0].sku,
          requestedQuantity: 1,
          availableQuantity: 0,
          missingQuantity: 1,
          status: "insufficient",
          allocations: [],
        }],
      },
    }));

    await checkAdminInventoryAtp("token-1", request, { fetcher });

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(request);
  });

  it("throws typed BFF errors for disabled mutations", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: "FORBIDDEN", message: "Inventory mutations are not enabled" },
    }, 403));

    await expect(
      createAdminInventoryStockAdjustment("token-1", {
        idempotencyKey: "inventory-adjust-1",
        skuId: "11111111-1111-4111-8111-111111111111",
        locationId: "22222222-2222-4222-8222-222222222222",
        quantityDelta: 1,
        reason: "receipt",
      }, { fetcher }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

function atpRequest(): InventoryAtpRequest {
  return {
    contractVersion: INVENTORY_CONTRACT_VERSION,
    orderMode: "one_time",
    region: "PL",
    noSplitShipment: true,
    requestedAt: "2026-06-05T10:00:00+00:00",
    lines: [{
      skuId: "11111111-1111-4111-8111-111111111111",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      quantity: 1,
    }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
