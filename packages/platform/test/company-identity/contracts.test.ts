import { rules } from "./fixtures.js";
import { describe, expect, it } from "vitest";
import { companyIdentityLookupRequestSchema as coreRequest } from "@openlup/core/company-identity";
import { createCompanyIdentitySchemas, companyIdentityLookupRequestSchema as neutralRequest, companyIdentityLookupResponseSchema, isValidCompanyIdentifier } from "../../src/company-identity/index.js";

const { companyIdentityLookupRequestSchema } = createCompanyIdentitySchemas(rules);
const input = { country: "zz", identifierKind: "national", identifierValue: "12-36", purpose: "checkout_invoice" };
const company = {
  country: "ZZ", identifierKind: "national", identifierValue: "1236",
  legalName: "Example Company", registeredAddress: null, registryStatus: "active",
  regon: "123456789", vatStatus: "active",
};
describe("company host compatibility", () => {
  it("normalizes the selected national identifier downstream of core", () => {
    const parsed = companyIdentityLookupRequestSchema.parse(input);
    expect(parsed).toMatchObject({ country: "ZZ", identifierKind: "national", identifierValue: "1236" });
    expect(isValidCompanyIdentifier(parsed.country, parsed.identifierKind, parsed.identifierValue, rules)).toBe(true);
  });
  it("leaves core request parsing country neutral", () => {
    expect(coreRequest.parse(input)).toMatchObject({ country: "ZZ", identifierValue: "12-36" });
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
    expect(parsed.manualCompany).toMatchObject({ ...company, identifierValue: "1236" });
    expect(companyIdentityLookupRequestSchema.safeParse({ ...input, manualCompany: { ...company, unknown: true } }).success).toBe(false);
  });
  it("defaults to identity normalization for non-empty identifiers", () => {
    expect(neutralRequest.parse(input).identifierValue).toBe("12-36");
    expect(isValidCompanyIdentifier("ZZ", "national", "12-36")).toBe(true);
    expect(isValidCompanyIdentifier("ZZ", "national", " ")).toBe(false);
  });

});
