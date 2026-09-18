/** @beta */
export const PAYMENT_TARGET_KINDS = ["one_time_order", "subscription_cycle"] as const;
/** @beta */
export type PaymentTargetKind = (typeof PAYMENT_TARGET_KINDS)[number];

/** @beta */
export const PAYMENT_INTENT_STATUSES = [
  "created",
  "requires_action",
  "processing",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
  "disputed",
] as const;
/** @beta */
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** @beta */
export const PAYMENT_ATTEMPT_STATUSES = [
  "created",
  "blocked_preflight",
  "sent_to_provider",
  "requires_action",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
/** @beta */
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/**
 * The attempt statuses that prove no provider call can still be outstanding, and
 * so allow a fresh attempt against the same intent.
 *
 * This is the admission gate's own set, not a convenience list: the durable
 * gate is written in SQL as `status NOT IN (...)` over exactly these four values,
 * at three call sites, and `src/domains/payment/payment.test.ts` pins all three
 * against this constant. The gate is deliberately fail-closed — every status
 * outside this set is treated as "a call may exist" even when it is terminal —
 * because admitting a second call against a live attempt can take the payer's
 * money twice, while refusing one only delays a retry.
 *
 * @beta
 */
export const RETRYABLE_ATTEMPT_STATUSES = [
  "blocked_preflight",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly PaymentAttemptStatus[];

/**
 * The attempt statuses that describe an outcome still in the air: the request
 * exists, and neither success nor refusal is known yet.
 *
 * NOT the complement of {@link RETRYABLE_ATTEMPT_STATUSES}. The complement also
 * contains `succeeded`, which is settled rather than live, so the two predicates
 * relate as `!isRetryableAttemptStatus(s) === isLiveAttemptStatus(s) || s ===
 * "succeeded"` — an identity the canon test pins, because reasoning about it
 * from the two lists alone has already gone wrong once in this repository.
 *
 * @beta
 */
export const LIVE_ATTEMPT_STATUSES = [
  "created",
  "sent_to_provider",
  "requires_action",
  "processing",
] as const satisfies readonly PaymentAttemptStatus[];

/**
 * Whether a fresh attempt may be admitted against the intent this attempt
 * belongs to. See {@link RETRYABLE_ATTEMPT_STATUSES}.
 *
 * @beta
 */
export function isRetryableAttemptStatus(status: string): boolean {
  return (RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether this attempt's outcome is still unresolved — the row a status poller,
 * a reconciliation sweep or a stuck-attempt watchdog is looking for. See
 * {@link LIVE_ATTEMPT_STATUSES}.
 *
 * @beta
 */
export function isLiveAttemptStatus(status: string): boolean {
  return (LIVE_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether the request demonstrably reached the provider and nothing came back.
 *
 * The single status that says so is `sent_to_provider`, and it exists because the
 * alternatives both lie. `created` claims the provider was never contacted, so a
 * caller is free to contact it again. `processing` claims money is moving, which
 * is what a payer is then told — and that exact claim was made about intents no
 * issuer had ever been asked about (recorded in the deployment payment-status canon).
 *
 * Reaching for this predicate instead of comparing the string is the point: the
 * mapping that produced the wrong verdict lived in an adapter that could not see
 * the reasoning, which sat unexported in a file beside it.
 *
 * @beta
 */
export function providerAckedButNeverConfirmed(status: string): boolean {
  return status === "sent_to_provider";
}

/** @beta */
export const PAYMENT_CONTROL_EVENT_TYPES = [
  "payment.requires_action",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.disputed",
] as const;
/** @beta */
export type PaymentControlEventType = (typeof PAYMENT_CONTROL_EVENT_TYPES)[number];

/** @beta */
export interface PaymentIntentAggregate {
  id: string;
  targetKind: PaymentTargetKind;
  targetId: string;
  status: PaymentIntentStatus;
  amountMinor: number;
  currency: string;
  activeAttemptId: string | null;
  updatedAt: string;
  providerPaymentId?: string | null;
  failureReason?: string | null;
}

/** @beta */
export interface PaymentAttemptAggregate {
  id: string;
  intentId: string;
  status: PaymentAttemptStatus;
  provider: string;
  providerAttemptId: string | null;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  updatedAt: string;
  nextActionKind?: string | null;
  failureReason?: string | null;
}

/** @beta */
export interface CanonicalPaymentControlEvent {
  provider: string;
  providerEventId: string;
  eventType: PaymentControlEventType;
  providerPaymentId: string;
  amountMinor?: number;
  currency?: string;
  occurredAt: string;
  failureReason?: string;
  nextActionKind?: string;
  rawPayload: Record<string, unknown>;
}

/** @beta */
export type PaymentControlDecisionKind =
  | "state_changed"
  | "noop"
  | "late_success_recovered";

/** @beta */
export interface PaymentControlDecision {
  kind: PaymentControlDecisionKind;
  reason: string;
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
}

/** @beta */
export type PaymentControlFailureReason =
  | "amount_mismatch"
  | "currency_mismatch"
  | "invalid_transition"
  | "refund_requires_success"
  | "terminal_intent"
  | "wrong_attempt";

/** @beta */
export type PaymentControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PaymentControlFailureReason; message: string };
