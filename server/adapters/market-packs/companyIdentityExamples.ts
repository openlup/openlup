import type { CompanyIdentityProvider, CompanyIdentityProviderResult } from "@openlup/platform/company-identity/server";

/** Offline example with caller-supplied synthetic data; no credentials or provider IO. */
export function createStaticCompanyIdentityExample(result: CompanyIdentityProviderResult): CompanyIdentityProvider {
  return { providerKind: result.source.providerKind, lookup: async () => result };
}
