import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";

const { binding, resolveBinding, authorize } = vi.hoisted(() => ({
  binding: {
    submitSurvey: vi.fn(), listSurveys: vi.fn(), applyNewsletterConsent: vi.fn(), close: vi.fn(),
  },
  resolveBinding: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("../../../runtime/marketing/acquisitionEvidenceBinding.js", () => ({ resolveAcquisitionEvidenceBinding: resolveBinding }));
vi.mock("../../clients/acquisitionCaseDirect.js", () => ({ authorizeAcquisitionCaseAdmin: authorize }));

import {
  handleAcquisitionNewsletterConsent,
  handleAcquisitionSurveyList,
  handleAcquisitionSurveySubmit,
} from "./acquisitionEvidenceDirect.js";

const CASE = "acquisition-case:11111111-1111-4111-8111-111111111111";
const CONTACT = "acquisition-contact:22222222-2222-4222-8222-222222222222";
const EVIDENCE = { evidenceReference: "acquisition-survey:33333333-3333-4333-8333-333333333333",
  caseReference: CASE, contactReference: CONTACT, surveyType: "consumer", responseDigest: "a".repeat(64),
  answerCount: 1, recordedAt: "2026-08-17T13:00:00.000Z" };

describe("direct acquisition evidence BFF handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks(); resolveBinding.mockResolvedValue(binding); authorize.mockResolvedValue("9f576216-011a-4f67-8404-3f28f7f624d5");
  });
  it("submits and lists strict survey evidence", async () => {
    binding.submitSurvey.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", evidence: EVIDENCE, replayed: false } });
    const submitRes = response();
    await handleAcquisitionSurveySubmit({ method: "POST", headers: { "idempotency-key": "survey-key-0001" },
      body: { view: "acquisition_survey_v1", caseReference: CASE, surveyType: "consumer", responseData: { a: 1 } } } as unknown as HttpRequest,
    submitRes, env());
    expect(submitRes.status).toHaveBeenCalledWith(200);
    binding.listSurveys.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", rows: [EVIDENCE], totalCount: 1 } });
    const listRes = response();
    await handleAcquisitionSurveyList({ method: "GET", headers: {}, query: { view: "acquisition_survey_v1", limit: "10" } } as unknown as HttpRequest, listRes, env());
    expect(authorize).toHaveBeenCalled(); expect(listRes.status).toHaveBeenCalledWith(200);
  });
  it("applies providerless consent and maps conflicts", async () => {
    binding.applyNewsletterConsent.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_newsletter_consent_v1",
      eventReference: "consent-event-0001", outcome: "applied", consentState: "granted",
      auditReference: "acquisition-consent:44444444-4444-4444-8444-444444444444", replayed: false } });
    const res = response();
    await handleAcquisitionNewsletterConsent({ contractVersion: "acquisition_newsletter_consent_v1", caseReference: CASE,
      contactReference: CONTACT, eventReference: "consent-event-0001", eventType: "subscribe",
      purpose: "marketing_newsletter", explicitOptInEvidence: true, occurredAt: "2026-08-17T13:00:00.000Z" }, res, env());
    expect(res.status).toHaveBeenCalledWith(200);
    binding.submitSurvey.mockResolvedValue({ ok: false, error: { kind: "conflict" } });
    const conflict = response();
    await handleAcquisitionSurveySubmit({ method: "POST", headers: { "idempotency-key": "survey-key-0001" },
      body: { view: "acquisition_survey_v1", caseReference: CASE, surveyType: "consumer", responseData: { a: 2 } } } as unknown as HttpRequest,
    conflict, env());
    expect(conflict.status).toHaveBeenCalledWith(409);
  });
});

function env() { return { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local" }; }
function response(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res); vi.mocked(res.json).mockReturnValue(res); return res;
}
