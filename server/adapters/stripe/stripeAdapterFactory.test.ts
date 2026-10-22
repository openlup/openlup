import { describe, expect, it, vi } from "vitest";

const { paymentIntentCreate, setupIntentCreate, stripeCtor } = vi.hoisted(() => {
  const paymentIntentCreate = vi.fn();
  const setupIntentCreate = vi.fn();
  const stripeCtor = vi.fn(function StripeMock(this: object) {
    Object.assign(this, {
      paymentIntents: { create: paymentIntentCreate },
      setupIntents: { create: setupIntentCreate },
    });
  });
  return { paymentIntentCreate, setupIntentCreate, stripeCtor };
});

vi.mock("stripe", () => ({ default: stripeCtor }));

import { buildStripeAdapterIfEnabled } from "./stripeAdapterFactory.js";
import { StripeLiveKeyBlockedError } from "../../infra/providerReadiness.js";

describe("buildStripeAdapterIfEnabled", () => {
  it("returns null when STRIPE_PROVIDER_ENABLED is not 'true'", () => {
    stripeCtor.mockClear();
    expect(buildStripeAdapterIfEnabled({ STRIPE_SECRET_KEY: "sk_test_x" })).toBeNull();
    expect(stripeCtor).not.toHaveBeenCalled();
  });

  it("returns null when STRIPE_SECRET_KEY is missing", () => {
    expect(buildStripeAdapterIfEnabled({ STRIPE_PROVIDER_ENABLED: "true" })).toBeNull();
  });

  it("builds the stripe adapter for sk_test_ keys in sandbox mode", async () => {
    const result = buildStripeAdapterIfEnabled({
      STRIPE_PROVIDER_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_abc",
    });
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("sandbox");
    expect(result?.adapter.execute).toBeTypeOf("function");
    paymentIntentCreate.mockResolvedValueOnce({ id: "pi_host", status: "requires_confirmation", client_secret: "transient",
      customer: "customer-host", payment_method: "method-host" });
    const execution = await result!.adapter.execute({ idempotencyKey: "host", providerIdempotencyKey: "host-key",
      providerRequestFingerprint: "host-fingerprint", paymentIntentId: "intent-host", amountMinor: 1200, currency: "EUR",
      mode: "one_time", orderRef: "order-host", customerRef: "customer-host", clientId: "client-host", saveForFutureUse: true });
    expect(execution).toMatchObject({ clientSecret: "transient", customerProviderRef: "customer-host", paymentMethodRef: "method-host" });
    expect(paymentIntentCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "customer-host", setup_future_usage: "off_session",
      metadata: expect.objectContaining({ clientId: "client-host", providerRequestFingerprint: "host-fingerprint" }) }), { idempotencyKey: "host-key" });
    setupIntentCreate.mockResolvedValueOnce({ id: "seti_host", status: "requires_confirmation", client_secret: "setup-transient" });
    const setup = await result!.adapter.execute({ idempotencyKey: "setup-host", providerIdempotencyKey: "setup-key",
      providerRequestFingerprint: "setup-fingerprint", paymentIntentId: "intent-host", amountMinor: 1200, currency: "EUR",
      mode: "one_time", orderRef: "order-host", providerFlow: "setup_reusable_method", customerRef: "customer-host" });
    expect(setup.clientSecret).toBe("setup-transient");
    expect(setupIntentCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "customer-host", usage: "off_session" }), { idempotencyKey: "setup-key" });
  });

  it("rejects sk_live_ keys without STRIPE_LIVE_CONFIRMED", () => {
    expect(() =>
      buildStripeAdapterIfEnabled({
        STRIPE_PROVIDER_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_live_abc",
      }),
    ).toThrow(StripeLiveKeyBlockedError);
  });

  it("accepts sk_live_ keys with STRIPE_LIVE_CONFIRMED=true and marks live mode", () => {
    const result = buildStripeAdapterIfEnabled({
      STRIPE_PROVIDER_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_live_abc",
      STRIPE_LIVE_CONFIRMED: "true",
    });
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("live");
  });
});
