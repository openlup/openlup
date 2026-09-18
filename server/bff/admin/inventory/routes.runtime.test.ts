import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventoryAtpCheckRouteHandler } from "./atp-check.js";
import { createAdminInventoryReservationsRouteHandler } from "./reservations.js";
import { createAdminInventoryStockAdjustmentRouteHandler } from "./stock-adjustment.js";
import { createAdminInventoryStockRouteHandler } from "./stock.js";
import { createAdminInventorySubscriptionForecastRouteHandler } from "./subscription-forecast.js";

const SKU_ID = "00000000-0000-4000-8000-000000000001";
const LOCATION_ID = "00000000-0000-4000-8000-000000000002";

describe("bundle-aware admin inventory routes", () => {
  it("executes every mounted route against the selected runtime binding", async () => {
    const readPort = {
      listStock: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0", stock: [], totalCount: 0, page: 1, pageSize: 25,
      }),
      listReservations: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0", reservations: [], totalCount: 0, page: 1, pageSize: 25,
      }),
      checkAtp: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0", status: "fulfillable", reason: null,
        locationId: LOCATION_ID, locationCode: "pl-main", lines: [],
      }),
      forecastSubscriptions: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        generatedAt: "2026-08-14T12:00:00.000Z",
        stockMasterProvider: "omnipack",
        horizonDays: 60,
        protectionDays: 45,
        skus: [],
        totals: {
          activeSubscriptionCount: 0, excludedSubscriptionCount: 0,
          missingProviderStockSkuCount: 0, staleProviderStockSkuCount: 0,
          horizonShortageSkuCount: 0, protectionShortageSkuCount: 0,
          shortageSkuCount: 0, recommendedProductionQty: 0,
        },
      }),
    };
    const mutationPort = {
      adjustStock: vi.fn().mockResolvedValue({ contractVersion: "inventory.v0", replayed: false }),
    };
    const binding: AdminInventoryRuntimeBinding = {
      readPort,
      mutationPort,
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-1" }),
      mutationsEnabled: () => true,
    };
    const resolve = vi.fn(() => binding);

    await createAdminInventoryStockRouteHandler(resolve)(request("GET", {}), response().res);
    await createAdminInventoryReservationsRouteHandler(resolve)(request("GET", {}), response().res);
    await createAdminInventorySubscriptionForecastRouteHandler(resolve)(request("GET", {}), response().res);
    await createAdminInventoryAtpCheckRouteHandler(resolve)(request("POST", {}, {
      contractVersion: "inventory.v0",
      lines: [{ skuId: SKU_ID, sku: "SKU-1", quantity: 1 }],
      requestedAt: "2026-08-14T12:00:00.000Z",
      orderMode: "subscription_cycle",
      region: "PL",
      noSplitShipment: true,
      minShelfLifeDays: 0,
    }), response().res);
    await createAdminInventoryStockAdjustmentRouteHandler(resolve)(request("POST", {}, {
      idempotencyKey: "renewal-cycle-1",
      skuId: SKU_ID,
      locationId: LOCATION_ID,
      quantityDelta: 2,
      reason: "renewal_readback_test",
    }), response().res);

    expect(readPort.listStock).toHaveBeenCalledOnce();
    expect(readPort.listReservations).toHaveBeenCalledOnce();
    expect(readPort.forecastSubscriptions).toHaveBeenCalledOnce();
    expect(readPort.checkAtp).toHaveBeenCalledWith(expect.objectContaining({ orderMode: "subscription_cycle" }));
    expect(mutationPort.adjustStock).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "admin-1" }));
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("fails closed when the active bundle has no inventory runtime", async () => {
    const output = response();
    await createAdminInventoryStockRouteHandler(() => null)(request("GET", {}), output.res);
    expect(output.statusCode).toBe(503);
    expect(output.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });
});

function request(
  method: string,
  query: Record<string, string>,
  body?: unknown,
): VercelRequest {
  return { method, query, body, headers: {} } as unknown as VercelRequest;
}

function response(): {
  res: VercelResponse;
  statusCode: number;
  body: unknown;
} {
  const output = {
    statusCode: 200,
    body: undefined as unknown,
    res: undefined as unknown as VercelResponse,
  };
  const res = {
    status(code: number) { output.statusCode = code; return res; },
    json(body: unknown) { output.body = body; return res; },
    setHeader() {},
  } as unknown as VercelResponse;
  output.res = res;
  return output;
}
