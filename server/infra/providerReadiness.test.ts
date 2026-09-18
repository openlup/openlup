import { describe, expect, it } from "vitest";
import {
  assertProviderEnabledAndConfigured,
  assertProviderInactiveOrConfigured,
  assertStripeKeyMode,
  ProviderDisabledError,
  ProviderEnvMissingError,
  readProviderActivationConfig,
  sanitizeProviderError,
  StripeLiveKeyBlockedError,
} from "./providerReadiness.js";

describe("provider readiness helpers", () => {
  it("fails closed when disabled, missing env, or nominally configured", () => {
    const disabled = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: false,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: {},
    });
    expect(() => assertProviderInactiveOrConfigured(disabled)).toThrow(ProviderDisabledError);

    const missingEnv = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: true,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: {},
    });
    expect(() => assertProviderInactiveOrConfigured(missingEnv)).toThrow(ProviderEnvMissingError);

    const configured = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: true,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: { STRIPE_SECRET_KEY: "sk_test_redacted" },
    });
    expect(() => assertProviderInactiveOrConfigured(configured)).toThrow(
      /live_provider_calls_not_implemented/,
    );
  });

  it("sanitizes provider errors without raw payloads or credentials", () => {
    expect(sanitizeProviderError(new Error("sk_live_secret leaked?"))).toEqual({
      code: "provider_error",
      message: "Provider request failed",
      retryable: true,
    });
  });

  it("assertProviderEnabledAndConfigured passes when enabled and env present", () => {
    const ok = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: true,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: { STRIPE_SECRET_KEY: "sk_test_redacted" },
    });
    expect(() => assertProviderEnabledAndConfigured(ok)).not.toThrow();

    const disabled = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: false,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: {},
    });
    expect(() => assertProviderEnabledAndConfigured(disabled)).toThrow(ProviderDisabledError);

    const missing = readProviderActivationConfig({
      providerKind: "stripe",
      enabled: true,
      requiredEnv: ["STRIPE_SECRET_KEY"],
      env: {},
    });
    expect(() => assertProviderEnabledAndConfigured(missing)).toThrow(ProviderEnvMissingError);
  });

  it("assertStripeKeyMode accepts sk_test_ as sandbox", () => {
    expect(assertStripeKeyMode("sk_test_abc", {})).toBe("sandbox");
  });

  it("assertStripeKeyMode rejects sk_live_ without STRIPE_LIVE_CONFIRMED", () => {
    expect(() => assertStripeKeyMode("sk_live_abc", {})).toThrow(StripeLiveKeyBlockedError);
    expect(() => assertStripeKeyMode("sk_live_abc", { STRIPE_LIVE_CONFIRMED: "false" })).toThrow(
      StripeLiveKeyBlockedError,
    );
  });

  it("assertStripeKeyMode accepts sk_live_ only with STRIPE_LIVE_CONFIRMED=true", () => {
    expect(assertStripeKeyMode("sk_live_abc", { STRIPE_LIVE_CONFIRMED: "true" })).toBe("live");
  });

  it("assertStripeKeyMode rejects malformed keys", () => {
    expect(() => assertStripeKeyMode("", {})).toThrow(StripeLiveKeyBlockedError);
    expect(() => assertStripeKeyMode("rk_test_abc", {})).toThrow(StripeLiveKeyBlockedError);
  });
});
