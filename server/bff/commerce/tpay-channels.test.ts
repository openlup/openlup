import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTpaySimulatorClient, TPAY_SIMULATOR_MANDATE_REFUSED_TOKEN } from "../../infra/tpay/tpaySimulatorClient.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const { mockCreateTpayHttpClient } = vi.hoisted(() => ({
  mockCreateTpayHttpClient: vi.fn(() => ({ listPaymentChannels: vi.fn(async () => []) })),
}));

vi.mock("@openlup/platform/payments/tpay", () => ({
  createTpayHttpClient: mockCreateTpayHttpClient,
}));

const ENV_KEYS = [
  "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
  "PAYMENTS_TPAY_ENABLED",
  "PAYMENTS_TPAY_SANDBOX_ENABLED",
  "PAYMENTS_TPAY_SIMULATOR_ENABLED",
  "PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED",
  "TPAY_VERIFIED_TEST_MODE_CONFIRMED",
  "TPAY_API_BASE_URL",
  "TPAY_CLIENT_ID",
  "TPAY_CLIENT_SECRET",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("commerce payment-rail channels BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateTpayHttpClient.mockClear();
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

  it("fails closed before creating a client when provider flags are disabled", async () => {
    process.env.TPAY_API_BASE_URL = "https://openapi.sandbox.tpay.com";
    process.env.TPAY_CLIENT_ID = "client";
    process.env.TPAY_CLIENT_SECRET = "secret";
    const { default: handler } = await import("./tpay-channels.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateTpayHttpClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("rejects production Open API base URL under sandbox flags", async () => {
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    process.env.PAYMENTS_TPAY_ENABLED = "true";
    process.env.PAYMENTS_TPAY_SANDBOX_ENABLED = "true";
    process.env.TPAY_API_BASE_URL = "https://api.tpay.com";
    process.env.TPAY_CLIENT_ID = "client";
    process.env.TPAY_CLIENT_SECRET = "secret";
    const { default: handler } = await import("./tpay-channels.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateTpayHttpClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toMatchObject({
      error: { details: { feature: "tpay-channels" } },
    });
  });

  it("allows verified-account test mode only with production Open API and confirmation", async () => {
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    process.env.PAYMENTS_TPAY_ENABLED = "true";
    process.env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED = "true";
    process.env.TPAY_VERIFIED_TEST_MODE_CONFIRMED = "true";
    process.env.TPAY_API_BASE_URL = "https://api.tpay.com";
    process.env.TPAY_CLIENT_ID = "client";
    process.env.TPAY_CLIENT_SECRET = "secret";
    const { default: handler } = await import("./tpay-channels.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateTpayHttpClient).toHaveBeenCalledWith({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
    });
  });

  it("returns simulator channels without provider credentials", async () => {
    process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = "true";
    process.env.PAYMENTS_TPAY_ENABLED = "true";
    process.env.PAYMENTS_TPAY_SIMULATOR_ENABLED = "true";
    process.env.PAYMENTS_TPAY_SANDBOX_ENABLED = "false";
    const { default: handler } = await import("./tpay-channels.js");
    const res = createResponse();

    await handler(request("GET"), res);

    expect(mockCreateTpayHttpClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      data: {
        channels: [
          expect.objectContaining({ id: "sim-pbl-1", available: true, onlinePayment: true }),
          expect.objectContaining({ id: "150", available: true, onlinePayment: false }),
        ],
      },
    });
  });

  it("supports simulatorPath injection and neutral mandate refusal messaging", async () => {
    const defaultClient = createTpaySimulatorClient();
    const customClient = createTpaySimulatorClient({ simulatorPath: "/custom/sim" });
    const baseTx = { amount: 14.9, description: "order_abc", hiddenDescription: "intent_1", payer: { email: "fixture@example.test", name: "Customer" }, successUrl: "https://example.test/ok", errorUrl: "https://example.test/err", notificationUrl: "https://example.test/hook" } as Parameters<typeof defaultClient.createTransaction>[0];
    const defaultPbl = await defaultClient.createTransaction({ ...baseTx, channelId: "sim-pbl-1" });
    const customPbl = await customClient.createTransaction({ ...baseTx, channelId: "sim-pbl-1" });
    expect(new URL(defaultPbl.transactionPaymentUrl!).pathname).toBe("/tpay-simulator");
    expect(new URL(customPbl.transactionPaymentUrl!).pathname).toBe("/custom/sim");
    const refused = await defaultClient.createTransaction({ ...baseTx, blikToken: TPAY_SIMULATOR_MANDATE_REFUSED_TOKEN, alias: { value: "alias-key", type: "PAYID" } });
    expect(refused.payIdEligible).toBeNull();
    expect(refused.errors).toEqual([{ errorCode: "payment_failed", errorMessage: "Bank does not support recurring alias registration", fieldName: null }]);
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
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
