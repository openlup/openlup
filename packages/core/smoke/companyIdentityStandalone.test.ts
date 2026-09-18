import { describe, expect, it } from "vitest";
import {
  COMPANY_IDENTITY_CONTRACT_VERSION,
  companyIdentityLookupRequestSchema,
  companyIdentityLookupResponseSchema,
  isCompleteCompanyIdentity,
  type CompanyIdentityLookupPort,
} from "@openlup/core/company-identity";

describe("company identity standalone", () => {
  it("exports a neutral lookup contract and structural port", async () => {
    const request = companyIdentityLookupRequestSchema.parse({
      country: "zz",
      identifierKind: "registry_id",
      identifierValue: " EXAMPLE-42 ",
      purpose: "checkout_invoice",
      manualCompany: {
        legalName: "Example Company",
        registeredAddress: null,
      },
    });

    expect(request).toMatchObject({
      country: "ZZ",
      identifierKind: "registry_id",
      identifierValue: "EXAMPLE-42",
      manualCompany: {
        country: "ZZ",
        identifierKind: "registry_id",
        identifierValue: "EXAMPLE-42",
        registryStatus: "manual",
      },
    });

    const port: CompanyIdentityLookupPort = {
      async lookupCompanyIdentity(request) {
        return companyIdentityLookupResponseSchema.parse({
          contractVersion: COMPANY_IDENTITY_CONTRACT_VERSION,
          status: "found",
          verificationLevel: "registry_verified",
          company: {
            country: request.country,
            identifierKind: request.identifierKind,
            identifierValue: request.identifierValue,
            legalName: "Example Company",
            registeredAddress: {
              line1: "1 Example Street",
              postalCode: "10000",
              city: "Example City",
              country: request.country,
            },
            registryStatus: "active",
          },
          sources: [{
            providerKind: "registry_example",
            status: "found",
            observedAt: "2026-01-01T00:00:00.000Z",
            evidenceHash: "sha256:example",
          }],
        });
      },
    };

    const response = await port.lookupCompanyIdentity(request);
    expect(response.status).toBe("found");
    expect(isCompleteCompanyIdentity(response.company)).toBe(true);
  });
});
