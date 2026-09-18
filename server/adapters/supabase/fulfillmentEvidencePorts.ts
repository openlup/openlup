import type {
  AdminLowStockEvidenceItem,
  AdminProductReconciliationItem,
} from "../../../src/domains/fulfillment/contracts.js";
import type {
  FulfillmentLowStockEvidencePort,
  FulfillmentProductReconciliationEvidencePort,
} from "../../../src/domains/fulfillment/ports.js";

type EvidenceQueryResult<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;

interface EvidenceQuery<T> extends EvidenceQueryResult<T> {
  select(columns: string): EvidenceQuery<T>;
  eq(column: string, value: string): EvidenceQuery<T>;
  order(column: string, options: { ascending: boolean }): EvidenceQuery<T>;
}

export interface FulfillmentEvidenceSupabaseClient {
  from(table: string): EvidenceQuery<unknown>;
}

const LOW_STOCK_EVIDENCE_TABLE = "omnipack_low_stock_evidence";
const LOW_STOCK_EVIDENCE_COLUMNS =
  "id, sku, threshold_kind, severity, status, provider_for_sale_quantity, local_available_quantity, forecast_days, first_seen_at, last_seen_at, resolved_at";

const PRODUCT_RECONCILIATION_TABLE = "omnipack_product_reconciliation_evidence";
const PRODUCT_RECONCILIATION_COLUMNS =
  "id, sku, ean, conflict_kind, provider_quantity, status, first_seen_at, last_seen_at, resolved_at";

interface LowStockEvidenceRow {
  id: string;
  sku: string;
  threshold_kind: string;
  severity: string;
  status: string;
  provider_for_sale_quantity: number | null;
  local_available_quantity: number | null;
  forecast_days: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  resolved_at: string | null;
}

interface ReconciliationRow {
  id: string;
  sku: string;
  ean: string | null;
  conflict_kind: string;
  provider_quantity: number | null;
  status: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  resolved_at: string | null;
}

export function createSupabaseLowStockEvidencePort(
  client: FulfillmentEvidenceSupabaseClient,
): FulfillmentLowStockEvidencePort {
  return {
    async getLowStockEvidence({ statusFilter }) {
      const read = client as unknown as { from(table: string): EvidenceQuery<LowStockEvidenceRow> };
      let query = read
        .from(LOW_STOCK_EVIDENCE_TABLE)
        .select(LOW_STOCK_EVIDENCE_COLUMNS)
        .order("last_seen_at", { ascending: false });
      if (statusFilter !== "all") query = query.eq("status", statusFilter);

      const { data, error } = await query;
      if (error) throw new Error(error.message ?? "low_stock_evidence_query_failed");
      const items = (data ?? []).map(toLowStockEvidenceItem);

      const openCount =
        statusFilter === "open"
          ? items.length
          : (await read.from(LOW_STOCK_EVIDENCE_TABLE).select("id").eq("status", "open")).data?.length ?? 0;

      return { statusFilter, openCount, items };
    },
  };
}

export function createSupabaseProductReconciliationEvidencePort(
  client: FulfillmentEvidenceSupabaseClient,
): FulfillmentProductReconciliationEvidencePort {
  return {
    async getProductReconciliationEvidence({ statusFilter }) {
      const read = client as unknown as { from(table: string): EvidenceQuery<ReconciliationRow> };
      let query = read
        .from(PRODUCT_RECONCILIATION_TABLE)
        .select(PRODUCT_RECONCILIATION_COLUMNS)
        .order("last_seen_at", { ascending: false });
      if (statusFilter !== "all") query = query.eq("status", statusFilter);

      const { data, error } = await query;
      if (error) throw new Error(error.message ?? "product_reconciliation_query_failed");
      const items = (data ?? []).map(toProductReconciliationItem);

      const openCount =
        statusFilter === "open"
          ? items.length
          : (await read.from(PRODUCT_RECONCILIATION_TABLE).select("id").eq("status", "open")).data?.length ?? 0;

      return { statusFilter, openCount, items };
    },
  };
}

function toLowStockEvidenceItem(row: LowStockEvidenceRow): AdminLowStockEvidenceItem {
  return {
    id: String(row.id),
    sku: String(row.sku),
    thresholdKind: row.threshold_kind as AdminLowStockEvidenceItem["thresholdKind"],
    severity: row.severity as AdminLowStockEvidenceItem["severity"],
    status: row.status as AdminLowStockEvidenceItem["status"],
    providerForSaleQuantity: row.provider_for_sale_quantity ?? null,
    localAvailableQuantity: row.local_available_quantity ?? null,
    forecastDays: row.forecast_days ?? null,
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}

function toProductReconciliationItem(row: ReconciliationRow): AdminProductReconciliationItem {
  return {
    id: String(row.id),
    sku: String(row.sku),
    ean: row.ean ?? null,
    conflictKind: row.conflict_kind as AdminProductReconciliationItem["conflictKind"],
    providerQuantity: row.provider_quantity ?? null,
    status: row.status as AdminProductReconciliationItem["status"],
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}
