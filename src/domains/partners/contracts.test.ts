import { describe, expect, it } from "vitest";
import {
  PARTNER_ACQUISITION_VIEW,
  partnerAcquisitionCaseSchema,
  partnerAcquisitionListRequestSchema,
  partnerAcquisitionTransitionRequestSchema,
  partnersB2BInquiryListRequestSchema,
  partnersB2BInquiryListResponseSchema,
  partnersB2BInquiryStatusUpdateRequestSchema,
  partnersB2BInquiryStatusUpdateResponseSchema,
} from "./contracts";

describe("partners contracts", () => {
  it("validates admin B2B inquiry list requests and responses", () => {
    expect(
      partnersB2BInquiryListRequestSchema.parse({
        status: " contacted ",
        search: " acme ",
        page: "2",
        pageSize: "50",
      }),
    ).toEqual({
      status: "contacted",
      search: "acme",
      page: 2,
      pageSize: 50,
    });

    expect(
      partnersB2BInquiryListResponseSchema.parse({
        inquiries: [b2bInquiry()],
        totalCount: 1,
        newCount: 1,
      }).inquiries[0].company,
    ).toBe("Acme Foods");
  });

  it("validates status update contracts", () => {
    expect(
      partnersB2BInquiryStatusUpdateRequestSchema.parse({
        id: "inq-1",
        status: "qualified",
      }),
    ).toEqual({ id: "inq-1", status: "qualified" });

    expect(
      partnersB2BInquiryStatusUpdateResponseSchema.parse({ updated: true }),
    ).toEqual({ updated: true });

    expect(
      partnersB2BInquiryStatusUpdateRequestSchema.safeParse({
        id: "inq-1",
        status: "invented",
      }).success,
    ).toBe(false);
  });

  it("pins the provider-neutral partner acquisition projection", () => {
    const acquisitionCase = partnerAcquisitionCase();
    expect(partnerAcquisitionCaseSchema.parse(acquisitionCase)).toEqual(acquisitionCase);
    expect(partnerAcquisitionCaseSchema.safeParse({
      ...acquisitionCase,
      pipedriveDealId: 42,
    }).success).toBe(false);
    expect(partnerAcquisitionListRequestSchema.parse({
      view: PARTNER_ACQUISITION_VIEW,
    })).toEqual({ view: PARTNER_ACQUISITION_VIEW, limit: 25 });
    expect(partnerAcquisitionTransitionRequestSchema.safeParse({
      id: acquisitionCase.caseRef,
      expectedVersion: 1,
      status: "contacted",
    }).success).toBe(true);
    expect(partnerAcquisitionTransitionRequestSchema.safeParse({
      id: acquisitionCase.caseRef,
      expectedVersion: 1,
      status: "new",
    }).success).toBe(false);
  });
});

function partnerAcquisitionCase() {
  return {
    contractVersion: "partner_acquisition_v1",
    caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
    contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
    organization: { name: "Acme Foods", country: "DE" },
    contact: {
      firstName: "Anna",
      lastName: "Nowak",
      email: "anna@acme.example",
      phone: "+48123456789",
    },
    notes: "Interested",
    status: "new",
    version: 1,
    createdAt: "2026-08-17T10:00:00.000+00:00",
    updatedAt: "2026-08-17T10:00:00.000+00:00",
  };
}

function b2bInquiry() {
  return {
    id: "inq-1",
    created_at: "2026-05-01T10:00:00.000Z",
    company: "Acme Foods",
    website: "https://acme.example",
    country: "DE",
    company_type: "Brand",
    revenue_bucket: "1M-5M",
    first_name: "Anna",
    last_name: "Nowak",
    business_email: "anna@acme.example",
    phone: "+48123",
    interests: ["private label"],
    notes: "Interested",
    ip_hash: "hash",
    pipedrive_deal_id: 123,
    status: "new",
  };
}
