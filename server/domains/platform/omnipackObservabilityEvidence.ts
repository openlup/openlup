import type { OmniPackHealthSnapshot } from "../../../src/domains/platform/observabilityContracts.js";
import {
  collectFulfillmentHealthAttentionEvidence,
  maxFulfillmentHealthAge,
  type OrderPaidOutboxEventEvidenceRow,
} from "./omnipackFulfillmentHealthObservability.js";
import { summarizeRecentOmnipackQuarantines } from "./omnipackObservabilityQuarantine.js";
export type OmniPackDispatchEvidenceRow = Record<string, unknown> & {
  fulfillment_order_id?: string | null;
  provider_order_id?: string | null;
  status?: string | null;
  sanitized_request?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
};
export type OmniPackOrderEvidenceRow = Record<string, unknown> & {
  id: string;
  status?: string | null;
  mode?: string | null;
  subscription_id?: string | null;
  subscription_cycle_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
};
export type OmniPackFulfillmentOrderEvidenceRow = Record<string, unknown> & {
  id: string;
  order_id: string;
  status?: string | null;
  provider_kind?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};
export type OmniPackStatusEvidenceRow = Record<string, unknown> & {
  fulfillment_order_id?: string | null;
  local_status?: string | null;
  provider_status?: string | null;
  created_at?: string | null;
  occurred_at?: string | null;
};
export type OmniPackStockCursorEvidenceRow = Record<string, unknown> & {
  status?: string | null;
  updated_at?: string | null;
  last_stock_synced_at?: string | null;
};
export type OmniPackStockSnapshotEvidenceRow = Record<string, unknown> & {
  sku?: string | null;
  mismatch_kind?: string | null;
  snapshot_at?: string | null;
};
export type OmniPackProviderStockCurrentEvidenceRow = Record<string, unknown> & {
  sku?: string | null;
  inventory_class?: string | null;
  stale_after?: string | null;
};
export type OmniPackLowStockEvidenceRow = Record<string, unknown> & {
  sku?: string | null;
  provider_for_sale_quantity?: number | null;
  local_available_quantity?: number | null;
  first_seen_at?: string | null;
  created_at?: string | null;
  last_seen_at?: string | null;
  status?: string | null;
  threshold_kind?: string | null;
};
export type OmniPackInboundEventRow = Record<string, unknown> & {
  provider?: string | null;
  processing_status?: string | null;
  received_at?: string | null;
  error?: Record<string, unknown> | null;
};

const ACTIONABLE_SHORTAGE_KINDS = new Set(["safety_stock", "forecast", "manual"]);

export function summarizeOmniPackEvidence(input: {
  dispatchRefs: OmniPackDispatchEvidenceRow[];
  statusEvidence: OmniPackStatusEvidenceRow[];
  stockCursors: OmniPackStockCursorEvidenceRow[];
  stockSnapshots?: OmniPackStockSnapshotEvidenceRow[];
  providerStockCurrent?: OmniPackProviderStockCurrentEvidenceRow[];
  lowStockEvidence: OmniPackLowStockEvidenceRow[];
  orders?: OmniPackOrderEvidenceRow[];
  fulfillmentOrders?: OmniPackFulfillmentOrderEvidenceRow[];
  orderPaidOutboxEvents?: OrderPaidOutboxEventEvidenceRow[];
  inboundEvents?: OmniPackInboundEventRow[];
  reconciliationStateConflictCount?: number;
  now: Date;
}): OmniPackHealthSnapshot {
  const staleStatusCutoff = input.now.getTime() - 6 * 60 * 60 * 1000;
  // `label_created` cannot share the 6h cutoff: a label minted Friday 18:00 is
  // not collected until Monday ~09:00 (~63h), so 6h would page every weekend.
  // 72h clears the worst legitimate weekend with margin.
  const staleLabelCreatedCutoff = input.now.getTime() - 72 * 60 * 60 * 1000;
  const staleStockCutoff = input.now.getTime() - 2 * 60 * 60 * 1000;
  const staleDispatchCutoff = input.now.getTime() - 5 * 60 * 1000;
  const recentInboundCutoff = input.now.getTime() - 24 * 60 * 60 * 1000;
  const recentQuarantines = summarizeRecentOmnipackQuarantines(input.inboundEvents ?? [], recentInboundCutoff);
  const latestStatusEvidenceAt = latest(input.statusEvidence.map((row) => row.occurred_at ?? row.created_at));
  const latestStockSyncAt = latest(input.stockCursors.map((row) => row.last_stock_synced_at ?? row.updated_at));
  const dispatchRefsByFulfillment = latestDispatchRefsByFulfillment(input.dispatchRefs);
  const fulfillmentByOrder = groupFulfillmentByOrder(input.fulfillmentOrders ?? []);
  const activeFulfillmentIds = new Set(
    [...fulfillmentByOrder.values()]
      .map(newestFulfillment)
      .filter((row): row is OmniPackFulfillmentOrderEvidenceRow =>
        row !== null && ["created", "label_pending"].includes(text(row.status))
      )
      .map((row) => row.id),
  );
  const activeDispatchRefs = [...dispatchRefsByFulfillment.values()].filter((row) =>
    typeof row.fulfillment_order_id === "string" && activeFulfillmentIds.has(row.fulfillment_order_id)
  );
  const paidProviderOrders = (input.orders ?? []).filter(isPaidProviderOrder);
  const fulfillmentHealthEvidence = collectFulfillmentHealthAttentionEvidence(input);
  const reservationCoverageRows = input.lowStockEvidence.filter((row) =>
    row.status !== "resolved" && text(row.threshold_kind) === "reservation_coverage"
  );
  return {
    dispatchFailureCount: activeDispatchRefs.filter((row) => text(row.status) === "failed").length,
    paidOrderMissingDispatchRefCount: paidProviderOrders.filter((order) => {
      const fulfillment = newestFulfillment(fulfillmentByOrder.get(order.id) ?? []);
      return !fulfillment || !dispatchRefsByFulfillment.has(fulfillment.id);
    }).length,
    wrongFulfillmentProviderCount: paidProviderOrders.filter((order) => {
      const fulfillment = newestFulfillment(fulfillmentByOrder.get(order.id) ?? []);
      return Boolean(fulfillment && text(fulfillment.provider_kind) && text(fulfillment.provider_kind) !== "omnipack");
    }).length,
    staleDispatchRefCount: activeDispatchRefs.filter((row) => {
      const updatedAt = timestamp(row.updated_at ?? row.created_at);
      return text(row.status) === "submitting" && (updatedAt <= 0 || updatedAt < staleDispatchCutoff);
    }).length,
    missingProviderOrderIdCount: activeDispatchRefs.filter((row) =>
      text(row.status) === "created" && !text(row.provider_order_id),
    ).length,
    payloadMismatchCount: activeDispatchRefs.filter((row) => dispatchPayloadMismatchesDictionary(row)).length,
    staleStockSyncCount: latestStockSyncAt && Date.parse(latestStockSyncAt) >= staleStockCutoff ? 0 : 1,
    actionableShortageEvidenceCount: input.lowStockEvidence.filter((row) =>
      row.status !== "resolved" && ACTIONABLE_SHORTAGE_KINDS.has(text(row.threshold_kind)),
    ).length,
    reservationCoverageCount: reservationCoverageRows.length,
    reservationCoverageEvidence: reservationCoverageRows
      .map((row) => ({
        sku: safeSku(row.sku),
        providerForSaleQuantity: safeQuantity(row.provider_for_sale_quantity),
        localAvailableQuantity: safeQuantity(row.local_available_quantity),
        firstSeenAt: safeTimestamp(row.first_seen_at ?? row.created_at),
        lastSeenAt: safeTimestamp(row.last_seen_at),
      }))
      .filter((row) => row.sku !== "unknown")
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, 10),
    unknownStockSkuCount: input.providerStockCurrent?.filter((row) =>
      row.inventory_class == null && timestamp(row.stale_after) > input.now.getTime()
    ).length ?? 0,
    recentQuarantinedInboundCount: recentQuarantines.other,
    reconciliationStateConflictCount: input.reconciliationStateConflictCount ?? recentQuarantines.stateConflicts,
    // Frozen = mid-pipeline status with no update past 6h: neither the
    // picking/shipping webhooks nor reconciliation advanced this fulfillment.
    // Only tokens the commerce_fulfillment_orders CHECK constraint allows count
    // here; `provider_received`/`picking` are omnipack_status_evidence
    // local_status values and can never appear on this column. `created` is
    // excluded on purpose — it is owned by the p0
    // omnipack_paid_order_missing_dispatch_ref and the fulfillmentHealth*
    // family, so counting it here would double-page one root cause.
    frozenFulfillmentCount: countFrozenFulfillment(input.fulfillmentOrders ?? [], ["packed", "label_pending"], staleStatusCutoff),
    // Same failure, different clock: the label exists and the carrier has not
    // collected it. See staleLabelCreatedCutoff for why 6h cannot be reused.
    frozenLabelCreatedCount: countFrozenFulfillment(input.fulfillmentOrders ?? [], ["label_created"], staleLabelCreatedCutoff),
    fulfillmentHealthAttentionCount: fulfillmentHealthEvidence.length,
    fulfillmentHealthMissingLocalCommitmentCount: fulfillmentHealthEvidence.filter((row) => row.healthStatus === "missing_local_commitment").length,
    fulfillmentHealthBlockedUncertainCount: fulfillmentHealthEvidence.filter((row) => row.healthStatus === "blocked_uncertain").length,
    fulfillmentHealthLocalAheadCount: fulfillmentHealthEvidence.filter((row) => row.healthStatus === "local_ahead").length,
    fulfillmentHealthProviderAheadCount: fulfillmentHealthEvidence.filter((row) => row.healthStatus === "provider_ahead").length,
    fulfillmentHealthNeedsAttentionCount: fulfillmentHealthEvidence.filter((row) => row.healthStatus === "needs_attention").length,
    fulfillmentHealthOldestAgeSeconds: maxFulfillmentHealthAge(fulfillmentHealthEvidence.map((row) => row.oldestAgeSeconds)),
    fulfillmentHealthEvidence,
    latestStatusEvidenceAt,
    latestStockSyncAt,
  };
}

function countFrozenFulfillment(
  rows: OmniPackFulfillmentOrderEvidenceRow[],
  statuses: string[],
  cutoff: number,
): number {
  return rows.filter((row) => {
    const updatedAt = timestamp(row.updated_at);
    return statuses.includes(text(row.status)) && updatedAt > 0 && updatedAt <= cutoff;
  }).length;
}

function isPaidProviderOrder(row: OmniPackOrderEvidenceRow): boolean {
  if (!["paid", "fulfillment_pending", "fulfilled"].includes(text(row.status))) return false;
  return readSelectedDeliveryProviderKind(row.metadata) === "omnipack";
}

function readSelectedDeliveryProviderKind(metadata: Record<string, unknown> | null | undefined): string | null {
  const direct = object(metadata?.selectedDelivery);
  const runtimeFinalize = object(metadata?.runtimeFinalize);
  const nested = object(runtimeFinalize?.selectedDelivery);
  return text(direct?.providerKind ?? nested?.providerKind) || null;
}

function dispatchPayloadMismatchesDictionary(row: OmniPackDispatchEvidenceRow): boolean {
  const request = object(row.sanitized_request);
  if (!request) return false;
  const carrier = text(request.carrier);
  const service = text(request.service);
  const pickUpPoint = text(request.pickUpPoint);
  const itemCount = typeof request.itemCount === "number" ? request.itemCount : null;
  if (!carrier || !service) return true;
  if (service.includes("locker") && !pickUpPoint) return true;
  if (itemCount !== null && itemCount <= 0) return true;
  return false;
}

function groupFulfillmentByOrder(rows: OmniPackFulfillmentOrderEvidenceRow[]) {
  const grouped = new Map<string, OmniPackFulfillmentOrderEvidenceRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.order_id) ?? [];
    current.push(row);
    grouped.set(row.order_id, current);
  }
  return grouped;
}

function newestFulfillment(rows: OmniPackFulfillmentOrderEvidenceRow[]): OmniPackFulfillmentOrderEvidenceRow | null {
  return [...rows].sort((a, b) =>
    timestamp(b.updated_at ?? b.created_at) - timestamp(a.updated_at ?? a.created_at)
  )[0] ?? null;
}

function latestDispatchRefsByFulfillment(rows: OmniPackDispatchEvidenceRow[]): Map<string, OmniPackDispatchEvidenceRow> {
  const latest = new Map<string, OmniPackDispatchEvidenceRow>();
  for (const row of rows) {
    const fulfillmentOrderId = typeof row.fulfillment_order_id === "string" ? row.fulfillment_order_id : "";
    if (!fulfillmentOrderId) continue;
    const current = latest.get(fulfillmentOrderId);
    if (!current || timestamp(row.updated_at ?? row.created_at) > timestamp(current.updated_at ?? current.created_at)) {
      latest.set(fulfillmentOrderId, row);
    }
  }
  return latest;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeSku(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(normalized) ? normalized : "unknown";
}

function safeQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function latest(values: Array<string | null | undefined>): string | null {
  const sorted = values.filter(Boolean).sort();
  return sorted[sorted.length - 1] ?? null;
}
