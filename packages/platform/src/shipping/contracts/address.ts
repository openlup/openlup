export interface CanonicalAddressInput {
  clientId?: string | null;
  kind?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  country?: string | null;
}

export interface AddressCanonSource {
  sourceKind: string;
  status: "active" | "inactive" | "disabled_pending_license";
  displayName: string;
  officialUrl: string;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
}
export interface AddressCanonLocalityCandidate {
  localityId: string; countryCode: string; name: string; tercCode: string; simcCode: string;
  municipalityName: string | null; municipalityTercCode: string | null;
  countyName: string | null; voivodeshipName: string | null;
  sources: AddressCanonSource[]; postalCode: string | null;
  confidence: "exact" | "ambiguous" | "partial";
  resolutionLevel: "postal_code" | "locality" | "street" | "address_point";
}
export interface AddressCanonStreet {
  streetId: string; localityId: string; name: string; ulicCode: string | null; sources: AddressCanonSource[];
}
export interface AddressCanonPostalCodeLookupRequest { postalCode: string; limit: number }
export interface AddressCanonLocalitiesLookupRequest { q: string; limit: number }
export interface AddressCanonStreetsLookupRequest { localityId: string; q?: string; limit: number }
export interface AddressCanonPostalCodeLookupResponse {
  contractVersion: "address.canon.v1"; query: { postalCode: string }; resolutionLevel: "postal_code";
  candidates: AddressCanonLocalityCandidate[]; sources: AddressCanonSource[];
}
export interface AddressCanonLocalitiesLookupResponse {
  contractVersion: "address.canon.v1"; query: { q: string }; resolutionLevel: "locality";
  candidates: AddressCanonLocalityCandidate[]; sources: AddressCanonSource[];
}
export interface AddressCanonStreetsLookupResponse {
  contractVersion: "address.canon.v1"; query: { localityId: string; q: string | null }; resolutionLevel: "street";
  streets: AddressCanonStreet[]; sources: AddressCanonSource[];
}
export type CustomerAddressKind = "shipping" | "billing" | "both";
export interface CustomerAddress {
  addressId: string; kind: CustomerAddressKind; label: string | null; recipientName: string | null;
  contactPhone: string | null; companyName: string | null; taxId: string | null;
  line1: string; line2: string | null; city: string; postalCode: string; country: string;
  isDefault: boolean; deliveryNotes: string | null; courierInstructions: string | null;
  lastUsedAt: string | null; createdAt: string; updatedAt: string;
}
export interface CustomerOrdererProfile {
  profileId: string; label: string | null; fullName: string; email: string; phone: string | null;
  companyName: string | null; taxId: string | null;
  companyVerificationLevel?: "registry_verified" | "provider_verified" | "manual_unverified" | "invalid" | null;
  companyIdentitySource?: string | null; companyIdentityEvidenceHash?: string | null;
  isDefault: boolean; createdAt: string; updatedAt: string;
}
export type CustomerAddressesRequest = Record<string, never>;
export interface CustomerAddressesResponse {
  contractVersion: "customer.addresses.v1"; ordererProfiles: CustomerOrdererProfile[]; addresses: CustomerAddress[];
}
export interface CustomerAddressUpsertRequest {
  idempotencyKey: string; addressId?: string; kind: CustomerAddressKind;
  label?: string | null; recipientName?: string | null; contactPhone?: string | null;
  companyName?: string | null; taxId?: string | null;
  line1: string; line2?: string | null; city: string; postalCode: string; country?: string;
  isDefault?: boolean; deliveryNotes?: string | null; courierInstructions?: string | null;
}
export interface CustomerAddressDeleteRequest { idempotencyKey: string; addressId: string }
