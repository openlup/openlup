import { describe, expect, it } from "vitest";
import {
  adminPrelaunchLeadsRequestSchema,
  adminPrelaunchLeadsResponseSchema,
  MARKETING_PRELAUNCH_CONTRACT_VERSION,
  PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
  prelaunchAcquisitionDetailResponseSchema,
  prelaunchAcquisitionListRequestSchema,
  prelaunchAcquisitionListResponseSchema,
} from "./contracts";

describe("marketing prelaunch contracts", () => {
  it("defaults admin lead list filters and validates source refs", () => {
    const request = adminPrelaunchLeadsRequestSchema.parse({});

    expect(request).toEqual({ page: 0, pageSize: 50, source: "all", stage: "all" });
    expect(adminPrelaunchLeadsRequestSchema.parse({ source: "tester", stage: "feedback_completed" }).stage)
      .toBe("feedback_completed");
  });

  it("validates read-only prelaunch lead responses", () => {
    expect(adminPrelaunchLeadsResponseSchema.safeParse({
      contractVersion: MARKETING_PRELAUNCH_CONTRACT_VERSION,
      totalCount: 1,
      page: 0,
      pageSize: 50,
      leads: [{
        contractVersion: MARKETING_PRELAUNCH_CONTRACT_VERSION,
        primarySourceRef: "testers:tester-1",
        sourceRefs: ["testers:tester-1", "waitlist:waitlist-1"],
        sources: ["tester", "waitlist"],
        stage: "feedback_completed",
        displayName: "Jan Kowalski",
        email: "jan@example.com",
        phone: "123456789",
        createdAt: "2026-07-05T10:00:00.000Z",
        testerStatus: "completed",
        petSnapshots: [{
          sourceRef: "testers:tester-1",
          petKind: "dog",
          name: "Figa",
          breed: "mix",
          age: "3",
          weightKg: 12,
        }],
        feedbackSummary: {
          testerId: "tester-1",
          feedbackId: "feedback-1",
          status: "completed",
          submittedAt: "2026-07-06T10:00:00.000Z",
          sectionBSubmittedAt: null,
          sectionCSubmittedAt: null,
          overallRating: 5,
          npsRating: 10,
          photoCount: 1,
        },
        consentSummary: {
          marketingLaunchOfferConsent: true,
          testerProgramConsent: true,
          newsletterConsent: false,
          emailSequencePaused: false,
        },
        attributionSummary: {
          waitlistSource: "launch-popup",
          waitlistLocale: "pl",
        },
        conversionCandidate: {
          status: "ready",
          reason: "has_email",
          existingClientId: null,
          existingLifecycleStage: null,
          prefill: {
            email: "jan@example.com",
            firstName: "Jan",
            lastName: "Kowalski",
            phone: "123456789",
            pets: [{
              sourceRef: "testers:tester-1",
              petKind: "dog",
              name: "Figa",
              breed: "mix",
              age: "3",
              weightKg: 12,
            }],
          },
        },
      }],
    }).success).toBe(true);
  });

  it("keeps the portable acquisition projection distinct from the managed rich join", () => {
    const lead = {
      sourceRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
      contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
      sourceKind: "tester_application" as const,
      consent: {
        consentVersion: "tester-consent.v1",
        policyVersion: "privacy.v1",
        recordedAt: "2026-08-17T10:00:00.000Z",
        locale: "en" as const,
        sourcePath: "/tester-application" as const,
      },
      addressReference: {
        source: "fixture",
        reference: "address-ref-0001",
        revision: "v1",
        provenance: "operator_fixture",
      },
      state: "submitted" as const,
      version: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    };
    expect(prelaunchAcquisitionListRequestSchema.parse({ view: "prelaunch_acquisition_v1" }))
      .toEqual({ view: "prelaunch_acquisition_v1", limit: 25 });
    expect(prelaunchAcquisitionListResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      leads: [lead],
      nextCursor: null,
    }).success).toBe(true);
    expect(prelaunchAcquisitionDetailResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      lead,
    }).success).toBe(true);
    expect(prelaunchAcquisitionListResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      leads: [{ ...lead, email: "private@example.test" }],
      nextCursor: null,
    }).success).toBe(false);
  });
});
