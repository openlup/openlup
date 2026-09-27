import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: mockCreateClient }));

const ENV_KEYS = [
  "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
  "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED",
  "VITE_SUPABASE_URL",
  "SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

describe("/api/bff/customers/profile route", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockReset();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("fails closed before constructing Supabase clients when disabled", async () => {
    const { default: handler } = await import("./profile.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
      }),
    );
  });

  it("fails before clients when required Supabase env is missing", async () => {
    process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
    process.env.COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED = "true";
    const { default: handler } = await import("./profile.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

function request(method: string): VercelRequest {
  return { method, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
