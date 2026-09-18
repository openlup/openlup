import { createHash } from "node:crypto";

// Direct-Postgres adapter for the subscription-activation spine. Same shape as
// the other adapters in this folder: a named factory over a routine-calling
// client, concrete methods, and no generic data gateway used as a business API.
//
// The payment fingerprint is derived HERE, from the handle the settlement rail
// already recorded, and never accepted as a parameter from a caller. That is
// what makes a replay comparable: two calls that saw the same captured payment
// produce the same 64-hex value, and two that saw different ones cannot
// accidentally agree.

type RoutineClient = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

export type OfferReadinessState = "ready" | "unavailable" | "stale" | "unknown";

export interface OfferReadiness {
  sku: string;
  readiness: OfferReadinessState;
  forSale: number | null;
  sellable: boolean;
}

export interface OfferContinuationRecord {
  continuationId: string;
  status: string;
  recorded: boolean;
  replayed: boolean;
}

export interface OfferContinuationReentry extends OfferReadiness {
  continuationStatus: string | null;
  waiting: boolean;
}

export interface ProvisionalActivation {
  orderId: string;
  state: string;
  cadenceDays: number;
  declared: boolean;
  replayed: boolean;
}

export interface CapturedPaymentActivation {
  orderId: string;
  subscriptionId: string | null;
  state: string;
  cadenceDays: number;
  activatedAt: string | null;
  repaired: boolean;
  replayed: boolean;
}

export interface CheckoutCompensation {
  cancelled: boolean;
  reason: string | null;
  orderStatus: string | null;
  replayed: boolean;
}

export interface PaidActivationGapReconciliation {
  repaired: number;
  overdue: number;
}

export interface PostgresSubscriptionActivationAdapter {
  readOfferReadiness(input: { sourceKey: string; sku: string }): Promise<OfferReadiness>;
  recordBackInStockContinuation(input: {
    idempotencyKey: string;
    sourceKey: string;
    sku: string;
    contactRef: string;
    consentRef: string;
  }): Promise<OfferContinuationRecord>;
  readContinuationReentry(input: {
    sourceKey: string;
    sku: string;
    contactRef: string;
  }): Promise<OfferContinuationReentry>;
  declareProvisionalActivation(input: {
    idempotencyKey: string;
    orderId: string;
    cadenceDays: number;
  }): Promise<ProvisionalActivation>;
  activateFromCapturedPayment(input: {
    idempotencyKey: string;
    orderId: string;
    capturedReference: string;
  }): Promise<CapturedPaymentActivation>;
  reconcilePaidActivationGaps(limit?: number): Promise<PaidActivationGapReconciliation>;
  isPaidActivationGapOpen(input: { orderId: string }): Promise<boolean>;
  compensateAbandonedCheckout(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<CheckoutCompensation>;
}

/** The opaque identity of a captured payment: a hash of the handle the settlement rail wrote. */
export function capturedPaymentFingerprint(capturedReference: string): string {
  return createHash("sha256").update(capturedReference).digest("hex");
}

export function createPostgresSubscriptionActivationAdapter(
  client: RoutineClient,
): PostgresSubscriptionActivationAdapter {
  return {
    async readOfferReadiness({ sourceKey, sku }) {
      return readiness(object(await call(client, "commerce_offer_readiness", {
        p_source_key: sourceKey,
        p_sku: sku,
      })));
    },

    async recordBackInStockContinuation({ idempotencyKey, sourceKey, sku, contactRef, consentRef }) {
      const row = object(await call(client, "commerce_record_offer_continuation", {
        p_idempotency_key: idempotencyKey,
        p_source_key: sourceKey,
        p_sku: sku,
        p_contact_ref: contactRef,
        p_consent_ref: consentRef,
      }));
      return {
        continuationId: required(row, "continuationId"),
        status: required(row, "status"),
        recorded: row.recorded === true,
        replayed: row.replayed === true,
      };
    },

    async readContinuationReentry({ sourceKey, sku, contactRef }) {
      const row = object(await call(client, "commerce_offer_continuation_reentry", {
        p_source_key: sourceKey,
        p_sku: sku,
        p_contact_ref: contactRef,
      }));
      return {
        ...readiness(row),
        continuationStatus: optional(row, "continuationStatus"),
        waiting: row.waiting === true,
      };
    },

    async declareProvisionalActivation({ idempotencyKey, orderId, cadenceDays }) {
      const row = object(await call(client, "subscription_declare_provisional_activation", {
        p_idempotency_key: idempotencyKey,
        p_order_id: orderId,
        p_cadence_days: cadenceDays,
      }));
      return {
        orderId: required(row, "orderId"),
        state: required(row, "state"),
        cadenceDays: integer(row, "cadenceDays"),
        declared: row.declared === true,
        replayed: row.replayed === true,
      };
    },

    async activateFromCapturedPayment({ idempotencyKey, orderId, capturedReference }) {
      const row = object(await call(client, "subscription_activate_from_captured_payment", {
        p_idempotency_key: idempotencyKey,
        p_order_id: orderId,
        p_payment_fingerprint: capturedPaymentFingerprint(capturedReference),
      }));
      return {
        orderId: required(row, "orderId"),
        subscriptionId: optional(row, "subscriptionId"),
        state: required(row, "state"),
        cadenceDays: integer(row, "cadenceDays"),
        activatedAt: optional(row, "activatedAt"),
        repaired: row.repaired === true,
        replayed: row.replayed === true,
      };
    },

    async reconcilePaidActivationGaps(limit = 200) {
      const row = object(await call(client, "subscription_reconcile_paid_activation_gaps", {
        p_limit: limit,
      }));
      return { repaired: integer(row, "repaired"), overdue: integer(row, "overdue") };
    },

    async isPaidActivationGapOpen({ orderId }) {
      return await call(client, "subscription_paid_activation_gap_open", { p_order_id: orderId }) === true;
    },

    async compensateAbandonedCheckout({ idempotencyKey, orderId, reason }) {
      const row = object(await call(client, "commerce_compensate_abandoned_checkout", {
        p_idempotency_key: idempotencyKey,
        p_order_id: orderId,
        p_reason: reason,
      }));
      return {
        cancelled: row.cancelled === true,
        reason: optional(row, "reason"),
        orderStatus: optional(row, "orderStatus"),
        replayed: row.replayed === true,
      };
    },
  };
}

function readiness(row: Record<string, unknown>): OfferReadiness {
  return {
    sku: required(row, "sku"),
    readiness: required(row, "readiness") as OfferReadinessState,
    forSale: typeof row.forSale === "number" ? row.forSale : null,
    sellable: row.sellable === true,
  };
}

async function call(client: RoutineClient, name: string, args?: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subscription activation response invalid");
  }
  return value as Record<string, unknown>;
}

function required(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error("subscription activation response invalid");
  return field;
}

function optional(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field ? field : null;
}

function integer(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new Error("subscription activation response invalid");
  }
  return field;
}
