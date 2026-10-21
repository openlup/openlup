export type {
  DeliverySelectionSummaryKind, DeliverySelectionSummary,
  DeliverySelectionSourceKey, DeliverySelectionSources, DeliverySelectionEvidence,
} from "./contracts/delivery.js";
export type { DeliverySelectionPort } from "./deliverySelectionPort.js";
export type { PickupPointSearchPort } from "./pickupPointSearchPort.js";
export type { DeliverySelectionSchemas } from "./handlerSchemas.js";
export {
  createDeliveryOptionsHandler, createPickupPointSearchHandler, createPickupPointValidationHandler,
  DELIVERY_SELECTION_CONTRACT_VERSION, PICKUP_POINT_SEARCH_CONTRACT_VERSION,
} from "./deliverySelectionHandler.js";
export { summarizeDeliverySelection } from "./deliverySelectionSummary.js";
export { resolveDeliverySelectionEvidence } from "./readDeliverySelectionEvidence.js";
export type { CanonicalAddressInput } from "./contracts/address.js";
export type { AddressCanonLookupPort, AddressCanonLookupDeps, CustomerAddressesDeps, CustomerAddressBookPort, CustomerAddressMutationPort, CustomerAddressReadStore } from "./addressPorts.js";
export type { AddressLookupSchemas, CustomerAddressSchemas } from "./addressSchemas.js";
export { createAddressCanonPostalCodeHandler, createAddressCanonLocalitiesHandler, createAddressCanonStreetsHandler } from "./addressCanonLookupHandler.js";
export { createCustomerAddressesHandler } from "./customerAddressesHandler.js";
export { canonicalAddressKey } from "./addressCanonical.js";
export { readAddresses, readOrdererProfiles, addressUsedByActiveSubscription, addressRow, findCanonicalAddressId, clearDefaultAddress } from "./customerSelfServiceAddressModels.js";
export type { AdminShippingRateResponse, AdminSetShippingRateRequest, AdminSetShippingRateResponse } from "./contracts/shippingRate.js";
export { createAdminShippingRateHandler } from "./adminShippingRateHandler.js";
export type { AdminShippingRateHandlerDeps, ShippingRateDataPort, ShippingRateHandlerSchemas } from "./shippingRatePorts.js";
export { createShippingBindings, type ShippingBindingDependencies, type ShippingBindings } from "./bindings.js";

/** Sparse canonical projections, never an install chain. */
export const SHIPPING_MIGRATIONS = [
  { id: "20260807140000_read_parity_catalog", catalogPath: "db/platform/migrations/20260807140000_read_parity_catalog.sql", position: 1, sha256: "fcf3827028c1651ae42a7c7d7472153825a3121c936d58a3d105befc7dece9ea", url: new URL("../../sql/20260807140000_read_parity_catalog.sql", import.meta.url) },
  { id: "20261021120000_shipping_flat_rate_seed", catalogPath: "db/platform/migrations/20261021120000_shipping_flat_rate_seed.sql", position: 71, sha256: "34f8696f515a2cc072395db5a3de2d9b09643d13236ee3851d0d78123f907eae", url: new URL("../../sql/20261021120000_shipping_flat_rate_seed.sql", import.meta.url) },
] as const;
