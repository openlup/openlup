import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresAcquisitionEvidencePort } from "./acquisitionEvidenceRoutines.js";

const AT = "2026-08-17T13:00:00.000Z";
const evidence = {
  evidenceReference: "acquisition-survey:33333333-3333-4333-8333-333333333333",
  caseReference: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactReference: "acquisition-contact:22222222-2222-4222-8222-222222222222",
  surveyType: "consumer", responseDigest: "a".repeat(64), answerCount: 1, recordedAt: AT,
};

function stubPool(responses: unknown[]) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const end = vi.fn(async () => {});
  const pool = { connect: async () => ({
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return text.startsWith("SELECT public.") ? { rows: [{ response: responses.shift() }] } : { rows: [] };
    }, release: vi.fn(),
  }), end } as unknown as Pool;
  return { pool, queries, end };
}

describe("postgres acquisition evidence adapter", () => {
  it("maps survey submit/list and providerless consent through the capability role", async () => {
    const stub = stubPool([
      { outcome: "recorded", replayed: false, evidence },
      { rows: [evidence], totalCount: "1" },
      { outcome: "applied", consentState: "granted", auditReference: "acquisition-consent:44444444-4444-4444-8444-444444444444", eventReference: "consent-event-0001", replayed: false },
    ]);
    const port = createPostgresAcquisitionEvidencePort({ connectionString: "postgres://local" }, { poolFactory: () => stub.pool });
    await expect(port.submitSurvey({ view: "acquisition_survey_v1", caseReference: evidence.caseReference,
      surveyType: "consumer", responseData: { a: 1 }, idempotencyKey: "survey-key-0001" }))
      .resolves.toMatchObject({ ok: true, value: { evidence } });
    await expect(port.listSurveys({ view: "acquisition_survey_v1", actorReference: "9f576216-011a-4f67-8404-3f28f7f624d5", limit: 10 }))
      .resolves.toMatchObject({ ok: true, value: { rows: [evidence], totalCount: 1 } });
    await expect(port.applyNewsletterConsent({ contractVersion: "acquisition_newsletter_consent_v1",
      caseReference: evidence.caseReference, contactReference: evidence.contactReference,
      eventReference: "consent-event-0001", eventType: "subscribe", purpose: "marketing_newsletter",
      explicitOptInEvidence: true, occurredAt: AT }))
      .resolves.toMatchObject({ ok: true, value: { outcome: "applied", consentState: "granted" } });
    expect(stub.queries.filter(({ text }) => text === "SET LOCAL ROLE platform_acquisition_runtime")).toHaveLength(3);
    expect(stub.queries.filter(({ text }) => text === "COMMIT")).toHaveLength(3);
    await port.close(); expect(stub.end).toHaveBeenCalledOnce();
  });

  it("maps durable business refusals and rejects missing database configuration", async () => {
    const stub = stubPool([{ outcome: "idempotency_conflict" }, { outcome: "not_found" }]);
    const port = createPostgresAcquisitionEvidencePort({ connectionString: "postgres://local" }, { poolFactory: () => stub.pool });
    await expect(port.submitSurvey({ view: "acquisition_survey_v1", caseReference: evidence.caseReference,
      surveyType: "consumer", responseData: { a: 1 }, idempotencyKey: "survey-key-0001" }))
      .resolves.toEqual({ ok: false, error: { kind: "conflict" } });
    await expect(port.applyNewsletterConsent({ contractVersion: "acquisition_newsletter_consent_v1",
      caseReference: evidence.caseReference, contactReference: evidence.contactReference,
      eventReference: "consent-event-0001", eventType: "update", purpose: "marketing_newsletter",
      explicitOptInEvidence: false, occurredAt: AT }))
      .resolves.toEqual({ ok: false, error: { kind: "not_found" } });
    expect(() => createPostgresAcquisitionEvidencePort({ connectionString: " " }))
      .toThrow("acquisition_evidence_database_url_required");
  });
});
