import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import route from "./order-ops.js";

function mockRes() {
  const out: { statusCode: number; body: Record<string, unknown> } = { statusCode: 200, body: {} };
  const res = {
    setHeader() {},
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      out.body = body;
    },
  };
  return { res: res as unknown as VercelResponse, out };
}

function req(method: string): VercelRequest {
  return { method, headers: {}, query: {} } as unknown as VercelRequest;
}

describe("/api/bff/admin/channels/order-ops route", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("fails closed when the admin data environment is not configured", async () => {
    const { res, out } = mockRes();
    await route(req("GET"), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("stays fail-closed on a write method", async () => {
    const { res, out } = mockRes();
    await route(req("POST"), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });
});
