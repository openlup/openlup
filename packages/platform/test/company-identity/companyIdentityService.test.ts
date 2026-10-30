import { rules } from "./fixtures.js";
import { describe, expect, it, vi } from "vitest";

import { createCompanyIdentityLookupPort, type CompanyIdentityProvider } from "../../src/company-identity/server/index.js";

const request = {
  country: "ZZ",
  identifierKind: "national",
  identifierValue: "1236",
  purpose: "checkout_invoice" as const,
};

describe("company identity lookup service", () => {
  it("returns unsupported_country without a registered strategy", async () => {
    const port = createCompanyIdentityLookupPort({});

    await expect(port.lookupCompanyIdentity({
      country: "DE",
      identifierKind: "de_ust_id",
      identifierValue: "DE123",
      purpose: "checkout_invoice",
    })).resolves.toMatchObject({
      status: "unsupported_country",
      verificationLevel: "invalid",
    });
  });

  it("allows custom identifiers only as manual_unverified", async () => {
    const port = createCompanyIdentityLookupPort({});

    await expect(port.lookupCompanyIdentity({
      country: "US",
      identifierKind: "custom",
      identifierValue: "ACME-1",
      purpose: "customer_billing_profile",
      manualCompany: {
        legalName: "Acme Inc.",
        registeredAddress: null,
      },
    })).resolves.toMatchObject({
      status: "partial",
      verificationLevel: "manual_unverified",
      company: { legalName: "Acme Inc.", registryStatus: "manual" },
    });
  });

  it("rejects invalid synthetic identifier before provider calls", async () => {
    const provider = vi.fn();
    const port = createCompanyIdentityLookupPort({
      ZZ: [{ providerKind: "test", lookup: provider }],
    }, rules);

    await expect(port.lookupCompanyIdentity({
      ...request,
      identifierValue: "123",
    })).resolves.toMatchObject({ status: "invalid" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("continues from first absent source to later complete data", async () => {
    const mf = provider("fixture_first", { status: "not_found" });
    const gus = provider("fixture_later", { status: "found" });
    const port = createCompanyIdentityLookupPort({
      ZZ: [mf, gus],
    });

    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "found",
      verificationLevel: "registry_verified",
      company: {
        legalName: "Example Company LLC",
        registeredAddress: { city: "ExampleCity" },
      },
      sources: [
        { providerKind: "fixture_first", status: "not_found" },
        { providerKind: "fixture_later", status: "found" },
      ],
    });
  });

  it("continues past a complete first personal-name record and prefers a fuller later name", async () => {
    const mf = provider("fixture_first", {
      status: "found",
      legalName: "Alfa Beta",
      regon: "123456789",
      address: { line1: "Example Road 3", postalCode: "00-001", city: "Example City", country: "ZZ" },
    });
    const ceidg = provider("fixture_later", {
      status: "found",
      legalName: "Example Services Alfa Beta",
      regon: "123456789",
      address: { line1: "Example Road 3", postalCode: "00-001", city: "Example City", country: "ZZ" },
    });
    const port = createCompanyIdentityLookupPort({ ZZ: [mf, ceidg] }, rules);

    await expect(port.lookupCompanyIdentity({ ...request, identifierValue: "1236" })).resolves.toMatchObject({
      status: "found",
      verificationLevel: "registry_verified",
      company: { legalName: "Example Services Alfa Beta" },
      sources: [
        { providerKind: "fixture_first", status: "found" },
        { providerKind: "fixture_later", status: "found" },
      ],
    });
  });

  it("does not call later providers when the first provider returns a complete company legal name", async () => {
    const mf = provider("fixture_first", {
      status: "found",
      legalName: 'Example Company LLC',
    });
    const ceidg = provider("fixture_later", {
      status: "found",
      legalName: "Ignored Enrichment LLC",
    });
    const port = createCompanyIdentityLookupPort({ ZZ: [mf, ceidg] }, rules);

    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "found",
      company: { legalName: 'Example Company LLC' },
      sources: [{ providerKind: "fixture_first", status: "found" }],
    });
    expect(ceidg.lookup).not.toHaveBeenCalled();
  });
  it("retains ordered unavailable and absent evidence", async () => {
    const port = createCompanyIdentityLookupPort({ ZZ: [
      provider("fixture_a", { status: "provider_unavailable" }),
      provider("fixture_b", { status: "not_found" }),
    ] });
    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "provider_unavailable", verificationLevel: "invalid", company: null,
      sources: [
        { providerKind: "fixture_a", status: "provider_unavailable", evidenceHash: null },
        { providerKind: "fixture_b", status: "not_found", evidenceHash: null },
      ], warnings: ["provider_unavailable"],
    });
  });

  it("retains partial identity when enrichment is unavailable", async () => {
    const port = createCompanyIdentityLookupPort({ ZZ: [
      provider("fixture_a", { status: "found", legalName: "Example Supply Ltd", regon: "1234567", address: null }),
      provider("fixture_b", { status: "provider_unavailable" }),
    ] });
    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "partial", verificationLevel: "provider_verified",
      company: { legalName: "Example Supply Ltd", registeredAddress: null },
      sources: [
        { providerKind: "fixture_a", status: "found", evidenceHash: "sha256:test" },
        { providerKind: "fixture_b", status: "provider_unavailable" },
      ], warnings: ["partial_company_identity"],
    });
  });

  it("distinguishes exhausted absence from unavailability", async () => {
    const port = createCompanyIdentityLookupPort({ ZZ: [provider("fixture_a", { status: "not_found" })] });
    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "not_found", verificationLevel: "invalid", company: null, warnings: ["not_found"],
    });
  });

  it("propagates provider throws and never calls the next provider", async () => {
    const failed = { providerKind: "fixture_a", lookup: vi.fn().mockRejectedValue(new Error("fixture unavailable")) };
    const later = provider("fixture_b", { status: "not_found" });
    await expect(createCompanyIdentityLookupPort({ ZZ: [failed, later] }).lookupCompanyIdentity(request))
      .rejects.toThrow("fixture unavailable");
    expect(later.lookup).not.toHaveBeenCalled();
  });

  it("stops on the last complete provider without asking the continuation rule", async () => {
    const shouldSeekFullerLegalName = vi.fn(() => true);
    const port = createCompanyIdentityLookupPort({ ZZ: [provider("fixture", { status: "found" })] }, { ...rules, shouldSeekFullerLegalName });
    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({ status: "found" });
    expect(shouldSeekFullerLegalName).not.toHaveBeenCalled();
  });
  it("defaults to country-neutral non-empty validation with no fuller-name preference", async () => {
    const first = provider("first", { status: "found", legalName: "Alfa Beta", address: null });
    const later = provider("later", { status: "found", legalName: "Services Alfa Beta", address: null });
    const port = createCompanyIdentityLookupPort({ ZZ: [first, later] });
    await expect(port.lookupCompanyIdentity({ ...request, identifierValue: "any-non-empty" })).resolves.toMatchObject({
      status: "partial", company: { legalName: "Alfa Beta" }, sources: [{ providerKind: "first" }, { providerKind: "later" }],
    });
  });
  it("uses the injected fuller-name comparison independently of country-specific continuation", async () => {
    const port = createCompanyIdentityLookupPort({ US: [
      provider("first", { status: "found", legalName: "Alfa Beta", address: null }),
      provider("later", { status: "found", legalName: "Services Alfa Beta", address: null }),
    ] }, rules);
    await expect(port.lookupCompanyIdentity({ ...request, country: "US" })).resolves.toMatchObject({
      status: "partial", company: { legalName: "Services Alfa Beta" },
    });
  });
  it("keeps custom identifier validation in the engine rather than in host policy", async () => {
    const isValidIdentifier = vi.fn(() => false);
    const port = createCompanyIdentityLookupPort({}, { ...rules, isValidIdentifier });
    await expect(port.lookupCompanyIdentity({ ...request, identifierKind: "custom", identifierValue: "manual" })).resolves.toMatchObject({ status: "not_found", verificationLevel: "manual_unverified" });
    await expect(port.lookupCompanyIdentity({ ...request, identifierKind: "custom", identifierValue: " " })).resolves.toMatchObject({ status: "invalid" });
    expect(isValidIdentifier).not.toHaveBeenCalled();
  });

});

function provider(
  providerKind: string,
  {
    status,
    legalName = "Example Company LLC",
    regon = "123456789",
    address = { line1: "Example Street 11", postalCode: "32-091", city: "ExampleCity", country: "ZZ" as const },
  }: {
    status: "found" | "not_found" | "provider_unavailable";
    legalName?: string;
    regon?: string;
    address?: { line1: string; postalCode: string; city: string; country: "ZZ" } | null;
  },
): CompanyIdentityProvider {
  return {
    providerKind,
    lookup: vi.fn(async (request) => ({
      status,
      company: status === "found"
        ? {
            country: request.country,
            identifierKind: request.identifierKind,
            identifierValue: request.identifierValue,
            legalName,
            registeredAddress: address,
            registryStatus: "found",
            regon,
            vatStatus: "active",
          }
        : null,
      source: {
        providerKind,
        status,
        evidenceHash: status === "found" ? "sha256:test" : null,
        observedAt: "2026-06-15T10:00:00+02:00",
      },
    })),
  };
}
