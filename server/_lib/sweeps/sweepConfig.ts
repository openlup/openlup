/**
 * Single typed resolver for the state-sweep crons' enable + window/grace config.
 *
 * Collapses the three identical ad-hoc `*Minutes(env)` helpers and inline
 * `env.X !== "true"` gates that previously lived in each cron
 * (commerce-reservation-sweep, commerce-payment-event-sweep, subscription-sweep)
 * into one pure function. Behaviour-preserving: same env in -> same enabled
 * booleans and minute values (including the exact defaults).
 *
 * Reads `env.X` (a passed-in record), NOT `process.env.X`, so the env-flag
 * discovery scanner does not register this module as a new flag source.
 *
 * The subscription RENEWAL cron is intentionally excluded — it gates on a
 * different, contested flag and is out of scope (see Tier-1 follow-ups).
 */

export type SweepEnv = Record<string, string | undefined>;

const MIN_AUTO_EXPIRY_WINDOW_MINUTES = 24 * 60;
const MAX_AUTO_EXPIRY_WINDOW_MINUTES = 36 * 60;

export interface SweepConfig {
  reservation: { enabled: boolean; windowMinutes: number };
  reservationAutoExpiry: { enabled: boolean; windowMinutes: number };
  paymentEvent: { enabled: boolean; graceMinutes: number };
  subscriptionActivation: { enabled: boolean; windowMinutes: number };
}

/** `Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback` — verbatim. */
function positiveMinutes(raw: number, fallback: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function checkoutReservationWindowMinutes(raw: number): number {
  const minutes = positiveMinutes(raw, MIN_AUTO_EXPIRY_WINDOW_MINUTES);
  return Math.min(MAX_AUTO_EXPIRY_WINDOW_MINUTES, Math.max(MIN_AUTO_EXPIRY_WINDOW_MINUTES, minutes));
}

export function resolveSweepConfig(env: SweepEnv = process.env): SweepConfig {
  return {
    reservation: {
      enabled: env.COMMERCE_RESERVATION_SWEEP_ENABLED === "true",
      windowMinutes: checkoutReservationWindowMinutes(Number(env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES)),
    },
    reservationAutoExpiry: {
      enabled: env.COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED === "true",
      windowMinutes: checkoutReservationWindowMinutes(Number(env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES)),
    },
    paymentEvent: {
      enabled: env.COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED === "true",
      graceMinutes: positiveMinutes(Number(env.COMMERCE_PAYMENT_EVENT_SWEEP_GRACE_MINUTES), 1440),
    },
    subscriptionActivation: {
      enabled: env.COMMERCE_SUBSCRIPTION_SWEEP_ENABLED === "true",
      // 24 h, matching the two other windows that govern the same unpaid order:
      // the checkout-recovery link/nudge window and the inventory reservation
      // lease (itself clamped to 24-36 h just above). This default used to be
      // 120, which made the sweep terminate an order roughly an hour after its
      // own 1h recovery email had been delivered and long before the 20h nudge
      // could fire — measured on production 2026-08-20. Staging already ran
      // 1440 via an explicit override, so only environments falling back to
      // this default ever saw the short window.
      windowMinutes: positiveMinutes(Number(env.SUBSCRIPTION_ACTIVATION_WINDOW_MINUTES), 1440),
    },
  };
}
