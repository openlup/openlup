/**
 * Companion test for the admin-commerce catalog composition root.
 *
 * Drives BOTH branches of composeAdminCatalog and pins the load-bearing
 * env-null response bytes (code + message) that the per-route smoke tests do
 * NOT assert — this is the single oracle that protects the message constant
 * now owned by the helper instead of duplicated at 12 call-sites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { composeAdminCatalog } from "./_compose.js";

const SUPABASE_ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function request(authorization?: string): VercelRequest {
  return {
    method: "GET",
    query: {},
    headers: authorization ? { authorization } : {},
  } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("composeAdminCatalog", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SUPABASE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SUPABASE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns null and sends UPSTREAM_UNAVAILABLE / 'Admin catalog is not configured' when the env is missing", () => {
    const res = createResponse();

    const result = composeAdminCatalog(request(), res);

    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Admin catalog is not configured",
      },
    });
  });

  it("returns the access token + auth/service clients when the env is present", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const res = createResponse();

    const result = composeAdminCatalog(request("Bearer test-token-123"), res);

    expect(res.json).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("test-token-123");
    expect(result?.authClient).toBeTruthy();
    expect(result?.serviceClient).toBeTruthy();
    expect(result?.authClient).not.toBe(result?.serviceClient);
  });
});
