import type {
  CompanyIdentityCompany as CoreCompanyIdentityCompany,
  CompanyIdentityLookupRequest as CoreCompanyIdentityLookupRequest,
  CompanyIdentityLookupResponse as CoreCompanyIdentityLookupResponse,
} from "@openlup/core/company-identity";

/** Existing registry-compatible host fields; the neutral core remains unchanged. */
export type CompanyIdentityCompany = CoreCompanyIdentityCompany & {
  regon?: string | null;
  vatStatus?: string | null;
};
export type CompanyIdentityLookupRequest = Omit<CoreCompanyIdentityLookupRequest, "manualCompany"> & {
  manualCompany?: Partial<CompanyIdentityCompany>;
};
export type CompanyIdentityLookupResponse = Omit<CoreCompanyIdentityLookupResponse, "company"> & {
  company: CompanyIdentityCompany | null;
};
export interface CompanyIdentityLookupPort {
  lookupCompanyIdentity(request: CompanyIdentityLookupRequest): Promise<CompanyIdentityLookupResponse>;
}
export type {
  CompanyIdentityPurpose, CompanyIdentitySource, CompanyIdentitySourceStatus,
  CompanyIdentityVerificationLevel,
} from "@openlup/core/company-identity";
