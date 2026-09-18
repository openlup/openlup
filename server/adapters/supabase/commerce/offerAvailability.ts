import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  deriveOfferAvailability,
} from "../../../../src/domains/commerce/offerAvailability.js";
import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
} from "../../../../src/domains/commerce/offerAvailabilityContracts.js";
import type {
  CommerceOfferAvailabilityPort,
} from "../../../../src/domains/commerce/ports.js";

export interface OfferAvailabilitySupabaseClient {
  from(table: string): SupabaseQueryBuilder;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): PromiseLike<SupabaseQueryResult>;
}

interface SupabaseQueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface InventoryBalanceRow {
  on_hand: number;
  unavailable: number;
  safety_stock: number;
  catalog_skus?: { sku?: string } | null;
  inventory_locations?: {
    status?: string;
    fulfillable?: boolean;
  } | null;
  inventory_lots?: {
    status?: string | null;
    expires_at?: string | null;
  } | null;
}

interface ProviderStockCurrentRow {
  sku: string;
  provider_kind: string;
  provider_for_sale_quantity: number;
  last_synced_at: string;
  stale_after: string;
}

interface InventoryReservationRow {
  quantity: number;
  status: string;
  expires_at: string | null;
  catalog_skus?: { sku?: string } | null;
  commerce_orders?: { status?: string } | null;
}

// Orders in a terminal, non-committed state must NOT hold stock. A cancelled
// order historically stranded its `reserved` rows (no release path fired), so
// even with the release-on-cancel trigger in place we defensively exclude these
// here — legacy stranded rows can never depress sellableNow. Paid /
// fulfillment_pending / pending_payment reservations stay counted: that stock is
// legitimately committed.
const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
  "expired",
]);

export function createSupabaseOfferAvailabilityPort(
  client: OfferAvailabilitySupabaseClient,
  options: { lowStockThreshold?: number; now?: () => Date } = {},
): CommerceOfferAvailabilityPort {
  const lowStockThreshold = options.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const now = options.now ?? (() => new Date());

  return {
    async getAvailability({ items }) {
      if (items.length === 0) return [];

      const skus = [...new Set(items.map((item) => item.sku))];
      const [providerResult, balanceResult, reservationResult] = await Promise.all([
        client
          .from("fulfillment_provider_stock_current")
          .select("sku, provider_kind, provider_for_sale_quantity, last_synced_at, stale_after")
          .in("sku", skus),
        client
          .from("inventory_balances")
          .select(
            "on_hand, unavailable, safety_stock, catalog_skus!inventory_balances_sku_id_fkey!inner(sku), inventory_locations!inventory_balances_location_id_fkey!inner(status, fulfillable), inventory_lots!inventory_balances_lot_id_fkey(status, expires_at)",
          )
          .in("catalog_skus.sku", skus),
        client
          .from("inventory_reservations")
          .select(
            "quantity, status, expires_at, catalog_skus!inventory_reservations_sku_id_fkey!inner(sku), commerce_orders!inventory_reservations_order_id_fkey!inner(status)",
          )
          .in("catalog_skus.sku", skus),
      ]);

      if (providerResult.error || balanceResult.error || reservationResult.error) {
        return items.map((item) => unknownAvailability(item, "inventory_read_failed"));
      }

      const requestedAt = now();
      const activeReservedBySku = sumActiveReservedBySku(
        (reservationResult.data ?? []) as InventoryReservationRow[],
        requestedAt,
      );
      const safetyStockBySku = sumSafetyStockBySku(
        (balanceResult.data ?? []) as InventoryBalanceRow[],
        requestedAt,
      );
      const providerBySku = providerStockBySku(
        (providerResult.data ?? []) as ProviderStockCurrentRow[],
      );
      if (providerBySku.size > 0) {
        return items.map((item) =>
          providerAvailability({
            item,
            provider: providerBySku.get(item.sku) ?? null,
            activeReserved: activeReservedBySku.get(item.sku) ?? 0,
            safetyStock: safetyStockBySku.get(item.sku) ?? 0,
            requestedAt,
            lowStockThreshold,
          }),
        );
      }

      const localBaseBySku = sumLocalAvailableBaseBySku(
        (balanceResult.data ?? []) as InventoryBalanceRow[],
        requestedAt,
      );
      return items.map((item) => {
        const sellableNow = localBaseBySku.has(item.sku)
          ? Math.max(0, (localBaseBySku.get(item.sku) ?? 0) - (activeReservedBySku.get(item.sku) ?? 0))
          : null;
        return deriveOfferAvailability({
          ...item,
          sellableNow,
          lowStockThreshold,
          source: "inventory",
        });
      });
    },
  };
}

/**
 * Composition helper for BFFs. The generated Supabase builder is richer than
 * the ATP adapter's deliberately narrow query interface, so the cast belongs
 * here at the DB adapter boundary rather than in an HTTP/BFF composer.
 */
export function createSupabaseOfferAvailabilityPortFromClient(
  client: SupabaseClient,
): CommerceOfferAvailabilityPort {
  return createSupabaseOfferAvailabilityPort({
    from(table) {
      return client.from(table) as unknown as ReturnType<OfferAvailabilitySupabaseClient["from"]>;
    },
  });
}

function providerStockBySku(rows: readonly ProviderStockCurrentRow[]): Map<string, ProviderStockCurrentRow> {
  return new Map(
    rows
      .filter((row) => row.provider_kind === "omnipack" && row.sku)
      .map((row) => [row.sku, row]),
  );
}

function providerAvailability(input: {
  item: CommerceOfferAvailabilityRequestItem;
  provider: ProviderStockCurrentRow | null;
  activeReserved: number;
  safetyStock: number;
  requestedAt: Date;
  lowStockThreshold: number;
}): CommerceOfferAvailability {
  if (!input.provider) {
    return unavailable(input.item, "provider_stock_missing");
  }
  if (Date.parse(input.provider.stale_after) <= input.requestedAt.getTime()) {
    return unavailable(input.item, "provider_stock_stale");
  }
  return deriveOfferAvailability({
    ...input.item,
    sellableNow: Math.max(
      0,
      input.provider.provider_for_sale_quantity - input.activeReserved - input.safetyStock,
    ),
    lowStockThreshold: input.lowStockThreshold,
    source: "inventory_provider",
  });
}

function sumActiveReservedBySku(
  rows: readonly InventoryReservationRow[],
  requestedAt: Date,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const sku = row.catalog_skus?.sku;
    if (!sku || !reservationBlocksStock(row, requestedAt)) continue;
    result.set(sku, (result.get(sku) ?? 0) + row.quantity);
  }
  return result;
}

function sumSafetyStockBySku(
  rows: readonly InventoryBalanceRow[],
  requestedAt: Date,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const sku = row.catalog_skus?.sku;
    if (!sku || !balanceUsable(row, requestedAt)) continue;
    result.set(sku, (result.get(sku) ?? 0) + row.safety_stock);
  }
  return result;
}

function sumLocalAvailableBaseBySku(
  rows: readonly InventoryBalanceRow[],
  requestedAt: Date,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const sku = row.catalog_skus?.sku;
    if (!sku || !balanceUsable(row, requestedAt)) continue;
    result.set(
      sku,
      (result.get(sku) ?? 0) + Math.max(0, row.on_hand - row.unavailable - row.safety_stock),
    );
  }
  return result;
}

function balanceUsable(row: InventoryBalanceRow, requestedAt: Date): boolean {
  const location = row.inventory_locations;
  if (location?.status !== "active" || location.fulfillable !== true) return false;
  const lotStatus = row.inventory_lots?.status;
  if (lotStatus && lotStatus !== "available") return false;
  const expiresAt = row.inventory_lots?.expires_at;
  if (expiresAt && Date.parse(expiresAt) <= requestedAt.getTime()) return false;
  return true;
}

function reservationBlocksStock(row: InventoryReservationRow, requestedAt: Date): boolean {
  if (row.status !== "reserved") return false;
  // A reserved row tied to a terminal (cancelled/failed/expired) order is a
  // stranded hold — do not let it depress sellableNow.
  const orderStatus = row.commerce_orders?.status;
  if (orderStatus && TERMINAL_ORDER_STATUSES.has(orderStatus)) return false;
  if (!row.expires_at) return true;
  return Date.parse(row.expires_at) > requestedAt.getTime();
}

function unavailable(
  item: CommerceOfferAvailabilityRequestItem,
  reasonCode: string,
): CommerceOfferAvailability {
  return {
    sku: item.sku,
    productSlug: item.productSlug,
    variantId: item.variantId,
    status: "out_of_stock",
    visibleInConfigurator: false,
    sellableNow: 0,
    reasonCode,
    source: "inventory_provider",
  };
}

function unknownAvailability(
  item: CommerceOfferAvailabilityRequestItem,
  reasonCode: string,
): CommerceOfferAvailability {
  return {
    sku: item.sku,
    productSlug: item.productSlug,
    variantId: item.variantId,
    status: "unknown",
    visibleInConfigurator: true,
    sellableNow: null,
    reasonCode,
    source: "inventory",
  };
}
