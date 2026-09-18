import type {
  SubscriptionDeliveryAlignmentOverdueEvidence,
  SubscriptionDueCycleWithoutOrderEvidence,
  SubscriptionHealthSnapshot,
  SubscriptionPaidRenewalWithoutFulfillmentEvidence,
} from "../../../src/domains/platform/observabilityContracts.js";
import type { FulfillmentOrderEvidenceRow } from "./accountingObservabilityEvidence.js";
import type { OutboxEventEvidenceRow } from "./outboxObservabilityEvidence.js";
import {
  buildDueCycleTriageContext,
  buildPaidFulfillmentTriageContext,
  isoOrNull,
  latestBy,
} from "./subscriptionRenewalTriageContext.js";

export type SubscriptionEvidenceRow = Record<string, unknown> & {
  id: string;
  status?: string | null;
  client_id?: string | null;
  next_cycle_at?: string | null;
  template_version?: number | string | null;
  // Arrives with the port's select("*"). Only the pageable escalation reads it:
  // a seeded row must never wake anyone, while the p1 keeps counting it.
  is_test_fixture?: boolean | null;
};

// Chargeable-mandate evidence rows: pre-filtered by the port to the shape the
// renewal due-RPC accepts (subscription-scoped, active=true, status='active').
export type PaymentMethodRefEvidenceRow = Record<string, unknown> & {
  subscription_id?: string | null;
  client_id?: string | null;
  status?: string | null;
  active?: boolean | null;
};

export type SubscriptionCycleEvidenceRow = Record<string, unknown> & {
  id?: string | null;
  subscription_id: string;
  status: string;
  order_id?: string | null;
  scheduled_at?: string | null;
  template_version?: number | string | null;
  renewal_quarantined_until?: string | null;
};

export type SubscriptionEventEvidenceRow = Record<string, unknown> & {
  subscription_id: string;
  event_type: string;
};

export type SubscriptionOrderEvidenceRow = Record<string, unknown> & {
  id: string;
  status?: string | null;
  mode?: string | null;
  subscription_id?: string | null;
  subscription_cycle_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SubscriptionPaymentIntentEvidenceRow = Record<string, unknown> & {
  order_id?: string | null;
  subscription_id?: string | null;
  subscription_cycle_id?: string | null;
  target_kind?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type DeliveryAlignmentCaseEvidenceRow = Record<string, unknown> & {
  subscription_id?: string | null;
  state?: string | null;
  observed_next_cycle_at?: string | null;
};

export function summarizeSubscriptionEvidence(
  subscriptions: SubscriptionEvidenceRow[],
  cycles: SubscriptionCycleEvidenceRow[],
  events: SubscriptionEventEvidenceRow[],
  orders: SubscriptionOrderEvidenceRow[],
  fulfillmentOrders: FulfillmentOrderEvidenceRow[],
  now: Date,
  paymentIntents: SubscriptionPaymentIntentEvidenceRow[] = [],
  orderPaidOutboxEvents: OutboxEventEvidenceRow[] = [],
  paymentMethodRefs: PaymentMethodRefEvidenceRow[] = [],
  deliveryAlignmentCases: DeliveryAlignmentCaseEvidenceRow[] = [],
): SubscriptionHealthSnapshot {
  const eventBySubscription = groupBy(events, (row) => row.subscription_id);
  const upcomingCutoff = now.getTime() + 3 * 24 * 60 * 60 * 1000;
  const alignment = summarizeDeliveryAlignmentCases(deliveryAlignmentCases, now);
  const dueCycleWithoutOrder = collectDueCycleWithoutOrder(subscriptions, cycles, now, alignment.openSubscriptionIds);
  const dueCycleUnattempted = collectDueCycleUnattempted(dueCycleWithoutOrder, subscriptions);
  const paidRenewalWithoutFulfillment = collectPaidRenewalWithoutFulfillment(
    orders,
    fulfillmentOrders,
    subscriptions,
    cycles,
    paymentIntents,
    orderPaidOutboxEvents,
    now,
  );

  return {
    dueCycleWithoutOrderCount: dueCycleWithoutOrder.length,
    dueCycleUnattemptedCount: dueCycleUnattempted.length,
    dueCycleUnattemptedEvidence: dueCycleUnattempted.slice(0, 10),
    upcomingDeliveryReminderMissingCount: subscriptions.filter((row) => {
      if (!row.next_cycle_at) return false;
      const nextCycleAt = new Date(row.next_cycle_at).getTime();
      if (nextCycleAt < now.getTime() || nextCycleAt > upcomingCutoff) return false;
      return !(eventBySubscription.get(row.id) ?? []).some((event) => event.event_type === "subscription.delivery_reminder_queued");
    }).length,
    paidRenewalWithoutFulfillmentCount: paidRenewalWithoutFulfillment.length,
    activeWithoutPaymentMethodCount: countActiveWithoutPaymentMethod(subscriptions, paymentMethodRefs),
    renewalRowQuarantinedCount: countRenewalQuarantined(cycles, now),
    deliveryAlignmentOverdueCount: alignment.overdueCount,
    deliveryAlignmentOverdueEvidence: alignment.evidence,
    evidence: [...dueCycleWithoutOrder, ...paidRenewalWithoutFulfillment],
  };
}

function summarizeDeliveryAlignmentCases(rows: DeliveryAlignmentCaseEvidenceRow[], now: Date) {
  const openSubscriptionIds = new Set<string>();
  const overdueBySubscription = new Map<string, SubscriptionDeliveryAlignmentOverdueEvidence>();
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  for (const row of rows) {
    if (!row.subscription_id || !["protected", "manual_review"].includes(row.state ?? "")) continue;
    openSubscriptionIds.add(row.subscription_id);
    const observedAt = timestamp(row.observed_next_cycle_at);
    if (observedAt <= 0 || observedAt > cutoff) continue;
    const existing = overdueBySubscription.get(row.subscription_id);
    if (!existing || observedAt < timestamp(existing.nextCycleAt)) {
      overdueBySubscription.set(row.subscription_id, {
        subscriptionId: row.subscription_id,
        nextCycleAt: new Date(observedAt).toISOString(),
        ageSeconds: Math.floor((now.getTime() - observedAt) / 1000),
      });
    }
  }
  const evidence = [...overdueBySubscription.values()]
    .sort((left, right) => right.ageSeconds - left.ageSeconds || left.subscriptionId.localeCompare(right.subscriptionId))
    .slice(0, 10);
  return { openSubscriptionIds, overdueCount: overdueBySubscription.size, evidence };
}

// Cycles the renewal lane is currently skipping because the same row failed
// three times in a row with the identical error. The quarantine is a deliberate
// slow-down and always self-expires, so this is not a failure count — it is the
// answer to "why has this renewal gone quiet", which is otherwise invisible:
// a quarantined row produces no run-ledger error and no customer event while
// the window is open. Counted on presence rather than on a threshold, because
// one quarantined cycle is already one renewal nobody is watching.
//
// Reads the rows the port already fetches, so it costs no extra query. Rows
// whose window has elapsed are excluded: they are back in the lane and need no
// operator attention.
function countRenewalQuarantined(cycles: SubscriptionCycleEvidenceRow[], now: Date): number {
  return cycles.filter((row) => {
    const until = row.renewal_quarantined_until;
    if (typeof until !== "string" || until.length === 0) return false;
    const parsed = new Date(until).getTime();
    return Number.isFinite(parsed) && parsed > now.getTime();
  }).length;
}

// Early-warning form of `subscription_cycle_due_without_order`: an active
// subscription with no chargeable mandate (the exact condition the renewal
// due-RPC's LATERAL join requires — subscription-scoped, same-client, active,
// status='active') will silently fail its next renewal at preflight. Rows
// arrive pre-filtered to active+status='active'; the subscription/client match
// happens here because PostgREST cannot express NOT EXISTS.
function countActiveWithoutPaymentMethod(
  subscriptions: SubscriptionEvidenceRow[],
  paymentMethodRefs: PaymentMethodRefEvidenceRow[],
): number {
  if (subscriptions.length === 0) return 0;
  const chargeableBySubscription = new Set(
    paymentMethodRefs
      .filter((ref) => ref.subscription_id && ref.active === true && ref.status === "active")
      .map((ref) => `${ref.subscription_id}|${ref.client_id ?? ""}`),
  );
  return subscriptions.filter((row) =>
    !chargeableBySubscription.has(`${row.id}|${row.client_id ?? ""}`),
  ).length;
}

function collectDueCycleWithoutOrder(
  subscriptions: SubscriptionEvidenceRow[],
  cycles: SubscriptionCycleEvidenceRow[],
  now: Date,
  protectedSubscriptionIds: Set<string>,
): SubscriptionDueCycleWithoutOrderEvidence[] {
  const cycleBySubscription = groupBy(cycles, (row) => row.subscription_id);

  return subscriptions
    .filter((row) => row.next_cycle_at && timestamp(row.next_cycle_at) <= now.getTime())
    .filter((row) => !protectedSubscriptionIds.has(row.id))
    .filter((row) => !hasCycleForDueDate(cycleBySubscription.get(row.id) ?? [], row.next_cycle_at))
    .map((subscription) => ({
      kind: "due_cycle_without_order" as const,
      subscriptionId: subscription.id,
      nextCycleAt: isoOrNull(subscription.next_cycle_at) ?? subscription.next_cycle_at ?? "",
      reason: "active_subscription_due_without_order_evidence" as const,
      ageSeconds: secondsSince(subscription.next_cycle_at ?? "", now),
      owner: "commerce/subscription-support" as const,
      customerSafeStatus: "operator_review_required" as const,
      operatorNextAction: "inspect_subscription_scheduler" as const,
      observedAt: now.toISOString(),
      triageContext: buildDueCycleTriageContext(subscription),
    }))
    .sort((a, b) => b.ageSeconds - a.ageSeconds || a.subscriptionId.localeCompare(b.subscriptionId));
}

function collectPaidRenewalWithoutFulfillment(
  orders: SubscriptionOrderEvidenceRow[],
  fulfillmentOrders: FulfillmentOrderEvidenceRow[],
  subscriptions: SubscriptionEvidenceRow[],
  cycles: SubscriptionCycleEvidenceRow[],
  paymentIntents: SubscriptionPaymentIntentEvidenceRow[],
  orderPaidOutboxEvents: OutboxEventEvidenceRow[],
  now: Date,
): SubscriptionPaidRenewalWithoutFulfillmentEvidence[] {
  const fulfillmentByOrder = groupBy(fulfillmentOrders, (row) => row.order_id);
  const subscriptionById = new Map(subscriptions.map((row) => [row.id, row]));
  const cycleById = new Map(cycles.filter((row) => row.id).map((row) => [row.id ?? "", row]));
  const paymentIntentByOrder = latestBy(paymentIntents.filter((row) => row.order_id), (row) => row.order_id ?? "");
  const orderPaidOutboxByOrder = latestBy(
    orderPaidOutboxEvents.filter((row) => row.event_type === "commerce.order.paid" && row.aggregate_id),
    (row) => row.aggregate_id ?? "",
  );
  const cutoff = now.getTime() - 30 * 60 * 1000;

  return orders
    .filter((order) => {
      const cycle = cycleById.get(order.subscription_cycle_id ?? "");
      const paymentIntent = paymentIntentByOrder.get(order.id);
      return order.mode === "subscription_cycle" &&
        order.subscription_id &&
        order.subscription_cycle_id &&
        ["paid", "fulfillment_pending"].includes(order.status ?? "") &&
        timestamp(order.updated_at ?? order.created_at) <= cutoff &&
        (fulfillmentByOrder.get(order.id) ?? []).length === 0 &&
        cycle?.status === "paid" &&
        paymentIntent?.status === "succeeded";
    })
    .map((order) => ({
      kind: "paid_renewal_without_fulfillment" as const,
      subscriptionId: order.subscription_id ?? "",
      subscriptionCycleId: order.subscription_cycle_id ?? "",
      orderId: order.id,
      reason: "paid_subscription_cycle_order_without_fulfillment_order",
      ageSeconds: secondsSince(order.updated_at ?? order.created_at ?? "", now),
      owner: "commerce/fulfillment" as const,
      customerSafeStatus: "paid_fulfillment_pending" as const,
      operatorNextAction: "inspect_fulfillment_dispatch" as const,
      observedAt: now.toISOString(),
      triageContext: buildPaidFulfillmentTriageContext({
        order,
        subscription: subscriptionById.get(order.subscription_id ?? ""),
        cycle: cycleById.get(order.subscription_cycle_id ?? ""),
        paymentIntent: paymentIntentByOrder.get(order.id),
        outboxEvent: orderPaidOutboxByOrder.get(order.id),
      }),
    }))
    .sort((a, b) => b.ageSeconds - a.ageSeconds || a.orderId.localeCompare(b.orderId));
}

// "An attempt happened" is keyed on the DUE DATE, never on cycle progress and
// never on order presence: the engine writes the cycle with
// `scheduled_at = subscriptions.next_cycle_at` in the same transaction as its
// order and payment (the 20260604180000 cycle-order RPC), and `next_cycle_at`
// advances only once a result lands. So a cycle at or after the due date means
// the charge was tried and dunning or the retry ladder owns it, and it already
// implies the order, which is why this collector no longer looks at orders at
// all. The port hands us only the four statuses that mean an attempt exists
// (payment_pending, paid, payment_failed, retry_scheduled) and never planned,
// skipped or cancelled rows, so no status test is needed here - widening that
// read would silently re-break the signal.
//
// Both earlier tests were all-time and therefore dead: the paid activation cycle
// always "has progress", and the paid activation ORDER is itself
// `mode = 'subscription_cycle'` carrying the subscription id, so between them no
// subscription that ever activated could report.
function hasCycleForDueDate(cycles: SubscriptionCycleEvidenceRow[], nextCycleAt: string | null | undefined): boolean {
  const due = timestamp(nextCycleAt);
  return due > 0 && cycles.some((cycle) => timestamp(cycle.scheduled_at) >= due);
}

// The pageable subset of the rows above: fixtures never wake anyone, and the
// first 6h past the due date belong to the renewal lane's own cadence and
// retries. What is left is a real customer whose renewal was never charged.
const DUE_CYCLE_UNATTEMPTED_MIN_AGE_SECONDS = 6 * 60 * 60;

function collectDueCycleUnattempted(
  dueCycleWithoutOrder: SubscriptionDueCycleWithoutOrderEvidence[],
  subscriptions: SubscriptionEvidenceRow[],
): SubscriptionDeliveryAlignmentOverdueEvidence[] {
  const fixtureIds = new Set(subscriptions.filter((row) => row.is_test_fixture === true).map((row) => row.id));
  return dueCycleWithoutOrder
    .filter((row) => !fixtureIds.has(row.subscriptionId) && row.ageSeconds > DUE_CYCLE_UNATTEMPTED_MIN_AGE_SECONDS)
    .map((row) => ({ subscriptionId: row.subscriptionId, nextCycleAt: row.nextCycleAt, ageSeconds: row.ageSeconds }));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function secondsSince(value: string, now: Date): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}
