import { describe, expect, it } from "vitest";
import * as schemas from "../../src/marketing/partnerAcquisitionSchemas.js";

// Frozen R1 expectations: R2 delegates to these contracts without changing them.
const request = { company: "  North  Studio  ", country: "gb", firstName: "  Ada  ", lastName: "  Vale  ",
  email: "Ada@studio.example", phone: " +44 (20) 1234 5678 ", notes: "  sample  note  " };
const projection = { contractVersion: "partner_acquisition_v1", caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222", organization: { name: "North Studio", country: "GB" },
  contact: { firstName: "Ada", lastName: "Vale", email: "ada@studio.example", phone: null }, notes: null,
  status: "new", version: 1, createdAt: "2026-01-12T10:00:00.000Z", updatedAt: "2026-01-12T10:00:00.000Z" };

describe("partner acquisition frozen public contracts", () => {
  it("retains trimming, bounded fields, defaults and the public sentinel", () => {
    expect(schemas.partnersB2BInquirySubmitRequestSchema.parse(request)).toEqual({ ...request,
      company: "North  Studio", firstName: "Ada", lastName: "Vale", phone: "+44 (20) 1234 5678", notes: "sample  note" });
    expect(schemas.partnersB2BInquirySubmitRequestSchema.parse({ ...request, openlupInternalCheck: "silent" }).openlupInternalCheck).toBe("silent");
    expect(schemas.partnersB2BInquirySubmitRequestSchema.safeParse({ ...request, privateInternalCheck: "silent" }).success).toBe(false);
    expect(schemas.partnerAcquisitionListRequestSchema.parse({ view: "partner_acquisition_v1" }))
      .toEqual({ view: "partner_acquisition_v1", limit: 25 });
    expect(schemas.partnerAcquisitionListRequestSchema.parse({ view: "partner_acquisition_v1", limit: "100" }).limit).toBe(100);
    for (const limit of [0, 101, 1.5]) expect(schemas.partnerAcquisitionListRequestSchema.safeParse({ view: "partner_acquisition_v1", limit }).success).toBe(false);
    for (const key of ["a1234567", "A._:-123"]) expect(schemas.partnerAcquisitionIdempotencyKeySchema.parse(key)).toBe(key);
    for (const key of ["short", "-1234567", "a".repeat(201)]) expect(schemas.partnerAcquisitionIdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
  it("keeps producer admission broader than direct SQL for existing country/phone refusals", () => {
    expect(schemas.partnersB2BInquirySubmitRequestSchema.safeParse({ ...request, country: "OTHER", phone: "0123456789" }).success).toBe(true);
    for (const [field, value] of [["company", "a".repeat(101)], ["firstName", "a"], ["lastName", "a".repeat(51)],
      ["email", "invalid"], ["phone", "1".repeat(51)], ["notes", "x".repeat(1001)]] as const)
      expect(schemas.partnersB2BInquirySubmitRequestSchema.safeParse({ ...request, [field]: value }).success).toBe(false);
  });
  it("freezes the exact projection and transition vocabulary without customer or permission fields", () => {
    expect(schemas.partnerAcquisitionCaseSchema.parse(projection)).toEqual(projection);
    for (const extra of [{ customerId: "customer" }, { consent: true }, { organization: { ...projection.organization, website: "https://example.invalid" } }])
      expect(schemas.partnerAcquisitionCaseSchema.safeParse({ ...projection, ...extra }).success).toBe(false);
    for (const status of ["contacted", "qualified", "disqualified", "closed_won", "closed_lost"])
      expect(schemas.partnerAcquisitionTransitionRequestSchema.parse({ id: projection.caseRef, status, expectedVersion: "2" })).toEqual({ id: projection.caseRef, status, expectedVersion: 2 });
    for (const status of ["new", "active", "converted"])
      expect(schemas.partnerAcquisitionTransitionRequestSchema.safeParse({ id: projection.caseRef, status, expectedVersion: 1 }).success).toBe(false);
    expect(schemas.partnerAcquisitionTransitionResponseSchema.parse({ updated: true, acquisitionCase: projection, replayed: true }).replayed).toBe(true);
    expect(schemas.partnersB2BInquirySubmitResponseSchema.parse({ success: true, skipped: "internal-check" })).toEqual({ success: true, skipped: "internal-check" });
  });
});
