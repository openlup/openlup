import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
  CommerceOfferAvailabilityStatus,
} from "./offerAvailabilityContracts.js";

export const DEFAULT_LOW_STOCK_THRESHOLD = 20;

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
  if (sellableNow == null) return "unknown";
  if (sellableNow <= 0) return "out_of_stock";
  if (sellableNow <= lowStockThreshold) return "low_stock";
  return "available";
}

/** The reason-code vocabulary for a stock-derived status; exported for the same reason. */
export function reasonCodeFor(status: CommerceOfferAvailabilityStatus): string {
  if (status === "available") return "stock_available";
  if (status === "low_stock") return "low_stock";
  if (status === "out_of_stock") return "out_of_stock";
  return "stock_unknown";
}
