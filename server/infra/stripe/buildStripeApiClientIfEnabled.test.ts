import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider SDK constructor performs no I/O, but stubbing it lets the suite
// assert *which* secret key the construction policy forwards.
const { clientCtor } = vi.hoisted(() => ({
  clientCtor: vi.fn(function ClientMock(this: object) {
    Object.assign(this, {
      paymentIntents: { create: vi.fn(), search: vi.fn() },
      setupIntents: { create: vi.fn() },
      payouts: { list: vi.fn() },
      balanceTransactions: { list: vi.fn() },
    });
  }),
}));

vi.mock("stripe", () => ({ default: clientCtor }));

import { buildStripeApiClientIfEnabled as buildClientIfEnabled } from "./buildStripeApiClientIfEnabled.js";

// The provider-specific env keys are named exactly once; every case below
// builds its env through `env()` rather than repeating them.
const ENABLED_KEY = "STRIPE_PROVIDER_ENABLED";
const SECRET_KEY = "STRIPE_SECRET_KEY";
const LIVE_CONFIRMED_KEY = "STRIPE_LIVE_CONFIRMED";

// The key-mode assertion throws with this exact message tail; pinning the
// string rather than importing the error class keeps the check just as precise
// while adding no further vendor tokens.
const LIVE_KEY_BLOCKED = /_live_keys_blocked_without_explicit_confirmation$/;

const SANDBOX_KEY = "sk_test_dummy";
const LIVE_KEY = "sk_live_real";

function env(parts: {
  enabled?: string;
  secret?: string;
  liveConfirmed?: string;
}): Record<string, string | undefined> {
  return {
    [ENABLED_KEY]: parts.enabled,
    [SECRET_KEY]: parts.secret,
    [LIVE_CONFIRMED_KEY]: parts.liveConfirmed,
  };
}

describe("buildClientIfEnabled", () => {
  beforeEach(() => {
    clientCtor.mockClear();
  });

  describe("feature flag gate", () => {
    it("returns null when the enable flag is absent", () => {
      expect(buildClientIfEnabled(env({ secret: SANDBOX_KEY }))).toBeNull();
      expect(clientCtor).not.toHaveBeenCalled();
    });

    // The flag is compared with strict `!== "true"`, so anything that merely
    // looks enabled must stay off. A truthy-but-not-"true" value silently
    // switching on a payment provider would be the expensive failure here.
    it.each(["false", "1", "yes", "TRUE", "True", " true", ""])(
      "returns null for the non-canonical flag value %o",
      (enabled) => {
        expect(buildClientIfEnabled(env({ enabled, secret: SANDBOX_KEY }))).toBeNull();
        expect(clientCtor).not.toHaveBeenCalled();
      },
    );

    it("checks the flag before the key, so a live key behind a disabled flag never throws", () => {
      expect(buildClientIfEnabled(env({ enabled: "false", secret: LIVE_KEY }))).toBeNull();
      expect(clientCtor).not.toHaveBeenCalled();
    });
  });

  describe("credential gate", () => {
    it("returns null when the secret key is missing", () => {
      expect(buildClientIfEnabled(env({ enabled: "true" }))).toBeNull();
      expect(clientCtor).not.toHaveBeenCalled();
    });

    it("returns null for an empty secret key rather than building an unauthenticated client", () => {
      expect(buildClientIfEnabled(env({ enabled: "true", secret: "" }))).toBeNull();
      expect(clientCtor).not.toHaveBeenCalled();
    });
  });

  describe("key mode policy", () => {
    it("builds a client from a sandbox key and forwards exactly that key", () => {
      const client = buildClientIfEnabled(env({ enabled: "true", secret: SANDBOX_KEY }));

      expect(client).not.toBeNull();
      expect(client?.createPaymentIntent).toBeTypeOf("function");
      expect(client?.createSetupIntent).toBeTypeOf("function");
      expect(clientCtor).toHaveBeenCalledWith(SANDBOX_KEY, expect.any(Object));
    });

    it("blocks a live key that was not explicitly confirmed", () => {
      expect(() => buildClientIfEnabled(env({ enabled: "true", secret: LIVE_KEY })))
        .toThrow(LIVE_KEY_BLOCKED);
      expect(clientCtor).not.toHaveBeenCalled();
    });

    // The confirmation flag uses the same strict `=== "true"`, so a near-miss
    // value must not unlock live money movement.
    it.each(["false", "1", "yes", "TRUE"])(
      "blocks a live key when the confirmation value is %o",
      (liveConfirmed) => {
        expect(() => buildClientIfEnabled(
          env({ enabled: "true", secret: LIVE_KEY, liveConfirmed }),
        )).toThrow(LIVE_KEY_BLOCKED);
        expect(clientCtor).not.toHaveBeenCalled();
      },
    );

    it("builds a client from a live key once live use is explicitly confirmed", () => {
      const client = buildClientIfEnabled(
        env({ enabled: "true", secret: LIVE_KEY, liveConfirmed: "true" }),
      );

      expect(client).not.toBeNull();
      expect(clientCtor).toHaveBeenCalledWith(LIVE_KEY, expect.any(Object));
    });

    // Default-deny: an unrecognised prefix is not "not live", it is unknown,
    // and the key-mode assertion refuses it instead of falling through.
    // Keep every fake key's suffix under ten characters: the default gitleaks
    // rule for this vendor matches `[sr]k_(test|live)_` followed by ten or more
    // alphanumerics, and a longer placeholder fails the secret scan on CI while
    // proving nothing extra here — the prefix is the whole subject of the case.
    it.each(["rk_live_short", "pk_test_publishable", "sk_dummy", "whsec_secret"])(
      "refuses the unrecognised key prefix %o",
      (secret) => {
        expect(() => buildClientIfEnabled(env({ enabled: "true", secret })))
          .toThrow(LIVE_KEY_BLOCKED);
        expect(clientCtor).not.toHaveBeenCalled();
      },
    );

    it("refuses an unrecognised key prefix even when live use is confirmed", () => {
      expect(() => buildClientIfEnabled(
        env({ enabled: "true", secret: "rk_live_short", liveConfirmed: "true" }),
      )).toThrow(LIVE_KEY_BLOCKED);
      expect(clientCtor).not.toHaveBeenCalled();
    });
  });
});
