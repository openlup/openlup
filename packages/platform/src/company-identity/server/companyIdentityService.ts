import {
  COMPANY_IDENTITY_CONTRACT_VERSION,
  defaultCompanyIdentityRules,
  type CompanyIdentityRules,
  isCompleteCompanyIdentity,
  isValidCompanyIdentifier,
  type CompanyIdentityCompany,
  type CompanyIdentityLookupRequest,
  type CompanyIdentityLookupResponse,
  type CompanyIdentitySource,
  type CompanyIdentitySourceStatus,
} from "../index.js";
import type { CompanyIdentityLookupPort } from "../contracts/index.js";

export interface CompanyIdentityProvider {
  providerKind: string;
  lookup(request: CompanyIdentityLookupRequest): Promise<CompanyIdentityProviderResult>;
}

export interface CompanyIdentityProviderResult {
  status: CompanyIdentitySourceStatus;
  company: CompanyIdentityCompany | null;
  source: CompanyIdentitySource;
}

export function createCompanyIdentityLookupPort(
  providersByCountry: Record<string, CompanyIdentityProvider[]>,
  rules: CompanyIdentityRules = defaultCompanyIdentityRules,
): CompanyIdentityLookupPort {
  return {
    async lookupCompanyIdentity(request) {
      if (!isValidCompanyIdentifier(request.country, request.identifierKind, request.identifierValue, rules)) {
        return response("invalid", "invalid", null, [], ["invalid_identifier"]);
      }
      if (request.identifierKind === "custom") {
        return response(
          request.manualCompany ? "partial" : "not_found",
          "manual_unverified",
          request.manualCompany ? manualCompany(request) : null,
          [],
          ["manual_unverified"],
        );
      }

      const providers = providersByCountry[request.country] ?? [];
      if (!providers.length) {
        return response("unsupported_country", "invalid", null, [], ["unsupported_country"]);
      }

      const sources: CompanyIdentitySource[] = [];
      let best: CompanyIdentityCompany | null = null;
      let hasUnavailable = false;

      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        const result = await provider.lookup(request);
        sources.push(result.source);
        if (result.status === "provider_unavailable") hasUnavailable = true;
        if (result.company && (!best || isMoreComplete(result.company, best, rules))) best = result.company;
        if (best && isCompleteCompanyIdentity(best) && !(index < providers.length - 1 && rules.shouldSeekFullerLegalName(request, best))) {
          return response("found", "registry_verified", best, sources);
        }
      }

      if (best) return response("partial", "provider_verified", best, sources, ["partial_company_identity"]);
      return response(
        hasUnavailable ? "provider_unavailable" : "not_found",
        "invalid",
        null,
        sources,
        hasUnavailable ? ["provider_unavailable"] : ["not_found"],
      );
    },
  };
}

function manualCompany(request: CompanyIdentityLookupRequest): CompanyIdentityCompany {
  return {
    country: request.country,
    identifierKind: request.identifierKind,
    identifierValue: request.identifierValue,
    legalName: request.manualCompany?.legalName ?? null,
    registeredAddress: request.manualCompany?.registeredAddress ?? null,
    registryStatus: "manual",
    regon: null,
    vatStatus: null,
  };
}

function response(
  status: CompanyIdentityLookupResponse["status"],
  verificationLevel: CompanyIdentityLookupResponse["verificationLevel"],
  company: CompanyIdentityCompany | null,
  sources: CompanyIdentitySource[],
  warnings: string[] = [],
): CompanyIdentityLookupResponse {
  return {
    contractVersion: COMPANY_IDENTITY_CONTRACT_VERSION,
    status,
    verificationLevel,
    company,
    sources,
    warnings,
  };
}

function isMoreComplete(next: CompanyIdentityCompany, current: CompanyIdentityCompany, rules: CompanyIdentityRules): boolean {
  return Number(isCompleteCompanyIdentity(next)) > Number(isCompleteCompanyIdentity(current)) ||
    rules.isFullerLegalName(next.legalName, current.legalName) ||
    (!current.legalName && Boolean(next.legalName)) ||
    (!current.registeredAddress && Boolean(next.registeredAddress));
}
