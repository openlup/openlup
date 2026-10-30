import type { AddressLookupSchemas } from "@openlup/platform/shipping";
import {
  addressCanonPostalCodeLookupRequestSchema,
  addressCanonPostalCodeLookupResponseSchema,
  addressCanonLocalitiesLookupRequestSchema,
  addressCanonLocalitiesLookupResponseSchema,
  addressCanonStreetsLookupRequestSchema,
  addressCanonStreetsLookupResponseSchema,
} from "../../../src/domains/address-canon/contracts.js";
export { normalizeDirectoryText } from "../supabase/address-canon/addressCanonLookup.js";

/** Pass directly to the existing shipping handlers; lookup remains optional. */
export const referenceAddressCanonSchemas: AddressLookupSchemas = {
  addressCanonPostalCodeLookupRequestSchema,
  addressCanonPostalCodeLookupResponseSchema,
  addressCanonLocalitiesLookupRequestSchema,
  addressCanonLocalitiesLookupResponseSchema,
  addressCanonStreetsLookupRequestSchema,
  addressCanonStreetsLookupResponseSchema,
};
