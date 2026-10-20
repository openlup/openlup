import { createBundleAvailabilityServices } from "@openlup/platform/catalog";
import { deriveBundleAvailability } from "../../../src/domains/bundle/availability.js";
export const { createBundleAvailabilityService } = createBundleAvailabilityServices({ deriveBundleAvailability });
export { createUnknownOfferAvailabilityPort } from "@openlup/platform/catalog";
export type { BundleAvailabilityServiceDeps, BundleAvailabilityRow, BundleAvailabilityService } from "@openlup/platform/catalog";
