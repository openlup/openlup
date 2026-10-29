import { describe, expect, it } from "vitest";
import { companyIdentityLookupRequestSchema as coreRequest } from "@openlup/core/company-identity";
import { companyIdentityLookupRequestSchema, companyIdentityLookupResponseSchema, isValidCompanyIdentifier } from "../../src/company-identity/index.js";

const input = { country: "pl", identifierKind: "pl_nip", identifierValue: "123-456-32-18", purpose: "checkout_invoice" };
const company = {
  country: "PL", identifierKind: "pl_nip", identifierValue: "1234563218",
  legalName: "Example Company", registeredAddress: null, registryStatus: "active",
  regon: "123456789", vatStatus: "active",
};
describe("company host compatibility", () => {
  it("normalizes the selected national identifier downstream of core", () => {
    const parsed = companyIdentityLookupRequestSchema.parse(input);
    expect(parsed).toMatchObject({ country: "PL", identifierKind: "pl_nip", identifierValue: "1234563218" });
    expect(isValidCompanyIdentifier(parsed.country, parsed.identifierKind, parsed.identifierValue)).toBe(true);
  });
  it("leaves core request parsing country neutral", () => {
    expect(coreRequest.parse(input)).toMatchObject({ country: "PL", identifierValue: "123-456-32-18" });
  });
  it("preserves registry extensions and full source evidence", () => {
    const sources = [{ providerKind: "fixture_registry", status: "found", observedAt: "2026-01-01T00:00:00.000Z", evidenceHash: "sha256:example" }];
    const parsed = companyIdentityLookupResponseSchema.parse({ contractVersion: "company_identity.lookup.v1", status: "found", verificationLevel: "registry_verified", company, sources });
    expect(parsed.company).toEqual(company);
    expect(parsed.sources).toEqual(sources);
    expect(parsed.warnings).toEqual([]);
  });
  it("keeps manual registry extensions during normalization and refuses unknown fields", () => {
    const parsed = companyIdentityLookupRequestSchema.parse({ ...input, manualCompany: company });
    expect(parsed.manualCompany).toMatchObject({ ...company, identifierValue: "1234563218" });
    expect(companyIdentityLookupRequestSchema.safeParse({ ...input, manualCompany: { ...company, unknown: true } }).success).toBe(false);
  });
});
