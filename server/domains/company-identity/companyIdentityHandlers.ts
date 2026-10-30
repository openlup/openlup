import { createCompanyIdentityLookupHandler as createPackageHandler } from "@openlup/platform/company-identity/server";
import type { CompanyIdentityLookupPort } from "../../../src/domains/company-identity/ports.js";
import { bffResponder } from "../../_lib/bff/response.js";
import { referenceCompanyIdentityRules } from "./companyIdentityService.js";

export { __resetCompanyIdentityCaches } from "@openlup/platform/company-identity/server";

/** One package-owned cache; retain the original reference responder and rules. */
export function createCompanyIdentityLookupHandler({ lookupPort }: { lookupPort: CompanyIdentityLookupPort }) {
  return createPackageHandler({ lookupPort }, bffResponder, referenceCompanyIdentityRules);
}
