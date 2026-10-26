import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../src/http/index.js";
import { createBffResponder } from "../../../src/bff/index.js";
const respond = createBffResponder();
const { sendBffError } = respond;
import {
  acquisitionNewsletterConsentResponseSchema,
  acquisitionSurveyListResponseSchema,
  acquisitionSurveySubmitResponseSchema,
} from "../../../src/marketing/acquisitionEvidenceSchemas.js";

const { binding, resolveBinding, authorize } = ({
  binding: {
    submitSurvey: vi.fn(), listSurveys: vi.fn(), applyNewsletterConsent: vi.fn(), close: vi.fn(),
  },
  resolveBinding: vi.fn(),
  authorize: vi.fn(),
});

import {
  createAcquisitionNewsletterConsentDirectHandler,
  createAcquisitionSurveyListDirectHandler,
  createAcquisitionSurveySubmitDirectHandler,
} from "../../../src/marketing/server/acquisitionEvidenceDirect.js";

const dependencies = { respond, authorize, resolveBinding };
const handleAcquisitionSurveySubmit = createAcquisitionSurveySubmitDirectHandler(dependencies);
const handleAcquisitionSurveyList = createAcquisitionSurveyListDirectHandler(dependencies);
const handleAcquisitionNewsletterConsent = createAcquisitionNewsletterConsentDirectHandler(dependencies);

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
    submitRes);
    expect(submitRes.status).toHaveBeenCalledWith(200);
    binding.listSurveys.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", rows: [EVIDENCE], totalCount: 1 } });
    const listRes = response();
    await handleAcquisitionSurveyList({ method: "GET", headers: {}, query: { view: "acquisition_survey_v1", limit: "10" } } as unknown as HttpRequest, listRes);
    expect(authorize).toHaveBeenCalled(); expect(listRes.status).toHaveBeenCalledWith(200);
  });
  it("applies providerless consent and maps conflicts", async () => {
    binding.applyNewsletterConsent.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_newsletter_consent_v1",
      eventReference: "consent-event-0001", outcome: "applied", consentState: "granted",
      auditReference: "acquisition-consent:44444444-4444-4444-8444-444444444444", replayed: false } });
    const res = response();
    await handleAcquisitionNewsletterConsent({ contractVersion: "acquisition_newsletter_consent_v1", caseReference: CASE,
      contactReference: CONTACT, eventReference: "consent-event-0001", eventType: "subscribe",
      purpose: "marketing_newsletter", explicitOptInEvidence: true, occurredAt: "2026-08-17T13:00:00.000Z" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    binding.submitSurvey.mockResolvedValue({ ok: false, error: { kind: "conflict" } });
    const conflict = response();
    await handleAcquisitionSurveySubmit({ method: "POST", headers: { "idempotency-key": "survey-key-0001" },
      body: { view: "acquisition_survey_v1", caseReference: CASE, surveyType: "consumer", responseData: { a: 2 } } } as unknown as HttpRequest,
    conflict);
    expect(conflict.status).toHaveBeenCalledWith(409);
  });
});


const operations = [
  { name: "survey submit", port: "submitSurvey", responseSchema: acquisitionSurveySubmitResponseSchema,
    run: (res: HttpResponse) => handleAcquisitionSurveySubmit(surveyRequest(), res) },
  { name: "survey list", port: "listSurveys", responseSchema: acquisitionSurveyListResponseSchema,
    run: (res: HttpResponse) => handleAcquisitionSurveyList(listRequest(), res) },
  { name: "internal consent command", port: "applyNewsletterConsent", responseSchema: acquisitionNewsletterConsentResponseSchema,
    run: (res: HttpResponse) => handleAcquisitionNewsletterConsent(consentEvent(), res) },
] as const;

describe("direct acquisition evidence request and response boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveBinding.mockResolvedValue(binding);
    authorize.mockResolvedValue("9f576216-011a-4f67-8404-3f28f7f624d5");
  });

  it.each([
    ["survey submit", handleAcquisitionSurveySubmit, "GET", "POST"],
    ["survey list", handleAcquisitionSurveyList, "POST", "GET"],
  ] as const)("refuses the wrong method for %s before authorization or binding", async (_name, handler, method, allowed) => {
    const res = response();
    await handler({ method } as HttpRequest, res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", allowed);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: "METHOD_NOT_ALLOWED" }),
    }));
    expect(authorize).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it.each([undefined, ""])("refuses a missing or empty idempotency key (%s) before binding", async (key) => {
    const res = response();
    await handleAcquisitionSurveySubmit(surveyRequest({ headers: { "idempotency-key": key } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: "BAD_REQUEST" }),
    }));
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it.each([
    ["wrong version", { ...surveyBody(), view: "unknown" }],
    ["invalid case reference", { ...surveyBody(), caseReference: "not-a-case" }],
    ["invalid survey type", { ...surveyBody(), surveyType: "unknown" }],
    ["non-object answers", { ...surveyBody(), responseData: [] }],
  ])("rejects survey schema input: %s", async (_name, body) => {
    const res = response();
    await handleAcquisitionSurveySubmit(surveyRequest({ body }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: "BAD_REQUEST", details: expect.any(Object) }),
    }));
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it("keeps admin denial ahead of query parsing and acquisition binding", async () => {
    authorize.mockImplementationOnce(async (_req, res: HttpResponse) => {
      sendBffError(res, "FORBIDDEN", "Operator denied");
      return null;
    });
    const req = listRequest({ query: { view: "unknown", limit: "not-a-number" } });
    const res = response();
    await handleAcquisitionSurveyList(req, res);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(res.status).toHaveBeenCalledExactlyOnceWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: "FORBIDDEN", message: "Operator denied" }),
    }));
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it.each(["0", "101", "1.5", "not-a-number"])("rejects list limit %s after authorization and before binding", async (limit) => {
    const req = listRequest({ query: { view: "acquisition_survey_v1", limit } });
    const res = response();
    await handleAcquisitionSurveyList(req, res);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it("passes parsed survey input and the first idempotency header to the port", async () => {
    binding.submitSurvey.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", evidence: EVIDENCE, replayed: true } });
    const res = response();
    await handleAcquisitionSurveySubmit(surveyRequest({
      headers: { "idempotency-key": ["survey-key-0001", "ignored-key-0002"] },
      body: { ...surveyBody(), ignoredField: "not persisted" },
    }), res);
    expect(binding.submitSurvey).toHaveBeenCalledExactlyOnceWith({ ...surveyBody(), idempotencyKey: "survey-key-0001" });
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: {
      contractVersion: "acquisition_survey_v1", evidence: EVIDENCE, replayed: true,
    } });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("passes trusted actor and coerced first query values to the read port", async () => {
    binding.listSurveys.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", rows: [EVIDENCE], totalCount: 1 } });
    const res = response();
    await handleAcquisitionSurveyList(listRequest({ query: {
      view: ["acquisition_survey_v1", "unknown"], surveyType: ["consumer", "producer"], limit: ["10", "101"],
      actorReference: "untrusted-caller-actor",
    } }), res);
    expect(binding.listSurveys).toHaveBeenCalledExactlyOnceWith({
      view: "acquisition_survey_v1", surveyType: "consumer", limit: 10,
      actorReference: "9f576216-011a-4f67-8404-3f28f7f624d5",
    });
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(resolveBinding.mock.invocationCallOrder[0]);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: {
      contractVersion: "acquisition_survey_v1", rows: [EVIDENCE], totalCount: 1,
    } });
  });

  it("uses the default list limit after authorization", async () => {
    binding.listSurveys.mockResolvedValue({ ok: true, value: { contractVersion: "acquisition_survey_v1", rows: [], totalCount: 0 } });
    await handleAcquisitionSurveyList(listRequest(), response());
    expect(binding.listSurveys).toHaveBeenCalledExactlyOnceWith({
      view: "acquisition_survey_v1", limit: 50, actorReference: "9f576216-011a-4f67-8404-3f28f7f624d5",
    });
  });

  it.each([
    ["unknown field", { ...consentEvent(), rawAnswers: { a: 1 } }],
    ["uncorrelated contact", { ...consentEvent(), contactReference: "not-a-contact" }],
    ["invalid event key", { ...consentEvent(), eventReference: "short" }],
    ["unknown purpose", { ...consentEvent(), purpose: "unknown" }],
    ["invalid timestamp", { ...consentEvent(), occurredAt: "yesterday" }],
  ])("rejects the internal consent command schema: %s", async (_name, event) => {
    const res = response();
    await handleAcquisitionNewsletterConsent(event, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(resolveBinding).not.toHaveBeenCalled();
    expectNoEvidenceCalls();
  });

  it("defaults absent explicit opt-in evidence to false for the internal consent port", async () => {
    binding.applyNewsletterConsent.mockResolvedValue({ ok: false, error: { kind: "not_found" } });
    await handleAcquisitionNewsletterConsent(consentEvent(), response());
    expect(binding.applyNewsletterConsent).toHaveBeenCalledExactlyOnceWith({ ...consentEvent(), explicitOptInEvidence: false });
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["missing", "throws"])("fails closed when acquisition binding %s", async (mode) => {
    if (mode === "missing") resolveBinding.mockResolvedValueOnce(null);
    else resolveBinding.mockRejectedValueOnce(new Error("private binding details"));
    const res = response();
    await handleAcquisitionSurveySubmit(surveyRequest(), res);
    expectUnavailable(res);
    expectNoEvidenceCalls();
  });

  describe.each(operations)("$name port boundary", ({ run, port, responseSchema }) => {
    it.each([
      ["invalid", 400, "BAD_REQUEST", "Invalid acquisition evidence request"],
      ["not_found", 404, "NOT_FOUND", "Acquisition evidence subject not found"],
      ["conflict", 409, "CONFLICT", "Acquisition evidence request conflicts with prior state"],
      ["unavailable", 503, "UPSTREAM_UNAVAILABLE", "Acquisition evidence service unavailable"],
    ] as const)("maps %s without leaking port details", async (kind, status, code, message) => {
      binding[port].mockResolvedValue({ ok: false, error: { kind, details: "private port details" } });
      const res = response();
      await run(res);
      expect(binding[port]).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledExactlyOnceWith(status);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: { code, message } });
    });

    it("maps a thrown port error to the bounded unavailable envelope", async () => {
      binding[port].mockRejectedValue(new Error("private operation details"));
      const res = response();
      await run(res);
      expect(binding[port]).toHaveBeenCalledTimes(1);
      expectUnavailable(res);
    });

    it("forwards a successful port value without response-schema validation", async () => {
      const value = { contractVersion: "unexpected", opaquePortField: "forwarded" };
      expect(responseSchema.safeParse(value).success).toBe(false);
      binding[port].mockResolvedValue({ ok: true, value });
      const res = response();
      await run(res);
      expect(res.status).toHaveBeenCalledExactlyOnceWith(200);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({ ok: true, data: value });
    });
  });
});

function surveyBody() {
  return { view: "acquisition_survey_v1", caseReference: CASE, surveyType: "consumer", responseData: { a: 1 } };
}
function surveyRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "POST", headers: { "idempotency-key": "survey-key-0001" }, query: {}, body: surveyBody(), ...overrides } as HttpRequest;
}
function listRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", headers: {}, query: { view: "acquisition_survey_v1" }, ...overrides } as HttpRequest;
}
function consentEvent() {
  return { contractVersion: "acquisition_newsletter_consent_v1", caseReference: CASE, contactReference: CONTACT,
    eventReference: "consent-event-0001", eventType: "subscribe", purpose: "marketing_newsletter", occurredAt: "2026-08-17T13:00:00.000Z" };
}
function expectNoEvidenceCalls() {
  expect(binding.submitSurvey).not.toHaveBeenCalled();
  expect(binding.listSurveys).not.toHaveBeenCalled();
  expect(binding.applyNewsletterConsent).not.toHaveBeenCalled();
}
function expectUnavailable(res: HttpResponse) {
  expect(res.status).toHaveBeenCalledExactlyOnceWith(503);
  expect(res.json).toHaveBeenCalledExactlyOnceWith({
    ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Acquisition evidence service unavailable" },
  });
}

function response(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res); vi.mocked(res.json).mockReturnValue(res); return res;
}
