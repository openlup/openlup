import { describe, expect, it } from "vitest";
import { billingProfileRow } from "./customerBillingProfileModels.js";

describe("customer billing profile models", () => {
  it("persists company identity verification metadata from NIP lookup", () => {
    expect(
      billingProfileRow("client-1", {
        idempotencyKey: "billing-profile-1",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
        phone: null,
        companyName: "Example Company Sp. z o.o.",
        taxId: "1234563218",
        companyVerificationLevel: "registry_verified",
        companyIdentitySource: "gus_ceidg",
        companyIdentityEvidenceHash: "sha256:test",
        isDefault: true,
      }),
    ).toMatchObject({
      client_id: "client-1",
      company_name: "Example Company Sp. z o.o.",
      tax_id: "1234563218",
      company_verification_level: "registry_verified",
      company_identity_source: "gus_ceidg",
      company_identity_evidence_hash: "sha256:test",
      is_default: true,
    });
  });
});
