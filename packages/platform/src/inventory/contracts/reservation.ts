/** Checked on each policy helper call: positive safe integers, min <= default <= max. */
export interface CheckoutReservationLifetimePolicy {
  minMinutes: number;
  maxMinutes: number;
  defaultMinutes: number;
}

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

export interface AutomaticRenewalReservationResult {
  reserved: boolean;
  replayed: boolean;
  reservationId: string | null;
  status: "held" | "committed" | "consumed" | "released" | "expired" | "refused";
  reason: string | null;
}
