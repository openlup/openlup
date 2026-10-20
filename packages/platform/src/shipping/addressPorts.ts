import type {
  AddressCanonLocalitiesLookupRequest,
  AddressCanonLocalitiesLookupResponse,
  AddressCanonPostalCodeLookupRequest,
  AddressCanonPostalCodeLookupResponse,
  AddressCanonStreetsLookupRequest,
  AddressCanonStreetsLookupResponse,
} from "./contracts/address.js";

export interface AddressCanonLookupPort {
  lookupPostalCode(
    request: AddressCanonPostalCodeLookupRequest,
  ): Promise<AddressCanonPostalCodeLookupResponse>;
  searchLocalities(
    request: AddressCanonLocalitiesLookupRequest,
  ): Promise<AddressCanonLocalitiesLookupResponse>;
  listStreets(
    request: AddressCanonStreetsLookupRequest,
  ): Promise<AddressCanonStreetsLookupResponse>;
}

import type { HttpRequest } from "../http/index.js";
import type { CustomerAddressesResponse, CustomerAddressUpsertRequest, CustomerAddressDeleteRequest } from "./contracts/address.js";
export interface AddressCanonLookupDeps { lookupPort: AddressCanonLookupPort }
export interface CustomerAddressBookPort {
  getAddressBook(userId: string): Promise<CustomerAddressesResponse | null>;
}
export interface CustomerAddressMutationPort {
  upsertAddress(userId: string, input: CustomerAddressUpsertRequest): Promise<CustomerAddressesResponse | null>;
  deleteAddress(userId: string, input: CustomerAddressDeleteRequest): Promise<CustomerAddressesResponse | null>;
}
export interface CustomerAddressesDeps {
  addressBookPort: CustomerAddressBookPort;
  addressMutationPort?: CustomerAddressMutationPort;
  authenticateUser: (req: HttpRequest) => Promise<
    | { ok: true; userId: string }
    | { ok: false; code: "UNAUTHORIZED"; message: string }
  >;
}
type Row = Record<string, unknown>;
export interface CustomerAddressReadStore {
  readAddresses(clientId: string): Promise<Row[]>;
  readOrdererProfiles(clientId: string): Promise<Row[]>;
  addressUsedByActiveSubscription(clientId: string, addressId: string): Promise<boolean>;
  findCanonicalAddressId(clientId: string, canonicalKey: string): Promise<string | null>;
  clearDefaultAddress(clientId: string, kind: string, updatedAt: string): Promise<void>;
}

