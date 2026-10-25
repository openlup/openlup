import { rowsForParcel } from "@openlup/core/fulfillment";
import type { OmsFulfillmentOperationRow,OmsFulfillmentOrderRow,OmsProviderAttemptRow,OmsProviderDispatchRefRow,OmsProviderStatusEvidenceRow,OmsReleasedProviderExceptionHoldRow,OmsShipmentExternalRefRow } from "../contracts/omsTypes.js";
import type { OmsOrderDetail } from "../oms/omsContracts.js";
import {
customerSafeEvidenceToken,
customerStepFromTimedSignals,
resolveProviderExceptionRecovery,stepForToken,type CustomerFulfillmentStep,
type ReleasedProviderExceptionHold
} from "./customerFulfillmentRecovery.js";
import type { OmsReadModelProjections } from "./omsReadModelProjections.js";
export type { OmsFulfillmentOperationRow,OmsFulfillmentOrderRow,OmsProviderAttemptRow,OmsProviderDispatchRefRow,OmsProviderStatusEvidenceRow,OmsReleasedProviderExceptionHoldRow,OmsShipmentExternalRefRow } from "../contracts/omsTypes.js";

export function buildOmsFulfillmentSummary(input: {
  projections?: OmsReadModelProjections;
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  fulfillmentOperations: OmsFulfillmentOperationRow[];
  shipmentExternalRefs: OmsShipmentExternalRefRow[];
  providerAttempts?: OmsProviderAttemptRow[];
  providerDispatchRefs?: OmsProviderDispatchRefRow[];
  providerStatusEvidence?: OmsProviderStatusEvidenceRow[];
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
      label: labelForOperation(operation.operation_type, input.projections),
      occurredAt: operation.occurred_at,
      source: "fulfillment" as const,
    }));
  const providerStatusTimeline = (input.providerStatusEvidence ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
    .map((row) => {
      const eventType = row.customer_status ?? row.local_status ?? row.provider_status ?? "provider_status";
      return {
        eventType,
        label: labelForOperation(eventType, input.projections),
        occurredAt: row.occurred_at ?? null,
        source: sourceForEvidenceKind(row.evidence_kind),
      };
    });
  const dispatchTimeline = (input.providerDispatchRefs ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillmentOrder.id)
    .map((row) => ({
      eventType: `dispatch_${row.status ?? "recorded"}`,
      label: input.projections?.dispatchLabel?.(row.status) ?? "Provider dispatch recorded",
      occurredAt: row.updated_at ?? row.created_at ?? null,
      source: "dispatch" as const,
    }));
  const trackingTimeline = [...fulfillmentTimeline, ...providerStatusTimeline, ...dispatchTimeline]
    .sort((a, b) => parseTimestampOrZero(b.occurredAt) - parseTimestampOrZero(a.occurredAt))
    .slice(0, 12);
  const providerEvidence = [
    ...(input.providerDispatchRefs ?? [])
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
    ...(input.providerStatusEvidence ?? [])
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
  providerStatusEvidence: OmsProviderStatusEvidenceRow[] = [],
  activeHoldCount = 0,
  projections?: OmsReadModelProjections,
): CustomerFulfillmentStep {
  if (activeHoldCount > 0) return "exception";
  const recovery = resolveProviderExceptionRecovery({
    automaticHoldSource: projections?.automaticExceptionHoldSource,
    automaticReleaseSource: projections?.automaticExceptionReleaseSource,
    fulfillmentOrderId: fulfillment.fulfillmentOrderId,
    releasedHolds: releasedProviderExceptionHolds.map(toReleasedProviderExceptionHold),
    statusEvidence: providerStatusEvidence.map((row) => ({
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
      ...providerStatusEvidence
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

/** Resolve the same canonical step as the customer timeline, without choosing
 * a locale. Hosts supply presentation through the existing projection; the
 * neutral default is the step key, with the generic fallback for unknown tokens.
 * This is not another status-to-label table. */
function labelForOperation(operationType: string, projections?: OmsReadModelProjections): string {
  const step = stepForToken(operationType);
  return projections?.timelineLabel?.(step) ?? step ?? "Delivery status updated";
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
