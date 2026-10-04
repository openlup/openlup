import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: mockCreateClient }));

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const ENV_KEYS = [
  "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
  "COMMERCE_CUSTOMER_SELF_SERVICE_ENABLED",
  "COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED",
  "COMMERCE_PSP_RECOVERY_ENABLED",
  "VITE_SUPABASE_URL",
  "SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

describe("POST /api/bff/customers/payment-recovery/start route", () => {
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
    const { default: handler } = await import("./start.js");
    const res = createResponse();

    await handler(request(), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          details: expect.objectContaining({ reason: "feature_flag_disabled" }),
        }),
      }),
    );
  });
  it("public default refuses before constructing any client", async () => {
    unitComposition.enabled = false;
    try {
      const { default: handler } = await import("./start.js");
      const res = createResponse();
      await handler(request(), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false, error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }),
      }));
      expect(mockCreateClient).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});

function request(): VercelRequest {
  return { method: "POST", query: {}, headers: {}, body: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
