import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventoryStockAdjustmentRouteHandler } from "./stock-adjustment.js";

const SKU_ID = "00000000-0000-4000-8000-000000000001";
const LOCATION_ID = "00000000-0000-4000-8000-000000000002";

const VALID_BODY = {
  idempotencyKey: "stock-adj-behavioral-1",
  skuId: SKU_ID,
  locationId: LOCATION_ID,
  quantityDelta: 3,
  reason: "cycle_count_reconciliation",
};

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
      checkAtp: vi.fn(),
    },
    mutationPort: {
      adjustStock: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        replayed: false,
      }),
    },
    authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-42" }),
    mutationsEnabled: () => true,
    ...overrides,
  };
}

describe("inventory stock-adjustment BFF route", () => {
  it("fails closed with 503 when no inventory runtime binding is configured", async () => {
    const out = makeRes();
    await createAdminInventoryStockAdjustmentRouteHandler(() => null)(makeReq("POST", VALID_BODY), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("rejects unauthorized callers without invoking mutationPort.adjustStock", async () => {
    const binding = makeBinding({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin required" }),
    });
    const out = makeRes();
    await createAdminInventoryStockAdjustmentRouteHandler(() => binding)(makeReq("POST", VALID_BODY), out.res);
    expect(out.statusCode).toBe(403);
    expect(out.body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(binding.mutationPort.adjustStock).not.toHaveBeenCalled();
  });

  it("fails closed when inventory mutations are disabled", async () => {
    const binding = makeBinding({ mutationsEnabled: () => false });
    const out = makeRes();
    await createAdminInventoryStockAdjustmentRouteHandler(() => binding)(makeReq("POST", VALID_BODY), out.res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
    expect(out.body).toMatchObject({ ok: false });
    expect(binding.mutationPort.adjustStock).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods with 405", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryStockAdjustmentRouteHandler(() => binding)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(405);
    expect(binding.mutationPort.adjustStock).not.toHaveBeenCalled();
  });

  it("delegates valid POST payload with actorUserId to mutationPort.adjustStock", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryStockAdjustmentRouteHandler(() => binding)(makeReq("POST", VALID_BODY), out.res);
    expect(out.statusCode).toBe(200);
    expect(binding.mutationPort.adjustStock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "stock-adj-behavioral-1",
      skuId: SKU_ID,
      locationId: LOCATION_ID,
      quantityDelta: 3,
      actorUserId: "admin-42",
    }));
    expect(out.body).toMatchObject({ ok: true, data: { replayed: false } });
  });

  it("keeps direct database client access out of the BFF route module", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/stock-adjustment.ts"),
      "utf8",
    );
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
