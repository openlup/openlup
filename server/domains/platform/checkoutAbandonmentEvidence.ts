import { maskProviderReference } from "../../../src/domains/platform/observabilityRedaction.js";
import { latestTimestamp, secondsBetween } from "./paymentObservabilityEvidenceHelpers.js";
import {
  PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES,
  type PaymentIntentEvidenceRow,
  type PaymentObservabilityEvidence,
  type PaymentReconciliationEvidenceRow,
} from "./paymentObservabilityEvidence.js";

/**
 * THE FATE OF AN UNFINISHED CHECKOUT — the two detectors born from the
 * 2026-08-27 card dead-end review.
 *
 * Separate from `paymentRecoveryEvidence.ts` because the question is different.
 * That module asks "was this payment offered A WAY BACK", and every predicate in
 * it is about the existence of a rescue rail. These two ask what BECAME of a
 * checkout nobody finished: one counts payments the reconciler settled because
 * the buyer never confirmed, the other counts orders that outlived the rescue
 * rail entirely. Neither reads a recovery token or a dunning case.
 *
 * The split follows the precedent that created the sibling module: when the
 * 300-line cap is reached, this tree extracts a cohesive detector group rather
 * than raising a shrink-only pin — see `docs/plan/payment-decline-terminal-signal.md`.
 */
/**
 * One `commerce_orders` row still sitting in `pending_payment`, narrowed to the
 * two columns the recovery-window detector reads. Declared here rather than
 * imported from the adapter so the domain keeps owning its own read shape.
 *
 * ⛔ `mode` is deliberately absent: it was selected and never read, and the claim
 * is rail-agnostic — "nobody chased this buyer" is true of a one-time order and a
 * subscription first cycle alike. A selected column no predicate consults is a
 * false lead about what the detector considers.
 */
export type PendingPaymentOrderEvidenceRow = Record<string, unknown> & {
  id: string;
  created_at?: string | null;
};

/**
 * The disposition the reconciler writes when it settles a payment nobody refused.
 *
 * ⛔ A STRING LITERAL, not an import: a platform domain module may not import a
 * named provider adapter, and the value reaches here through the run's durable
 * payload, a provider-neutral carrier. Only the token is shared.
 *
 * EXPORTED so the equality can be asserted from the ADAPTER's own test, which is
 * where that assertion belongs twice over: the adapter owns the value, and naming
 * a vendor inside `server/domains/**` is a counted OSS-ratchet token, whereas
 * `server/adapters/**` is excluded. A rename on either side fails there.
 */
export const ABANDONED_BEFORE_CONFIRMATION = "abandoned_before_confirmation";

/**
 * The recovery rail's own ceiling, plus grace.
 *
 * `enqueue_checkout_recovery_reminders` bounds its candidate scope with
 * `o.created_at > now() - interval '24 hours'`. An order older than that has
 * fallen out of the only rail that was going to contact the buyer, and no other
 * detector in this file looks at order age at all. The two extra hours keep the
 * signal off a row the 20h reminder might still be working on.
 */
const PENDING_PAYMENT_RECOVERY_WINDOW_HOURS = 26;

/**
 * Payments that ended because nobody ever tried to pay them.
 *
 * ⛔ COUNTS A DURABLE OUTCOME, NOT AN AGE, and that difference is the whole
 * lesson of the wave that shipped it. The first version asked "is an
 * acknowledged attempt still unconfirmed 45 minutes later"; an adversarial review
 * proved that unreachable — the reconciliation worker is eligible to claim exactly those statuses
 * and acknowledgement columns; adopters must schedule it with a maximum 30-minute lag so it terminalises no later than 45 minutes after acknowledgement, so the
 * window opened where the cron closed the row. The five facts and their sources
 * are tabulated under `payment_abandoned_before_confirmation` in
 * `docs/platform/RUNTIME_AND_SELF_HOSTING.md`, which owns this semantics.
 *
 * What IS always observable is what the reconciler CONCLUDED: reading an intent
 * that is `requires_payment_method` with no error and no charge, it stamps
 * `nonDeclineDisposition = abandoned_before_confirmation` into the run's durable
 * payload — written once, never expiring, so this detector cannot be raced by
 * the mechanism that resolves the state.
 *
 * ⛔ DEDUPED BY ATTEMPT. Run rows are idempotency-keyed per 30-minute bucket, so
 * one payment leaves several — an observed row per pass plus the apply row.
 * Counting rows would report one buyer as many. Same `seenAttempts` idiom
 * `collectReconciliationMismatchEvidence` uses on the same table.
 *
 * ⛔ FLAG-INDEPENDENT: the incident was invisible while
 * `COMMERCE_PSP_OBSERVABILITY_ENABLED` was ON, so gating the repair behind the
 * same flag would rebuild the single point of silence one layer down.
 *
 * ⚠️ Counts BUYERS WHO LEFT, not system faults — 14 of 14 failed card payments in
 * 60 days. When that rate falls, the threshold is the knob, not this predicate.
 */
export function collectAbandonedBeforeConfirmationEvidence(
  reconciliationRuns: PaymentReconciliationEvidenceRow[],
  intentById: Map<string, PaymentIntentEvidenceRow>,
  now: Date,
): PaymentObservabilityEvidence[] {
  const seenAttempts = new Set<string>();
  const evidence: PaymentObservabilityEvidence[] = [];
  for (const row of reconciliationRuns) {
    if (dispositionOf(row) !== ABANDONED_BEFORE_CONFIRMATION) continue;
    // A row with no attempt link cannot be deduped against its siblings, so
    // counting it would risk exactly the multiple-count this guards against.
    const paymentAttemptId = row.payment_attempt_id ?? null;
    if (!paymentAttemptId || seenAttempts.has(paymentAttemptId)) continue;
    seenAttempts.add(paymentAttemptId);
    const intent = row.payment_intent_id ? intentById.get(row.payment_intent_id) : undefined;
    const checkedAt = latestTimestamp(row.checked_at);
    evidence.push({
      kind: "abandoned_before_confirmation" as const,
      provider: row.provider ?? null,
      paymentIntentId: row.payment_intent_id ?? null,
      paymentAttemptId,
      orderId: intent?.order_id ?? null,
      subscriptionId: intent?.subscription_id ?? null,
      subscriptionCycleId: intent?.subscription_cycle_id ?? null,
      providerPaymentId: maskProviderReference(row.provider_payment_id),
      reason: "reconciler_settled_payment_never_confirmed_by_buyer",
      ageSeconds: checkedAt === 0 ? undefined : secondsBetween(checkedAt, now),
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      observedAt: now.toISOString(),
    });
  }
  return evidence;
}

/**
 * ⛔ The nesting is load-bearing and is NOT `payload.nonDeclineDisposition`. The
 * worker stores `evidencePayload(...)`, which carries the provider's own
 * `rawPayload` under `providerPayload`, so the disposition lands two levels down.
 * The shallow path compiles, type-checks, and matches nothing — the same species
 * of always-empty detector this signal replaced. Pinned by the companion test.
 */
function dispositionOf(row: PaymentReconciliationEvidenceRow): string | null {
  const providerPayload = row.payload?.providerPayload;
  if (typeof providerPayload !== "object" || providerPayload === null) return null;
  const disposition = (providerPayload as Record<string, unknown>).nonDeclineDisposition;
  return typeof disposition === "string" ? disposition : null;
}

/**
 * An unpaid order that has outlived the only rail that was going to chase it.
 *
 * The recovery reminders stop at 24 hours by their own SQL bound. Past that the
 * order is not expired, not failed, and not worked on by anything — simply
 * `pending_payment` forever, with the buyer never contacted again. The incident's
 * own order is in that state, and so is a subscription waiting since July.
 *
 * ⛔ EXPECT A BACKLOG ON THE FIRST RUN: nothing has ever counted these rows, so
 * the first pass reports accumulated history, not a new event. That backlog IS
 * the finding — the runbook says so, so it is not muted as an outage.
 *
 * Flag-independent for the same reason as its sibling above: the silence being
 * repaired happened with every relevant flag switched on.
 */
export function collectPendingPaymentPastRecoveryWindowEvidence(
  orders: PendingPaymentOrderEvidenceRow[],
  intents: PaymentIntentEvidenceRow[],
  now: Date,
): PaymentObservabilityEvidence[] {
  const cutoff = now.getTime() - PENDING_PAYMENT_RECOVERY_WINDOW_HOURS * 60 * 60 * 1000;
  // `commerce_payment_intents` is UNIQUE on `order_id`, so one intent per order
  // and this map cannot lose a row to a collision.
  const intentByOrderId = new Map(
    intents.filter((row) => row.order_id).map((row) => [row.order_id as string, row]),
  );
  const evidence: PaymentObservabilityEvidence[] = [];
  for (const order of orders) {
    // `commerce_orders.created_at` is NOT NULL, so a zero here means the READ
    // dropped the column, not that the order is ancient. Treating that as
    // evidence would turn a select-list mistake into a page about every unpaid
    // order in the table.
    const createdAt = latestTimestamp(order.created_at);
    if (createdAt === 0 || createdAt > cutoff) continue;
    const intent = intentByOrderId.get(order.id);
    // An order left behind in `pending_payment` while its money landed is a
    // DIFFERENT and worse defect, owned by the local/provider agreement
    // detectors. Saying "nobody chased this buyer" about a buyer who paid would
    // be the same class of untrue alert this wave exists to stop producing.
    if (intent && PROVIDER_SUCCESS_CONSISTENT_INTENT_STATUSES.has(intent.status)) continue;

    evidence.push({
      kind: "pending_payment_past_recovery_window" as const,
      provider: intent ? intent.provider_kind ?? intent.provider ?? null : null,
      paymentIntentId: intent?.id ?? null,
      orderId: order.id,
      subscriptionId: intent?.subscription_id ?? null,
      subscriptionCycleId: intent?.subscription_cycle_id ?? null,
      reason: "pending_payment_order_outlived_recovery_reminders",
      ageSeconds: secondsBetween(createdAt, now),
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      observedAt: now.toISOString(),
    });
  }
  return evidence;
}
