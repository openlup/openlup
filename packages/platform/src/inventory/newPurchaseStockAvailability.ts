import type { BundleStockPort, BundleStockRequestItem, BundleStockAvailability } from "../catalog/index.js";
import type { NewPurchaseStockRow, NewPurchaseStockMode, NewPurchaseStockAvailabilityOptions } from "./contracts/newPurchaseStock.js";

/** Normalized host read. Transport, missing-function recognition and fallback stay with the host. */
export interface NewPurchaseStockReadPort {
  read(input: { skus: readonly string[]; horizonDays: number; excludeOrderId: string | null }): Promise<Map<string, NewPurchaseStockRow>>;
}
interface StockBindings {
  readPort: NewPurchaseStockReadPort;
  functionMissingFallback: (() => BundleStockPort) | null;
  functionMissingError: string;
  defaultLowStockThreshold: number;
  defaultHorizonDays: number;
  deriveOfferAvailability(input: BundleStockRequestItem & { sellableNow: number | null; lowStockThreshold: number; source: string }): BundleStockAvailability;
  observe: Pick<Console, "warn">;
}

export function createNewPurchaseStockAvailabilityPort(
  { readPort, functionMissingFallback, functionMissingError, defaultLowStockThreshold, defaultHorizonDays, deriveOfferAvailability, observe }: StockBindings,
  options: NewPurchaseStockAvailabilityOptions,
): BundleStockPort {
  const lowStockThreshold = options.lowStockThreshold ?? defaultLowStockThreshold;
  const horizonDays = options.horizonDays ?? defaultHorizonDays;

  return {
    async getAvailability({ items }) {
      if (items.length === 0) return [];

      let rows: Map<string, NewPurchaseStockRow>;
      try {
        rows = await readPort.read({
          skus: items.map((item) => item.sku),
          horizonDays,
          excludeOrderId: null,
        });
      } catch (error) {
        if (
          functionMissingFallback
          && error instanceof Error
          && error.message === functionMissingError
        ) {
          observe.warn("[new-purchase-stock] function missing; falling back to the core availability read");
          return functionMissingFallback().getAvailability({ items });
        }
        observe.warn("[new-purchase-stock] availability read failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return items.map((item) => unknownAvailability(item, "inventory_read_failed"));
      }

      // Same branch rule as the core adapter: once any requested SKU is
      // provider-backed, every SKU must be, and a SKU without a provider row is
      // not sellable rather than silently falling back to local stock.
      const providerBacked = [...rows.values()].some((row) => row.source === "provider");
      return items.map((item) => {
        const row = rows.get(item.sku);
        if (providerBacked) {
          if (row?.source !== "provider") return unavailable(item, "provider_stock_missing");
          if (row.stale) return unavailable(item, "provider_stock_stale");
          return deriveOfferAvailability({
            ...item,
            sellableNow: sellableFor(row, options.mode),
            lowStockThreshold,
            source: "inventory_provider",
          });
        }
        return deriveOfferAvailability({
          ...item,
          sellableNow: row?.source === "local" ? sellableFor(row, options.mode) : null,
          lowStockThreshold,
          source: "inventory",
        });
      });
    },
  };
}

function sellableFor(row: NewPurchaseStockRow, mode: NewPurchaseStockMode): number | null {
  const value = mode === "new_purchase" ? row.availableForNewPurchases : row.available;
  return value == null ? null : Math.max(0, value);
}

/** The core adapter's provider-missing / provider-stale answer shape. */
function unavailable(item: BundleStockRequestItem, reasonCode: string): BundleStockAvailability {
  const { sku, productSlug, variantId } = item;
  return {
    sku, productSlug, variantId, status: "out_of_stock", visibleInConfigurator: false, sellableNow: 0,
    reasonCode, source: "inventory_provider",
  };
}

/** The core adapter's read-failure answer shape. */
function unknownAvailability(item: BundleStockRequestItem, reasonCode: string): BundleStockAvailability {
  const { sku, productSlug, variantId } = item;
  return {
    sku, productSlug, variantId, status: "unknown", visibleInConfigurator: true, sellableNow: null,
    reasonCode, source: "inventory",
  };
}
