import { describe, expect, it, vi } from "vitest";

import { createCompanyIdentityLookupPort, type CompanyIdentityProvider } from "./companyIdentityService.js";

const request = {
  country: "PL",
  identifierKind: "pl_nip",
  identifierValue: "1234563218",
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

  it("rejects invalid PL NIP before provider calls", async () => {
    const provider = vi.fn();
    const port = createCompanyIdentityLookupPort({
      PL: [{ providerKind: "test", lookup: provider }],
    });

    await expect(port.lookupCompanyIdentity({
      ...request,
      identifierValue: "123",
    })).resolves.toMatchObject({ status: "invalid" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("continues from MF not_found to GUS complete data", async () => {
    const mf = provider("mf_vat_whitelist", { status: "not_found" });
    const gus = provider("gus_ceidg", { status: "found" });
    const port = createCompanyIdentityLookupPort({
      PL: [mf, gus],
    });

    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "found",
      verificationLevel: "registry_verified",
      company: {
        legalName: "Example Company Sp. z o.o.",
        registeredAddress: { city: "ExampleCity" },
      },
      sources: [
        { providerKind: "mf_vat_whitelist", status: "not_found" },
        { providerKind: "gus_ceidg", status: "found" },
      ],
    });
  });

  it("continues past a complete MF personal-name JDG record and prefers a fuller CEIDG name", async () => {
    const mf = provider("mf_vat_whitelist", {
      status: "found",
      legalName: "BARTŁOMIEJ ROSZKOWSKI",
      regon: "147460466",
      address: { line1: "Powstania Styczniowego 3", postalCode: "05-074", city: "Halinów", country: "PL" },
    });
    const ceidg = provider("gus_ceidg", {
      status: "found",
      legalName: "Zero to One Bartłomiej Roszkowski",
      regon: "147460466",
      address: { line1: "Powstania Styczniowego 3", postalCode: "05-074", city: "Halinów", country: "PL" },
    });
    const port = createCompanyIdentityLookupPort({ PL: [mf, ceidg] });

    await expect(port.lookupCompanyIdentity({ ...request, identifierValue: "1181590588" })).resolves.toMatchObject({
      status: "found",
      verificationLevel: "registry_verified",
      company: { legalName: "Zero to One Bartłomiej Roszkowski" },
      sources: [
        { providerKind: "mf_vat_whitelist", status: "found" },
        { providerKind: "gus_ceidg", status: "found" },
      ],
    });
  });

  it("does not call later providers when MF returns a complete company legal name", async () => {
    const mf = provider("mf_vat_whitelist", {
      status: "found",
      legalName: '"Example Company" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    });
    const ceidg = provider("gus_ceidg", {
      status: "found",
      legalName: "Ignored Enrichment Sp. z o.o.",
    });
    const port = createCompanyIdentityLookupPort({ PL: [mf, ceidg] });

    await expect(port.lookupCompanyIdentity(request)).resolves.toMatchObject({
      status: "found",
      company: { legalName: '"Example Company" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ' },
      sources: [{ providerKind: "mf_vat_whitelist", status: "found" }],
    });
    expect(ceidg.lookup).not.toHaveBeenCalled();
  });
});

function provider(
  providerKind: string,
  {
    status,
    legalName = "Example Company Sp. z o.o.",
    regon = "123456789",
    address = { line1: "Example Street 11", postalCode: "32-091", city: "ExampleCity", country: "PL" as const },
  }: {
    status: "found" | "not_found";
    legalName?: string;
    regon?: string;
    address?: { line1: string; postalCode: string; city: string; country: "PL" };
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
