import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const ENV_KEYS = [
  "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
  "COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED",
  "COMMERCE_PSP_RECOVERY_ENABLED",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("payment recovery redeem BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

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
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  it("fails closed before creating Supabase clients while hidden recovery is disabled", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./redeem.js");
    const res = createResponse();

    await handler(request(), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("requires both anon and service-role env after hidden flags are enabled", async () => {
    enableRecovery();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const { default: handler } = await import("./redeem.js");
    const res = createResponse();

    await handler(request(), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function enableRecovery(): void {
  process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
  process.env.COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED = "true";
  process.env.COMMERCE_PSP_RECOVERY_ENABLED = "true";
}

function request(): VercelRequest {
  return { method: "POST", body: {}, query: {}, headers: {} } as unknown as VercelRequest;
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
