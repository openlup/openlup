import { maskProviderReference } from "../../../src/domains/platform/observabilityRedaction.js";
import { groupBy, latestTimestamp, readErrorReason, secondsBetween } from "./paymentObservabilityEvidenceHelpers.js";
import {
  collectAbandonedBeforeConfirmationEvidence, collectPendingPaymentPastRecoveryWindowEvidence, type PendingPaymentOrderEvidenceRow,
} from "./checkoutAbandonmentEvidence.js";
import {
  collectRecoveryMissingEvidence, type DunningRescueEvidenceRow, type RecoveryTokenOrderIds,
} from "./paymentRecoveryEvidence.js";
import {
  ACTIVE_PROVIDER_ATTEMPT_STATUSES,
  collectReconciliationMismatchEvidence,
  type PaymentReconciliationEvidenceRow,
} from "./paymentReconciliationObservabilityEvidence.js";

export type { PaymentReconciliationEvidenceRow } from "./paymentReconciliationObservabilityEvidence.js";
export type { PendingPaymentOrderEvidenceRow } from "./checkoutAbandonmentEvidence.js";
export type {
  CheckoutRecoveryTokenEvidenceRow, DunningRescueEvidenceRow, RecoveryTokenOrderIds,
} from "./paymentRecoveryEvidence.js";

export type PaymentIntentEvidenceRow = Record<string, unknown> & {
  id: string;
  status: string;
  target_kind?: string | null;
  order_id?: string | null;
  subscription_id?: string | null;
  subscription_cycle_id?: string | null;
  provider_kind?: string | null;
  provider?: string | null;
  provider_payment_id?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  updated_at?: string | null;
};

export type PaymentAttemptEvidenceRow = Record<string, unknown> & {
  id: string;
  payment_intent_id: string;
  status: string;
  provider?: string | null;
  provider_kind?: string | null;
  provider_payment_id?: string | null;
  provider_attempt_id?: string | null;
  provider_session_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type PaymentEventEvidenceRow = Record<string, unknown> & {
  id?: string;
  provider_kind?: string | null;
  provider?: string | null;
  provider_event_id?: string | null;
  event_type?: string | null;
  payment_intent_id?: string | null;
  payment_attempt_id?: string | null;
  provider_payment_id?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  signature_verified?: boolean | null;
  error?: string | null;
  error_code?: string | null;
  rejection_reason?: string | null;
};

type PaymentEventKind =
  | "provider_paid_local_unpaid"
  | "amount_currency_mismatch"
  | "signature_failure";

// Statuses the apply-result guards only reach after a local success, so a
// provider success event stays consistent with them (paid, then refunded or
// disputed).
export const PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES = new Set([
  "succeeded",
  "refunded",
  "partially_refunded",
  "disputed",
]);

export type PaymentObservabilityEvidence = {
  kind:
    | PaymentEventKind
    | "local_paid_provider_unpaid"
    | "prepared_without_provider_ack"
    | "webhook_missing"
    | "stuck_processing"
    | "abandoned_before_confirmation" | "pending_payment_past_recovery_window"
    | "recovery_missing";
  provider: string | null;
  paymentIntentId: string | null;
  paymentAttemptId?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  subscriptionCycleId?: string | null;
  providerPaymentId?: string | null;
  providerEventId?: string | null;
  ageSeconds?: number;
  owner?: "commerce/payment";
  customerSafeStatus?: "operator_review_required";
  operatorNextAction?: "inspect_provider_before_retry";
  reason: string;
  observedAt: string;
};

export function summarizePayments(
  intents: PaymentIntentEvidenceRow[],
  attempts: PaymentAttemptEvidenceRow[],
  events: PaymentEventEvidenceRow[],
  now: Date,
  reconciliationRuns: PaymentReconciliationEvidenceRow[] = [],
  recoveryTokenOrderIds: RecoveryTokenOrderIds = new Set<string>(),
  dunningCases: DunningRescueEvidenceRow[] = [],
  pendingPaymentOrders: PendingPaymentOrderEvidenceRow[] = [],
) {
  const intentById = new Map(intents.map((row) => [row.id, row]));
  const attemptById = new Map(attempts.map((row) => [row.id, row]));
  const attemptsByIntent = groupBy(attempts, (row) => row.payment_intent_id);
  const succeededEvents = events.filter((row) => row.event_type === "payment.succeeded");
  const evidence: PaymentObservabilityEvidence[] = [];
  const staleCutoff = now.getTime() - 30 * 60 * 1000;
  const webhookCutoff = now.getTime() - 15 * 60 * 1000;
  const mismatches = collectReconciliationMismatchEvidence(
    reconciliationRuns,
    attemptById,
    intentById,
    now,
  );
  evidence.push(...mismatches.evidence);
  evidence.push(...collectRecoveryMissingEvidence(attempts, intentById, now, {
    recoveryTokenOrderIds,
    dunningCases,
  }));
  // Both are flag-independent by contract; see their docblocks. They are pushed
  // here, next to the other collectors, precisely so the flag gate in the
  // evaluator is the ONLY place that could ever mute them — and it does not.
  evidence.push(...collectAbandonedBeforeConfirmationEvidence(reconciliationRuns, intentById, now));
  evidence.push(...collectPendingPaymentPastRecoveryWindowEvidence(pendingPaymentOrders, intents, now));
  const mismatchAttemptIds = mismatches.attemptIds;

  for (const event of succeededEvents) {
    const intent = event.payment_intent_id ? intentById.get(event.payment_intent_id) : undefined;
    if (intent && !PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES.has(intent.status)) {
      evidence.push(paymentEvidence("provider_paid_local_unpaid", event, "provider_success_event_local_not_succeeded", now));
    }
  }

  for (const intent of intents.filter((row) => row.status === "succeeded")) {
    const intentAttempts = attemptsByIntent.get(intent.id) ?? [];
    const hasSucceededProviderEvent = succeededEvents.some((event) =>
      event.payment_intent_id === intent.id ||
      intentAttempts.some((attempt) => providerRefMatches(event, attempt)),
    );
    if (!hasSucceededProviderEvent) {
      evidence.push({
        kind: "local_paid_provider_unpaid" as const,
        provider: providerOf(intent),
        paymentIntentId: intent.id,
        reason: "local_succeeded_without_provider_success_event",
        observedAt: now.toISOString(),
      });
    }
  }

  for (const attempt of attempts) {
    const intent = intentById.get(attempt.payment_intent_id);
    // Match reconciliation SQL: either side of the active attempt/intent pair
    // becoming fresh must postpone stale-payment evidence.
    const localUpdatedAt = latestTimestamp(
      attempt.updated_at,
      intent?.updated_at,
      attempt.created_at,
    );
    const hasEvent = events.some((event) => providerRefMatches(event, attempt));
    const hasStrongerMismatch = mismatchAttemptIds.has(attempt.id);
    if (intent && isPreparedWithoutProviderAck(attempt, intent, localUpdatedAt, staleCutoff)) {
      evidence.push({
        kind: "prepared_without_provider_ack" as const,
        provider: providerOf(attempt) ?? providerOf(intent),
        paymentIntentId: attempt.payment_intent_id,
        paymentAttemptId: attempt.id,
        orderId: intent.order_id ?? null,
        subscriptionId: intent.subscription_id ?? null,
        subscriptionCycleId: intent.subscription_cycle_id ?? null,
        providerPaymentId: null,
        reason: intent.target_kind === "subscription_cycle"
          ? "prepared_subscription_attempt_without_provider_ack"
          : "prepared_attempt_without_provider_ack",
        ageSeconds: secondsBetween(localUpdatedAt, now),
        owner: "commerce/payment",
        customerSafeStatus: "operator_review_required",
        operatorNextAction: "inspect_provider_before_retry",
        observedAt: now.toISOString(),
      });
    }
    if (!hasStrongerMismatch && !hasEvent && ACTIVE_PROVIDER_ATTEMPT_STATUSES.has(attempt.status) && localUpdatedAt <= webhookCutoff) {
      evidence.push({
        kind: "webhook_missing" as const,
        provider: providerOf(attempt),
        paymentIntentId: attempt.payment_intent_id,
        paymentAttemptId: attempt.id,
        providerPaymentId: maskProviderReference(attempt.provider_payment_id ?? attempt.provider_attempt_id),
        reason: "active_provider_attempt_without_inbound_event",
        observedAt: now.toISOString(),
      });
    }
    if (!hasStrongerMismatch && ACTIVE_PROVIDER_ATTEMPT_STATUSES.has(attempt.status) && localUpdatedAt <= staleCutoff) {
      evidence.push({
        kind: "stuck_processing" as const,
        provider: providerOf(attempt),
        paymentIntentId: attempt.payment_intent_id,
        paymentAttemptId: attempt.id,
        providerPaymentId: maskProviderReference(attempt.provider_payment_id ?? attempt.provider_attempt_id),
        reason: "attempt_processing_beyond_watchdog_window",
        observedAt: now.toISOString(),
      });
    }
  }

  for (const event of events) {
    const intent = event.payment_intent_id ? intentById.get(event.payment_intent_id) : undefined;
    const coveredByReconciliationMismatch = [...mismatchAttemptIds].some((attemptId) => {
      const attempt = attemptById.get(attemptId);
      return attempt ? providerRefMatches(event, attempt) : false;
    });
    if (intent && !coveredByReconciliationMismatch && (
      (event.amount_cents != null && intent.amount_cents != null && event.amount_cents !== intent.amount_cents) ||
      (event.currency && intent.currency && event.currency.toUpperCase() !== intent.currency.toUpperCase())
    )) {
      evidence.push(paymentEvidence("amount_currency_mismatch", event, "provider_event_amount_currency_mismatch", now));
    }
    if (event.signature_verified === false || readErrorReason(event).includes("signature")) {
      evidence.push(paymentEvidence("signature_failure", event, "signature_rejected", now));
    }
  }

  return {
    providerPaidLocalUnpaidCount: evidence.filter((row) => row.kind === "provider_paid_local_unpaid").length,
    localPaidProviderUnpaidCount: evidence.filter((row) => row.kind === "local_paid_provider_unpaid").length,
    preparedWithoutProviderAckCount: evidence.filter((row) => row.kind === "prepared_without_provider_ack").length,
    webhookMissingCount: evidence.filter((row) => row.kind === "webhook_missing").length,
    stuckProcessingCount: evidence.filter((row) => row.kind === "stuck_processing").length,
    amountCurrencyMismatchCount: evidence.filter((row) => row.kind === "amount_currency_mismatch").length,
    signatureFailureCount: evidence.filter((row) => row.kind === "signature_failure").length,
    recoveryRequiredWithoutLinkCount: evidence.filter((row) => row.kind === "recovery_missing").length,
    evidence,
  };
}

function providerRefMatches(event: PaymentEventEvidenceRow, attempt: PaymentAttemptEvidenceRow): boolean {
  return Boolean(
    (event.payment_attempt_id && event.payment_attempt_id === attempt.id) ||
    (event.provider_payment_id && (
      event.provider_payment_id === attempt.provider_payment_id ||
      event.provider_payment_id === attempt.provider_attempt_id ||
      event.provider_payment_id === attempt.provider_session_id
    )),
  );
}

function paymentEvidence(
  kind: PaymentEventKind,
  event: PaymentEventEvidenceRow,
  reason: string,
  now: Date,
): PaymentObservabilityEvidence {
  return {
    kind,
    provider: event.provider_kind ?? event.provider ?? null,
    paymentIntentId: event.payment_intent_id ?? null,
    paymentAttemptId: event.payment_attempt_id ?? null,
    providerPaymentId: maskProviderReference(event.provider_payment_id),
    providerEventId: event.provider_event_id ?? null,
    reason,
    observedAt: now.toISOString(),
  };
}

function isPreparedWithoutProviderAck(
  attempt: PaymentAttemptEvidenceRow,
  intent: PaymentIntentEvidenceRow,
  createdAt: number,
  staleCutoff: number,
): boolean {
  return (
    ["one_time_order", "subscription_cycle"].includes(intent.target_kind ?? "") &&
    ["requires_action", "processing"].includes(intent.status) &&
    attempt.status === "created" &&
    ["stripe", "tpay"].includes(providerOf(attempt) ?? "") &&
    !attempt.provider_attempt_id &&
    !attempt.provider_session_id &&
    !intent.provider_payment_id &&
    createdAt <= staleCutoff
  );
}

function providerOf(row: { provider_kind?: string | null; provider?: string | null }): string | null {
  return row.provider_kind ?? row.provider ?? null;
}
