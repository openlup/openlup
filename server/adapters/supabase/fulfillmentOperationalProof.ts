import type { AdminOmnipackOperationalProofResponse } from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentOmnipackOperationalProofPort } from "../../../src/domains/fulfillment/ports.js";
import type { FulfillmentEvidenceSupabaseClient } from "./fulfillmentEvidencePorts.js";

const TERMINAL_PROVIDER_STATUSES = new Set(["packed", "handed_over", "in_transit", "delivered"]);

export function createSupabaseOmnipackOperationalProofPort(
  client: FulfillmentEvidenceSupabaseClient,
): FulfillmentOmnipackOperationalProofPort {
  return {
    async getOmnipackOperationalProof() {
      const generatedAt = new Date().toISOString();
      const [
        inboundEvents,
        statusEvidence,
        stockCursor,
        providerStock,
        lowStockEvidence,
        fulfillmentOrders,
      ] = await Promise.all([
        readRows<InboundProviderEventRow>(
          read(client)
            .from("inbound_provider_events")
            .select("event_type, processing_status, received_at, processed_at, received_via")
            .eq("provider", "omnipack")
            .order("received_at", { ascending: false })
            .limit(500),
          "inbound_provider_events",
        ),
        readRows<OmnipackStatusEvidenceRow>(
          read(client)
            .from("omnipack_status_evidence")
            .select("evidence_kind, local_status, created_at")
            .order("created_at", { ascending: false })
            .limit(500),
          "omnipack_status_evidence",
        ),
        readRows<OmnipackStockSyncCursorRow>(
          read(client)
            .from("omnipack_stock_sync_cursors")
            .select("status, last_stock_synced_at, updated_at")
            .eq("provider_kind", "omnipack")
            .limit(1),
          "omnipack_stock_sync_cursors",
        ),
        readRows<ProviderStockCurrentRow>(
          read(client)
            .from("fulfillment_provider_stock_current")
            .select("sku, stale_after, inventory_class")
            .eq("provider_kind", "omnipack"),
          "fulfillment_provider_stock_current",
        ),
        readRows<OmnipackLowStockEvidenceRow>(
          read(client)
            .from("omnipack_low_stock_evidence")
            .select("status, threshold_kind")
            .limit(500),
          "omnipack_low_stock_evidence",
        ),
        readRows<FulfillmentOrderRow>(
          read(client)
            .from("commerce_fulfillment_orders")
            .select("id, status, metadata")
            .eq("provider_kind", "omnipack")
            .order("updated_at", { ascending: false })
            .limit(500),
          "commerce_fulfillment_orders",
        ),
      ]);

      return buildProof({
        generatedAt,
        inboundEvents,
        statusEvidence,
        stockCursor: stockCursor[0] ?? null,
        providerStock,
        lowStockEvidence,
        fulfillmentOrders,
      });
    },
  };
}

function buildProof(input: {
  generatedAt: string;
  inboundEvents: InboundProviderEventRow[];
  statusEvidence: OmnipackStatusEvidenceRow[];
  stockCursor: OmnipackStockSyncCursorRow | null;
  providerStock: ProviderStockCurrentRow[];
  lowStockEvidence: OmnipackLowStockEvidenceRow[];
  fulfillmentOrders: FulfillmentOrderRow[];
}): AdminOmnipackOperationalProofResponse {
  const webhookEvents = input.inboundEvents.filter((event) => event.received_via === "omnipack.webhook.v0");
  const failedInboundEvents = input.inboundEvents.filter((event) => event.processing_status === "failed").length;
  const ignoredInboundEvents = input.inboundEvents.filter((event) => event.processing_status === "ignored").length;
  const reconciliationEvidence = input.statusEvidence.filter((row) => row.evidence_kind === "reconciliation");
  const reconciliationQuarantine = input.inboundEvents.filter((event) =>
    event.received_via === "omnipack.reconciliation.v0" && event.processing_status === "ignored"
  ).length;
  const staleProviderStockSkuCount = input.providerStock.filter((row) =>
    Date.parse(row.stale_after) <= Date.parse(input.generatedAt)
  ).length;
  const reservationCoverageCount = input.lowStockEvidence.filter((row) =>
    row.status !== "resolved" && row.threshold_kind === "reservation_coverage"
  ).length;
  const unknownStockSkuCount = input.providerStock.filter((row) =>
    row.inventory_class == null && Date.parse(row.stale_after) > Date.parse(input.generatedAt)
  ).length;
  const gapOrders = input.fulfillmentOrders.filter((order) =>
    TERMINAL_PROVIDER_STATUSES.has(order.status) && !providerStockConsumed(order.metadata)
  );
  const blockers = [
    webhookEvents.length === 0 ? "no_webhook_evidence" : null,
    reconciliationEvidence.length === 0 ? "no_reconciliation_evidence" : null,
    input.stockCursor === null ? "no_stock_sync_cursor" : null,
    input.stockCursor && input.stockCursor.status !== "succeeded" && input.stockCursor.status !== "failed"
      ? "stock_sync_not_succeeded"
      : null,
    input.providerStock.length === 0 ? "no_provider_current_stock" : null,
    failedInboundEvents > 0 ? "failed_inbound_events" : null,
    input.stockCursor?.status === "failed" ? "stock_sync_failed" : null,
    staleProviderStockSkuCount > 0 ? "stale_provider_stock" : null,
    reservationCoverageCount > 0 ? "reservation_coverage_shortage" : null,
    gapOrders.length > 0 ? "provider_stock_consumption_gap" : null,
  ].filter((value): value is string => Boolean(value));

  return {
    generatedAt: input.generatedAt,
    ok: blockers.length === 0,
    blockers,
    webhooks: {
      routes: webhookRoutes(webhookEvents),
      failedInboundEvents,
      ignoredInboundEvents,
    },
    reconciliation: {
      lastReconciledAt: reconciliationEvidence[0]?.created_at ?? null,
      statusEvidenceCount: reconciliationEvidence.length,
      quarantineCount: reconciliationQuarantine,
    },
    stockSync: {
      status: input.stockCursor?.status ?? null,
      lastStockSyncedAt: input.stockCursor?.last_stock_synced_at ?? null,
      staleProviderStockSkuCount,
      reservationCoverageCount,
      unknownStockSkuCount,
    },
    fulfillment: {
      consumedReservationGapCount: gapOrders.length,
      sampleFulfillmentOrderIds: gapOrders.slice(0, 10).map((order) => order.id),
    },
  };
}

function webhookRoutes(events: InboundProviderEventRow[]) {
  const byRoute = new Map<string, InboundProviderEventRow[]>();
  for (const event of events) {
    byRoute.set(event.event_type, [...(byRoute.get(event.event_type) ?? []), event]);
  }

  return [...byRoute.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([route, routeEvents]) => ({
    route,
    lastReceivedAt: routeEvents[0]?.received_at ?? null,
    lastProcessedAt: routeEvents.find((event) => event.processed_at)?.processed_at ?? null,
    failedCount: routeEvents.filter((event) => event.processing_status === "failed").length,
    ignoredCount: routeEvents.filter((event) => event.processing_status === "ignored").length,
  }));
}

function providerStockConsumed(metadata: unknown): boolean {
  return isRecord(metadata) && typeof metadata.providerStockConsumedAt === "string" && metadata.providerStockConsumedAt.length > 0;
}

async function readRows<T>(query: PromiseLike<QueryResult>, table: string): Promise<T[]> {
  const result = await query;
  if (result.error) throw new Error(`${table}_read_failed`);
  return Array.isArray(result.data) ? result.data as T[] : [];
}

function read(client: FulfillmentEvidenceSupabaseClient): { from(table: string): ProofQuery } {
  return client as unknown as { from(table: string): ProofQuery };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProofQuery extends PromiseLike<QueryResult> {
  select(columns: string): ProofQuery;
  eq(column: string, value: unknown): ProofQuery;
  order(column: string, options: Record<string, unknown>): ProofQuery;
  limit(count: number): ProofQuery;
}

interface QueryResult {
  data: unknown;
  error: { message?: string } | null;
}

interface InboundProviderEventRow {
  event_type: string;
  processing_status: string;
  received_at: string;
  processed_at: string | null;
  received_via: string | null;
}

interface OmnipackStatusEvidenceRow {
  evidence_kind: string;
  local_status: string | null;
  created_at: string;
}

interface OmnipackStockSyncCursorRow {
  status: string;
  last_stock_synced_at: string | null;
  updated_at: string;
}

interface ProviderStockCurrentRow {
  sku: string;
  stale_after: string;
  inventory_class: string | null;
}

interface OmnipackLowStockEvidenceRow {
  status: string;
  threshold_kind: string;
}

interface FulfillmentOrderRow {
  id: string;
  status: string;
  metadata: unknown;
}
