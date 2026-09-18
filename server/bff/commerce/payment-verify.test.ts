import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ mocked: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const ENV_KEYS = [
  "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("commerce payment-verify BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  it("fails closed before creating a service-role client when provider payments are disabled", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./payment-verify.js");
    const res = createResponse();

    await handler(request("POST"), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("responds upstream-unavailable when the service gateway env is missing", async () => {
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    const { default: handler } = await import("./payment-verify.js");
    const res = createResponse();

    await handler(request("POST"), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("rejects non-POST methods without touching the gateway", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    const { default: handler } = await import("./payment-verify.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(405);
  });
});

function request(method: string): VercelRequest {
  return { method, body: {}, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
