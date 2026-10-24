import type { NewPurchaseStockRow } from "./contracts/newPurchaseStock.js";
import type { NewPurchaseStockReadPort } from "./newPurchaseStockAvailability.js";

interface StockQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface NativeStockPromise {
  availableQuantity: number; forSaleQuantity: number; hardHoldQuantity: number;
  safetyQuantity: number; softSubscriptionDemandQuantity: number; channelExposureQuantity: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("inventory_stock_response_invalid");
  return value as Record<string, unknown>;
}
function quantity(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("inventory_stock_quantity_invalid");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("inventory_stock_quantity_invalid");
  return n;
}
/** Native read-only ATP. The fixed 14-day priority cannot be waived by a new
 * purchase caller. Only the fenced native SQL allocator uses the renewal exemption. */
export function createPostgresStockAvailability(executor: StockQueryExecutor, options: { sourceKey: string; now: () => string }): {
  readPort: NewPurchaseStockReadPort;
  availableToPromise(sku: string, asOf: string): Promise<NativeStockPromise>;
} {
  return {
    async availableToPromise(sku, asOf) {
      const row = object((await executor.query(`SELECT public.inventory_available_to_promise(
        $1::text,$2::text,$3::timestamptz,false) AS response`, [options.sourceKey, sku, asOf])).rows[0]?.response);
      return { availableQuantity: quantity(row.available_quantity), forSaleQuantity: quantity(row.for_sale_quantity),
        hardHoldQuantity: quantity(row.hard_hold_quantity), safetyQuantity: quantity(row.safety_quantity),
        softSubscriptionDemandQuantity: quantity(row.soft_subscription_demand_quantity), channelExposureQuantity: quantity(row.channel_exposure_quantity) };
    },
    readPort: {
      async read(input) {
        if (input.horizonDays !== 14 || input.excludeOrderId !== null) throw new Error("native_stock_read_options_unsupported");
        if (!input.skus.length) return new Map();
        const value = (await executor.query(`SELECT public.inventory_new_purchase_stock_read(
          $1::text,$2::jsonb,$3::timestamptz) AS response`, [options.sourceKey, JSON.stringify(input.skus), options.now()])).rows[0]?.response;
        if (!Array.isArray(value)) throw new Error("inventory_stock_response_invalid");
        return new Map(value.map(value => {
          const row = object(value);
          if (typeof row.sku !== "string" || !["provider", "missing"].includes(String(row.source)) || typeof row.stale !== "boolean") throw new Error("inventory_stock_response_invalid");
          const result: NewPurchaseStockRow = { sku: row.sku, catalogSkuId: row.catalogSkuId == null ? null : String(row.catalogSkuId),
            source: row.source as "provider" | "missing", providerForSale: row.providerForSale == null ? null : quantity(row.providerForSale),
            activeHolds: quantity(row.activeHolds), safetyStock: quantity(row.safetyStock), available: quantity(row.available), stale: row.stale,
            renewalDemand: quantity(row.renewalDemand), availableForNewPurchases: quantity(row.availableForNewPurchases), excludedOrderHolds: quantity(row.excludedOrderHolds) };
          return [result.sku, result];
        }));
      },
    },
  };
}
