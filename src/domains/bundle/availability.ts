import { createBundleAvailability } from "@openlup/platform/catalog";
import { offerAvailabilityReasonCode, offerAvailabilityStatusFor } from "../commerce/ports.js";
export const { deriveBundleAvailability } = createBundleAvailability({ offerAvailabilityReasonCode, offerAvailabilityStatusFor });
export { DEFAULT_BUNDLE_LOW_STOCK_THRESHOLD, BUNDLE_COMPONENT_STOCK_UNKNOWN, BUNDLE_COMPOSITION_EMPTY } from "@openlup/platform/catalog";
export type { BundleAvailabilityComponent, BundleAvailability, DeriveBundleAvailabilityInput } from "@openlup/platform/catalog";
