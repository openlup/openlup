import { expect, it } from "vitest";
import * as cases from "../clients/acquisitionCaseContracts.js";
import { CLIENTS_CONTRACT_VERSION } from "../clients/searchContracts.js";
import * as evidence from "./research/acquisitionEvidenceContracts.js";
import * as prelaunch from "./prelaunch/contracts.js";

// Captured against the untouched task base before moving the schema bodies.
// Preserve parsed data and every issue field, including issue ordering.
const id = "11111111-1111-4111-8111-111111111111";
const instant = "0001-01-01T00:00:00Z";
const address = { source: "source_a", reference: "address:one", revision: "revision:1", provenance: "source_a" };
const projection = {
  contractVersion: cases.ACQUISITION_CASE_CONTRACT_VERSION, caseRef: "case:one", contactRef: "contact:one",
  sourceKind: cases.ACQUISITION_CASE_SOURCE,
  consent: { consentVersion: "v1", policyVersion: "v1", recordedAt: instant, locale: "en", sourcePath: "/tester-application" },
  addressReference: address, state: "submitted", version: 1, createdAt: instant, updatedAt: instant,
};
const submit = { contact: { email: " reader@example.test " }, consent: {
  accepted: true, consentVersion: " v1 ", policyVersion: " v1 ", locale: "pl",
}, addressReference: address };
const survey = { view: evidence.ACQUISITION_SURVEY_VERSION, caseReference: `acquisition-case:${id}`,
  surveyType: "producer", responseData: { answer: "example" } };
const surveyEvidence = { evidenceReference: `acquisition-survey:${id}`, caseReference: survey.caseReference,
  contactReference: `acquisition-contact:${id}`, surveyType: "consumer", responseDigest: "a".repeat(64),
  answerCount: 1, recordedAt: instant };
const consentEvent = { contractVersion: evidence.ACQUISITION_NEWSLETTER_VERSION, caseReference: survey.caseReference,
  contactReference: surveyEvidence.contactReference, eventReference: "event:one", eventType: "subscribe",
  purpose: "marketing_newsletter", occurredAt: instant };
const transition = { view: cases.ACQUISITION_CASE_VIEW, caseRef: "case:one", expectedVersion: 1, transition: "approve" };
const valid: Array<[string, { safeParse(value: unknown): unknown }, unknown]> = [
  ["address", cases.acquisitionAddressReferenceSchema, address],
  ["state", cases.acquisitionCaseStateSchema, "active"],
  ["projection", cases.acquisitionCaseProjectionSchema, projection],
  ["case list defaults", cases.acquisitionCaseListRequestSchema, { view: cases.ACQUISITION_CASE_VIEW }],
  ["case list response", cases.acquisitionCaseListResponseSchema, { contractVersion: cases.ACQUISITION_CASE_CONTRACT_VERSION, cases: [projection], nextCursor: null }],
  ["active count", cases.acquisitionCaseActiveCountResponseSchema, { activeTesterCount: 0 }],
  ["idempotency", cases.acquisitionIdempotencyKeySchema, " command:one "],
  ["retired submit", cases.acquisitionCaseSubmitRequestSchema, submit],
  ["retired submit response", cases.acquisitionCaseSubmitResponseSchema, { contractVersion: CLIENTS_CONTRACT_VERSION, created: true, testerEmail: "reader@example.test", welcomeEmailRequested: false }],
  ["retired transition", cases.acquisitionCaseTransitionRequestSchema, transition],
  ["retired transition response", cases.acquisitionCaseTransitionResponseSchema, { contractVersion: cases.ACQUISITION_CASE_CONTRACT_VERSION, acquisitionCase: projection, replayed: false }],
  ["survey submit", evidence.acquisitionSurveySubmitSchema, survey],
  ["survey evidence", evidence.acquisitionSurveyEvidenceSchema, surveyEvidence],
  ["survey submit response", evidence.acquisitionSurveySubmitResponseSchema, { contractVersion: evidence.ACQUISITION_SURVEY_VERSION, evidence: surveyEvidence, replayed: true }],
  ["survey query defaults", evidence.acquisitionSurveyListQuerySchema, { view: evidence.ACQUISITION_SURVEY_VERSION }],
  ["survey list response", evidence.acquisitionSurveyListResponseSchema, { contractVersion: evidence.ACQUISITION_SURVEY_VERSION, rows: [surveyEvidence], totalCount: 1 }],
  ["consent event default", evidence.acquisitionNewsletterConsentEventSchema, consentEvent],
  ["consent response", evidence.acquisitionNewsletterConsentResponseSchema, { contractVersion: evidence.ACQUISITION_NEWSLETTER_VERSION, eventReference: "event:one", outcome: "applied", consentState: "granted", auditReference: `acquisition-consent:${id}`, replayed: false }],
];
const checks = [...valid];
for (const [name, schema, input] of valid) {
  checks.push([`${name} invalid`, schema, {}]);
  if (input && typeof input === "object") checks.push([`${name} unknown key`, schema, { ...input, extra: true }]);
}
function variants(name: string, schema: { safeParse(value: unknown): unknown }, base: object, mutations: Record<string, unknown[]>) {
  for (const [key, values] of Object.entries(mutations)) values.forEach((value, index) => {
    checks.push([`${name} ${key} ${index}`, schema, { ...base, [key]: value }]);
  });
}
variants("address", cases.acquisitionAddressReferenceSchema, address, {
  source: ["", "A", "a".repeat(48), "a".repeat(49), " source_a "],
  reference: ["a".repeat(7), "a".repeat(8), "a".repeat(160), "a".repeat(161), "bad/ref"],
  revision: ["", "a".repeat(64), "a".repeat(65), "bad/ref"],
  provenance: ["", "A", "a".repeat(64), "a".repeat(65)],
});
variants("projection", cases.acquisitionCaseProjectionSchema, projection, {
  state: ["withdrawn", "unknown"], addressReference: [null], version: [0, 1.5], createdAt: ["invalid"],
  consent: [{ ...projection.consent, locale: "xx" }, { ...projection.consent, extra: true },
    { ...projection.consent, consentVersion: "", policyVersion: "a".repeat(65), recordedAt: "invalid", sourcePath: "invalid" }],
});
checks.push(["withdrawn without address", cases.acquisitionCaseProjectionSchema, { ...projection, state: "withdrawn", addressReference: null }]);
variants("case query", cases.acquisitionCaseListRequestSchema, { view: cases.ACQUISITION_CASE_VIEW }, {
  cursor: ["short", "bad/ref", "a".repeat(161)], limit: [0, 1, 100, 101, 1.5, "2"],
});
checks.push(["case list bound", cases.acquisitionCaseListResponseSchema, { contractVersion: cases.ACQUISITION_CASE_CONTRACT_VERSION, cases: Array(101).fill(projection), nextCursor: null }]);
checks.push(["count negative", cases.acquisitionCaseActiveCountResponseSchema, { activeTesterCount: -1 }]);
for (const input of ["a".repeat(7), "a".repeat(8), "a".repeat(200), "a".repeat(201), "bad/key"]) checks.push([`key ${input.length} ${input.slice(0, 7)}`, cases.acquisitionIdempotencyKeySchema, input]);
variants("retired submit", cases.acquisitionCaseSubmitRequestSchema, submit, {
  contact: [{ email: "invalid" }, { email: "a".repeat(250) + "@example.test" }, { ...submit.contact, extra: true }],
  consent: [{ ...submit.consent, accepted: false }, { ...submit.consent, locale: "xx" }, { ...submit.consent, consentVersion: "", policyVersion: "a".repeat(65), extra: true }],
});
variants("retired transition", cases.acquisitionCaseTransitionRequestSchema, transition, {
  transition: ["reject", "unknown"], reason: [" why ", "", "a".repeat(240), "a".repeat(241)], expectedVersion: [0, 1.5],
});
for (const reason of [" why ", "", "a".repeat(241)]) checks.push([`reject reason ${reason.length}`, cases.acquisitionCaseTransitionRequestSchema, { ...transition, transition: "reject", reason }]);
variants("survey submit", evidence.acquisitionSurveySubmitSchema, survey, { caseReference: ["invalid"], surveyType: ["unknown"], responseData: [null, {}, { answer: undefined }] });
variants("survey evidence", evidence.acquisitionSurveyEvidenceSchema, surveyEvidence, {
  evidenceReference: ["invalid"], contactReference: ["invalid"], responseDigest: ["A".repeat(64), "a".repeat(63), "a".repeat(65)],
  answerCount: [0, 100, 101, 1.5], recordedAt: ["invalid"],
});
variants("survey query", evidence.acquisitionSurveyListQuerySchema, { view: evidence.ACQUISITION_SURVEY_VERSION }, { limit: ["2", 0, 100, 101, "invalid", 1.5], surveyType: ["consumer", "unknown"] });
variants("consent event", evidence.acquisitionNewsletterConsentEventSchema, consentEvent, {
  eventReference: ["a".repeat(7), "a".repeat(8), "a".repeat(200), "a".repeat(201), "bad/key"],
  eventType: ["unsubscribe", "suppress", "complaint", "update", "unknown"], purpose: ["marketing_launch_offer", "unknown"],
  explicitOptInEvidence: [true, "true"], occurredAt: ["invalid"],
});
it.each(checks)("preserves base parse transcript: %s", (_name, schema, input) => {
  const result = schema.safeParse(input) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  expect(result.success ? { success: true, data: result.data } : { success: false, issues: result.error?.issues }).toMatchSnapshot();
});

it("keeps reference re-exports identical to the public package objects", async () => {
  const marketing = await import("@openlup/platform/marketing");
  const retired = new Set(["acquisitionCaseSubmitRequestSchema", "acquisitionCaseSubmitResponseSchema", "acquisitionCaseTransitionRequestSchema", "acquisitionCaseTransitionResponseSchema"]);
  for (const [name, value] of Object.entries(cases)) {
    if (!retired.has(name)) expect(marketing[name as keyof typeof marketing]).toBe(value);
  }
  for (const [name, value] of Object.entries(evidence)) expect(marketing[name as keyof typeof marketing]).toBe(value);
  for (const [name, value] of Object.entries(prelaunch)) {
    if (name.startsWith("PRELAUNCH_ACQUISITION_") || name.startsWith("prelaunchAcquisition")) {
      expect(marketing[name as keyof typeof marketing]).toBe(value);
    }
  }
});

// Addendum goldens are captured from git-show base content before extraction.
const prelaunchLead = {
  sourceRef: `acquisition-case:${id}`, contactRef: `acquisition-contact:${id}`,
  sourceKind: projection.sourceKind, consent: projection.consent, addressReference: address,
  state: "submitted", version: 1, createdAt: instant, updatedAt: instant,
};
const prelaunchList = { contractVersion: prelaunch.PRELAUNCH_ACQUISITION_CONTRACT_VERSION, leads: [prelaunchLead], nextCursor: null };
const prelaunchDetail = { contractVersion: prelaunch.PRELAUNCH_ACQUISITION_CONTRACT_VERSION, lead: prelaunchLead };
const prelaunchValid: Array<[string, { safeParse(value: unknown): unknown }, object]> = [
  ["list defaults", prelaunch.prelaunchAcquisitionListRequestSchema, { view: prelaunch.PRELAUNCH_ACQUISITION_VIEW }],
  ["detail request", prelaunch.prelaunchAcquisitionDetailRequestSchema, { sourceRef: prelaunchLead.sourceRef }],
  ["lead", prelaunch.prelaunchAcquisitionLeadSchema, prelaunchLead],
  ["list response", prelaunch.prelaunchAcquisitionListResponseSchema, prelaunchList],
  ["detail response", prelaunch.prelaunchAcquisitionDetailResponseSchema, prelaunchDetail],
];
const prelaunchChecks = [...prelaunchValid];
for (const [name, schema, input] of prelaunchValid) {
  prelaunchChecks.push([`${name} missing`, schema, {}], [`${name} unknown`, schema, { ...input, extra: true }]);
}
function prelaunchVariants(name: string, schema: { safeParse(value: unknown): unknown }, input: object, mutations: Record<string, unknown[]>) {
  for (const [key, values] of Object.entries(mutations)) values.forEach((value, index) => {
    prelaunchChecks.push([`${name} ${key} ${index}`, schema, { ...input, [key]: value }]);
  });
}
prelaunchVariants("list", prelaunch.prelaunchAcquisitionListRequestSchema, { view: prelaunch.PRELAUNCH_ACQUISITION_VIEW }, {
  view: ["invalid"], cursor: ["a".repeat(7), "a".repeat(8), "a".repeat(160), "a".repeat(161), "bad/ref", " cursor:one "],
  limit: ["2", 0, 1, 100, 101, 1.5, "invalid", null],
});
prelaunchVariants("detail", prelaunch.prelaunchAcquisitionDetailRequestSchema, { sourceRef: prelaunchLead.sourceRef }, {
  sourceRef: ["case:one", "acquisition-case:" + "-".repeat(36), "acquisition-case:" + "A".repeat(36), "acquisition-case:" + "a".repeat(35), "acquisition-case:" + "a".repeat(37), " " + prelaunchLead.sourceRef],
});
prelaunchVariants("lead", prelaunch.prelaunchAcquisitionLeadSchema, prelaunchLead, {
  sourceRef: ["invalid"], contactRef: ["invalid", "acquisition-contact:" + "-".repeat(36)],
  sourceKind: ["invalid"], state: ["approved", "active", "rejected", "withdrawn", "invalid"],
  addressReference: [null], version: [0, 1.5], createdAt: ["invalid", "0001-01-01T00:00:00+01:00"], updatedAt: ["invalid"],
  consent: [{ ...projection.consent, extra: true }, { ...projection.consent, locale: "pl" }, { ...projection.consent, locale: "xx" },
    { ...projection.consent, consentVersion: "", policyVersion: "a".repeat(65), recordedAt: "invalid", sourcePath: "invalid" },
    { ...projection.consent, consentVersion: "a".repeat(64), policyVersion: "a".repeat(64) }],
});
prelaunchChecks.push(["withdrawn without address", prelaunch.prelaunchAcquisitionLeadSchema, { ...prelaunchLead, state: "withdrawn", addressReference: null }]);
for (const [key, values] of Object.entries({
  source: ["", "A", "a".repeat(48), "a".repeat(49), " source_a "],
  reference: ["a".repeat(7), "a".repeat(8), "a".repeat(160), "a".repeat(161), "bad/ref", " address:one "],
  revision: ["", "a".repeat(64), "a".repeat(65), "bad/ref", " v1 "],
  provenance: ["", "A", "a".repeat(64), "a".repeat(65), " source_a "],
  extra: [true],
})) values.forEach((value, index) => prelaunchChecks.push([
  `address ${key} ${index}`, prelaunch.prelaunchAcquisitionLeadSchema, { ...prelaunchLead, addressReference: { ...address, [key]: value } },
]));
prelaunchVariants("list response", prelaunch.prelaunchAcquisitionListResponseSchema, prelaunchList, {
  contractVersion: ["invalid"], leads: [[], Array(101).fill(prelaunchLead)], nextCursor: ["short", " cursor:one ", "bad/ref", "a".repeat(161)],
});
prelaunchVariants("detail response", prelaunch.prelaunchAcquisitionDetailResponseSchema, prelaunchDetail, {
  contractVersion: ["invalid"], lead: [null, {}],
});
it.each(prelaunchChecks)("preserves base prelaunch transcript: %s", (_name, schema, input) => {
  const result = schema.safeParse(input) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  expect(result.success ? { success: true, data: result.data } : { success: false, issues: result.error?.issues }).toMatchSnapshot();
});
