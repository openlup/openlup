import type { OmniPackFulfillmentHealthAttentionEvidence } from "../../../src/domains/platform/omnipackFulfillmentHealthContracts.js";
import { customerStepFromSignals, phaseIndexForStep } from "../../../src/domains/fulfillment/types.js";
import type {
  OmniPackDispatchEvidenceRow,
  OmniPackFulfillmentOrderEvidenceRow,
  OmniPackOrderEvidenceRow,
  OmniPackStatusEvidenceRow,
} from "./omnipackObservabilityEvidence.js";

const ORDER_PAID_EVENT_TYPE = "commerce.order.paid";
const LOCAL_AHEAD_GRACE_SECONDS = 30 * 60;
const MISSING_DISPATCH_REF_GRACE_SECONDS = 30 * 60;
const STALE_SUBMITTING_SECONDS = 5 * 60;
const PROVIDER_AHEAD_GRACE_SECONDS = 5 * 60;

export interface OrderPaidOutboxEventEvidenceRow {
  id: string;
  event_type: string;
  status: string;
  aggregate_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  available_at?: string | null;
  attempts?: number | null;
}

type HealthStatus = OmniPackFulfillmentHealthAttentionEvidence["healthStatus"];

export function collectFulfillmentHealthAttentionEvidence(input: {
  orders?: OmniPackOrderEvidenceRow[];
  fulfillmentOrders?: OmniPackFulfillmentOrderEvidenceRow[];
  dispatchRefs: OmniPackDispatchEvidenceRow[];
  statusEvidence: OmniPackStatusEvidenceRow[];
  orderPaidOutboxEvents?: OrderPaidOutboxEventEvidenceRow[];
  now: Date;
}): OmniPackFulfillmentHealthAttentionEvidence[] {
  const fulfillmentsByOrder = groupBy(input.fulfillmentOrders ?? [], (row) => row.order_id);
  const dispatchRefsByFulfillment = groupBy(input.dispatchRefs, (row) => row.fulfillment_order_id ?? "");
  const evidenceByFulfillment = groupBy(input.statusEvidence, (row) => row.fulfillment_order_id ?? "");
  const outboxByOrder = groupBy(input.orderPaidOutboxEvents ?? [], (row) => row.aggregate_id ?? "");
  const rows: OmniPackFulfillmentHealthAttentionEvidence[] = [];

  for (const order of (input.orders ?? []).filter(isPaidProviderOrder)) {
    const fulfillmentOrders = fulfillmentsByOrder.get(order.id) ?? [];
    const fulfillmentOrder = newest(fulfillmentOrders, (row) => row.updated_at ?? row.created_at);
    const fulfillmentOrderId = fulfillmentOrder?.id ?? null;
    const latestOutbox = newest(
      (outboxByOrder.get(order.id) ?? []).filter((row) => row.event_type === ORDER_PAID_EVENT_TYPE),
      (row) => row.updated_at ?? row.created_at,
    );
    const latestDispatch = newest(
      fulfillmentOrderId ? dispatchRefsByFulfillment.get(fulfillmentOrderId) ?? [] : [],
      (row) => row.updated_at ?? row.created_at,
    );
    const latestEvidence = newest(
      fulfillmentOrderId ? evidenceByFulfillment.get(fulfillmentOrderId) ?? [] : [],
      (row) => row.occurred_at ?? row.created_at,
    );
    const issue = classifyHealth({
      order,
      fulfillmentOrder,
      latestOutbox,
      latestDispatch,
      latestEvidence,
      now: input.now,
    });
    if (!issue) continue;
    rows.push({
      orderId: order.id,
      fulfillmentOrderId,
      outboxEventId: latestOutbox?.id ?? null,
      dispatchRefFulfillmentOrderId: latestDispatch?.fulfillment_order_id ?? null,
      latestEvidenceFulfillmentOrderId: latestEvidence?.fulfillment_order_id ?? null,
      healthStatus: issue.healthStatus,
      attentionReasons: issue.reasons,
      oldestAgeSeconds: oldestAgeSeconds(issue.timestamps, input.now),
    });
  }

  return rows.sort((a, b) =>
    (b.oldestAgeSeconds ?? -1) - (a.oldestAgeSeconds ?? -1) ||
    a.orderId.localeCompare(b.orderId),
  );
}

export function maxFulfillmentHealthAge(values: Array<number | null | undefined>): number | null {
  const ages = values.filter((value): value is number => typeof value === "number");
  return ages.length ? Math.max(...ages) : null;
}

function classifyHealth(input: {
  order: OmniPackOrderEvidenceRow;
  fulfillmentOrder: OmniPackFulfillmentOrderEvidenceRow | null;
  latestOutbox: OrderPaidOutboxEventEvidenceRow | null;
  latestDispatch: OmniPackDispatchEvidenceRow | null;
  latestEvidence: OmniPackStatusEvidenceRow | null;
  now: Date;
}): { healthStatus: HealthStatus; reasons: string[]; timestamps: Array<string | null | undefined> } | null {
  if (!shouldEvaluatePaidFulfillment(input.order.status)) return null;
  if (!input.fulfillmentOrder) {
    return {
      healthStatus: "missing_local_commitment",
      reasons: [reasonForOutbox(input.latestOutbox)],
      timestamps: [input.latestOutbox?.updated_at ?? input.latestOutbox?.created_at, input.order.updated_at],
    };
  }
  if (text(input.fulfillmentOrder.provider_kind) && text(input.fulfillmentOrder.provider_kind) !== "omnipack") {
    return null;
  }
  if (!input.latestDispatch) {
    const commitmentAt = input.fulfillmentOrder.updated_at ?? input.fulfillmentOrder.created_at;
    if (!isAtLeastAgeOrUnknown(commitmentAt, input.now, MISSING_DISPATCH_REF_GRACE_SECONDS)) return null;
    return {
      healthStatus: "missing_local_commitment",
      reasons: ["paid_order_missing_dispatch_ref"],
      timestamps: [commitmentAt],
    };
  }
  const dispatchStatus = text(input.latestDispatch.status);
  const dispatchUpdatedAt = input.latestDispatch.updated_at ?? input.latestDispatch.created_at;
  if (dispatchStatus === "submitting") {
    if (!isAtLeastAgeOrUnknown(dispatchUpdatedAt, input.now, STALE_SUBMITTING_SECONDS)) return null;
    return {
      healthStatus: "blocked_uncertain",
      reasons: ["dispatch_ref_stale_submitting"],
      timestamps: [dispatchUpdatedAt],
    };
  }
  if (dispatchStatus === "uncertain") {
    return {
      healthStatus: "blocked_uncertain",
      reasons: ["dispatch_ref_uncertain"],
      timestamps: [dispatchUpdatedAt],
    };
  }
  if (dispatchStatus === "failed") {
    return {
      healthStatus: "needs_attention",
      reasons: ["dispatch_ref_failed"],
      timestamps: [dispatchUpdatedAt],
    };
  }
  if (dispatchStatus === "created" && !text(input.latestDispatch.provider_order_id)) {
    return {
      healthStatus: "needs_attention",
      reasons: ["dispatch_ref_created_without_provider_order_id"],
      timestamps: [dispatchUpdatedAt],
    };
  }
  if (isAcceptedProviderDispatchAwaitingLocalAck(input.fulfillmentOrder, input.latestDispatch)) {
    const acceptedAt = input.latestDispatch?.updated_at ?? input.latestDispatch?.created_at ?? "";
    if (secondsSince(acceptedAt, input.now) >= PROVIDER_AHEAD_GRACE_SECONDS) {
      return {
        healthStatus: "provider_ahead",
        reasons: ["provider_accepted_local_label_ack_missing"],
        timestamps: [acceptedAt],
      };
    }
    if (timestamp(acceptedAt) > 0) return null;
  }
  if (isLocalAhead(input)) {
    return {
      healthStatus: "local_ahead",
      reasons: ["local_status_ahead_of_provider"],
      timestamps: [
        input.latestEvidence?.occurred_at ?? input.latestEvidence?.created_at,
        input.fulfillmentOrder.updated_at ?? input.fulfillmentOrder.created_at,
      ],
    };
  }
  return null;
}

function isAcceptedProviderDispatchAwaitingLocalAck(
  fulfillmentOrder: OmniPackFulfillmentOrderEvidenceRow,
  dispatchRef: OmniPackDispatchEvidenceRow | null,
): boolean {
  return text(fulfillmentOrder.status) === "created"
    && text(dispatchRef?.status) === "created"
    && Boolean(text(dispatchRef?.provider_order_id));
}

function isLocalAhead(input: {
  fulfillmentOrder: OmniPackFulfillmentOrderEvidenceRow | null;
  latestEvidence: OmniPackStatusEvidenceRow | null;
  now: Date;
}): boolean {
  if (!input.fulfillmentOrder) return false;
  const fulfillmentOrder = input.fulfillmentOrder;
  if (!hasOmniPackProviderSignal(fulfillmentOrder, input.latestEvidence)) return false;
  const localPhase = phaseIndexForStep(customerStepFromSignals([fulfillmentOrder.status]));
  if (localPhase < phaseIndexForStep("transit")) return false;
  const providerStep = customerStepFromSignals([input.latestEvidence?.local_status ?? null]);
  const providerPhase = input.latestEvidence ? phaseIndexForStep(providerStep) : phaseIndexForStep("paid");
  if (providerPhase >= localPhase) return false;
  const evidenceAt = input.latestEvidence?.occurred_at ??
    input.latestEvidence?.created_at ??
    fulfillmentOrder.updated_at ??
    fulfillmentOrder.created_at;
  return secondsSince(evidenceAt ?? "", input.now) >= LOCAL_AHEAD_GRACE_SECONDS;
}

function hasOmniPackProviderSignal(
  fulfillmentOrder: OmniPackFulfillmentOrderEvidenceRow,
  latestEvidence: OmniPackStatusEvidenceRow | null,
): boolean {
  return Boolean(latestEvidence) || text(fulfillmentOrder.provider_kind) === "omnipack";
}

function isPaidProviderOrder(row: OmniPackOrderEvidenceRow): boolean {
  if (!["paid", "fulfillment_pending", "fulfilled"].includes(text(row.status))) return false;
  return readSelectedDeliveryProviderKind(row.metadata) === "omnipack";
}

function shouldEvaluatePaidFulfillment(orderStatus: string | null | undefined): boolean {
  return !["cancelled", "refunded", "fulfilled"].includes(text(orderStatus));
}

function reasonForOutbox(row: OrderPaidOutboxEventEvidenceRow | null): string {
  if (!row) return "order_paid_outbox_missing";
  if (row.status === "discarded") return "order_paid_outbox_discarded";
  if (row.status === "processed") return "order_paid_outbox_processed_without_fulfillment";
  return "paid_order_missing_fulfillment";
}

function readSelectedDeliveryProviderKind(metadata: Record<string, unknown> | null | undefined): string | null {
  const direct = object(metadata?.selectedDelivery);
  const runtimeFinalize = object(metadata?.runtimeFinalize);
  const nested = object(runtimeFinalize?.selectedDelivery);
  return text(direct?.providerKind ?? nested?.providerKind) || null;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (!id) continue;
    const current = grouped.get(id) ?? [];
    current.push(row);
    grouped.set(id, current);
  }
  return grouped;
}

function newest<T>(rows: T[] | undefined, time: (row: T) => string | null | undefined): T | null {
  return [...(rows ?? [])].sort((a, b) => timestamp(time(b)) - timestamp(time(a)))[0] ?? null;
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

function isAtLeastAgeOrUnknown(value: string | null | undefined, now: Date, seconds: number): boolean {
  const parsed = timestamp(value);
  return parsed <= 0 || now.getTime() - parsed > seconds * 1000;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
