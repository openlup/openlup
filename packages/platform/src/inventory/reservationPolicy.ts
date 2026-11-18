import type { CheckoutReservationLifetimePolicy, ReservationPolicyInput, ReservationPolicy } from "./contracts/reservation.js";

export const MIN_CHECKOUT_RESERVATION_TTL_MINUTES = 24 * 60;
export const MAX_CHECKOUT_RESERVATION_TTL_MINUTES = 36 * 60;
export const DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES = MIN_CHECKOUT_RESERVATION_TTL_MINUTES;

// Technical ceiling (ten years, matching MAX_CADENCE_DAYS): expiries stay representable for realistic clocks;
// a clock within ten years of the Date limit still fails closed with RangeError.
const MAX_POLICY_MINUTES = 3660 * 24 * 60;

const defaultPolicy: CheckoutReservationLifetimePolicy = {
  minMinutes: MIN_CHECKOUT_RESERVATION_TTL_MINUTES,
  maxMinutes: MAX_CHECKOUT_RESERVATION_TTL_MINUTES,
  defaultMinutes: DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES,
};

/** Validates the policy on every call, including non-checkout kinds. Invalid policies throw reservation_policy_invalid. */
export function reservationPolicyFor(
  input: ReservationPolicyInput,
  policy: CheckoutReservationLifetimePolicy = defaultPolicy,
): ReservationPolicy {
  const ttlMinutes = normalizedTtlMinutes(input.checkoutTtlMinutes, policy);
  if (input.reservationKind !== "checkout_payment_window") {
    return { expiresAt: null, ttlMinutes: null };
  }

  return {
    expiresAt: new Date(input.now.getTime() + ttlMinutes * 60_000).toISOString(),
    ttlMinutes,
  };
}

/** Validates the policy on every call; invalid policies throw reservation_policy_invalid. */
export function normalizedTtlMinutes(
  value: number | null | undefined,
  policy: CheckoutReservationLifetimePolicy = defaultPolicy,
): number {
  if (!policy || ![policy.minMinutes, policy.maxMinutes, policy.defaultMinutes]
    .every(minutes => Number.isSafeInteger(minutes) && minutes > 0 && minutes <= MAX_POLICY_MINUTES)
    || policy.minMinutes > policy.defaultMinutes || policy.defaultMinutes > policy.maxMinutes) {
    throw new Error("reservation_policy_invalid");
  }
  if (Number.isFinite(value) && value && value > 0) {
    return Math.min(
      policy.maxMinutes,
      Math.max(policy.minMinutes, Math.floor(value)),
    );
  }
  return policy.defaultMinutes;
}
