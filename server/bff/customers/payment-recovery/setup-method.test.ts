import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

const { mockCreateClient, mockBuildStripeApiClientIfEnabled } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockBuildStripeApiClientIfEnabled: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../../../infra/stripe/buildStripeApiClientIfEnabled.js", () => ({
  buildStripeApiClientIfEnabled: mockBuildStripeApiClientIfEnabled,
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
  "STRIPE_PROVIDER_ENABLED",
  "STRIPE_SECRET_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("payment recovery setup-method BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockReset();
    mockBuildStripeApiClientIfEnabled.mockReset();
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
    const { default: handler } = await import("./setup-method.js");
    const res = createResponse();

    await handler(request(), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("requires service-role env before creating Stripe setup intents", async () => {
    enableRecovery();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.STRIPE_PROVIDER_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    const { default: handler } = await import("./setup-method.js");
    const res = createResponse();

    await handler(request(), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("wires Stripe ensureCustomer for a BLIK-only dunning recovery", async () => {
    enableRecovery();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.STRIPE_PROVIDER_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";

    const ensureCustomer = vi.fn(async () => "cus_new_for_blik");
    const createSetupIntent = vi.fn(async () => ({
      id: "seti_1",
      client_secret: "seti_1_secret",
    }));
    mockBuildStripeApiClientIfEnabled.mockReturnValue({ ensureCustomer, createSetupIntent });
    mockCreateClient
      .mockReturnValueOnce({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
      })
      .mockReturnValueOnce(recoveryServiceClient());

    const { default: handler } = await import("./setup-method.js");
    const res = createResponse();
    await handler(request({
      method: "POST",
      headers: { authorization: "Bearer access-token" },
      body: { idempotencyKey: "recovery-setup-1", recoveryToken: "a".repeat(64) },
    }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ensureCustomer).toHaveBeenCalledWith(
      {
        clientId: "client-1",
        metadata: expect.objectContaining({
          clientId: "client-1",
          source: "payment-recovery.customer",
        }),
      },
      { idempotencyKey: "recovery-customer:client-1" },
    );
    expect(createSetupIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new_for_blik" }),
      { idempotencyKey: "recovery-setup:11111111-1111-4111-8111-111111111111:recovery-setup-1" },
    );
  });
});

function enableRecovery(): void {
  process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
  process.env.COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED = "true";
  process.env.COMMERCE_PSP_RECOVERY_ENABLED = "true";
}

function request(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return { method: "POST", body: {}, query: {}, headers: {}, ...overrides } as unknown as VercelRequest;
}

function recoveryServiceClient() {
  const rows: Record<string, Record<string, unknown> | null> = {
    subscription_payment_recovery_tokens: {
      id: "token-1",
      case_id: "11111111-1111-4111-8111-111111111111",
      client_id: "client-1",
      purpose: "repair_payment",
      expires_at: "2099-01-01T00:00:00.000Z",
      used_at: null,
      revoked_at: null,
    },
    clients: { id: "client-1", auth_user_id: "user-1" },
    subscription_dunning_cases: {
      id: "11111111-1111-4111-8111-111111111111",
      subscription_id: "22222222-2222-4222-8222-222222222222",
      status: "open",
    },
    commerce_payment_method_refs: null,
  };
  return {
    from: vi.fn((table: string) => ({
      select: () => {
        const builder = {
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        };
        return builder;
      },
    })),
    rpc: vi.fn(),
  };
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
