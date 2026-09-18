import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import handler from "./list.js";

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

describe("admin commerce promotions list BFF route", () => {
  it("executes the observed handler and fails closed without managed config", async () => {
    const req = { method: "GET", body: {}, query: {}, headers: {} } as unknown as VercelRequest;
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
    vi.mocked(res.status).mockReturnValue(res);
    vi.mocked(res.json).mockReturnValue(res);

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});
