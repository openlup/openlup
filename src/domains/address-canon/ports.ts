import type {
  AddressCanonLocalitiesLookupRequest,
  AddressCanonLocalitiesLookupResponse,
  AddressCanonPostalCodeLookupRequest,
  AddressCanonPostalCodeLookupResponse,
  AddressCanonStreetsLookupRequest,
  AddressCanonStreetsLookupResponse,
} from "./contracts.js";

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
