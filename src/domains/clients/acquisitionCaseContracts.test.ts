import { describe, expect, it } from "vitest";

import {
  ACQUISITION_CASE_CONTRACT_VERSION,
  ACQUISITION_CASE_VIEW,
  acquisitionCaseListRequestSchema,
  acquisitionCaseProjectionSchema,
  acquisitionCaseSubmitRequestSchema,
  acquisitionCaseTransitionRequestSchema,
  acquisitionIdempotencyKeySchema,
} from "./acquisitionCaseContracts.js";

const addressReference = {
  source: "local_registry",
  reference: "address:krakow-1",
  revision: "2026-08-16",
  provenance: "operator_fixture",
};

describe("acquisition case contracts", () => {
  it("accepts only the narrow tester application request", () => {
    const request = {
      contact: { email: "person@example.test" },
      consent: {
        accepted: true,
        consentVersion: "tester-consent.v1",
        policyVersion: "privacy.v1",
        locale: "en",
      },
      addressReference,
    };
    expect(acquisitionCaseSubmitRequestSchema.parse(request)).toEqual(request);
    expect(acquisitionCaseSubmitRequestSchema.safeParse({ ...request, petName: "Private" }).success).toBe(false);
    expect(acquisitionCaseSubmitRequestSchema.safeParse({
      ...request,
      contact: { ...request.contact, firstName: "Private" },
    }).success).toBe(false);
    expect(acquisitionCaseSubmitRequestSchema.safeParse({
      ...request,
      consent: { ...request.consent, accepted: false },
    }).success).toBe(false);
  });

  it("pins bounded list, idempotency and transition inputs", () => {
    expect(acquisitionCaseListRequestSchema.parse({ view: ACQUISITION_CASE_VIEW })).toEqual({
      view: ACQUISITION_CASE_VIEW,
      limit: 25,
    });
    expect(acquisitionCaseListRequestSchema.safeParse({ view: ACQUISITION_CASE_VIEW, limit: 101 }).success).toBe(false);
    expect(acquisitionIdempotencyKeySchema.safeParse("submit:key-123").success).toBe(true);
    expect(acquisitionIdempotencyKeySchema.safeParse("bad key").success).toBe(false);

    const transition = {
      view: ACQUISITION_CASE_VIEW,
      caseRef: "case:tester-123",
      expectedVersion: 1,
      transition: "reject",
      reason: "consent evidence invalid",
    };
    expect(acquisitionCaseTransitionRequestSchema.safeParse(transition).success).toBe(true);
    expect(acquisitionCaseTransitionRequestSchema.safeParse({ ...transition, reason: undefined }).success).toBe(false);
    expect(acquisitionCaseTransitionRequestSchema.safeParse({
      ...transition,
      transition: "approve",
    }).success).toBe(false);
  });

  it("redacts the address only for a withdrawn neutral projection", () => {
    const projection = {
      contractVersion: ACQUISITION_CASE_CONTRACT_VERSION,
      caseRef: "case:tester-123",
      contactRef: "contact:tester-123",
      sourceKind: "tester_application",
      consent: {
        consentVersion: "tester-consent.v1",
        policyVersion: "privacy.v1",
        recordedAt: "2026-08-16T12:00:00.000Z",
        locale: "en",
        sourcePath: "/tester-application",
      },
      addressReference,
      state: "submitted",
      version: 1,
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
    };
    expect(acquisitionCaseProjectionSchema.safeParse(projection).success).toBe(true);
    expect(acquisitionCaseProjectionSchema.safeParse({ ...projection, addressReference: null }).success).toBe(false);
    expect(acquisitionCaseProjectionSchema.safeParse({
      ...projection,
      state: "withdrawn",
      addressReference: null,
    }).success).toBe(true);
  });
});
