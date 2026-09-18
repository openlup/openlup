import type { OmsOrderDetail } from "../../../src/domains/commerce/omsContracts.js";
import type {
  OmsFulfillmentOrderRow,
  OmsOmnipackStatusEvidenceRow,
} from "../../../src/domains/commerce/omsFulfillmentSummary.js";
import type { OmsOrderRow } from "../../../src/domains/commerce/omsReadModelRows.js";
import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import {
  customerSafeEvidenceToken,
  customerStepFromSignals,
  customerStepFromTimedSignals,
  phaseIndexForStep,
} from "../../../src/domains/fulfillment/types.js";
import {
  classifyOmsOmnipackDispatchHealth,
  type OmsHealthDispatchRefRow,
} from "./omsOmnipackDispatchHealth.js";

export type OmsFulfillmentHealth = OmsOrderDetail["fulfillmentHealth"];

export type OmsFulfillmentHealthStatus = OmsFulfillmentHealth["healthStatus"];

export type OmsFulfillmentHealthAttentionReason = OmsFulfillmentHealth["attentionReasons"][number];

export interface OmsOrderPaidOutboxEventRow {
  id: string;
  event_type: string;
  status: string;
  aggregate_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  available_at?: string | null;
  attempts?: number | null;
}

export function buildOmsFulfillmentHealth(input: {
  order: OmsOrderRow;
  paymentStatus: OmsOrderDetail["paymentStatus"];
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  dispatchRefs: OmsHealthDispatchRefRow[];
  statusEvidence: OmsOmnipackStatusEvidenceRow[];
  orderPaidOutboxEvents?: OmsOrderPaidOutboxEventRow[];
  now?: Date;
  localAheadGraceSeconds?: number;
  missingDispatchRefGraceSeconds?: number;
  dispatchSubmittingStaleSeconds?: number;
  providerAheadGraceSeconds?: number;
}): OmsFulfillmentHealth {
  const now = input.now ?? new Date();
  const localAheadGraceSeconds = input.localAheadGraceSeconds ?? 30 * 60;
  const missingDispatchRefGraceSeconds = input.missingDispatchRefGraceSeconds ?? 30 * 60;
  const dispatchSubmittingStaleSeconds = input.dispatchSubmittingStaleSeconds ?? 5 * 60;
  const providerAheadGraceSeconds = input.providerAheadGraceSeconds ?? 5 * 60;
  const fulfillmentOrder = newest(input.fulfillmentOrders, (row) => row.updated_at ?? row.created_at) ?? null;
  const fulfillmentOrderId = fulfillmentOrder?.id ?? null;
  const latestOutbox = newest(
    (input.orderPaidOutboxEvents ?? []).filter((row) =>
      row.event_type === COMMERCE_ORDER_PAID_EVENT_TYPE && (row.aggregate_id ?? input.order.id) === input.order.id
    ),
    (row) => row.updated_at ?? row.created_at,
  );
  const latestDispatch = newest(
    input.dispatchRefs.filter((row) => !fulfillmentOrderId || row.fulfillment_order_id === fulfillmentOrderId),
    (row) => row.updated_at ?? row.created_at,
  );
  const latestEvidence = newest(
    input.statusEvidence.filter((row) => !fulfillmentOrderId || row.fulfillment_order_id === fulfillmentOrderId),
    (row) => row.occurred_at ?? row.created_at,
  );
  const base = {
    healthStatus: "ok" as OmsFulfillmentHealthStatus,
    attentionReasons: [] as OmsFulfillmentHealthAttentionReason[],
    oldestAgeSeconds: null as number | null,
    dispatchRefId: latestDispatch?.id ?? null,
    dispatchStatus: clean(latestDispatch?.status) || null,
    opaqueIds: {
      orderId: input.order.id,
      fulfillmentOrderId: fulfillmentOrder?.id ?? null,
      outboxEventId: latestOutbox?.id ?? null,
      dispatchRefFulfillmentOrderId: latestDispatch?.fulfillment_order_id ?? null,
      latestEvidenceFulfillmentOrderId: latestEvidence?.fulfillment_order_id ?? null,
    },
  };

  const postDeliveryException = newestPostDeliveryException(
    fulfillmentOrder,
    input.statusEvidence.filter((row) =>
      !fulfillmentOrderId || row.fulfillment_order_id === fulfillmentOrderId
    ),
  );
  if (postDeliveryException) {
    return attention(base, "needs_attention", ["provider_exception_after_delivery"], [
      postDeliveryException.occurred_at,
    ], now);
  }

  if (!shouldEvaluatePaidFulfillment(input.paymentStatus, input.order.status)) {
    return base;
  }

  if (!fulfillmentOrder) {
    // Absent `orderPaidOutboxEvents` means the caller never read `outbox_events`
    // (the list path does not) - not the same fact as reading it and finding
    // nothing, which `[]` still says. Only a caller that looked may name the row.
    const reason = input.orderPaidOutboxEvents ? reasonForOutbox(latestOutbox) : "paid_order_missing_fulfillment";
    return attention(base, "missing_local_commitment", [reason], [
      latestOutbox?.updated_at ?? latestOutbox?.created_at,
      input.order.updated_at,
    ], now);
  }

  const dispatchHealth = classifyOmsOmnipackDispatchHealth({
    fulfillmentOrder,
    order: input.order,
    dispatchRef: latestDispatch,
    now,
    missingRefGraceSeconds: missingDispatchRefGraceSeconds,
    staleSeconds: dispatchSubmittingStaleSeconds,
  });
  if (dispatchHealth) {
    return attention(base, dispatchHealth.healthStatus, [dispatchHealth.reason], [dispatchHealth.timestamp], now);
  }

  const undeliveredException = undeliveredProviderException(fulfillmentOrder, latestEvidence);
  if (undeliveredException) {
    return attention(base, "needs_attention", [undeliveredException.reason], [
      undeliveredException.occurredAt,
    ], now);
  }

  if (isAcceptedProviderDispatchAwaitingLocalAck(fulfillmentOrder, latestDispatch)) {
    const acceptedAt = latestDispatch?.updated_at ?? latestDispatch?.created_at ?? "";
    if (secondsSince(acceptedAt, now) >= providerAheadGraceSeconds) {
      return attention(base, "provider_ahead", ["provider_accepted_local_label_ack_missing"], [
        acceptedAt,
      ], now);
    }
    if (timestamp(acceptedAt) > 0) return base;
  }

  if (isLocalAhead({
    fulfillmentOrder,
    latestDispatch,
    latestEvidence,
    now,
    localAheadGraceSeconds,
  })) {
    return attention(base, "local_ahead", ["local_status_ahead_of_provider"], [
      latestEvidence?.occurred_at ?? latestEvidence?.created_at,
      fulfillmentOrder.updated_at ?? fulfillmentOrder.created_at,
    ], now);
  }

  return base;
}

function newestPostDeliveryException(
  fulfillmentOrder: OmsFulfillmentOrderRow | null,
  evidence: OmsOmnipackStatusEvidenceRow[],
): OmsOmnipackStatusEvidenceRow | null {
  if (fulfillmentOrder?.status !== "delivered" || !fulfillmentOrder.delivered_at) return null;
  const step = customerStepFromTimedSignals(
    [fulfillmentOrder.status],
    [
      { token: "delivered", occurredAt: fulfillmentOrder.delivered_at },
      ...evidence.map((row) => ({
        token: customerSafeEvidenceToken(row.local_status, row.provider_status),
        occurredAt: row.occurred_at,
      })),
    ],
  );
  if (step !== "exception") return null;
  return newest(
    evidence.filter((row) =>
      customerSafeEvidenceToken(row.local_status, row.provider_status) === "exception"
      && Boolean(row.occurred_at)
    ),
    (row) => row.occurred_at,
  );
}

// A provider exception on an undelivered parcel splits across two desks: after handover the
// goods left us and the carrier failed (customer contact, claim), before handover the order is
// stuck at the fulfilment house (stock, address, carrier mapping - ops work). `handed_over_at` is
// the only witness of the split - the FSM flips to `exception` from both sides. Newest evidence
// wins as everywhere here, so a recovery row after the exception silences it. Delivery: above.
function undeliveredProviderException(
  fulfillmentOrder: OmsFulfillmentOrderRow,
  latestEvidence: OmsOmnipackStatusEvidenceRow | null,
): { reason: OmsFulfillmentHealthAttentionReason; occurredAt: string | null | undefined } | null {
  if (clean(fulfillmentOrder.status) === "delivered" || fulfillmentOrder.delivered_at) return null;
  if (!latestEvidence) return null;
  if (customerSafeEvidenceToken(latestEvidence.local_status, latestEvidence.provider_status) !== "exception") {
    return null;
  }
  const occurredAt = latestEvidence.occurred_at ?? latestEvidence.created_at;
  const handedOverAt = timestamp(fulfillmentOrder.handed_over_at);
  if (!handedOverAt) return { reason: "provider_exception_before_handover", occurredAt };
  // The exception predates a handover that then happened anyway: the parcel left the
  // warehouse, so neither half is true - the provider was stuck and stopped being
  // stuck. Same for evidence with no readable timestamp, which cannot be placed on
  // either side. Both fall through to the local/provider skew rules below rather than
  // inventing a story; the skew rules still speak if the local status ran ahead.
  if (timestamp(occurredAt) < handedOverAt) return null;
  return { reason: "provider_exception_after_handover", occurredAt };
}

function reasonForOutbox(row: OmsOrderPaidOutboxEventRow | null): OmsFulfillmentHealthAttentionReason {
  if (!row) return "order_paid_outbox_missing";
  if (row.status === "discarded") return "order_paid_outbox_discarded";
  if (row.status === "processed") return "order_paid_outbox_processed_without_fulfillment";
  return "paid_order_missing_fulfillment";
}

function shouldEvaluatePaidFulfillment(
  paymentStatus: OmsOrderDetail["paymentStatus"],
  orderStatus: string | null | undefined,
): boolean {
  if (paymentStatus !== "succeeded") return false;
  return !["cancelled", "refunded", "fulfilled"].includes(clean(orderStatus));
}

function isLocalAhead(input: {
  fulfillmentOrder: OmsFulfillmentOrderRow;
  latestDispatch: OmsHealthDispatchRefRow | null;
  latestEvidence: OmsOmnipackStatusEvidenceRow | null;
  now: Date;
  localAheadGraceSeconds: number;
}): boolean {
  if (!hasOmnipackProviderSignal(input.fulfillmentOrder, input.latestDispatch, input.latestEvidence)) {
    return false;
  }
  const localStep = customerStepFromSignals([input.fulfillmentOrder.status]);
  const localPhase = phaseIndexForStep(localStep);
  if (localPhase < phaseIndexForStep("transit")) return false;
  const providerStep = customerStepFromSignals([
    input.latestEvidence?.local_status ?? null,
  ]);
  const providerPhase = input.latestEvidence ? phaseIndexForStep(providerStep) : phaseIndexForStep("paid");
  if (providerPhase >= localPhase) return false;
  const evidenceAt = input.latestEvidence?.occurred_at ?? input.latestEvidence?.created_at ?? input.fulfillmentOrder.updated_at ?? input.fulfillmentOrder.created_at;
  return secondsSince(evidenceAt ?? "", input.now) >= input.localAheadGraceSeconds;
}

function hasOmnipackProviderSignal(
  fulfillmentOrder: OmsFulfillmentOrderRow,
  latestDispatch: OmsHealthDispatchRefRow | null,
  latestEvidence: OmsOmnipackStatusEvidenceRow | null,
): boolean {
  return Boolean(latestDispatch || latestEvidence) || clean(fulfillmentOrder.provider_kind) === "omnipack";
}

function isAcceptedProviderDispatchAwaitingLocalAck(
  fulfillmentOrder: OmsFulfillmentOrderRow,
  dispatchRef: OmsHealthDispatchRefRow | null,
): boolean {
  return clean(fulfillmentOrder.status) === "created"
    && clean(dispatchRef?.status) === "created"
    && Boolean(dispatchRef?.provider_order_id?.trim());
}

function attention(
  base: OmsFulfillmentHealth,
  healthStatus: Exclude<OmsFulfillmentHealthStatus, "ok">,
  attentionReasons: OmsFulfillmentHealthAttentionReason[],
  timestamps: Array<string | null | undefined>,
  now: Date,
): OmsFulfillmentHealth {
  return {
    ...base,
    healthStatus,
    attentionReasons,
    oldestAgeSeconds: oldestAgeSeconds(timestamps, now),
  };
}

function newest<T>(rows: T[], time: (row: T) => string | null | undefined): T | null {
  return [...rows].sort((a, b) => timestamp(time(b)) - timestamp(time(a)))[0] ?? null;
}

function oldestAgeSeconds(values: Array<string | null | undefined>, now: Date): number | null {
  const timestamps = values.map(timestamp).filter((value) => value > 0);
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps.map((value) => Math.max(0, Math.floor((now.getTime() - value) / 1000))));
}

function secondsSince(value: string, now: Date): number {
  const parsed = timestamp(value);
  if (!parsed) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
