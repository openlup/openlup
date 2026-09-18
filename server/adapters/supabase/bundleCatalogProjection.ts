import type {
  BundleSummary,
  BundleTargetPriceRow,
} from "../../domains/bundle/bundleCatalogReadPort.js";

/**
 * The hosted chain's PROJECTION: the column lists it asks for, the row shapes it
 * gets back, and the pure mapping from those rows onto the port's DTOs.
 *
 * It lives beside the adapter rather than inside it because it is the half a
 * reader checks against the port contract, while the adapter itself is the half
 * that decides which requests to make. Every function here is pure — no client, no
 * await — which is also what makes the embedded-relation flattening testable
 * through the shared read-port contract table.
 */

export const BUNDLE_COLUMNS =
  "id, code, title, status, fulfillment_mode, updated_at, composition_constraint, metadata";
// The catalog_products FK hint is load-bearing: since 20260827220000 added
// catalog_products_primary_sku_same_product_fkey, the skus/products pair has two
// relationships and PostgREST rejects an unhinted embed with PGRST201.
export const COMPONENT_COLUMNS =
  "bundle_id, quantity, is_addon, sort_order, catalog_skus!inner(id, sku, title, catalog_products!catalog_skus_product_id_fkey!inner(slug))";
export const PRICE_COLUMNS =
  "bundle_id, mode, target_price_minor, amount_kind, active, valid_from, valid_to, price_list_id, price_lists!inner(currency)";
export const AUDIT_COLUMNS =
  "id, action, actor_kind, actor_email, entity_id, old_value, new_value, occurred_at";

export type Embedded<T> = T | T[] | null;

export interface BundleRow {
  id: string;
  code: string;
  title: string;
  status: string;
  fulfillment_mode: string;
  updated_at: string;
  composition_constraint: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface ComponentRow {
  bundle_id: string;
  quantity: number;
  is_addon: boolean;
  sort_order: number;
  catalog_skus: Embedded<{
    id: string;
    sku: string;
    title: string | null;
    catalog_products: Embedded<{ slug: string }>;
  }>;
}

export interface PriceRow {
  bundle_id: string;
  mode: string;
  target_price_minor: number;
  amount_kind: string;
  active: boolean;
  valid_from: string;
  valid_to: string | null;
  price_list_id: string;
  price_lists: Embedded<{ currency: string }>;
}

export interface PriceEntryRow {
  variant_id: string;
  price_list_id: string;
  unit_price_minor: number;
  min_qty: number;
}

export interface AuditRow {
  id: string;
  action: string;
  actor_kind: string | null;
  actor_email: string | null;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  occurred_at: string;
}

export function sortComponents(rows: readonly ComponentRow[]): ComponentRow[] {
  return [...rows].sort((left, right) =>
    left.sort_order === right.sort_order
      ? (first(left.catalog_skus)?.sku ?? "") < (first(right.catalog_skus)?.sku ?? "")
        ? -1
        : 1
      : Number(left.sort_order) - Number(right.sort_order),
  );
}

export function tally(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

export function toSummary(row: BundleRow, componentCount: number, hasActive: boolean): BundleSummary {
  return {
    code: row.code,
    title: row.title,
    status: row.status,
    fulfillmentMode: row.fulfillment_mode,
    componentCount,
    hasActiveTargetPrice: hasActive,
    updatedAt: row.updated_at,
  };
}

export function toPrice(row: PriceRow): BundleTargetPriceRow {
  return {
    mode: row.mode,
    targetPriceMinor: Number(row.target_price_minor),
    currency: first(row.price_lists)?.currency ?? "",
    amountKind: row.amount_kind,
    active: row.active === true,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? null,
  };
}

/** An empty envelope is stored as `{}`; that is "unconstrained", not a constraint. */
export function toConstraint(value: Record<string, unknown> | null) {
  if (!value || typeof value.kind !== "string" || value.kind.trim() === "") return null;
  return {
    kind: value.kind,
    version: typeof value.version === "number" ? value.version : 0,
    data: (value.data ?? {}) as Record<string, unknown>,
  };
}

/** An embedded relation arrives as a row or a one-element array depending on cardinality. */
export function first<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
