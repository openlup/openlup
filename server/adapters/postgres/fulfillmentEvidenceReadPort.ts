import type { AdminLowStockEvidenceItem } from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentLowStockEvidencePort } from "../../../src/domains/fulfillment/ports.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const READ = `SELECT id, sku, threshold_kind, severity, status,
    provider_for_sale_quantity, local_available_quantity,
    first_seen_at, last_seen_at, resolved_at
  FROM public.fulfillment_stock_evidence
  WHERE source_key = $1::text AND ($2::text = 'all' OR status = $2::text)
  ORDER BY last_seen_at DESC, id ASC`;
const COUNT = `SELECT count(*)::integer AS count
  FROM public.fulfillment_stock_evidence
  WHERE source_key = $1::text AND status = 'open'`;

export function createPostgresFulfillmentLowStockEvidencePort(
  executor: PgQueryExecutor,
  sourceKey: string,
): FulfillmentLowStockEvidencePort {
  const key = sourceKey.trim();
  if (!key) throw new Error("fulfillment_stock_source_key_required");
  return { async getLowStockEvidence({ statusFilter }) {
    const [rows, count] = await Promise.all([
      executor.query(READ, [key, statusFilter]),
      executor.query(COUNT, [key]),
    ]);
    return {
      statusFilter,
      openCount: integer(count.rows[0]?.count),
      items: rows.rows.map(mapItem),
    };
  } };
}

function mapItem(row: Record<string, unknown>): AdminLowStockEvidenceItem {
  return {
    id: String(row.id),
    sku: String(row.sku),
    thresholdKind: row.threshold_kind as AdminLowStockEvidenceItem["thresholdKind"],
    severity: row.severity as AdminLowStockEvidenceItem["severity"],
    status: row.status as AdminLowStockEvidenceItem["status"],
    providerForSaleQuantity: nullableInteger(row.provider_for_sale_quantity),
    localAvailableQuantity: nullableInteger(row.local_available_quantity),
    forecastDays: null,
    firstSeenAt: nullableText(row.first_seen_at),
    lastSeenAt: nullableText(row.last_seen_at),
    resolvedAt: nullableText(row.resolved_at),
  };
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value); }
function nullableText(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
