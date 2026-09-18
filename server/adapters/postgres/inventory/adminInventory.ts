import { createHash } from "node:crypto";

import { calculateInventoryAtp, availableNow } from "../../../../src/domains/inventory/atp.js";
import {
  INVENTORY_CONTRACT_VERSION,
  type InventoryStockLine,
  type InventorySubscriptionForecastSku,
} from "../../../../src/domains/inventory/contracts.js";
import {
  InventoryPersistenceError,
  type InventoryMutationPort,
  type InventoryReadPort,
} from "../../../../src/domains/inventory/ports.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

const STOCK_SQL = `SELECT sku.id AS sku_id, sku.sku, stock.source_key,
    stock.for_sale_quantity AS on_hand,
    COALESCE((SELECT sum(line.quantity)::integer
      FROM public.fulfillment_inventory_reservation_lines line
      JOIN public.fulfillment_inventory_reservations reservation ON reservation.id = line.reservation_id
     WHERE line.sku = stock.sku AND reservation.source_key = stock.source_key
       AND reservation.status IN ('held', 'committed')), 0) AS reserved,
    stock.last_synced_at, stock.stale_after,
    count(*) OVER() AS total_count
  FROM public.fulfillment_stock_current stock
  JOIN public.catalog_skus sku ON sku.sku = stock.sku
 WHERE ($1::uuid IS NULL OR sku.id = $1::uuid)
   AND ($2::boolean OR stock.for_sale_quantity > 0)
 ORDER BY stock.updated_at DESC, stock.source_key, stock.sku
 LIMIT $3::integer OFFSET $4::integer`;

const RESERVATIONS_SQL = `SELECT reservation.id, order_row.id AS order_id, cycle.id AS cycle_id,
    CASE reservation.status
      WHEN 'held' THEN 'reserved' WHEN 'committed' THEN 'reserved'
      ELSE reservation.status END AS status,
    reservation.expires_at, reservation.created_at,
    operation.identity_key, operation.operation_fingerprint, operation.terminal_outcome,
    count(*) OVER() AS total_count
  FROM public.fulfillment_inventory_reservations reservation
  JOIN public.subscription_renewal_operations operation ON operation.id = reservation.renewal_operation_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id = operation.id
  LEFT JOIN public.commerce_orders order_row ON order_row.renewal_operation_id = operation.id
 WHERE ($1::text IS NULL OR CASE reservation.status
      WHEN 'held' THEN 'reserved' WHEN 'committed' THEN 'reserved'
      ELSE reservation.status END = $1::text)
   AND ($2::uuid IS NULL OR order_row.id = $2::uuid)
 ORDER BY reservation.created_at DESC, reservation.id
  LIMIT $3::integer OFFSET $4::integer`;

const ATP_SQL = `SELECT sku.id AS sku_id, sku.sku, stock.source_key,
    stock.for_sale_quantity AS on_hand,
    COALESCE((SELECT sum(line.quantity)::integer
      FROM public.fulfillment_inventory_reservation_lines line
      JOIN public.fulfillment_inventory_reservations reservation ON reservation.id = line.reservation_id
     WHERE line.sku = stock.sku AND reservation.source_key = stock.source_key
       AND reservation.status IN ('held', 'committed')), 0) AS reserved,
    stock.last_synced_at, stock.stale_after, 0 AS total_count
  FROM public.fulfillment_stock_current stock
  JOIN public.catalog_skus sku ON sku.sku = stock.sku
 WHERE sku.id = ANY($1::uuid[])
   AND stock.inventory_class = 'sellable'
   AND stock.stale_after > $2::timestamptz
 ORDER BY stock.source_key, stock.sku`;

const FORECAST_SQL = `WITH forecast_skus AS (
    SELECT line.sku
      FROM public.subscription_renewal_term_lines line
      JOIN public.subscriptions subscription ON subscription.id = line.subscription_id
     WHERE subscription.status = 'active'
    UNION
    SELECT stock.sku
      FROM public.fulfillment_stock_current stock
     WHERE stock.inventory_class = 'sellable'
  ), sellable_stock AS (
    SELECT stock.sku,
           sum(stock.for_sale_quantity)::integer AS for_sale_quantity,
           max(stock.last_synced_at) AS last_synced_at,
           min(stock.stale_after) AS stale_after
      FROM public.fulfillment_stock_current stock
     WHERE stock.inventory_class = 'sellable'
     GROUP BY stock.sku
  )
  SELECT sku.id AS sku_id, sku.sku,
    stock.for_sale_quantity, stock.last_synced_at, stock.stale_after,
    COALESCE(reserved.quantity, 0)::integer AS reserved,
    COALESCE(demand.days_30, 0)::integer AS days_30,
    COALESCE(demand.days_45, 0)::integer AS days_45,
    COALESCE(demand.days_60, 0)::integer AS days_60
  FROM forecast_skus forecast
  JOIN public.catalog_skus sku ON sku.sku = forecast.sku
  LEFT JOIN sellable_stock stock ON stock.sku = forecast.sku
  LEFT JOIN LATERAL (
    SELECT sum(line.quantity)::integer AS quantity
      FROM public.fulfillment_inventory_reservation_lines line
      JOIN public.fulfillment_inventory_reservations reservation ON reservation.id = line.reservation_id
     WHERE line.sku = forecast.sku
       AND reservation.status IN ('held', 'committed')) reserved ON true
  LEFT JOIN LATERAL (
    SELECT
      sum(CASE WHEN subscription.next_cycle_at <= $1::timestamptz + interval '30 days' THEN line.quantity ELSE 0 END)::integer AS days_30,
      sum(CASE WHEN subscription.next_cycle_at <= $1::timestamptz + interval '45 days' THEN line.quantity ELSE 0 END)::integer AS days_45,
      sum(CASE WHEN subscription.next_cycle_at <= $1::timestamptz + interval '60 days' THEN line.quantity ELSE 0 END)::integer AS days_60
      FROM public.subscription_renewal_term_lines line
      JOIN public.subscriptions subscription ON subscription.id = line.subscription_id
     WHERE line.sku = forecast.sku AND subscription.status = 'active'
       AND subscription.next_cycle_at <= $1::timestamptz + ($2::integer * interval '1 day')) demand ON true
 ORDER BY sku.sku`;

const ACTIVE_SUBSCRIPTION_COUNT_SQL = `SELECT count(*)::integer AS active_subscription_count
  FROM public.subscriptions WHERE status = 'active'`;

/** Operator readback over the same public stock and reservation rail used by renewal. */
export function createPostgresAdminInventoryPort(
  executor: PgQueryExecutor,
  now: () => string = () => new Date().toISOString(),
): InventoryReadPort & InventoryMutationPort {
  return {
    async listStock(request) {
      const offset = (request.page - 1) * request.pageSize;
      const result = await executor.query(STOCK_SQL, [
        request.skuId ?? null, request.includeZero, request.pageSize, offset,
      ]);
      const stock = result.rows.map(mapStock);
      return {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        stock: stock.map((line) => ({ ...line, availableNow: availableNow(line) })),
        totalCount: count(result.rows[0]), page: request.page, pageSize: request.pageSize,
      };
    },

    async listReservations(request) {
      const offset = (request.page - 1) * request.pageSize;
      const result = await executor.query(RESERVATIONS_SQL, [
        request.status ?? null, request.orderId ?? null, request.pageSize, offset,
      ]);
      return {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        reservations: result.rows.map((row) => ({
          id: text(row.id), orderId: text(row.order_id),
          subscriptionCycleId: nullableText(row.cycle_id),
          status: text(row.status) as "reserved" | "released" | "consumed" | "expired",
          kind: "subscription_retry_window" as const,
          expiresAt: timestampOrNull(row.expires_at), createdAt: timestamp(row.created_at),
        })),
        totalCount: count(result.rows[0]), page: request.page, pageSize: request.pageSize,
      };
    },

    async checkAtp(request) {
      const result = await executor.query(ATP_SQL, [
        request.lines.map((line) => line.skuId), request.requestedAt,
      ]);
      return calculateInventoryAtp({ request, stock: result.rows.map(mapStock) });
    },

    async forecastSubscriptions(request) {
      const generatedAt = now();
      const result = await executor.query(FORECAST_SQL, [generatedAt, request.horizonDays]);
      const activeSubscriptionResult = await executor.query(ACTIVE_SUBSCRIPTION_COUNT_SQL);
      const skus = result.rows.map((row) => mapForecast(row, generatedAt, request));
      return {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        generatedAt,
        // Compatibility projection required by the existing admin BFF contract;
        // the public tables themselves keep source_key opaque.
        stockMasterProvider: "omnipack",
        horizonDays: request.horizonDays,
        protectionDays: request.protectionDays,
        skus,
        totals: {
          activeSubscriptionCount: integer(
            activeSubscriptionResult.rows[0]?.active_subscription_count,
          ),
          excludedSubscriptionCount: 0,
          missingProviderStockSkuCount: skus.filter((sku) => sku.stockStatus === "missing").length,
          staleProviderStockSkuCount: skus.filter((sku) => sku.stockStatus === "stale").length,
          horizonShortageSkuCount: skus.filter((sku) => sku.horizonMissingQty > 0).length,
          protectionShortageSkuCount: skus.filter((sku) => sku.protectionMissingQty > 0).length,
          shortageSkuCount: skus.filter((sku) => sku.missingQty > 0).length,
          recommendedProductionQty: skus.reduce((sum, sku) => sum + sku.recommendedProductionQty, 0),
        },
      };
    },

    async adjustStock() {
      throw new InventoryPersistenceError(
        "Direct stock is externally observed; use the configured stock-source adapter",
      );
    },
  };
}

function mapStock(row: Record<string, unknown>): InventoryStockLine {
  const source = text(row.source_key);
  return {
    skuId: text(row.sku_id), sku: text(row.sku),
    locationId: stableUuid(source), locationCode: source,
    locationKind: "third_party_logistics", locationStatus: "active", fulfillable: true,
    lotId: null, lotCode: null, lotStatus: null, expiresAt: null,
    onHand: integer(row.on_hand), reserved: integer(row.reserved), unavailable: 0,
    incoming: 0, safetyStock: 0,
  };
}

function mapForecast(
  row: Record<string, unknown>,
  generatedAt: string,
  request: { horizonDays: number; protectionDays: number },
): InventorySubscriptionForecastSku {
  const sellable = Math.max(0, integer(row.for_sale_quantity) - integer(row.reserved));
  const horizonDemand = request.horizonDays <= 30 ? integer(row.days_30)
    : request.horizonDays <= 45 ? integer(row.days_45) : integer(row.days_60);
  const protectionDemand = request.protectionDays <= 30 ? integer(row.days_30)
    : request.protectionDays <= 45 ? integer(row.days_45) : integer(row.days_60);
  const horizonMissingQty = Math.max(0, horizonDemand - sellable);
  const protectionMissingQty = Math.max(0, protectionDemand - sellable);
  const staleAfter = timestampOrNull(row.stale_after);
  const stockStatus = row.for_sale_quantity === null || row.for_sale_quantity === undefined
    ? "missing" as const
    : staleAfter && staleAfter <= generatedAt ? "stale" as const : "fresh" as const;
  return {
    skuId: text(row.sku_id), sku: text(row.sku),
    providerCurrentForSale: nullableInteger(row.for_sale_quantity),
    providerStockLastSyncedAt: timestampOrNull(row.last_synced_at),
    providerStockStaleAfter: staleAfter, stockStatus,
    openHardReservations: integer(row.reserved), safetyStock: 0, sellableNow: sellable,
    activeSubscriptionDemand30: integer(row.days_30),
    activeSubscriptionDemand45: integer(row.days_45),
    activeSubscriptionDemand60: integer(row.days_60), plannedSupply: 0,
    coverageDays: null, shortageDate: null,
    horizonMissingQty, protectionMissingQty,
    missingQty: Math.max(horizonMissingQty, protectionMissingQty),
    recommendedProductionQty: Math.max(horizonMissingQty, protectionMissingQty),
  };
}

function stableUuid(value: string): string {
  const hash = createHash("sha256").update(`inventory-source:${value}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function text(value: unknown): string { return typeof value === "string" ? value : String(value ?? ""); }
function nullableText(value: unknown): string | null { const result = text(value).trim(); return result || null; }
function integer(value: unknown): number { const result = Number(value); return Number.isSafeInteger(result) && result >= 0 ? result : 0; }
function nullableInteger(value: unknown): number | null { return value === null || value === undefined ? null : integer(value); }
function count(row: Record<string, unknown> | undefined): number { return row ? integer(row.total_count) : 0; }
function timestamp(value: unknown): string { return value instanceof Date ? value.toISOString() : text(value); }
function timestampOrNull(value: unknown): string | null { return value === null || value === undefined ? null : timestamp(value); }
