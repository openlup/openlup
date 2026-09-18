import type {
  AlertDecision,
  ObservabilitySnapshot,
  PaymentEvidenceKind,
  PaymentMismatchEvidence,
} from "./observabilityContracts.js";
import type { AlertHumanContext } from "./alertHumanContext.js";
import { urgencyForSeverity } from "./alertHumanContext.js";
import { maskProviderReference } from "./observabilityRedaction.js";

// Flag-independent: a leaked checkout hold means stock is locked AND the order
// is stranded in `pending_payment` with no recovery email — a data-integrity
// problem regardless of whether reservation-sweep is "enabled". Runs outside the
// PSP-observability gate so a disabled/stalled sweep can never go silent.
export function collectReservationLeakAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  const leaked = snapshot.payments.leakedCheckoutReservationCount ?? 0;
  if (leaked > 0) {
    decisions.push({
      dedupeKey: "checkout_reservation_leak",
      severity: "p1",
      owner: "commerce/payment",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Checkout reservation holds leaked",
      message: `${leaked} checkout payment-window reservation(s) are still reserved past expiry — commerce-reservation-sweep is not releasing holds, so stranded orders get no payment-failed email and stock stays locked.`,
      channels: ["webhook"],
      payload: { leakedCheckoutReservationCount: leaked },
    });
  }

  const retryLeaked = snapshot.payments.leakedSubscriptionRetryReservationCount ?? 0;
  if (retryLeaked > 0) {
    decisions.push({
      dedupeKey: "subscription_retry_reservation_leak",
      severity: "p1",
      owner: "commerce/subscription-support",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Subscription retry reservation holds leaked",
      message: `${retryLeaked} subscription retry-window reservation(s) are still reserved past expiry. Remediation is release-only: the owning subscription must stay active and its dunning case must stay open.`,
      channels: ["webhook"],
      payload: { leakedSubscriptionRetryReservationCount: retryLeaked },
    });
  }

  const driftCount = snapshot.payments.reservedBalanceDriftCount ?? 0;
  if (driftCount > 0) {
    decisions.push({
      dedupeKey: "inventory_reserved_balance_drift",
      severity: "p1",
      owner: "commerce/payment",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      title: "Materialized reserved balance drifts from live leases",
      message: `${driftCount} inventory balance slot(s) have reserved counts that disagree with live reservation leases — the ATP read-model is showing false stock levels (sold-out or oversell risk) even if runtime availability is correct.`,
      channels: ["webhook"],
      payload: {
        reservedBalanceDriftCount: driftCount,
        evidence: (snapshot.payments.reservedBalanceDriftEvidence ?? []).slice(0, 10),
      },
    });
  }
}

// Flag-independent guard for the PSP gate itself: when the reconciliation flag
// is OFF, the granular gated alerts above never fire, so stranded attempts
// (prepared without ack, webhook missing, stuck processing) would be invisible
// exactly when the mechanism that repairs them is disabled. Fires only while
// the flag is off — with the flag on, the granular alerts own the signal.
export function collectStrandedPaymentAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  if (snapshot.runtimeFlags.COMMERCE_PSP_OBSERVABILITY_ENABLED === true) return;
  const stranded =
    (snapshot.payments.preparedWithoutProviderAckCount ?? 0) +
    snapshot.payments.webhookMissingCount +
    snapshot.payments.stuckProcessingCount;
  if (stranded <= 0) return;
  decisions.push({
    dedupeKey: "payment_attempt_stranded",
    severity: "p1",
    owner: "commerce/payment",
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    title: "Stranded payment attempts while PSP reconciliation is disabled",
    message: `${stranded} payment attempt(s) are stranded (no provider ack, missing webhook, or stuck processing) and COMMERCE_PSP_OBSERVABILITY_ENABLED is off, so nothing will reconcile them.`,
    channels: ["webhook"],
    payload: {
      strandedCount: stranded,
      preparedWithoutProviderAckCount: snapshot.payments.preparedWithoutProviderAckCount ?? 0,
      webhookMissingCount: snapshot.payments.webhookMissingCount,
      stuckProcessingCount: snapshot.payments.stuckProcessingCount,
    },
  });
}

// ⛔ FLAG-INDEPENDENT, AND THAT IS THE WHOLE REPAIR.
//
// The card dead-end incident happened with `COMMERCE_PSP_OBSERVABILITY_ENABLED`
// switched ON, and still produced no signal: the two failures below fell between
// the gated detectors' predicates. Putting their replacements behind the same
// gate would rebuild the single point of silence one layer down, so these two
// live outside `collectPaymentAlerts` entirely and no runtime flag can reach
// them.
//
// Counted out of `snapshot.payments.evidence` rather than from snapshot counters
// of their own: the evidence array is already the authority those counters
// summarize, so a second derived number would only be a thing that can disagree
// with it.
export function collectCardDeadEndPaymentAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  pushEvidenceAlert(
    decisions, snapshot, "abandoned_before_confirmation",
    "Payments settled because nobody ever tried to pay them",
    "The reconciler read each of these intents as awaiting a payment method with no issuer error and no charge, and settled it: the buyer reached the payment step and never confirmed. This counts BUYERS WHO LEFT, not system faults — treat a rise as a checkout-usability emergency, not a provider incident, and do not retry anything.",
  );
  pushEvidenceAlert(
    decisions, snapshot, "pending_payment_past_recovery_window",
    "Unpaid order outlived the checkout recovery rail",
    "The order is still awaiting payment past the 24h ceiling of enqueue_checkout_recovery_reminders, so the buyer will never be contacted again and nothing else is watching the row. On the first run after this detector ships, expect the accumulated historical backlog rather than a new event.",
  );
}

function pushEvidenceAlert(
  decisions: AlertDecision[],
  snapshot: ObservabilitySnapshot,
  kind: PaymentEvidenceKind,
  title: string,
  message: string,
) {
  const rows = snapshot.payments.evidence.filter((row) => row.kind === kind);
  if (rows.length === 0) return;
  decisions.push({
    dedupeKey: kind === "abandoned_before_confirmation"
      ? "payment_abandoned_before_confirmation"
      : "order_pending_payment_past_recovery_window",
    severity: "p1",
    owner: "commerce/payment",
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    title,
    message: `${title}: ${rows.length} row(s) require operator review. ${message}`,
    channels: ["webhook"],
    payload: { kind, count: rows.length, evidence: rows.slice(0, 10).map(sanitizePaymentEvidence) },
  });
}

export function collectPaymentAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  if (snapshot.runtimeFlags.COMMERCE_PSP_OBSERVABILITY_ENABLED !== true) return;
  pushPaymentAlert(decisions, snapshot, "provider_paid_local_unpaid", snapshot.payments.providerPaidLocalUnpaidCount, "Provider paid but local payment is unpaid", "p0");
  pushPaymentAlert(decisions, snapshot, "local_paid_provider_unpaid", snapshot.payments.localPaidProviderUnpaidCount, "Local payment is paid but provider is unpaid", "p0");
  // Two prepared attempts with no acknowledgement is a rail that stopped
  // answering, so nobody can pay at all; one is a single buyer stuck on an
  // otherwise healthy rail. Hence p0 from 2 and p1 at 1.
  pushPaymentAlert(decisions, snapshot, "prepared_without_provider_ack", snapshot.payments.preparedWithoutProviderAckCount ?? 0, "Prepared payment lacks provider acknowledgement", "p1", { p0AtCount: 2 });
  pushPaymentAlert(decisions, snapshot, "webhook_missing", snapshot.payments.webhookMissingCount, "Provider webhook missing", "p1");
  pushPaymentAlert(decisions, snapshot, "stuck_processing", snapshot.payments.stuckProcessingCount, "Payment stuck processing", "p1");
  pushPaymentAlert(decisions, snapshot, "amount_currency_mismatch", snapshot.payments.amountCurrencyMismatchCount, "Payment amount or currency mismatch", "p0");
  // A single one is already p0: the rail confirmed an event and we refused it,
  // so money may be taken with nothing to show for it on our side.
  pushPaymentAlert(decisions, snapshot, "signature_failure", snapshot.payments.signatureFailureCount, "Payment webhook signature failures", "p0");
  pushPaymentAlert(decisions, snapshot, "recovery_missing", snapshot.payments.recoveryRequiredWithoutLinkCount, "Payment recovery path missing", "p1");
}

function pushPaymentAlert(
  decisions: AlertDecision[],
  snapshot: ObservabilitySnapshot,
  kind: PaymentEvidenceKind,
  count: number,
  title: string,
  severity: "p0" | "p1",
  // `p0AtCount` raises this kind to p0 once the count reaches the threshold, so
  // a volume that means "the rail is down" pages while a single row does not.
  options: { p0AtCount?: number } = {},
) {
  if (count <= 0) return;
  const effectiveSeverity = options.p0AtCount !== undefined && count >= options.p0AtCount ? "p0" : severity;
  const humanContext = paymentHumanContext(kind, effectiveSeverity);
  decisions.push({
    dedupeKey: `payment_${kind}`,
    severity: effectiveSeverity,
    owner: "commerce/payment",
    runbookUrl: "/docs/platform/CANONICAL_CONTRACTS.md",
    title,
    message: `${title}: ${count} evidence row(s) require operator review.`,
    ...(humanContext ? { humanContext } : {}),
    channels: ["webhook"],
    payload: {
      kind,
      count,
      evidence: snapshot.payments.evidence
        .filter((row) => row.kind === kind)
        .slice(0, 10)
        .map(sanitizePaymentEvidence),
    },
  });
}

// Operator context for the two kinds this evaluator can page on. The other
// kinds are left exactly as they were, payload and all.
function paymentHumanContext(kind: PaymentEvidenceKind, severity: "p0" | "p1"): AlertHumanContext | undefined {
  if (kind === "signature_failure") {
    return {
      incidentClass: "data_integrity",
      impact: "A payment rail confirmed an event and we refused it. Money may already be taken from the buyer while our side has nothing to show for it, and every further event on that rail is being dropped the same way.",
      firstAction: "Compare the rejected event references in the payload against the rail dashboard, then check the webhook signing secret configured for the environment that received them. Do not replay anything until the secret matches.",
      urgency: urgencyForSeverity(severity),
    };
  }
  if (kind === "prepared_without_provider_ack") {
    return {
      incidentClass: "data_integrity",
      impact: severity === "p0"
        ? "Several prepared payments never got an acknowledgement back from the rail: the rail is disconnected, so nobody can complete a purchase or a renewal."
        : "One prepared payment never got an acknowledgement back from the rail. One buyer is stuck; the rail itself still looks reachable.",
      firstAction: "Take the prepared attempts in the payload to the rail and confirm whether it saw them, then verify the payment provider credentials and outbound reachability from the runtime.",
      urgency: urgencyForSeverity(severity),
    };
  }
  return undefined;
}

function sanitizePaymentEvidence(row: PaymentMismatchEvidence): PaymentMismatchEvidence {
  return {
    kind: row.kind,
    provider: row.provider ?? null,
    paymentIntentId: row.paymentIntentId ?? null,
    paymentAttemptId: row.paymentAttemptId ?? null,
    orderId: row.orderId ?? null,
    subscriptionId: row.subscriptionId ?? null,
    subscriptionCycleId: row.subscriptionCycleId ?? null,
    providerPaymentId: maskProviderReference(row.providerPaymentId),
    providerEventId: row.providerEventId ?? null,
    ageSeconds: row.ageSeconds,
    owner: row.owner,
    customerSafeStatus: row.customerSafeStatus,
    operatorNextAction: row.operatorNextAction,
    reason: row.reason,
    observedAt: row.observedAt,
  };
}
