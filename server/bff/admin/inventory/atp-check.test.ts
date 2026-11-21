import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventoryAtpCheckRouteHandler } from "./atp-check.js";

const SKU_ID = "00000000-0000-4000-8000-000000000001";
const LOCATION_ID = "00000000-0000-4000-8000-000000000002";

function makeReq(method: string, body?: unknown): VercelRequest {
  return { method, query: {}, body, headers: {} } as unknown as VercelRequest;
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
      forecastSubscriptions: vi.fn(),
      checkAtp: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        status: "fulfillable",
        reason: null,
        locationId: LOCATION_ID,
        locationCode: "zz-main",
        lines: [],
      }),
    },
    mutationPort: { adjustStock: vi.fn() },
    authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-1" }),
    mutationsEnabled: () => true,
    ...overrides,
  };
}

describe("inventory atp-check BFF route", () => {
  it("fails closed with 503 when no inventory runtime binding is configured", async () => {
    const out = makeRes();
    await createAdminInventoryAtpCheckRouteHandler(() => null, {})(makeReq("POST", {}), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("fails closed with 503 when INVENTORY_REGION is invalid", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryAtpCheckRouteHandler(
      () => binding,
      { INVENTORY_REGION: "" },
    )(makeReq("POST", {}), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(binding.readPort.checkAtp).not.toHaveBeenCalled();
  });

  it("rejects unauthorized callers without invoking readPort.checkAtp", async () => {
    const binding = makeBinding({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin required" }),
    });
    const out = makeRes();
    await createAdminInventoryAtpCheckRouteHandler(() => binding, { INVENTORY_REGION: "ZZ" })(
      makeReq("POST", {
        contractVersion: "inventory.v0",
        lines: [{ skuId: SKU_ID, sku: "SKU-1", quantity: 1 }],
        requestedAt: "2030-08-14T12:00:00.000Z",
        orderMode: "subscription_cycle",
        region: "ZZ",
        noSplitShipment: true,
        minShelfLifeDays: 0,
      }),
      out.res,
    );
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(binding.readPort.checkAtp).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods with 405", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryAtpCheckRouteHandler(() => binding, { INVENTORY_REGION: "ZZ" })(
      makeReq("GET"),
      out.res,
    );
    expect(out.statusCode).toBe(405);
    expect(binding.readPort.checkAtp).not.toHaveBeenCalled();
  });

  it("delegates valid POST payloads with configured region to readPort.checkAtp", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryAtpCheckRouteHandler(() => binding, { INVENTORY_REGION: "ZZ" })(
      makeReq("POST", {
        contractVersion: "inventory.v0",
        lines: [{ skuId: SKU_ID, sku: "SKU-1", quantity: 2 }],
        requestedAt: "2030-08-14T12:00:00.000Z",
        orderMode: "subscription_cycle",
        noSplitShipment: true,
        minShelfLifeDays: 0,
      }),
      out.res,
    );
    expect(out.statusCode).toBe(200);
    expect(binding.readPort.checkAtp).toHaveBeenCalledWith(expect.objectContaining({
      region: "ZZ",
      orderMode: "subscription_cycle",
    }));
    expect(out.body).toMatchObject({ ok: true, data: { status: "fulfillable", locationId: LOCATION_ID } });
  });

  it("keeps direct database client access out of the BFF route module", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/atp-check.ts"),
      "utf8",
    );
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
