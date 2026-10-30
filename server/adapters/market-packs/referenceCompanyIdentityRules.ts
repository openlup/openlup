import { createCompanyIdentitySchemas } from "@openlup/platform/company-identity";
import { addressCanonLocalitySchema } from "../../../src/domains/address-canon/contracts.js";
import { referenceCompanyIdentityRules } from "../../domains/company-identity/companyIdentityService.js";

/** Existing reference jurisdiction, imported rather than stated as a platform fact. */
export const referenceCompanyCountry = addressCanonLocalitySchema.shape.countryCode.value;

/** Opt-in reference policy; the engine owns completeness, sequencing and cache scope. */
export { referenceCompanyIdentityRules };

/** Same strict host extensions as the current reference, through R1's rules seam. */
export const referenceCompanyIdentitySchemas = createCompanyIdentitySchemas(referenceCompanyIdentityRules);
