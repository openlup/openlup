import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { AdminInventoryRuntimeBinding } from "../../../runtime/inventory/adminInventoryBinding.js";
import { createAdminInventoryReservationsRouteHandler } from "./reservations.js";

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
      listReservations: vi.fn().mockResolvedValue({
        contractVersion: "inventory.v0",
        reservations: [],
        totalCount: 0,
        page: 2,
        pageSize: 10,
      }),
      forecastSubscriptions: vi.fn(),
      checkAtp: vi.fn(),
    },
    mutationPort: { adjustStock: vi.fn() },
    authorizeAdmin: vi.fn().mockResolvedValue({ ok: true, userId: "admin-1" }),
    mutationsEnabled: () => true,
    ...overrides,
  };
}

describe("inventory reservations BFF route", () => {
  it("fails closed with 503 when no inventory runtime binding is configured", async () => {
    const out = makeRes();
    await createAdminInventoryReservationsRouteHandler(() => null)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("rejects unauthorized callers without invoking readPort.listReservations", async () => {
    const binding = makeBinding({
      authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED", message: "Missing token" }),
    });
    const out = makeRes();
    await createAdminInventoryReservationsRouteHandler(() => binding)(makeReq("GET"), out.res);
    expect(out.statusCode).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(binding.readPort.listReservations).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods with 405", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryReservationsRouteHandler(() => binding)(makeReq("POST"), out.res);
    expect(out.statusCode).toBe(405);
    expect(binding.readPort.listReservations).not.toHaveBeenCalled();
  });

  it("delegates GET pagination query parameters to readPort.listReservations", async () => {
    const binding = makeBinding();
    const out = makeRes();
    await createAdminInventoryReservationsRouteHandler(() => binding)(
      makeReq("GET", { page: "2", pageSize: "10" }),
      out.res,
    );
    expect(out.statusCode).toBe(200);
    expect(binding.readPort.listReservations).toHaveBeenCalledWith(expect.objectContaining({
      page: 2,
      pageSize: 10,
    }));
    expect(out.body).toMatchObject({ ok: true, data: { reservations: [], page: 2, pageSize: 10 } });
  });

  it("keeps direct database client access out of the BFF route module", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/reservations.ts"),
      "utf8",
    );
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
