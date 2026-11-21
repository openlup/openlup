import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventoryStockRouteHandler } from "./stock.js";

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
      listStock: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        stock: [],
        totalCount: 0,
        page: 1,
        pageSize: 20,
      }),
      listReservations: vi.fn(),
      forecastSubscriptions: vi.fn(),
      checkAtp: vi.fn(),
    },
    mutationPort: { adjustStock: vi.fn() },
    authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-1" }),
    mutationsEnabled: () => true,
    ...overrides,
  };
}

describe("inventory stock BFF route", () => {
  it("fails closed with 503 when no inventory runtime binding is configured", async () => {
    const out = makeRes();
    await createAdminInventoryStockRouteHandler(() => null)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("rejects unauthorized callers without invoking readPort.listStock", async () => {
    const binding = makeBinding({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "Missing token" }),
    });
    const out = makeRes();
    await createAdminInventoryStockRouteHandler(() => binding)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(binding.readPort.listStock).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods with 405", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryStockRouteHandler(() => binding)(makeReq("POST"), out.res);
    expect(out.statusCode).toBe(405);
    expect(binding.readPort.listStock).not.toHaveBeenCalled();
  });

  it("delegates GET query parameters to readPort.listStock", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryStockRouteHandler(() => binding)(
      makeReq("GET", { page: "1", pageSize: "20" }),
      out.res,
    );
    expect(out.statusCode).toBe(200);
    expect(binding.readPort.listStock).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
    }));
    expect(out.body).toMatchObject({ ok: true, data: { stock: [], page: 1, pageSize: 20 } });
  });

  it("keeps direct database client access out of the BFF route module", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/stock.ts"),
      "utf8",
    );
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
