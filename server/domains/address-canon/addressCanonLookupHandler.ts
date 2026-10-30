import {
  createAddressCanonPostalCodeHandler as postal,
  createAddressCanonLocalitiesHandler as localities,
  createAddressCanonStreetsHandler as streets,
  type AddressLookupSchemas,
} from "@openlup/platform/shipping";
import { bffResponder } from "../../_lib/bff/response.js";
import {
  addressCanonLocalitiesLookupRequestSchema,
  addressCanonLocalitiesLookupResponseSchema,
  addressCanonPostalCodeLookupRequestSchema,
  addressCanonPostalCodeLookupResponseSchema,
  addressCanonStreetsLookupRequestSchema,
  addressCanonStreetsLookupResponseSchema,
} from "../../../src/domains/address-canon/contracts.js";

import type { AddressCanonLookupPort } from "./ports.js";

export interface AddressCanonLookupDeps {
  lookupPort: AddressCanonLookupPort;
  schemas?: AddressLookupSchemas;
}
const schemas: AddressLookupSchemas = { addressCanonPostalCodeLookupRequestSchema, addressCanonPostalCodeLookupResponseSchema, addressCanonLocalitiesLookupRequestSchema, addressCanonLocalitiesLookupResponseSchema, addressCanonStreetsLookupRequestSchema, addressCanonStreetsLookupResponseSchema };

export function createAddressCanonPostalCodeHandler(deps: AddressCanonLookupDeps) {
  return postal(deps, deps.schemas ?? schemas, bffResponder);
}
export function createAddressCanonLocalitiesHandler(deps: AddressCanonLookupDeps) {
  return localities(deps, deps.schemas ?? schemas, bffResponder);
}
export function createAddressCanonStreetsHandler(deps: AddressCanonLookupDeps) {
  return streets(deps, deps.schemas ?? schemas, bffResponder);
}
