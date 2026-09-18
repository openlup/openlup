import { describe, expect, it } from "vitest";
import { readOrdererProfiles, type CustomerAddressReadStore } from "./customerSelfServiceAddressModels.js";

describe("customer self-service address models", () => {
  it("reads billing profile company identity metadata", async () => {
    const profiles = await readOrdererProfiles(
      storeReturning([
        {
          id: "11111111-1111-4111-8111-111111111111",
          label: "Firma",
          full_name: "Ada Buyer",
          email: "buyer@example.com",
          phone: null,
          company_name: "Example Company Sp. z o.o.",
          tax_id: "1234563218",
          company_verification_level: "registry_verified",
          company_identity_source: "gus_ceidg",
          company_identity_evidence_hash: "sha256:test",
          is_default: true,
          created_at: "2026-06-08T10:00:00+00:00",
          updated_at: "2026-06-08T10:00:00+00:00",
        },
      ]),
      "client-1",
    );

    expect(profiles[0]).toMatchObject({
      companyVerificationLevel: "registry_verified",
      companyIdentitySource: "gus_ceidg",
      companyIdentityEvidenceHash: "sha256:test",
    });
  });
});

function storeReturning(rows: Record<string, unknown>[]): CustomerAddressReadStore {
  return { readOrdererProfiles: async () => rows } as unknown as CustomerAddressReadStore;
}
