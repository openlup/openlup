import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import routeHandler from "./record-tracking-event.js";

const ENV_KEYS = ["SUPABASE_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("admin fulfillment record tracking event route boundary", () => {
  it("uses the fulfillment gateway instead of direct service-role port construction", () => {
    const source = read("server/bff/admin/fulfillment/commerce-orders/record-tracking-event.ts");

    expect(source).toContain("createSupabaseAdminCommerceFulfillmentGateway");
    expect(source).toContain("gateway.mutationPort");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toContain("createSupabaseCommerceFulfillmentPort");
  });

  it("returns an error envelope when Supabase env is absent", async () => {
    const res = response();
    await routeHandler(
      { method: "POST", body: {}, query: {}, headers: {} } as unknown as VercelRequest,
      res,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
