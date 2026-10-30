import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyIdentityLookupPort } from "@openlup/platform/company-identity/server";
import { companyIdentityLookupRequestSchema, companyIdentityLookupResponseSchema } from "../../../src/domains/company-identity/companyIdentityContracts.js";
import { createCompanyIdentityLookupPort as currentPort } from "../../domains/company-identity/companyIdentityService.js";
import { referenceCompanyCountry, referenceCompanyIdentityRules, referenceCompanyIdentitySchemas } from "./referenceCompanyIdentityRules.js";
import { createStaticCompanyIdentityExample } from "./companyIdentityExamples.js";
import type { CompanyIdentityProviderResult } from "@openlup/platform/company-identity/server";

const request = { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "1234563218", purpose: "checkout_invoice" as const };
const company = { country: request.country, identifierKind: request.identifierKind, identifierValue: request.identifierValue, legalName: "Example Supply Inc.", registeredAddress: { line1: "Example Road 1", postalCode: "10-001", city: "Example City", country: request.country }, registryStatus: "active", regon: "123456789", vatStatus: "active" };
const source = { providerKind: "example", status: "found" as const, observedAt: "2026-01-01T00:00:00Z", evidenceHash: "sha256:example" };
afterEach(() => vi.restoreAllMocks());

describe("reference company policy parity", () => {
  it.each([
    { ...request, identifierValue: "123-456-32-18" },
    { ...request, country: request.country.toLowerCase(), identifierValue: "123-456-32-18" },
    { ...request, country: "ZZ", identifierValue: " A-1 " },
    { ...request, identifierKind: "custom", manualCompany: { ...company, identifierValue: undefined } },
    { ...request, manualCompany: { ...company, unexpected: true } },
    { ...request, purpose: "unknown" },
  ])("reproduces request fields or exact validation errors: %#", (input) => {
    const expected = companyIdentityLookupRequestSchema.safeParse(input);
    const actual = referenceCompanyIdentitySchemas.companyIdentityLookupRequestSchema.safeParse(input);
    expect(actual.success).toBe(expected.success);
    if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
    if (!actual.success && !expected.success) expect(actual.error.issues).toEqual(expected.error.issues);
  });

  it("retains strict registry extensions, warnings and all source evidence", async () => {
    const result: CompanyIdentityProviderResult = { status: "found", company, source };
    const providers = { [request.country]: [createStaticCompanyIdentityExample(result)] };
    const expected = await currentPort(providers).lookupCompanyIdentity(request);
    const actual = await createCompanyIdentityLookupPort(providers, referenceCompanyIdentityRules).lookupCompanyIdentity(request);
    expect(actual).toEqual(expected);
    expect(referenceCompanyIdentitySchemas.companyIdentityLookupResponseSchema.parse(actual)).toEqual(companyIdentityLookupResponseSchema.parse(expected));
    expect(actual.company).toEqual(company);
    expect(actual.sources).toEqual([source]);
  });

  it("rejects checksum failure before consulting a provider", async () => {
    const lookup = vi.fn();
    const providers = { [request.country]: [{ providerKind: "example", lookup }] };
    const invalid = { ...request, identifierValue: "123" };
    expect(await createCompanyIdentityLookupPort(providers, referenceCompanyIdentityRules).lookupCompanyIdentity(invalid)).toEqual(await currentPort(providers).lookupCompanyIdentity(invalid));
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([request.country, "ZZ"])("preserves whole-candidate fuller-name replacement and source order: %s", async (country) => {
    const first = { ...company, country, legalName: "ALEX EXAMPLE", registeredAddress: null };
    const second = { ...company, country, legalName: "Workshop Alex Example", registeredAddress: null, regon: null, vatStatus: null };
    const providers = { [country]: [first, second].map((value, index) => createStaticCompanyIdentityExample({ status: "partial", company: value, source: { ...source, providerKind: `example_${index}`, status: "partial" } })) };
    const input = { ...request, country };
    const expected = await currentPort(providers).lookupCompanyIdentity(input);
    const actual = await createCompanyIdentityLookupPort(providers, referenceCompanyIdentityRules).lookupCompanyIdentity(input);
    expect(actual).toEqual(expected);
    expect(actual.company).toEqual(second);
    expect(actual.sources).toHaveLength(2);
  });

  it("continues past a complete personal name, then stops at the last provider", async () => {
    const inputs: string[] = [];
    const providers = { [request.country]: ["ALEX EXAMPLE", "Workshop Alex Example"].map((legalName, index) => ({ providerKind: String(index), lookup: async () => {
      inputs.push(String(index));
      return { status: "found" as const, company: { ...company, legalName }, source: { ...source, providerKind: String(index) } };
    } })) };
    const expected = await currentPort(providers).lookupCompanyIdentity(request);
    const firstTranscript = inputs.splice(0);
    const actual = await createCompanyIdentityLookupPort(providers, referenceCompanyIdentityRules).lookupCompanyIdentity(request);
    expect(actual).toEqual(expected);
    expect(inputs).toEqual(firstTranscript);
    expect(inputs).toEqual(["0", "1"]);
    expect(actual.status).toBe("found");
  });
});
