import { createInventoryBindings, createNewPurchaseStockAvailabilityPort, type InventoryBindingDependencies, type InventoryBindings } from "@openlup/platform/inventory";
import { createInventoryContribution } from "@openlup/platform/composition";
import { createBundleAvailability, createBundleAvailabilityServices, type BundleStockPort, type BundleCatalogReadPort } from "@openlup/platform/catalog";
import type { RequiredSchema } from "@openlup/core/readiness";
import { inventorySubscriptionForecastResponseSchema } from "../../../src/domains/inventory/contracts.js";
import { deriveOfferAvailability, reasonCodeFor, statusForSellableNow } from "../../../src/domains/commerce/offerAvailability.js";

/** Opt-in reference composition. Importing this file registers no routes or stock reader. */
export function createM06InventoryReferenceBinding(input: {
  store: Omit<InventoryBindingDependencies, "provider">;
  version: string;
  requiredSchema: RequiredSchema;
  bundleCatalogReadPort: BundleCatalogReadPort;
  stock: Omit<Parameters<typeof createNewPurchaseStockAvailabilityPort>[0], "readPort" | "deriveOfferAvailability">;
  options: Parameters<typeof createNewPurchaseStockAvailabilityPort>[1];
  requireNewPurchaseStockRead?: boolean;
}) {
  const bindings: InventoryBindings = createInventoryBindings({ ...input.store, provider: {
    stockMasterProvider: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value,
    providerSchema: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider,
  } });
  // This assignment is the cross-entry structural drift check; inventory imports no catalog types.
  const stock: BundleStockPort | null = bindings.newPurchaseStockReadPort
    ? createNewPurchaseStockAvailabilityPort({ ...input.stock, readPort: bindings.newPurchaseStockReadPort, deriveOfferAvailability }, input.options)
    : null;
  const { deriveBundleAvailability } = createBundleAvailability({ offerAvailabilityReasonCode: reasonCodeFor, offerAvailabilityStatusFor: statusForSellableNow });
  const availability = stock ? createBundleAvailabilityServices({ deriveBundleAvailability }).createBundleAvailabilityService({
    bundleCatalogReadPort: input.bundleCatalogReadPort, offerAvailabilityPort: stock,
  }) : null;
  const contribution = createInventoryContribution({ version: input.version, requiredSchema: input.requiredSchema,
    inventory: {
      listStock: bindings.readPort?.listStock ?? null,
      listReservations: bindings.readPort?.listReservations ?? null,
      checkAtp: bindings.readPort?.checkAtp ?? null,
      forecastSubscriptions: bindings.readPort?.forecastSubscriptions ?? null,
      ...(input.requireNewPurchaseStockRead ? { newPurchaseStockRead: bindings.newPurchaseStockReadPort?.read ?? null } : {}),
    }, routes: [],
  });
  return { ...bindings,
    readiness: input.requireNewPurchaseStockRead && bindings.unsupported.newPurchaseStockRead
      ? { ready: false, reason: bindings.unsupported.newPurchaseStockRead } : bindings.readiness,
    stock, availability, ...contribution };
}
