import { describeMarket, readSettlementProfile } from "@openlup/platform/market-packs";
import { createCompanyIdentityLookupPort } from "@openlup/platform/company-identity/server";
import type { CompanyIdentityProvider } from "@openlup/platform/company-identity/server";
import type { AddressCanonLookupPort } from "../../../src/domains/address-canon/ports.js";
import { marketResources } from "../../../src/public-reference/i18n/marketResources.js";
import { referenceCompanyCountry, referenceCompanyIdentityRules, referenceCompanyIdentitySchemas } from "./referenceCompanyIdentityRules.js";
import { referenceAddressCanonSchemas } from "./referenceAddressCanon.js";
import { referenceSettlementFallbacks } from "./referenceMarketDescriptor.js";

/** Explicit source recipe, never mounted by importing it. No selection fallback. */
export function createReferenceMarketRecipe(input: {
  language: keyof typeof marketResources;
  configuration: Readonly<Record<string, string | undefined>>;
  providers: CompanyIdentityProvider[];
  directory?: AddressCanonLookupPort;
}) {
  if (!Object.hasOwn(marketResources, input.language)) throw new Error("Unsupported reference language");
  const settlement = readSettlementProfile(input.configuration, referenceSettlementFallbacks);
  return {
    descriptor: describeMarket(input.language, settlement),
    settlement,
    messages: marketResources[input.language],
    companySchemas: referenceCompanyIdentitySchemas,
    companyLookup: createCompanyIdentityLookupPort({ [referenceCompanyCountry]: input.providers }, referenceCompanyIdentityRules),
    addressSchemas: referenceAddressCanonSchemas,
    directory: input.directory,
  };
}
