import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES,
  MAX_CHECKOUT_RESERVATION_TTL_MINUTES,
  MIN_CHECKOUT_RESERVATION_TTL_MINUTES,
  normalizedTtlMinutes,
  reservationPolicyFor,
} from "./reservationPolicy.js";

describe("reservationPolicyFor", () => {
  const now = new Date("2026-06-16T10:00:00.000Z");

  it("sets a checkout payment-window expiry from a product-agnostic TTL in the allowed window", () => {
    expect(reservationPolicyFor({
      reservationKind: "checkout_payment_window",
      paymentTargetKind: "one_time_order",
      orderMode: "one_time",
      now,
      checkoutTtlMinutes: 2160,
    })).toEqual({
      expiresAt: "2026-06-17T22:00:00.000Z",
      ttlMinutes: 2160,
    });
  });

  it("defaults checkout payment-window holds to the openlup runtime TTL", () => {
    expect(reservationPolicyFor({
      reservationKind: "checkout_payment_window",
      paymentTargetKind: "one_time_order",
      orderMode: "one_time",
      now,
    })).toEqual({
      expiresAt: "2026-06-17T10:00:00.000Z",
      ttlMinutes: DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES,
    });
  });

  it("clamps checkout payment-window holds to the 24-36h abandoned-checkout window", () => {
    expect(normalizedTtlMinutes(45)).toBe(MIN_CHECKOUT_RESERVATION_TTL_MINUTES);
    expect(normalizedTtlMinutes(1440)).toBe(1440);
    expect(normalizedTtlMinutes(1800)).toBe(1800);
    expect(normalizedTtlMinutes(3000)).toBe(MAX_CHECKOUT_RESERVATION_TTL_MINUTES);
  });

  it("leaves non-checkout hold kinds without automatic expiry", () => {
    expect(reservationPolicyFor({
      reservationKind: "manual_ops",
      paymentTargetKind: "one_time_order",
      orderMode: "one_time",
      now,
      checkoutTtlMinutes: 1440,
    })).toEqual({ expiresAt: null, ttlMinutes: null });
  });

  it("normalizes invalid TTL values back to the default", () => {
    expect(normalizedTtlMinutes(0)).toBe(DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES);
    expect(normalizedTtlMinutes(-5)).toBe(DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES);
    expect(normalizedTtlMinutes(Number.NaN)).toBe(DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES);
  });
});
