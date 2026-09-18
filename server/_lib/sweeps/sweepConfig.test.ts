import { describe, expect, it } from "vitest";

import { resolveSweepConfig } from "./sweepConfig.js";

const MINUTE_FIELDS = [
  ["reservation", "COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES", 1440, "windowMinutes"],
  ["reservationAutoExpiry", "COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES", 1440, "windowMinutes"],
  ["paymentEvent", "COMMERCE_PAYMENT_EVENT_SWEEP_GRACE_MINUTES", 1440, "graceMinutes"],
  ["subscriptionActivation", "SUBSCRIPTION_ACTIVATION_WINDOW_MINUTES", 1440, "windowMinutes"],
] as const;

const CHECKOUT_RESERVATION_SWEEPS = new Set(["reservation", "reservationAutoExpiry"]);

const ENABLE_FLAGS = [
  ["reservation", "COMMERCE_RESERVATION_SWEEP_ENABLED"],
  ["reservationAutoExpiry", "COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED"],
  ["paymentEvent", "COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED"],
  ["subscriptionActivation", "COMMERCE_SUBSCRIPTION_SWEEP_ENABLED"],
] as const;

describe("resolveSweepConfig minute parsing", () => {
  for (const [sweep, envName, fallback, field] of MINUTE_FIELDS) {
    const cases: Array<[string | undefined, number]> = [
      [undefined, fallback],
      ["", fallback],
      [" ", fallback],
      ["0", fallback],
      ["-5", fallback],
      ["abc", fallback],
      ["1.9", CHECKOUT_RESERVATION_SWEEPS.has(sweep) ? 1440 : 1],
      ["90", CHECKOUT_RESERVATION_SWEEPS.has(sweep) ? 1440 : 90],
      ["1800", CHECKOUT_RESERVATION_SWEEPS.has(sweep) ? 1800 : 1800],
      ["3000", CHECKOUT_RESERVATION_SWEEPS.has(sweep) ? 2160 : 3000],
    ];
    for (const [raw, expected] of cases) {
      it(`${sweep}.${field} for ${envName}=${JSON.stringify(raw)} -> ${expected}`, () => {
        const cfg = resolveSweepConfig(raw === undefined ? {} : { [envName]: raw });
        expect((cfg[sweep] as unknown as Record<string, number>)[field]).toBe(expected);
      });
    }
  }
});

describe("resolveSweepConfig enable gates", () => {
  for (const [sweep, flag] of ENABLE_FLAGS) {
    it(`${sweep}.enabled only when ${flag} === "true"`, () => {
      expect(resolveSweepConfig({})[sweep].enabled).toBe(false);
      expect(resolveSweepConfig({ [flag]: "false" })[sweep].enabled).toBe(false);
      expect(resolveSweepConfig({ [flag]: "1" })[sweep].enabled).toBe(false);
      expect(resolveSweepConfig({ [flag]: "TRUE" })[sweep].enabled).toBe(false);
      expect(resolveSweepConfig({ [flag]: "true" })[sweep].enabled).toBe(true);
    });
  }
});

describe("resolveSweepConfig defaults", () => {
  it("returns the documented defaults for an empty env", () => {
    expect(resolveSweepConfig({})).toEqual({
      reservation: { enabled: false, windowMinutes: 1440 },
      reservationAutoExpiry: { enabled: false, windowMinutes: 1440 },
      paymentEvent: { enabled: false, graceMinutes: 1440 },
      // 1440, not 120: the activation window now matches the recovery and
      // reservation windows that govern the same unpaid order.
      subscriptionActivation: { enabled: false, windowMinutes: 1440 },
    });
  });
});
