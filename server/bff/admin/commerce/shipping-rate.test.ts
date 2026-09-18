import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import handler from "./shipping-rate.js";

const ENV_KEYS = ["SUPABASE_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function request(): VercelRequest {
  return { method: "GET", body: {}, query: {}, headers: {} } as unknown as VercelRequest;
}
function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("admin commerce shipping rate BFF route", () => {
  it("exports an observed route handler", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("returns an error envelope when Supabase env is absent", async () => {
    const res = response();
    await handler(request(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});
