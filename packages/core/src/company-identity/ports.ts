import type {
  CompanyIdentityLookupRequest,
  CompanyIdentityLookupResponse,
} from "./contracts.js";

/**
 * Provider seam for resolving a company's registry identity from a tax/registry
 * identifier. The host application supplies the adapter (a national registry
 * client, a commercial data provider, or a manual store); the core owns only
 * this request/response contract. Adapters must not throw on a "not found" or
 * "unsupported country" outcome — those are represented in the response
 * `status`, so callers can branch on data rather than exceptions.
 */
/** @beta */
export interface CompanyIdentityLookupPort {
  lookupCompanyIdentity(
    request: CompanyIdentityLookupRequest,
  ): Promise<CompanyIdentityLookupResponse>;
}
