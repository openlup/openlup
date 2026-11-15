export type {
  DeliverySelectionSummaryKind, DeliverySelectionSummary,
  DeliverySelectionSourceKey, DeliverySelectionSources, DeliverySelectionEvidence,
} from "./contracts/delivery.js";
export type { DeliverySelectionPort } from "./deliverySelectionPort.js";
export type { PickupPointSearchPort } from "./pickupPointSearchPort.js";
export { createDeliverySelectionBoundary } from './deliverySelectionBoundary.js';
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
export type { ShippingTerms, ShippingPolicyEntry, ShippingPolicy, ShippingSettings } from "./contracts/threshold.js";
export { shippingTermsSchema, shippingPolicySchema, parseShippingTerms, hasShippingTerms, normalizeShippingPolicy, resolveShippingPolicy, resolveThresholdShipping, summarizeThresholdShipping } from "./thresholdPolicy.js";

/** Sparse canonical projections, never an install chain. */
export const SHIPPING_MIGRATIONS = [
  { id: "20260807140000_read_parity_catalog", catalogPath: "db/platform/migrations/20260807140000_read_parity_catalog.sql", position: 1, sha256: "fcf3827028c1651ae42a7c7d7472153825a3121c936d58a3d105befc7dece9ea", url: new URL("../../sql/20260807140000_read_parity_catalog.sql", import.meta.url) },
  { id: "20261021200000_shipping_flat_rate_seed", catalogPath: "db/platform/migrations/20261021200000_shipping_flat_rate_seed.sql", position: 72, sha256: "34f8696f515a2cc072395db5a3de2d9b09643d13236ee3851d0d78123f907eae", url: new URL("../../sql/20261021200000_shipping_flat_rate_seed.sql", import.meta.url) },
] as const;

export { createPostgresCustomerSavedAddressPort, CustomerSavedAddressRefused } from "./postgresAddressBook.js";
export type { SavedAddressQueryExecutor, CustomerSavedAddressScope, CustomerSavedAddressOptions, CustomerSavedAddressRefusalCode, CustomerSavedAddressPort } from "./postgresAddressBook.js";
export { createCustomerSavedAddressRequestSchemas } from "./customerSavedAddressSchemas.js";
export type { CustomerSavedAddressValidationPolicy, CustomerSavedAddressRequestSchemas } from "./customerSavedAddressSchemas.js";

/** Sparse asset reference; install the complete selected native catalogue. */
export const CUSTOMER_SAVED_ADDRESS_MIGRATIONS = [{ id: '20261110190000_customer_saved_addresses', catalogPath: 'db/platform/migrations/20261110190000_customer_saved_addresses.sql', position: 117, sha256: '0cf335d6a2497015d9218a6ab64fe888a3143290d7f6605a115c848eee4c042a', url: new URL('../../sql/20261110190000_customer_saved_addresses.sql', import.meta.url) }] as const;
export { createPostgresCustomerPreferencePort, createPostgresCustomerDefaultsPort } from './postgresCustomerPreferences.js';
export { createCustomerPreferenceSchemas, type CustomerPreferencePolicy } from './customerPreferenceSchemas.js';
export { createCustomerPaymentPreferencesHandler, createCustomerDeliveryPreferencesHandler, type CustomerPreferenceHandlerOptions } from './customerPreferenceHandlers.js';
