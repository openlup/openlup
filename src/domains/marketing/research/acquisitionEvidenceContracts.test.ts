import { describe, expect, it } from "vitest";
import {
  acquisitionNewsletterConsentEventSchema,
  acquisitionSurveySubmitSchema,
} from "./acquisitionEvidenceContracts.js";

describe("acquisition evidence contracts", () => {
  it("accepts bounded providerless survey and newsletter V1 inputs", () => {
    expect(acquisitionSurveySubmitSchema.safeParse({
      view: "acquisition_survey_v1",
      caseReference: "acquisition-case:11111111-1111-4111-8111-111111111111",
      surveyType: "consumer",
      responseData: { cadence: "weekly" },
    }).success).toBe(true);
    expect(acquisitionNewsletterConsentEventSchema.safeParse({
      contractVersion: "acquisition_newsletter_consent_v1",
      caseReference: "acquisition-case:11111111-1111-4111-8111-111111111111",
      contactReference: "acquisition-contact:22222222-2222-4222-8222-222222222222",
      eventReference: "consent-event-0001",
      eventType: "subscribe",
      purpose: "marketing_newsletter",
      explicitOptInEvidence: true,
      occurredAt: "2026-08-17T13:00:00.000Z",
    }).success).toBe(true);
  });

  it("refuses raw/provider newsletter fields", () => {
    expect(acquisitionNewsletterConsentEventSchema.safeParse({
      contractVersion: "acquisition_newsletter_consent_v1",
      caseReference: "acquisition-case:11111111-1111-4111-8111-111111111111",
      contactReference: "acquisition-contact:22222222-2222-4222-8222-222222222222",
      eventReference: "consent-event-0001",
      eventType: "subscribe",
      purpose: "marketing_newsletter",
      explicitOptInEvidence: true,
      occurredAt: "2026-08-17T13:00:00.000Z",
      email: "raw@example.test",
      providerKind: "vendor",
      payload: { secret: true },
    }).success).toBe(false);
  });
});
