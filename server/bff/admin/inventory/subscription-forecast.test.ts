import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { inventorySubscriptionForecastResponseSchema } from "../../../../src/domains/inventory/contracts.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventorySubscriptionForecastRouteHandler } from "./subscription-forecast.js";

const STOCK_MASTER_PROVIDER = inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value;

function makeReq(method: string, query: Record<string, string> = {}): VercelRequest {
  return { method, query, headers: {} } as unknown as VercelRequest;
}

function makeRes() {
  const out = { statusCode: 200, body: undefined as unknown, res: undefined as unknown as VercelResponse };
  const res = {
    status(code: number) { out.statusCode = code; return res; },
    json(body: unknown) { out.body = body; return res; },
    setHeader() {},
  } as unknown as VercelResponse;
  out.res = res;
  return out;
}

function makeBinding(overrides?: Partial<AdminInventoryRuntimeBinding>): AdminInventoryRuntimeBinding {
  return {
    readPort: {
      listStock: vi.fn(),
      listReservations: vi.fn(),
      checkAtp: vi.fn(),
      forecastSubscriptions: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        generatedAt: "2030-08-14T12:00:00.000Z",
        stockMasterProvider: STOCK_MASTER_PROVIDER,
        horizonDays: 90,
        protectionDays: 30,
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
      }),
    },
    mutationPort: { adjustStock: vi.fn() },
    authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-1" }),
    mutationsEnabled: () => true,
    ...overrides,
  };
}

describe("inventory subscription forecast BFF route", () => {
  it("fails closed with 503 when no inventory runtime binding is configured", async () => {
    const out = makeRes();
    await createAdminInventorySubscriptionForecastRouteHandler(() => null)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("rejects unauthorized callers without invoking readPort.forecastSubscriptions", async () => {
    const binding = makeBinding({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "Missing token" }),
    });
    const out = makeRes();
    await createAdminInventorySubscriptionForecastRouteHandler(() => binding)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(binding.readPort.forecastSubscriptions).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods with 405", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventorySubscriptionForecastRouteHandler(() => binding)(makeReq("POST"), out.res);
    expect(out.statusCode).toBe(405);
    expect(binding.readPort.forecastSubscriptions).not.toHaveBeenCalled();
  });

  it("delegates GET forecast parameters to readPort.forecastSubscriptions", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventorySubscriptionForecastRouteHandler(() => binding)(
      makeReq("GET", { horizonDays: "90", protectionDays: "30" }),
      out.res,
    );
    expect(out.statusCode).toBe(200);
    expect(binding.readPort.forecastSubscriptions).toHaveBeenCalledWith(expect.objectContaining({
      horizonDays: 90,
      protectionDays: 30,
    }));
    expect(out.body).toMatchObject({ ok: true, data: { horizonDays: 90, protectionDays: 30 } });
  });

  it("keeps direct database client access out of the BFF route module", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/subscription-forecast.ts"),
      "utf8",
    );
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
