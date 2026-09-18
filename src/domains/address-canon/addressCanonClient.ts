import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  addressCanonLocalitiesLookupResponseSchema,
  addressCanonPostalCodeLookupResponseSchema,
  addressCanonStreetsLookupResponseSchema,
  type AddressCanonLocalitiesLookupRequest,
  type AddressCanonLocalitiesLookupResponse,
  type AddressCanonPostalCodeLookupRequest,
  type AddressCanonPostalCodeLookupResponse,
  type AddressCanonStreetsLookupRequest,
  type AddressCanonStreetsLookupResponse,
} from "./contracts";

export function lookupAddressCanonPostalCode(
  request: AddressCanonPostalCodeLookupRequest,
  options: BffRequestOptions = {},
): Promise<AddressCanonPostalCodeLookupResponse> {
  const params = new URLSearchParams({
    postalCode: request.postalCode,
    limit: String(request.limit),
  });

  return requestBff(
    `/api/bff/address-canon/postal-code?${params}`,
    addressCanonPostalCodeLookupResponseSchema,
    { ...options, method: "GET" },
  );
}

export function lookupAddressCanonLocalities(
  request: AddressCanonLocalitiesLookupRequest,
  options: BffRequestOptions = {},
): Promise<AddressCanonLocalitiesLookupResponse> {
  const params = new URLSearchParams({
    q: request.q,
    limit: String(request.limit),
  });

  return requestBff(
    `/api/bff/address-canon/localities?${params}`,
    addressCanonLocalitiesLookupResponseSchema,
    { ...options, method: "GET" },
  );
}

export function lookupAddressCanonStreets(
  request: AddressCanonStreetsLookupRequest,
  options: BffRequestOptions = {},
): Promise<AddressCanonStreetsLookupResponse> {
  const params = new URLSearchParams({
    localityId: request.localityId,
    limit: String(request.limit),
  });
  if (request.q) params.set("q", request.q);

  return requestBff(
    `/api/bff/address-canon/streets?${params}`,
    addressCanonStreetsLookupResponseSchema,
    { ...options, method: "GET" },
  );
}
