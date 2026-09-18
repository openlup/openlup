export const MIN_CHECKOUT_RESERVATION_TTL_MINUTES = 24 * 60;
export const MAX_CHECKOUT_RESERVATION_TTL_MINUTES = 36 * 60;
export const DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES = MIN_CHECKOUT_RESERVATION_TTL_MINUTES;

export interface ReservationPolicyInput {
  reservationKind: string;
  paymentTargetKind: "one_time_order" | "subscription_cycle" | string;
  orderMode: "one_time" | "subscription_cycle" | string;
  now: Date;
  checkoutTtlMinutes?: number | null;
}

export interface ReservationPolicy {
  expiresAt: string | null;
  ttlMinutes: number | null;
}

export function reservationPolicyFor(input: ReservationPolicyInput): ReservationPolicy {
  if (input.reservationKind !== "checkout_payment_window") {
    return { expiresAt: null, ttlMinutes: null };
  }

  const ttlMinutes = normalizedTtlMinutes(input.checkoutTtlMinutes);
  return {
    expiresAt: new Date(input.now.getTime() + ttlMinutes * 60_000).toISOString(),
    ttlMinutes,
  };
}

export function normalizedTtlMinutes(value: number | null | undefined): number {
  if (Number.isFinite(value) && value && value > 0) {
    return Math.min(
      MAX_CHECKOUT_RESERVATION_TTL_MINUTES,
      Math.max(MIN_CHECKOUT_RESERVATION_TTL_MINUTES, Math.floor(value)),
    );
  }
  return DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES;
}
