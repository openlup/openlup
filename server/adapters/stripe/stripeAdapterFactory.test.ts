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
    expect(buildStripeAdapterIfEnabled({ STRIPE_SECRET_KEY: "sk_test_x" })).toBeNull();
  });

  it("returns null when STRIPE_SECRET_KEY is missing", () => {
    expect(buildStripeAdapterIfEnabled({ STRIPE_PROVIDER_ENABLED: "true" })).toBeNull();
  });

  it("builds the stripe adapter for sk_test_ keys in sandbox mode", () => {
    const result = buildStripeAdapterIfEnabled({
      STRIPE_PROVIDER_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_abc",
    });
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("sandbox");
    expect(result?.adapter.execute).toBeTypeOf("function");
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
