import type { PaymentExecutionProvider, TpayTransientProviderInput } from "../../../src/domains/payment/types.js";
import { buildStripeAdapterIfEnabled, unattendedChargeCapability as cardCapability } from "../../adapters/stripe/stripeAdapterFactory.js";
import { buildTpayAdapterIfEnabled, unattendedChargeCapability as codeCapability } from "../../adapters/tpay/tpayAdapterFactory.js";
import { createPaymentProviderReadbackRegistry } from "../paymentProviderReadbackRegistry.js";
const { sdkConstruction, certificateConstruction } = vi.hoisted(() => ({ certificateConstruction: vi.fn(() => { throw new Error("unexpected certificate construction"); }), sdkConstruction: vi.fn(function () {
  return { paymentIntents: { create: async () => ({ id: "pi_bound", status: "requires_confirmation", client_secret: "transient" }) } };
}) }));
vi.mock("stripe", () => ({ default: sdkConstruction }));
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), X509Certificate: certificateConstruction }));
import { describe, expect, it, vi } from "vitest";
import {
  getPaymentExecutionAdapter,
  NoopSettlementNotAllowedError,
  UnknownPaymentProviderError,
} from "./paymentAdapterRegistry.js";

const cardKind = cardCapability.providerKind as PaymentExecutionProvider;
const codeKind = codeCapability.providerKind as TpayTransientProviderInput["provider"];

const executionInput = {
  idempotencyKey: "wave-test",
  providerIdempotencyKey: "openlup:hidden_rehearsal:00000000-0000-0000-0000-000000000000:wave-test",
  providerRequestFingerprint: "hidden_rehearsal|00000000-0000-0000-0000-000000000000|1490|PLN|one_time|order_abc",
  paymentIntentId: "00000000-0000-0000-0000-000000000000",
  amountMinor: 1490,
  currency: "PLN" as const,
  mode: "one_time" as const,
  orderRef: "order_abc",
};

describe("paymentAdapterRegistry", () => {
  it("resolves the hidden_rehearsal no-op adapter with no provider call", async () => {
    const adapter = getPaymentExecutionAdapter("hidden_rehearsal", {}, true);
    const result = await adapter.execute(executionInput);

    expect(result).toEqual({
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {
        source: "commerce.runtime.hidden.v0",
        providerIdempotencyKey: executionInput.providerIdempotencyKey,
        providerRequestFingerprint: executionInput.providerRequestFingerprint,
      },
      responsePayload: { providerCall: false },
    });
  });

  it("resolves the noop_payment provider via the widened enum", async () => {
    const adapter = getPaymentExecutionAdapter("noop_payment", {}, true);
    const result = await adapter.execute(executionInput);

    expect(result.provider).toBe("noop_payment");
    expect(result.responsePayload).toEqual({ providerCall: false });
  });

  it("throws for an unknown (not-yet-implemented) PSP so it cannot silently no-op", () => {
    expect(() => getPaymentExecutionAdapter(cardKind, {}, true)).toThrow(UnknownPaymentProviderError);
    expect(() => getPaymentExecutionAdapter(codeKind, {}, true)).toThrow(/Unknown payment execution provider/);
  });

  it("refuses no-op providers when no-op settlement is not allowed (production seam)", () => {
    expect(() => getPaymentExecutionAdapter("hidden_rehearsal", {}, false)).toThrow(
      NoopSettlementNotAllowedError,
    );
    expect(() => getPaymentExecutionAdapter("noop_payment", {}, false)).toThrow(
      /No-op payment settlement is not allowed/,
    );
  });

  it("routes selected providers only when an execution adapter is explicitly injected", async () => {
    const stripeDouble = {
      execute: async () => ({
        provider: "hidden_rehearsal" as const,
        providerAttemptId: "stripe_double_attempt",
        providerSessionId: "stripe_double_session",
        attemptStatus: "requires_action" as const,
        nextActionKind: "3ds_challenge" as const,
        requestPayload: { providerKind: cardKind },
        responsePayload: { providerCall: false },
      }),
    };

    // Injected real adapters bypass the no-op seam even when noop is disallowed.
    const adapter = getPaymentExecutionAdapter(cardKind, { [cardKind]: stripeDouble }, false);
    const result = await adapter.execute(executionInput);

    expect(result.providerAttemptId).toBe("stripe_double_attempt");
    expect(result.responsePayload).toEqual({ providerCall: false });
    sdkConstruction.mockClear();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected network"); });
    try {
      expect(buildStripeAdapterIfEnabled({})).toBeNull();
      expect(buildTpayAdapterIfEnabled({})).toBeNull();
      expect(createPaymentProviderReadbackRegistry({})).toEqual({});
      expect(sdkConstruction).not.toHaveBeenCalled();
      expect(certificateConstruction).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const card = buildStripeAdapterIfEnabled({ STRIPE_PROVIDER_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_fixture" })!;
      expect((await getPaymentExecutionAdapter(cardKind, { [cardKind]: card.adapter }, false).execute(executionInput)).providerAttemptId).toBe("pi_bound");
      expect(sdkConstruction).toHaveBeenCalledTimes(1);
      const simulator = buildTpayAdapterIfEnabled({ PAYMENTS_TPAY_ENABLED: "true", PAYMENTS_TPAY_SIMULATOR_ENABLED: "true", APP_BASE_URL: "https://example.test" })!;
      const simulated = await simulator.adapter.execute({ ...executionInput, returnContext: "account", petId: "pet-id", customerRef: "fixture@example.test",
        transientProviderInput: { provider: codeKind, flow: "pbl_one_time", channelId: "sim-pbl-1" } });
      expect(new URL(simulated.redirectUrl!).searchParams.get("return")).toBe("/konto/zamowienie/status");
      expect(fetch).not.toHaveBeenCalled();
      expect(certificateConstruction).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
