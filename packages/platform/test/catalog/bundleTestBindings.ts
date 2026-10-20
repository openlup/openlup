import { z } from "zod";
import { createBffResponder } from "../../src/bff/index.js";
import { createBundleWriteRules, evaluateBundleComposition, evaluateBundleCompositionConstraint, evaluateBundleFulfillmentMode, evaluateBundleTargetPrice, isEmptyCompositionConstraint } from "../../src/catalog/bundleRules.js";
import { createBundleAvailability } from "../../src/catalog/bundleAvailability.js";
import { createBundleAvailabilityServices, createUnknownOfferAvailabilityPort } from "../../src/catalog/bundleAvailabilityService.js";
import { createSellableBundleHandlers, toSellableBundle } from "../../src/catalog/sellableBundleHandler.js";
import type { BundleStockStatus, BundleStockPort } from "../../src/catalog/bundleBindings.js";

// Synthetic host policy for isolated package cases. Actual helper/schema identity is
// exercised once by tests/platform/catalog/bundleBindings.test.ts.
export function offerAvailabilityStatusFor(value: number | null, threshold = 20): BundleStockStatus {
  return value === null ? "unknown" : value <= 0 ? "out_of_stock" : value <= threshold ? "low_stock" : "available";
}
export const { deriveBundleAvailability } = createBundleAvailability({
  offerAvailabilityStatusFor,
  offerAvailabilityReasonCode: (status) => ({ available: "stock_available", low_stock: "low_stock", out_of_stock: "out_of_stock", unknown: "stock_unknown" })[status],
});
export const { evaluateBundleWriteRules } = createBundleWriteRules({
  assertActivateNotMachineActor: ({ operation, actorKind }) => operation === "activate" && actorKind === "machine" ? "DRAFT_ONLY_FOR_MACHINE" : null,
});
export const { createBundleAvailabilityService } = createBundleAvailabilityServices({ deriveBundleAvailability });
const component = z.object({ sku: z.string(), quantity: z.number().int().positive(), effectiveUnitPriceMinor: z.number().int().nonnegative(), lineSubtotalMinor: z.number().int().nonnegative(), discountBps: z.number().int().nonnegative() }).strict();
export const sellableBundleListResponseSchema = z.object({
  contractVersion: z.literal("catalog.sellable-bundle.v1"),
  bundles: z.array(z.object({ code: z.string(), title: z.string(), fulfillmentMode: z.string(), price: z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string() }).strict(), components: z.array(component).min(1), availability: z.object({ status: z.enum(["available", "low_stock", "out_of_stock", "unknown"]), sellableNow: z.number().int().nonnegative().nullable(), limitingSku: z.string().nullable(), reasonCode: z.string() }).strict() }).strict()),
}).strict();
export const { createSellableBundleHandler } = createSellableBundleHandlers({ responder: createBffResponder(), sellableBundleListResponseSchema, SELLABLE_BUNDLE_CONTRACT_VERSION: "catalog.sellable-bundle.v1" });
export { evaluateBundleComposition, evaluateBundleCompositionConstraint, evaluateBundleFulfillmentMode, evaluateBundleTargetPrice, isEmptyCompositionConstraint, createUnknownOfferAvailabilityPort, toSellableBundle };
export type { BundleAvailability, BundleAvailabilityComponent } from "../../src/catalog/bundleAvailability.js";
export { BUNDLE_COMPONENT_STOCK_UNKNOWN, BUNDLE_COMPOSITION_EMPTY, DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD } from "../../src/catalog/bundleAvailability.js";
export type { BundleAvailabilityRow } from "../../src/catalog/bundleAvailabilityService.js";
export type { BundleStockPort as CommerceOfferAvailabilityPort };
