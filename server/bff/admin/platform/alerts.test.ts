import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import alertsRoute from "./alerts.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

const SUPABASE_ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
] as const;

const originalEnv: Record<string, string | undefined> = {};

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    end: vi.fn(),
  };
  return res as unknown as VercelResponse & {
    statusCode: number;
    body: { ok: boolean; error?: { code: string; message: string } };
  };
}

beforeEach(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.restoreAllMocks();
});

describe("GET /api/bff/admin/platform/alerts", () => {
  it("is mounted as a route handler", () => {
    expect(alertsRoute).toBeTypeOf("function");
  });

  it("fails closed when Supabase is not configured rather than reporting an empty ledger", async () => {
    const res = mockRes();

    await alertsRoute({ method: "GET", headers: {} } as unknown as VercelRequest, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("INTERNAL");
  });

  it("refuses a caller with no bearer token once the environment is present", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const res = mockRes();

    await alertsRoute({ method: "GET", headers: {} } as unknown as VercelRequest, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("UNAUTHORIZED");
  });
});
