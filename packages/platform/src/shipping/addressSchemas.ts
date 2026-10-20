import type {
  AddressCanonPostalCodeLookupRequest, AddressCanonPostalCodeLookupResponse,
  AddressCanonLocalitiesLookupRequest, AddressCanonLocalitiesLookupResponse,
  AddressCanonStreetsLookupRequest, AddressCanonStreetsLookupResponse,
  CustomerAddressesRequest, CustomerAddressesResponse, CustomerAddressUpsertRequest, CustomerAddressDeleteRequest,
} from "./contracts/address.js";
type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { flatten(): unknown } };
};
/** Host-owned format, source and geographic validation. */
export interface AddressLookupSchemas {
  addressCanonPostalCodeLookupRequestSchema: Schema<AddressCanonPostalCodeLookupRequest>;
  addressCanonPostalCodeLookupResponseSchema: Schema<AddressCanonPostalCodeLookupResponse>;
  addressCanonLocalitiesLookupRequestSchema: Schema<AddressCanonLocalitiesLookupRequest>;
  addressCanonLocalitiesLookupResponseSchema: Schema<AddressCanonLocalitiesLookupResponse>;
  addressCanonStreetsLookupRequestSchema: Schema<AddressCanonStreetsLookupRequest>;
  addressCanonStreetsLookupResponseSchema: Schema<AddressCanonStreetsLookupResponse>;
}
/** Host-owned validation and mutation-conflict identity. */
export interface CustomerAddressSchemas {
  customerAddressesRequestSchema: Schema<CustomerAddressesRequest>;
  customerAddressesResponseSchema: Schema<CustomerAddressesResponse>;
  customerAddressUpsertRequestSchema: Schema<CustomerAddressUpsertRequest>;
  customerAddressDeleteRequestSchema: Schema<CustomerAddressDeleteRequest>;
  isMutationConflict(error: unknown): error is Error;
}
