import type { CompanyIdentityProvider } from "@openlup/platform/company-identity/server";
import type { AddressCanonLookupPort } from "../../../src/domains/address-canon/ports.js";
import { DEFAULT_REFERENCE_LANGUAGE } from "../../../src/public-reference/subscriptionMessages.js";
import { createReferenceMarketRecipe } from "../../adapters/market-packs/marketRecipe.js";

/** Opt-in reference composition. Importing this module mounts no route or provider. */
export function createReferenceMarketBinding(input: {
  language?: Parameters<typeof createReferenceMarketRecipe>[0]["language"];
  configuration?: Readonly<Record<string, string | undefined>>;
  providers?: CompanyIdentityProvider[];
  directory?: AddressCanonLookupPort;
} = {}) {
  return createReferenceMarketRecipe({
    language: input.language ?? DEFAULT_REFERENCE_LANGUAGE,
    configuration: input.configuration ?? {},
    providers: input.providers ?? [],
    directory: input.directory,
  });
}
