import { addressRow as row, findCanonicalAddressId as find } from "@openlup/platform/shipping";
import type { CustomerAddressUpsertRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { canonicalAddressKey } from "../../../src/domains/customers/addressCanonical.js";
import type { CustomerAddressReadStore } from "@openlup/platform/shipping";
export type { CustomerAddressReadStore } from "@openlup/platform/shipping";
export { readAddresses, readOrdererProfiles, addressUsedByActiveSubscription, clearDefaultAddress } from "@openlup/platform/shipping";

export function addressRow(clientId: string, input: CustomerAddressUpsertRequest) {
  return row(clientId, input, canonicalAddressKey);
}
export function findCanonicalAddressId(store: CustomerAddressReadStore, clientId: string, input: CustomerAddressUpsertRequest) {
  return find(store, clientId, input, canonicalAddressKey);
}
