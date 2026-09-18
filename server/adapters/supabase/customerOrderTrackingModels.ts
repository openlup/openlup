import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerOrderDetailResponse,
} from "../../../src/domains/customers/accountV2Contracts.js";
import { buildFulfillmentEvidenceSummary } from "../../../src/domains/fulfillment/types.js";
import {
  customerSafeEvidenceToken,
  customerStepForTerminalOrder,
  customerStepFromTimedSignals,
  resolveProviderExceptionRecovery,
  type ReleasedProviderExceptionHold,
  type ResolvedProviderExceptionRecovery,
} from "../../../src/lib/customerFulfillmentCanon.js";
import { rowsForParcel } from "../../../src/lib/currentFulfillmentParcel.js";

type Row = Record<string, unknown>;
type FulfillmentSummary = NonNullable<CustomerOrderDetailResponse["order"]["fulfillment"]>;

export interface CustomerOrderTrackingCompanions {
  tracking: Map<string, Row[]>;
  operations: Map<string, Row[]>;
  evidence: Map<string, Row[]>;
}

// `parcelId` is the parcel currently representing the order. An order that has never taken a
// replacement has exactly one, and its references are either attributed to it or unattributed, so
// this narrowing is inert there. On an order that has, it is the difference between the customer
// reading the tracking number of the parcel on its way and the number of the one that was lost.
export function buildCustomerTrackingSummary(
  orderId: string,
  companions: CustomerOrderTrackingCompanions,
  recovery?: ResolvedProviderExceptionRecovery,
  parcelId?: string | null,
) {
  const evidence = buildFulfillmentEvidenceSummary({
    trackingRefs: rowsForParcel(companions.tracking.get(orderId) ?? [], parcelId),
    statusEvidenceRows: companions.evidence.get(orderId) ?? [],
    operationRows: companions.operations.get(orderId) ?? [],
    recovery,
  });
  return {
    trackingReferences: evidence.trackingReferences,
    trackingNumbers: evidence.trackingNumbers,
    trackingNumber: evidence.trackingNumber,
    trackingUrl: evidence.trackingUrl,
    carrierKind: evidence.carrierKind,
    service: evidence.service,
    trackingTimeline: evidence.trackingTimeline,
  };
}

export function buildCustomerFulfillmentSummary(
  row: Row,
  trackingSummary: ReturnType<typeof buildCustomerTrackingSummary>,
  lastOperation: Row | null,
): FulfillmentSummary {
  return {
    fulfillmentOrderId: text(row.id) || null,
    status: nullableText(row.status),
    providerKind: nullableText(row.provider_kind) ?? trackingSummary.trackingReferences[0]?.providerKind ?? null,
    trackingNumber: trackingSummary.trackingNumber,
    trackingNumbers: trackingSummary.trackingNumbers,
    trackingReferences: trackingSummary.trackingReferences,
    lastEventType: nullableText(lastOperation?.operation_type) ?? trackingSummary.trackingTimeline[0]?.eventType ?? null,
    updatedAt: nullableText(row.updated_at) ?? nullableText(lastOperation?.occurred_at),
    trackingTimeline: trackingSummary.trackingTimeline,
  };
}

export async function readReleasedProviderExceptionHolds(
  serviceClient: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, ReleasedProviderExceptionHold[]>> {
  const map = new Map<string, ReleasedProviderExceptionHold[]>();
  if (orderIds.length === 0) return map;
  const { data, error } = await serviceClient
    .from("commerce_order_holds")
    .select("order_id, status, reason, created_by, released_by, metadata")
    .in("order_id", orderIds)
    .eq("status", "released")
    .eq("reason", "fulfillment_exception");
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const orderId = text(row.order_id);
    if (!orderId) continue;
    const rows = map.get(orderId) ?? [];
    rows.push({
      orderId,
      status: nullableText(row.status),
      reason: nullableText(row.reason),
      createdBy: nullableText(row.created_by),
      releasedBy: nullableText(row.released_by),
      metadata: row.metadata,
    });
    map.set(orderId, rows);
  }
  return map;
}

/**
 * Fetch the exact evidence pair persisted on an automatic OmniPack release.
 * The customer-history feed is intentionally bounded; recovery correctness may
 * not depend on that general-purpose limit retaining an older exception row.
 */
export async function readReleasedProviderExceptionEvidence(
  serviceClient: SupabaseClient,
  releasedHolds: Map<string, ReleasedProviderExceptionHold[]>,
): Promise<Map<string, Row[]>> {
  const evidenceIds = new Set<string>();
  for (const holds of releasedHolds.values()) for (const hold of holds) {
    const evidence = record(record(hold.metadata).autoReleaseEvidence);
    for (const id of [text(evidence.clearedStatusEvidenceId), text(evidence.statusEvidenceId)]) if (id) evidenceIds.add(id);
  }
  const map = new Map<string, Row[]>();
  if (evidenceIds.size === 0) return map;
  const { data, error } = await serviceClient
    .from("omnipack_status_evidence")
    .select("id, order_id, fulfillment_order_id, provider_status, local_status, evidence_kind, occurred_at, created_at")
    .in("id", [...evidenceIds]);
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const orderId = text(row.order_id);
    if (!orderId) continue;
    const rows = map.get(orderId) ?? [];
    rows.push(row);
    map.set(orderId, rows);
  }
  return map;
}

export async function readActiveCustomerOrderHoldIds(
  serviceClient: SupabaseClient,
  orderIds: string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const { data, error } = await serviceClient
    .from("commerce_order_holds")
    .select("order_id")
    .in("order_id", orderIds)
    .eq("status", "active");
  if (error) throw error;
  return new Set((data ?? []).map((row) => text((row as Row).order_id)).filter(Boolean));
}

export function buildCustomerRecoveryMap(
  fulfillments: Row[],
  evidence: Map<string, Row[]>,
  releasedHolds: Map<string, ReleasedProviderExceptionHold[]>,
): Map<string, ResolvedProviderExceptionRecovery> {
  const recovery = new Map<string, ResolvedProviderExceptionRecovery>();
  for (const fulfillment of fulfillments) {
    const orderId = text(fulfillment.order_id);
    if (!orderId) continue;
    recovery.set(orderId, resolveProviderExceptionRecovery({
      fulfillmentOrderId: nullableText(fulfillment.id),
      releasedHolds: releasedHolds.get(orderId) ?? [],
      statusEvidence: (evidence.get(orderId) ?? []).map((row) => ({
        id: nullableText(row.id),
        fulfillmentOrderId: nullableText(row.fulfillment_order_id),
        providerStatus: nullableText(row.provider_status),
        localStatus: nullableText(row.local_status),
        token: customerSafeEvidenceToken(nullableText(row.local_status), nullableText(row.provider_status)),
        occurredAt: nullableText(row.occurred_at),
      })),
    }));
  }
  return recovery;
}

export function customerStepFromCustomerOrder(
  orderStatus: string,
  fulfillmentStatus: string | null,
  evidence: Row[],
  recovery: ResolvedProviderExceptionRecovery | undefined,
  hasActiveHold: boolean,
) {
  if (hasActiveHold) return "exception";
  // A cancelled/refunded order cannot be talked past its own terminal state by
  // later carrier evidence. Sits next to the hold short-circuit on purpose: both
  // are off-track overrides of the ranked signals, and one place decides.
  const terminal = customerStepForTerminalOrder(orderStatus);
  if (terminal) return terminal;
  return customerStepFromTimedSignals(
    [orderStatus, fulfillmentStatus],
    evidence.map((row) => ({
      id: nullableText(row.id),
      token: customerSafeEvidenceToken(nullableText(row.local_status), nullableText(row.provider_status)),
      occurredAt: nullableText(row.occurred_at),
    })),
    recovery,
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
