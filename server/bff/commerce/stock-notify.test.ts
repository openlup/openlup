import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const { mockCreateClient, rpc } = vi.hoisted(() => {
  const rpc = vi.fn();
  return {
    rpc,
    mockCreateClient: vi.fn(() => ({ rpc })),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const ENV_KEYS = [
  "COMMERCE_BACK_IN_STOCK_ENABLED",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("commerce stock-notify BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockClear();
    rpc.mockReset();
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

  it("fails closed before creating a service-role client when the flag is disabled", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./stock-notify.js");
    const res = createResponse();

    await handler(request("POST", validBody()), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Back-in-stock notifications are disabled",
        details: {
          feature: "back_in_stock",
          featureFlag: "COMMERCE_BACK_IN_STOCK_ENABLED",
          reason: "feature_flag_disabled",
        },
      },
      meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
  });

  it("records consent and subscribes on a valid request (happy path)", async () => {
    process.env.COMMERCE_BACK_IN_STOCK_ENABLED = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    rpc
      .mockResolvedValueOnce({ data: { allowed: true, attempts_by_ip: 1, attempts_by_email_sku: 1 }, error: null }) // rate limit
      .mockResolvedValueOnce({ data: "contact-uuid", error: null }) // touch_contact
      .mockResolvedValueOnce({ data: {}, error: null }) // record_permission_event
      .mockResolvedValueOnce({ data: "sub-uuid", error: null }); // subscribe rpc

    const { default: handler } = await import("./stock-notify.js");
    const res = createResponse();

    await handler(request("POST", validBody()), res);

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenNthCalledWith(1, "commerce_record_stock_notify_attempt", expect.objectContaining({
      p_max_per_ip: 20,
      p_max_per_email_sku: 3,
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, "communication_touch_contact", expect.objectContaining({ p_email: "buyer@example.com" }));
    expect(rpc).toHaveBeenNthCalledWith(3, "communication_record_permission_event", expect.objectContaining({
      p_contact_id: "contact-uuid",
      p_purpose: "marketing_newsletter",
      p_state: "granted",
    }));
    expect(rpc).toHaveBeenNthCalledWith(4, "subscribe_product_stock_notification", expect.objectContaining({
      p_sku: "OPENLUP-LAMB-5KG",
      p_email: "buyer@example.com",
      p_contact_id: "contact-uuid",
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("rate-limits before touching consent or subscriptions", async () => {
    process.env.COMMERCE_BACK_IN_STOCK_ENABLED = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    rpc.mockResolvedValueOnce({
      data: { allowed: false, reason: "email_sku_quota", attempts_by_ip: 2, attempts_by_email_sku: 3 },
      error: null,
    });

    const { default: handler } = await import("./stock-notify.js");
    const res = createResponse();

    await handler(request("POST", validBody()), res);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("commerce_record_stock_notify_attempt", expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "RATE_LIMITED",
        details: expect.objectContaining({ reason: "email_sku_quota" }),
      }),
    }));
  });

  it("rejects an invalid body with 400", async () => {
    process.env.COMMERCE_BACK_IN_STOCK_ENABLED = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./stock-notify.js");
    const res = createResponse();

    await handler(request("POST", { sku: "X", email: "not-an-email", marketingConsent: true }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects when marketing consent is not granted", async () => {
    process.env.COMMERCE_BACK_IN_STOCK_ENABLED = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./stock-notify.js");
    const res = createResponse();

    await handler(request("POST", { sku: "OPENLUP-LAMB-5KG", email: "buyer@example.com", marketingConsent: false }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

function validBody() {
  return { sku: "OPENLUP-LAMB-5KG", email: "buyer@example.com", marketingConsent: true, locale: "pl" };
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
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
