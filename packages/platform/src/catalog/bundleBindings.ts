import type { BundleActorKind } from "./bundleRuleCodes.js";

/** The host's normalized stock seam; no inventory implementation is owned here. */
export type BundleStockStatus = "available" | "low_stock" | "out_of_stock" | "unknown";
export interface BundleStockRequestItem {
  sku: string;
  productSlug: string;
  variantId: string;
  requestedQuantity: number;
  checkoutMode: "one_time" | "subscription";
}
export interface BundleStockAvailability {
  sku: string;
  productSlug: string;
  variantId: string;
  status: BundleStockStatus;
  visibleInConfigurator: boolean;
  sellableNow: number | null;
  reasonCode: string;
  source: string;
}
export interface BundleStockPort {
  getAvailability(input: { items: readonly BundleStockRequestItem[] }): Promise<BundleStockAvailability[]>;
}
export interface BundleRuleBindings {
  assertActivateNotMachineActor(input: { operation: string; actorKind: BundleActorKind }): "DRAFT_ONLY_FOR_MACHINE" | null;
  offerAvailabilityStatusFor(sellableNow: number | null, lowStockThreshold?: number): BundleStockStatus;
  offerAvailabilityReasonCode(status: BundleStockStatus): string;
}
