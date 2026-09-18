import type { OmsOrderDetail } from "./omsContracts.js";
import { stepForToken, timelineLabelForStep } from "../../lib/customerFulfillmentCanon.js";
import { rowsForParcel } from "../../lib/currentFulfillmentParcel.js";
import {
  customerSafeEvidenceToken,
  customerStepFromTimedSignals,
  resolveProviderExceptionRecovery,
  type CustomerFulfillmentStep,
  type ReleasedProviderExceptionHold,
} from "../../lib/customerFulfillmentCanon.js";
export interface OmsFulfillmentOrderRow {
  id: string;
  order_id: string;
  status: OmsOrderDetail["fulfillment"]["status"];
  provider_kind?: string | null;
  handed_over_at?: string | null;
  delivered_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // The parcel's place in the order's replacement chain. Absent on a row read by a query
  // that does not select them, which `parcelSequenceNo` reads as the original parcel.
  sequence_no?: number | null;
  replaces_fulfillment_order_id?: string | null;
  replacement_reason?: string | null;
  shipping_address_snapshot?: Record<string, unknown> | null;
}

export interface OmsFulfillmentOperationRow {
  fulfillment_order_id: string;
  operation_type: string;
  occurred_at: string;
}

export interface OmsProviderAttemptRow {
  fulfillment_order_id: string;
  provider_kind?: string | null;
  status?: string | null;
  provider_tracking_id?: string | null;
  error?: unknown;
  created_at?: string | null;
}

export interface OmsOmnipackDispatchRefRow {
  id?: string | null;
  fulfillment_order_id: string;
  provider_order_id?: string | null;
  dispatch_mode?: string | null;
  status?: string | null;
  error?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface OmsOmnipackStatusEvidenceRow {
  id?: string | null;
  fulfillment_order_id: string;
  provider_status?: string | null;
  provider_sub_status?: string | null;
  local_status?: string | null;
  customer_status?: string | null;
  evidence_kind?: string | null;
  occurred_at?: string | null;
  created_at?: string | null;
}

export interface OmsReleasedProviderExceptionHoldRow {
  order_id: string;
  status?: string | null;
  reason?: string | null;
  created_by?: string | null;
  released_by?: string | null;
  metadata?: unknown;
}

export interface OmsShipmentExternalRefRow {
  order_id: string;
  fulfillment_order_id?: string | null;
  provider_tracking_id: string;
  active: boolean;
  provider_kind?: string | null;
  tracking_url?: string | null;
  carrier_kind?: string | null;
  service?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export function buildOmsFulfillmentSummary(input: {
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  fulfillmentOperations: OmsFulfillmentOperationRow[];
  shipmentExternalRefs: OmsShipmentExternalRefRow[];
  providerAttempts?: OmsProviderAttemptRow[];
  omnipackDispatchRefs?: OmsOmnipackDispatchRefRow[];
  omnipackStatusEvidence?: OmsOmnipackStatusEvidenceRow[];
}): OmsOrderDetail["fulfillment"] {
  const fulfillmentOrder = input.fulfillmentOrders[0] ?? null;
  if (!fulfillmentOrder) {
    return {
      fulfillmentOrderId: null,
      status: null,
      providerKind: null,
      latestOperationType: null,
      latestOperationAt: null,
      providerTrackingId: null,
      trackingUrl: null,
      carrierKind: null,
      service: null,
      trackingReferences: [],
      trackingTimeline: [],
      providerEvidence: [],
    };
  }

  // Every other companion below is already narrowed to this parcel by `fulfillment_order_id`;
  // tracking references only joined them once the column existed. An unattributed row still
  // answers for any parcel, so a one-parcel order reads exactly as it did before.
  const parcelRefs = rowsForParcel(input.shipmentExternalRefs, fulfillmentOrder.id);
  const trackingReferences = parcelRefs
    .filter((row) => row.active !== false)
    .filter((row) => Boolean(row.provider_tracking_id))
    .map((row) => ({
      providerKind: row.provider_kind ?? "unknown",
      trackingNumber: row.provider_tracking_id,
      trackingUrl: row.tracking_url ?? null,
      carrierKind: row.carrier_kind ?? row.provider_kind ?? null,
      service: row.service ?? null,
      updatedAt: row.updated_at ?? row.created_at ?? null,
    }))
    .sort((a, b) => parseTimestampOrZero(b.updatedAt) - parseTimestampOrZero(a.updatedAt));
  const fulfillmentTimeline = input.fulfillmentOperations
    .filter((operation) => operation.fulfillment_order_id === fulfillmentOrder.id)
    .map((operation) => ({
      eventType: operation.operation_type,
      label: labelForOperation(operation.operation_type),
      occurredAt: operation.occurred_at,
      source: "fulfillment" as const,
    }));
  const providerStatusTimeline = (input.omnipackStatusEvidence ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
    .map((row) => {
      const eventType = row.customer_status ?? row.local_status ?? row.provider_status ?? "provider_status";
      return {
        eventType,
        label: labelForOperation(eventType),
        occurredAt: row.occurred_at ?? null,
        source: sourceForEvidenceKind(row.evidence_kind),
      };
    });
  const dispatchTimeline = (input.omnipackDispatchRefs ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
    .map((row) => ({
      eventType: `dispatch_${row.status ?? "recorded"}`,
      label: row.status === "created" ? "Wyslane do OmniPack" : row.status === "failed" ? "Dispatch OmniPack wymaga sprawdzenia" : "Dispatch OmniPack zapisany",
      occurredAt: row.updated_at ?? row.created_at ?? null,
      source: "dispatch" as const,
    }));
  const trackingTimeline = [...fulfillmentTimeline, ...providerStatusTimeline, ...dispatchTimeline]
    .sort((a, b) => parseTimestampOrZero(b.occurredAt) - parseTimestampOrZero(a.occurredAt))
    .slice(0, 12);
  const providerEvidence = [
    ...(input.omnipackDispatchRefs ?? [])
      .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
      .map((row) => ({
        evidenceType: "dispatch_ref" as const,
        status: row.status ?? null,
        providerStatus: null,
        providerOrderId: row.provider_order_id ?? null,
        evidenceKind: row.dispatch_mode ?? null,
        occurredAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? row.created_at ?? null,
        summary: row.error ? "dispatch_error_present" : null,
      })),
    ...(input.providerAttempts ?? [])
      .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
      .map((row) => ({
        evidenceType: "provider_attempt" as const,
        status: row.status ?? null,
        providerStatus: row.provider_kind ?? null,
        providerOrderId: null,
        evidenceKind: "provider_attempt",
        occurredAt: row.created_at ?? null,
        updatedAt: row.created_at ?? null,
        summary: row.error ? "provider_attempt_error_present" : null,
      })),
    ...(input.omnipackStatusEvidence ?? [])
      .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
      .map((row) => ({
        evidenceType: "status_evidence" as const,
        status: row.local_status ?? null,
        providerStatus: row.provider_status ?? null,
        providerOrderId: null,
        evidenceKind: row.evidence_kind ?? null,
        occurredAt: row.occurred_at ?? null,
        updatedAt: row.created_at ?? null,
        summary: row.provider_sub_status ?? null,
      })),
  ].sort((a, b) => parseTimestampOrZero(b.updatedAt ?? b.occurredAt) - parseTimestampOrZero(a.updatedAt ?? a.occurredAt));
  const latestOperation = input.fulfillmentOperations
    .find((operation) => operation.fulfillment_order_id === fulfillmentOrder.id) ?? null;
  const tracking = parcelRefs.find((ref) => ref.order_id === fulfillmentOrder.order_id && ref.active) ?? null;

  return {
    fulfillmentOrderId: fulfillmentOrder.id,
    status: fulfillmentOrder.status,
    providerKind: trackingReferences[0]?.providerKind ?? fulfillmentOrder.provider_kind ?? null,
    latestOperationType: latestOperation?.operation_type ?? null,
    latestOperationAt: latestOperation?.occurred_at ?? null,
    providerTrackingId: trackingReferences[0]?.trackingNumber ?? tracking?.provider_tracking_id ?? null,
    trackingUrl: trackingReferences[0]?.trackingUrl ?? null,
    carrierKind: trackingReferences[0]?.carrierKind ?? null,
    service: trackingReferences[0]?.service ?? null,
    trackingReferences,
    trackingTimeline,
    providerEvidence,
  };
}

export function deriveOmsCustomerFulfillmentStep(
  orderStatus: string | null | undefined,
  fulfillment: OmsOrderDetail["fulfillment"],
  deliveredAt?: string | null,
  releasedProviderExceptionHolds: OmsReleasedProviderExceptionHoldRow[] = [],
  omnipackStatusEvidence: OmsOmnipackStatusEvidenceRow[] = [],
  activeHoldCount = 0,
): CustomerFulfillmentStep {
  if (activeHoldCount > 0) return "exception";
  const recovery = resolveProviderExceptionRecovery({
    fulfillmentOrderId: fulfillment.fulfillmentOrderId,
    releasedHolds: releasedProviderExceptionHolds.map(toReleasedProviderExceptionHold),
    statusEvidence: omnipackStatusEvidence.map((row) => ({
      id: row.id,
      fulfillmentOrderId: row.fulfillment_order_id,
      providerStatus: row.provider_status,
      localStatus: row.local_status,
      occurredAt: row.occurred_at,
      token: customerSafeEvidenceToken(row.local_status, row.provider_status),
    })),
  });
  return customerStepFromTimedSignals(
    [orderStatus, fulfillment.status],
    [
      ...(deliveredAt ? [{ token: "delivered", occurredAt: deliveredAt }] : []),
      ...omnipackStatusEvidence
        .filter((row) => row.fulfillment_order_id === fulfillment.fulfillmentOrderId)
        .map((row) => ({
          id: row.id,
          token: customerSafeEvidenceToken(row.local_status, row.provider_status),
          occurredAt: row.occurred_at,
        })),
      ...fulfillment.trackingTimeline
        .filter((event) => event.source === "fulfillment")
        .map((event) => ({
          token: event.eventType,
          occurredAt: event.occurredAt,
        })),
    ],
    recovery,
  );
}

function toReleasedProviderExceptionHold(
  row: OmsReleasedProviderExceptionHoldRow,
): ReleasedProviderExceptionHold {
  return {
    orderId: row.order_id,
    status: row.status ?? null,
    reason: row.reason ?? null,
    createdBy: row.created_by ?? null,
    releasedBy: row.released_by ?? null,
    metadata: row.metadata,
  };
}

/**
 * Timeline label for one raw fulfillment operation / provider evidence token,
 * DERIVED from the canon (`statusMap.ts`, docs/FULFILLMENT_STATUS_CANON.md).
 * This must never become a second status->label dictionary: the OMS timeline and
 * the customer timeline read the same token the same way, so a label can no
 * longer drift from the step the customer is shown. A token the canon does not
 * resolve keeps the milestone-agnostic line rather than guessing a milestone.
 */
function labelForOperation(operationType: string): string {
  const step = stepForToken(operationType);
  return step ? timelineLabelForStep(step) : "Status dostawy zaktualizowany";
}

function sourceForEvidenceKind(kind: string | null | undefined): "webhook" | "reconciliation" | "provider" {
  if (kind === "webhook") return "webhook";
  if (kind === "reconciliation") return "reconciliation";
  return "provider";
}

// Shared with the two sibling read-model modules that sorted the same evidence
// rows through a byte-identical private copy of this function. Not merged with
// omsAccountingVisibility's `timestampOrNull`: that one answers null for a
// missing instant so the outbox comparator can rank "unknown" apart from the
// epoch, which this zero-defaulting sort must not do.
export function parseTimestampOrZero(value: string | null | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}
