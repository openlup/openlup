import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
  CommerceOfferAvailabilityStatus,
} from "./contracts/availability.js";

export const DEFAULT_LOW_STOCK_THRESHOLD = 20;
const MAX_LOW_STOCK_THRESHOLD = 2147483647;

function assertValidLowStockThreshold(threshold: number): number {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_LOW_STOCK_THRESHOLD) {
    throw new RangeError(
      `offer_low_stock_threshold_invalid: expected an integer from 0 to ${MAX_LOW_STOCK_THRESHOLD}`,
    );
  }
  return threshold;
}

export interface DeriveOfferAvailabilityInput
  extends CommerceOfferAvailabilityRequestItem {
  sellableNow: number | null;
  lowStockThreshold?: number;
  source: string;
}

export function deriveOfferAvailability(
  input: DeriveOfferAvailabilityInput,
): CommerceOfferAvailability {
  const status = statusForSellableNow(input.sellableNow, input.lowStockThreshold);
  return {
    sku: input.sku,
    productSlug: input.productSlug,
    variantId: input.variantId,
    status,
    visibleInConfigurator: status !== "out_of_stock",
    sellableNow: input.sellableNow,
    reasonCode: reasonCodeFor(status),
    source: input.source,
  };
}

export function defaultOfferAvailability(
  item: CommerceOfferAvailabilityRequestItem,
  source = "static",
): CommerceOfferAvailability {
  return {
    sku: item.sku,
    productSlug: item.productSlug,
    variantId: item.variantId,
    status: "available",
    visibleInConfigurator: true,
    sellableNow: null,
    reasonCode: "static_available",
    source,
  };
}

export function availabilityBySku(
  items: readonly CommerceOfferAvailability[],
): Map<string, CommerceOfferAvailability> {
  return new Map(items.map((item) => [item.sku, item]));
}

/**
 * The status ladder itself, exported so a composed offer (a bundle derives one
 * status from many components) reads the SAME four rungs rather than mirroring
 * them. A second copy would drift the first time a rung moves.
 */
export function statusForSellableNow(
  sellableNow: number | null,
  lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD,
): CommerceOfferAvailabilityStatus {
  const threshold = assertValidLowStockThreshold(lowStockThreshold);
  if (sellableNow == null) return "unknown";
  if (sellableNow <= 0) return "out_of_stock";
  if (sellableNow <= threshold) return "low_stock";
  return "available";
}

/** The reason-code vocabulary for a stock-derived status; exported for the same reason. */
export function reasonCodeFor(status: CommerceOfferAvailabilityStatus): string {
  if (status === "available") return "stock_available";
  if (status === "low_stock") return "low_stock";
  if (status === "out_of_stock") return "out_of_stock";
  return "stock_unknown";
}
