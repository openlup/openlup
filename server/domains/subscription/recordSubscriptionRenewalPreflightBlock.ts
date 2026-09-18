import type { PaymentControlRuntimePort } from "../../../src/domains/commerce/ports.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import { buildExecutionIdempotencyKey } from "./chargeSubscriptionCycleOffSessionHelpers.js";
import type {
  DueSubscription,
  SubscriptionRenewalPersistencePort,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";
import {
  propagateSubscriptionCycleChargeFailure,
  type CycleChargeFailurePropagationPort,
} from "./propagateSubscriptionCycleChargeFailure.js";
import type { SubscriptionPaymentMethodPreflightReason } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import { acceptedCycleCurrency } from "./subscriptionCycleOrderTotals.js";

export interface RenewalPreflightBlockDeps {
  persistence: SubscriptionRenewalPersistencePort;
  chargeFailurePropagation: CycleChargeFailurePropagationPort;
  paymentPort: PaymentControlRuntimePort;
  now?: () => string;
}

/**
 * Preflight reasons that must be handled by operators instead of customer
 * dunning. Provider/config reasons mean the PSP adapter is disabled, the
 * provider kind is unknown. Integrity
 * reasons mean local payment-method evidence is suspicious or unsupported by
 * the current resolver. In both cases the customer's next email must not be a
 * misleading "your payment failed" recovery email.
 *
 * Instead they leave a durable, watchdog-monitored operator signal WITHOUT
 * touching the customer: by returning without creating a cycle order, the due
 * subscription stays order-less past its `next_cycle_at`, which the platform
 * watchdog surfaces as the durable `subscription_cycle_due_without_order` p1
 * alert (webhook → ops, auto-resolving once the config is fixed and orders are
 * created). The renewal cron additionally records the specific provider/reason
 * + count into the `platform_job_runs` ledger so an operator triaging that
 * alert sees exactly what to fix. The `console.warn` below is only a real-time
 * breadcrumb, not the load-bearing signal.
 *
 * Customer-data reasons (`missing_provider_method_ref`,
 * `payment_method_revoked`, `payment_method_requires_action`,
 * `payment_method_invalid`, `tpay_recurring_*`, `tpay_payer_missing`) are
 * genuinely customer-actionable and keep the full durable dunning path.
 */
// Typed with `satisfies` so a typo or a reason removed from the union fails the
// build; the runtime `Set<string>` keeps `.has(reason: string)` ergonomic for
// callers that pass an unvalidated reason string. A test
// (recordSubscriptionRenewalPreflightBlock.test.ts) pins these against the full
// SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS list so a newly-added reason
// cannot silently default into customer dunning.
const OPERATOR_CONFIG_PREFLIGHT_REASONS = new Set<string>([
  "stripe_provider_not_configured",
  "tpay_provider_not_configured",
  "subscription_provider_not_supported",
] satisfies SubscriptionPaymentMethodPreflightReason[]);
const PAYMENT_METHOD_INTEGRITY_PREFLIGHT_REASONS = new Set<string>([
  "payment_method_cross_client",
  "payment_method_unhandled_status",
] satisfies SubscriptionPaymentMethodPreflightReason[]);

export function isOperatorConfigPreflightReason(reason: string): boolean {
  return OPERATOR_CONFIG_PREFLIGHT_REASONS.has(reason);
}

export function isPaymentMethodIntegrityPreflightReason(reason: string): boolean {
  return PAYMENT_METHOD_INTEGRITY_PREFLIGHT_REASONS.has(reason);
}

export function isOperatorOnlyPreflightReason(reason: string): boolean {
  return isOperatorConfigPreflightReason(reason) || isPaymentMethodIntegrityPreflightReason(reason);
}

export async function recordSubscriptionRenewalPreflightBlock(
  deps: RenewalPreflightBlockDeps,
  due: DueSubscription,
  reason: string,
): Promise<SubscriptionRenewalChargeResult> {
  if (isOperatorOnlyPreflightReason(reason)) {
    // This branch deliberately persists nothing — no cycle order, no intent, no
    // attempt, no dunning case — so there is no column to stamp and no class to
    // record. All five operator-only reasons classify `indeterminate` anyway:
    // they say the adapter is disabled or the stored evidence is unreadable,
    // neither of which is a statement about whether the payer's instrument may
    // be charged again.
    console.warn(
      "[subscription-renewal] operator-only preflight block; skipping customer dunning",
      { subscriptionId: due.subscriptionId, providerKind: due.providerKind, reason },
    );
    return failed(due, null, null, null, null, reason);
  }

  const snapshots = await deps.persistence.buildCycleSnapshots({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
  });
  const totalGrossMinor = readTotalGrossMinor(snapshots.orderSnapshot);
  if (totalGrossMinor === null) {
    return failed(due, null, snapshots.cycleNumber, null, null, "invalid_totals");
  }

  const cycleKey = `subscription:${due.subscriptionId}:cycle:${due.nextCycleAt}`;
  const cycleOrder = await deps.persistence.createCycleOrder({
    idempotencyKey: cycleKey,
    subscriptionId: due.subscriptionId,
    cycleNumber: snapshots.cycleNumber,
    scheduledAt: due.nextCycleAt,
    templateSnapshot: snapshots.templateSnapshot,
    pricingSnapshot: snapshots.pricingSnapshot,
    orderSnapshot: snapshots.orderSnapshot,
  });
  const intent = await deps.paymentPort.createIntent({
    idempotencyKey: `${cycleKey}:payment-intent`,
    targetKind: "subscription_cycle",
    orderId: cycleOrder.orderUuid,
    subscriptionId: due.subscriptionId,
    subscriptionCycleId: cycleOrder.cycleId,
    amountMinor: totalGrossMinor,
    currency: acceptedCycleCurrency(due.currency),
    metadata: {
      source: "subscription.renewal.preflight.v0",
      runtimeIdempotencyKey: cycleKey,
      cycleNumber: snapshots.cycleNumber,
      scheduledAt: due.nextCycleAt,
      preflightBlockReason: reason,
    },
  });
  // Retry-scoped, in the charge path's own words: "Provider execution keys are
  // scoped by `retry_attempt`; local order/intent keys stay stable. (CJ01-P)".
  // A cycle-only key here made every later tick a replay of the first — the same
  // attempt row, the same applied result, the same dunning key — so the ladder
  // never advanced past its first rung. `snapshots.retryAttempt` is the cycle's
  // CURRENT attempt, read before the order is created exactly as the charge path
  // reads it, so the two paths mint the same key for the same rung.
  const executionKey = buildExecutionIdempotencyKey(
    cycleKey, snapshots.retryAttempt, snapshots.providerAttemptSequence,
  );
  const attempt = buildProviderAttemptIdentity({
    provider: normalizedProviderKind(due.providerKind),
    localExecutionIdempotencyKey: executionKey,
    paymentIntentId: intent.paymentIntentId,
    amountMinor: totalGrossMinor,
    currency: due.currency,
    mode: "subscription_cycle",
    orderRef: cycleOrder.orderRef,
  });
  // No `failureClassification` is passed, and that is the classification, not
  // the absence of one. A preflight block holds no refusal evidence — nobody
  // asked a rail — so the reason key IS the whole evidence, and the propagation
  // derives the class from it through the shared resolver (kernel table plus the
  // neutral hints the reason's own module publishes). Supplying a verdict here
  // would be this call site inventing one, which is exactly what the class must
  // not be now that the retry ladder reads it. The derived class reaches the
  // attempt on the terminal `applyFailedResult` call — the write that makes the
  // outcome failed — and the same value is stamped on the dunning case, so no
  // later pass patches a row that was already terminal.
  // Pinned end-to-end, per reason, in this module's characterization test.
  const propagation = await propagateSubscriptionCycleChargeFailure(deps.chargeFailurePropagation, {
    kind: "preflight_block",
    executionIdempotencyKey: executionKey,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    providerRequestFingerprint: attempt.providerRequestFingerprint,
    paymentIntentId: intent.paymentIntentId,
    cycleId: cycleOrder.cycleId,
    subscriptionId: due.subscriptionId,
    orderUuid: cycleOrder.orderUuid,
    providerKind: normalizedProviderKind(due.providerKind),
    failureReason: reason,
    occurredAt: (deps.now ?? (() => new Date().toISOString()))(),
  });

  return failed(
    due,
    cycleOrder.cycleId,
    snapshots.cycleNumber,
    cycleOrder.orderUuid,
    intent.paymentIntentId,
    reason,
    propagation,
  );
}

function normalizedProviderKind(providerKind: string | null | undefined): string {
  const normalized = providerKind?.trim();
  return normalized ? normalized : "unknown";
}

function readTotalGrossMinor(orderSnapshot: Record<string, unknown>): number | null {
  const totals = orderSnapshot.totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
  const totalGross = (totals as Record<string, unknown>).totalGross;
  if (!totalGross || typeof totalGross !== "object" || Array.isArray(totalGross)) return null;
  const amount = (totalGross as Record<string, unknown>).amountMinor;
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0 ? amount : null;
}

function failed(
  due: DueSubscription,
  cycleId: string | null,
  cycleNumber: number | null,
  orderId: string | null,
  paymentIntentId: string | null,
  reason: string,
  propagation?: {
    dunningCaseId: string | null;
    retryAttempt: number | null;
    applyReplayed?: boolean;
    dunningPropagationFailed?: boolean;
  },
): SubscriptionRenewalChargeResult {
  return {
    subscriptionId: due.subscriptionId,
    outcome: "failed",
    cycleId,
    cycleNumber,
    orderId,
    paymentIntentId,
    attemptStatus: propagation ? "failed" : null,
    replayed: false,
    dunningCaseId: propagation?.dunningCaseId ?? null,
    retryAttempt: propagation?.retryAttempt ?? null,
    // This is THE path the live incident runs through, so its replay marker is
    // the one the quarantine actually depends on reaching the batch.
    applyReplayed: propagation?.applyReplayed,
    dunningPropagationFailed: propagation?.dunningPropagationFailed,
    reason,
  };
}
