import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";

export type PaidFulfillmentRecoveryAction =
  | "wait_for_outbox" | "requeue_discarded_order_paid_outbox" | "inspect_processed_without_effect"
  | "inspect_missing_order_paid_outbox"
  | "monitor_dispatch" | "inspect_missing_dispatch_ref" | "inspect_stale_dispatch_submission"
  | "inspect_uncertain_dispatch" | "inspect_failed_dispatch"
  | "inspect_created_dispatch_without_provider_order_id" | "inspect_terminal_dispatch"
  | "inspect_unknown_dispatch_status";

export type PaidFulfillmentRecoveryReason =
  | "paid_order_without_fulfillment_order" | "order_paid_outbox_missing" | "order_paid_outbox_discarded"
  | "order_paid_outbox_processed_without_fulfillment" | "omnipack_dispatch_in_progress"
  | "omnipack_fulfillment_without_dispatch_ref" | "omnipack_dispatch_submission_stale"
  | "omnipack_dispatch_outcome_uncertain" | "omnipack_dispatch_failed"
  | "omnipack_dispatch_created_without_provider_order_id"
  | "omnipack_dispatch_terminal_without_progress" | "omnipack_dispatch_status_unknown";

export type PaidFulfillmentRecoveryPosture =
  | "automatic_local_requeue_safe" | "wait_for_existing_automation" | "operator_review_required";

export type PaidFulfillmentOrderRow = Record<string, unknown> & {
  id: string; status?: string | null; mode?: string | null;
  created_at?: string | null; updated_at?: string | null;
};

export type PaidFulfillmentOrderEvidenceRow = Record<string, unknown> & {
  id: string; order_id: string; provider_kind?: string | null; status?: string | null;
  created_at?: string | null; updated_at?: string | null;
};

export type PaidFulfillmentDispatchRefRow = Record<string, unknown> & {
  id?: string | null; fulfillment_order_id: string; provider_order_id?: string | null;
  status?: string | null; created_at?: string | null; updated_at?: string | null;
};

export type PaidFulfillmentOutboxEventRow = Record<string, unknown> & {
  id: string; event_type: string; status: string; aggregate_id?: string | null;
  created_at?: string | null; updated_at?: string | null; available_at?: string | null;
  attempts?: number | null;
};

export type PaidFulfillmentRecoveryCandidate = {
  orderId: string; orderStatus: string; orderMode: string | null;
  fulfillmentOrderId: string | null; providerKind: string | null;
  dispatchRefId: string | null; dispatchStatus: string | null;
  outboxEventId: string | null; outboxStatus: string | null; outboxAttempts: number | null;
  reason: PaidFulfillmentRecoveryReason;
  recommendedAction: PaidFulfillmentRecoveryAction;
  recoveryPosture: PaidFulfillmentRecoveryPosture;
  ageSeconds: number;
};

export type PaidFulfillmentRecoveryPlan = { checkedOrders: number; candidates: PaidFulfillmentRecoveryCandidate[] };

export type RequeueDiscardedOrderPaidOutboxResult = { requeuedCount: number; eventIds: string[] };

export function collectPaidFulfillmentRecoveryCandidates(input: {
  orders: PaidFulfillmentOrderRow[];
  fulfillmentOrders: PaidFulfillmentOrderEvidenceRow[];
  omnipackDispatchRefs?: PaidFulfillmentDispatchRefRow[];
  orderPaidOutboxEvents: PaidFulfillmentOutboxEventRow[];
  now: Date;
  minimumAgeSeconds?: number;
  dispatchSubmissionStaleSeconds?: number;
}): PaidFulfillmentRecoveryPlan {
  const minimumAgeSeconds = input.minimumAgeSeconds ?? 30 * 60;
  const minimumAgeMs = minimumAgeSeconds * 1000;
  const dispatchSubmissionStaleSeconds = input.dispatchSubmissionStaleSeconds ?? 5 * 60;
  const fulfillmentByOrder = groupBy(input.fulfillmentOrders, (row) => row.order_id);
  const dispatchRefsByFulfillment = groupBy(
    input.omnipackDispatchRefs ?? [],
    (row) => row.fulfillment_order_id,
  );
  const outboxByOrder = latestBy(
    input.orderPaidOutboxEvents.filter((row) => row.event_type === COMMERCE_ORDER_PAID_EVENT_TYPE),
    (row) => row.aggregate_id ?? "",
  );
  const candidates: PaidFulfillmentRecoveryCandidate[] = [];
  let checkedOrders = 0;

  for (const order of input.orders) {
    const status = clean(order.status);
    if (!["paid", "fulfillment_pending"].includes(status)) continue;
    const ageSeconds = secondsSince(order.updated_at ?? order.created_at ?? "", input.now);
    if (ageSeconds * 1000 < minimumAgeMs) continue;
    checkedOrders += 1;

    const outbox = outboxByOrder.get(order.id);
    const fulfillments = fulfillmentByOrder.get(order.id) ?? [];
    if (fulfillments.length === 0) {
      candidates.push(candidateForMissingFulfillment(order, outbox, ageSeconds));
      continue;
    }

    for (const fulfillment of fulfillments) {
      const providerKind = clean(fulfillment.provider_kind);
      if (providerKind !== "omnipack") continue;
      const latestDispatchRef = latestBy(
        dispatchRefsByFulfillment.get(fulfillment.id) ?? [],
        (row) => row.fulfillment_order_id,
      ).get(fulfillment.id);
      const decision = dispatchRecoveryDecision({
        dispatchRef: latestDispatchRef,
        fulfillmentCreatedAt: fulfillment.updated_at ?? fulfillment.created_at,
        now: input.now,
        missingRefGraceSeconds: minimumAgeSeconds,
        staleSeconds: dispatchSubmissionStaleSeconds,
      });
      if (!decision) continue;
      candidates.push({
        ...baseCandidate(order, outbox, ageSeconds),
        fulfillmentOrderId: fulfillment.id,
        providerKind: "omnipack",
        dispatchRefId: latestDispatchRef?.id ?? null,
        dispatchStatus: clean(latestDispatchRef?.status) || null,
        ...decision,
      });
    }
  }

  candidates.sort((a, b) => b.ageSeconds - a.ageSeconds || a.orderId.localeCompare(b.orderId));
  return { checkedOrders, candidates };
}

function candidateForMissingFulfillment(
  order: PaidFulfillmentOrderRow,
  outbox: PaidFulfillmentOutboxEventRow | undefined,
  ageSeconds: number,
): PaidFulfillmentRecoveryCandidate {
  const outboxStatus = clean(outbox?.status);
  const decision = !outbox
    ? recoveryDecision("order_paid_outbox_missing", "inspect_missing_order_paid_outbox")
    : outboxStatus === "discarded"
      ? recoveryDecision("order_paid_outbox_discarded", "requeue_discarded_order_paid_outbox", "automatic_local_requeue_safe")
      : outboxStatus === "processed"
        ? recoveryDecision("order_paid_outbox_processed_without_fulfillment", "inspect_processed_without_effect")
        : recoveryDecision("paid_order_without_fulfillment_order", "wait_for_outbox", "wait_for_existing_automation");
  return { ...baseCandidate(order, outbox, ageSeconds), ...decision };
}

function baseCandidate(
  order: PaidFulfillmentOrderRow,
  outbox: PaidFulfillmentOutboxEventRow | undefined,
  ageSeconds: number,
): Omit<PaidFulfillmentRecoveryCandidate, "reason" | "recommendedAction" | "recoveryPosture"> {
  return {
    orderId: order.id,
    orderStatus: clean(order.status),
    orderMode: clean(order.mode) || null,
    fulfillmentOrderId: null,
    providerKind: null,
    dispatchRefId: null,
    dispatchStatus: null,
    outboxEventId: outbox?.id ?? null,
    outboxStatus: clean(outbox?.status) || null,
    outboxAttempts: typeof outbox?.attempts === "number" ? outbox.attempts : null,
    ageSeconds,
  };
}

function dispatchRecoveryDecision(input: {
  dispatchRef: PaidFulfillmentDispatchRefRow | undefined;
  fulfillmentCreatedAt: string | null | undefined;
  now: Date;
  missingRefGraceSeconds: number;
  staleSeconds: number;
}): Pick<PaidFulfillmentRecoveryCandidate, "reason" | "recommendedAction" | "recoveryPosture"> | null {
  const { dispatchRef, now, staleSeconds } = input;
  if (!dispatchRef) {
    if (!isAtLeastAgeOrUnknown(input.fulfillmentCreatedAt, now, input.missingRefGraceSeconds)) return null;
    return recoveryDecision("omnipack_fulfillment_without_dispatch_ref", "inspect_missing_dispatch_ref");
  }
  const status = clean(dispatchRef.status);
  if (status === "draft") {
    return recoveryDecision("omnipack_dispatch_in_progress", "monitor_dispatch", "wait_for_existing_automation");
  }
  if (status === "submitting") {
    return isAtLeastAgeOrUnknown(dispatchRef.updated_at ?? dispatchRef.created_at, now, staleSeconds)
      ? recoveryDecision("omnipack_dispatch_submission_stale", "inspect_stale_dispatch_submission")
      : recoveryDecision("omnipack_dispatch_in_progress", "monitor_dispatch", "wait_for_existing_automation");
  }
  if (status === "uncertain") {
    return recoveryDecision("omnipack_dispatch_outcome_uncertain", "inspect_uncertain_dispatch");
  }
  if (status === "failed") {
    return recoveryDecision("omnipack_dispatch_failed", "inspect_failed_dispatch");
  }
  if (status === "created") {
    return dispatchRef.provider_order_id?.trim()
      ? null
      : recoveryDecision(
        "omnipack_dispatch_created_without_provider_order_id",
        "inspect_created_dispatch_without_provider_order_id",
      );
  }
  if (["cancel_requested", "cancelled"].includes(status)) {
    return recoveryDecision("omnipack_dispatch_terminal_without_progress", "inspect_terminal_dispatch");
  }
  return recoveryDecision("omnipack_dispatch_status_unknown", "inspect_unknown_dispatch_status");
}

function recoveryDecision(
  reason: PaidFulfillmentRecoveryReason,
  recommendedAction: PaidFulfillmentRecoveryAction,
  recoveryPosture: PaidFulfillmentRecoveryPosture = "operator_review_required",
) {
  return { reason, recommendedAction, recoveryPosture };
}

function latestBy<T extends { created_at?: string | null; updated_at?: string | null }>(
  rows: T[],
  key: (row: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const rowKey = key(row);
    if (!rowKey) continue;
    const current = result.get(rowKey);
    if (!current || timestamp(row.updated_at ?? row.created_at) >= timestamp(current.updated_at ?? current.created_at)) {
      result.set(rowKey, row);
    }
  }
  return result;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const rowKey = key(row);
    groups.set(rowKey, [...(groups.get(rowKey) ?? []), row]);
  }
  return groups;
}

function clean(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
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
function isAtLeastAgeOrUnknown(value: string | null | undefined, now: Date, seconds: number): boolean {
  const parsed = timestamp(value);
  return parsed <= 0 || now.getTime() - parsed > seconds * 1000;
}
