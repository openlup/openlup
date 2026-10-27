import { expect, it } from "vitest";
import * as marketing from "../../src/marketing/index.js";
import * as core from "@openlup/core/marketing/research";

it("re-exports every research runtime schema with its core object identity", () => {
  for (const [name, value] of Object.entries(core)) expect(marketing[name as keyof typeof marketing]).toBe(value);
  for (const name of ["acquisitionCaseSubmitRequestSchema", "acquisitionCaseSubmitResponseSchema", "acquisitionCaseTransitionRequestSchema", "acquisitionCaseTransitionResponseSchema", "CLIENTS_CONTRACT_VERSION", "MARKETING_PRELAUNCH_CONTRACT_VERSION", "prelaunchLeadSourceSchema", "prelaunchLeadSchema", "adminPrelaunchLeadsResponseSchema"]) {
    expect(marketing).not.toHaveProperty(name);
  }
});

it("preserves acquisition parsing, normalization, defaults and refusal", () => {
  const address = { source: " source_a ", reference: " address:one ", revision: " v1 ", provenance: " source_a " };
  expect(marketing.acquisitionAddressReferenceSchema.parse(address)).toEqual({ source: "source_a", reference: "address:one", revision: "v1", provenance: "source_a" });
  expect(marketing.acquisitionAddressReferenceSchema.safeParse({ ...address, extra: true }).success).toBe(false);
  expect(marketing.acquisitionOpaqueReferenceSchema.parse(" address:one ")).toBe("address:one");
  expect(marketing.acquisitionOpaqueReferenceSchema.safeParse("bad/ref").success).toBe(false);
  expect(marketing.acquisitionIdempotencyKeySchema.parse(" command:one ")).toBe("command:one");
  expect(marketing.acquisitionCaseStateSchema.parse("withdrawn")).toBe("withdrawn");
  expect(marketing.acquisitionCaseListRequestSchema.parse({ view: marketing.ACQUISITION_CASE_VIEW })).toEqual({ view: marketing.ACQUISITION_CASE_VIEW, limit: 25 });
  expect(marketing.acquisitionCaseListRequestSchema.safeParse({ view: marketing.ACQUISITION_CASE_VIEW, limit: "2" }).success).toBe(false);
  expect(marketing.acquisitionSurveyListQuerySchema.parse({ view: marketing.ACQUISITION_SURVEY_VERSION })).toEqual({ view: marketing.ACQUISITION_SURVEY_VERSION, limit: 50 });
  expect(marketing.acquisitionSurveyListQuerySchema.parse({ view: marketing.ACQUISITION_SURVEY_VERSION, limit: "2" }).limit).toBe(2);
  expect(marketing.acquisitionSurveyListQuerySchema.safeParse({ view: marketing.ACQUISITION_SURVEY_VERSION, limit: 101 }).success).toBe(false);
});

it("keeps survey unknown-key stripping distinct from strict consent events", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const caseReference = `acquisition-case:${id}`;
  const submit = { view: marketing.ACQUISITION_SURVEY_VERSION, caseReference, surveyType: "producer", responseData: { answer: 1 } };
  expect(marketing.acquisitionSurveySubmitSchema.parse({ ...submit, extra: true })).toEqual(submit);
  const event = { contractVersion: marketing.ACQUISITION_NEWSLETTER_VERSION, caseReference,
    contactReference: `acquisition-contact:${id}`, eventReference: "event:one", eventType: "subscribe",
    purpose: "marketing_newsletter", occurredAt: "0001-01-01T00:00:00Z" };
  expect(marketing.acquisitionNewsletterConsentEventSchema.parse(event)).toEqual({ ...event, explicitOptInEvidence: false });
  expect(marketing.acquisitionNewsletterConsentEventSchema.safeParse({ ...event, extra: true }).success).toBe(false);
  expect(marketing.acquisitionSurveyEvidenceSchema.safeParse({}).success).toBe(false);
  expect(marketing.acquisitionSurveySubmitResponseSchema.safeParse({}).success).toBe(false);
  expect(marketing.acquisitionSurveyListResponseSchema.safeParse({}).success).toBe(false);
  expect(marketing.acquisitionNewsletterConsentResponseSchema.safeParse({}).success).toBe(false);
});

it("preserves portable prelaunch defaults, private reference syntax and address refinement", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const instant = "0001-01-01T00:00:00Z";
  const lead = {
    sourceRef: "acquisition-case:" + id, contactRef: "acquisition-contact:" + id,
    sourceKind: "tester_application", consent: { consentVersion: "v1", policyVersion: "v1", recordedAt: instant, locale: "en", sourcePath: "/tester-application" },
    addressReference: { source: "source_a", reference: " address:one ", revision: " v1 ", provenance: "source_a" },
    state: "submitted", version: 1, createdAt: instant, updatedAt: instant,
  };
  expect(marketing.prelaunchAcquisitionListRequestSchema.parse({ view: marketing.PRELAUNCH_ACQUISITION_VIEW, limit: "2" }))
    .toEqual({ view: marketing.PRELAUNCH_ACQUISITION_VIEW, limit: 2 });
  expect(marketing.prelaunchAcquisitionListRequestSchema.parse({ view: marketing.PRELAUNCH_ACQUISITION_VIEW }).limit).toBe(25);
  expect(marketing.prelaunchAcquisitionDetailRequestSchema.safeParse({ sourceRef: "case:one" }).success).toBe(false);
  expect(marketing.prelaunchAcquisitionDetailRequestSchema.parse({ sourceRef: "acquisition-case:" + "-".repeat(36) }).sourceRef).toBe("acquisition-case:" + "-".repeat(36));
  expect(marketing.prelaunchAcquisitionLeadSchema.parse(lead).addressReference).toEqual({ ...lead.addressReference, reference: "address:one", revision: "v1" });
  const refused = marketing.prelaunchAcquisitionLeadSchema.safeParse({ ...lead, addressReference: null });
  expect(refused.success).toBe(false);
  if (!refused.success) expect(refused.error.issues).toEqual([{ code: "custom", path: ["addressReference"], message: "active case requires address reference" }]);
  const withdrawn = marketing.prelaunchAcquisitionLeadSchema.parse({ ...lead, state: "withdrawn", addressReference: null });
  const response = { contractVersion: marketing.PRELAUNCH_ACQUISITION_CONTRACT_VERSION, leads: [withdrawn], nextCursor: null };
  expect(marketing.prelaunchAcquisitionListResponseSchema.parse(response)).toEqual(response);
  expect(marketing.prelaunchAcquisitionDetailResponseSchema.parse({ contractVersion: response.contractVersion, lead: withdrawn }).lead).toEqual(withdrawn);
  expect(marketing.prelaunchAcquisitionLeadSchema.safeParse({ ...lead, extra: true }).success).toBe(false);
  expect(marketing.prelaunchAcquisitionListResponseSchema.safeParse({ ...response, leads: Array(101).fill(withdrawn) }).success).toBe(false);
});
