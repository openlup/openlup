import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

// Re-delivery / idempotency regression for the live Model B awaiting-mandate defect
// (PR #396, docs/evidence/subscription-model-b-20260611/awaiting-mandate-DEFECT/): a
// re-delivered subscription_cycle payment.succeeded used to 500 because the simulator
// re-applied the result (apply_result raises 23505 on the drifted fingerprint) with no
// try/catch. It must now absorb the conflict, still bind the alias mandate, never 500.

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({ rpc: vi.fn() })),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mockCreateClient }));

const ENV_KEYS = [
  "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
  "COMMERCE_PROVIDER_WEBHOOKS_ENABLED",
  "PAYMENTS_TPAY_ENABLED",
  "PAYMENTS_TPAY_SIMULATOR_ENABLED",
  "PAYMENTS_TPAY_SANDBOX_ENABLED",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const PROVIDER_PAYMENT_ID = "tpay_sim_55555555-5555-4555-8555-555555555555";

const INGEST_OK = {
  data: {
    paymentEvent: {
      id: "66666666-6666-4666-8666-666666666666",
      paymentIntentId: "55555555-5555-4555-8555-555555555555",
      paymentAttemptId: "77777777-7777-4777-8777-777777777777",
      replayed: true,
    },
  },
  error: null,
};
const APPLY_CONFLICT = {
  data: null,
  error: { code: "23505", message: "payment_control_result_idempotency_conflict" },
};

describe("Tpay simulator webhook re-delivery idempotency", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({ rpc: vi.fn() }));
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

  function enableSimulator(): void {
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    process.env.COMMERCE_PROVIDER_WEBHOOKS_ENABLED = "true";
    process.env.PAYMENTS_TPAY_ENABLED = "true";
    process.env.PAYMENTS_TPAY_SIMULATOR_ENABLED = "true";
    process.env.PAYMENTS_TPAY_SANDBOX_ENABLED = "false";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  }

  it("absorbs a re-delivered subscription_cycle succeeded apply (23505) as a 200 replay, never 500", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(INGEST_OK)
      .mockResolvedValueOnce(APPLY_CONFLICT);
    mockCreateClient.mockReturnValue({ rpc });
    enableSimulator();
    const { default: handler } = await import("./tpay-simulator.js");
    const res = createResponse();

    await handler(request({ providerPaymentId: PROVIDER_PAYMENT_ID, resultStatus: "succeeded" }), res);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ replayed: true }),
    }));
  });

  it("completes the two-event awaiting-mandate flow: an apply replay still binds the alias method-ref", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(INGEST_OK)
      .mockResolvedValueOnce(APPLY_CONFLICT)
      .mockResolvedValueOnce({ data: { paymentMethodRef: { replayed: false } }, error: null });
    mockCreateClient.mockReturnValue({ rpc });
    enableSimulator();
    const { default: handler } = await import("./tpay-simulator.js");
    const res = createResponse();

    await handler(request({
      providerPaymentId: PROVIDER_PAYMENT_ID,
      resultStatus: "succeeded",
      aliasResult: "accepted",
      clientId: "11111111-1111-4111-8111-111111111111",
      providerMethodRef: "payid_e2e_case4_accepted",
    }), res);

    // The absorbed apply conflict must NOT short-circuit: execution continues to the
    // mandate upsert (rpc #3) that the two-event activation depends on.
    expect(rpc).toHaveBeenNthCalledWith(3, "commerce_payment_method_ref_upsert", expect.objectContaining({
      p_provider_method_ref: "payid_e2e_case4_accepted",
      p_method_kind: "blik_payid",
      p_status: "active",
      p_active: true,
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("maps a non-idempotency RPC failure to a retryable 503, never a 500", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(INGEST_OK)
      .mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock detected" } });
    mockCreateClient.mockReturnValue({ rpc });
    enableSimulator();
    const { default: handler } = await import("./tpay-simulator.js");
    const res = createResponse();

    await handler(request({ providerPaymentId: PROVIDER_PAYMENT_ID, resultStatus: "succeeded" }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    }));
  });

  it("maps an ingest idempotency conflict to a terminal 409", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "commerce_idempotency_conflict" } });
    mockCreateClient.mockReturnValue({ rpc });
    enableSimulator();
    const { default: handler } = await import("./tpay-simulator.js");
    const res = createResponse();

    await handler(request({ providerPaymentId: PROVIDER_PAYMENT_ID, resultStatus: "succeeded" }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "CONFLICT" }),
    }));
  });
});

function request(body: unknown = "{}", headers: Record<string, string> = {}): VercelRequest {
  return { method: "POST", body, query: {}, headers } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), send: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  vi.mocked(res.send).mockReturnValue(res);
  return res;
}
