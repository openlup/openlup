export { createPostgresCustomerSavedAddressPort, CustomerSavedAddressRefused } from "../postgresAddressBook.js";
export type { SavedAddressQueryExecutor, CustomerSavedAddressScope, CustomerSavedAddressOptions, CustomerSavedAddressRefusalCode, CustomerSavedAddressPort } from "../postgresAddressBook.js";
export { createCustomerSavedAddressRequestSchemas } from "../customerSavedAddressSchemas.js";
export type { CustomerSavedAddressValidationPolicy, CustomerSavedAddressRequestSchemas } from "../customerSavedAddressSchemas.js";

/** Sparse asset reference; install the complete selected native catalogue. */
export const CUSTOMER_SAVED_ADDRESS_MIGRATIONS = [{ id: '20261110190000_customer_saved_addresses', catalogPath: 'db/platform/migrations/20261110190000_customer_saved_addresses.sql', position: 116, sha256: '0cf335d6a2497015d9218a6ab64fe888a3143290d7f6605a115c848eee4c042a', url: new URL('../../../sql/20261110190000_customer_saved_addresses.sql', import.meta.url) }] as const;
