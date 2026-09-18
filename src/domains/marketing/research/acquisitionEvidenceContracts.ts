import { z } from "../../../lib/validation/zod.js";

export const ACQUISITION_SURVEY_VERSION = "acquisition_survey_v1" as const;
export const ACQUISITION_NEWSLETTER_VERSION = "acquisition_newsletter_consent_v1" as const;

const caseReference = z.string().regex(/^acquisition-case:[0-9a-f-]{36}$/);
const contactReference = z.string().regex(/^acquisition-contact:[0-9a-f-]{36}$/);
const commandKey = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const acquisitionSurveySubmitSchema = z.object({
  view: z.literal(ACQUISITION_SURVEY_VERSION),
  caseReference,
  surveyType: z.enum(["producer", "consumer"]),
  responseData: z.record(z.string(), z.unknown()),
});

export const acquisitionSurveyEvidenceSchema = z.object({
  evidenceReference: z.string().regex(/^acquisition-survey:[0-9a-f-]{36}$/),
  caseReference,
  contactReference,
  surveyType: z.enum(["producer", "consumer"]),
  responseDigest: digest,
  answerCount: z.number().int().min(1).max(100),
  recordedAt: z.string().datetime({ offset: true }),
});

export const acquisitionSurveySubmitResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_SURVEY_VERSION),
  evidence: acquisitionSurveyEvidenceSchema,
  replayed: z.boolean(),
});

export const acquisitionSurveyListQuerySchema = z.object({
  view: z.literal(ACQUISITION_SURVEY_VERSION),
  surveyType: z.enum(["producer", "consumer"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const acquisitionSurveyListResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_SURVEY_VERSION),
  rows: z.array(acquisitionSurveyEvidenceSchema),
  totalCount: z.number().int().min(0),
});

export const acquisitionNewsletterConsentEventSchema = z.object({
  contractVersion: z.literal(ACQUISITION_NEWSLETTER_VERSION),
  caseReference,
  contactReference,
  eventReference: commandKey,
  eventType: z.enum(["subscribe", "unsubscribe", "suppress", "complaint", "update"]),
  purpose: z.enum(["marketing_launch_offer", "marketing_newsletter"]),
  explicitOptInEvidence: z.boolean().default(false),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const acquisitionNewsletterConsentResponseSchema = z.object({
  contractVersion: z.literal(ACQUISITION_NEWSLETTER_VERSION),
  eventReference: commandKey,
  outcome: z.enum(["applied", "ignored", "stale"]),
  consentState: z.enum(["granted", "suppressed"]).nullable(),
  auditReference: z.string().regex(/^acquisition-consent:[0-9a-f-]{36}$/),
  replayed: z.boolean(),
});

export type AcquisitionSurveySubmit = z.infer<typeof acquisitionSurveySubmitSchema>;
export type AcquisitionSurveyEvidence = z.infer<typeof acquisitionSurveyEvidenceSchema>;
export type AcquisitionSurveySubmitResponse = z.infer<typeof acquisitionSurveySubmitResponseSchema>;
export type AcquisitionSurveyListQuery = z.infer<typeof acquisitionSurveyListQuerySchema>;
export type AcquisitionSurveyListResponse = z.infer<typeof acquisitionSurveyListResponseSchema>;
export type AcquisitionNewsletterConsentEvent = z.infer<typeof acquisitionNewsletterConsentEventSchema>;
export type AcquisitionNewsletterConsentResponse = z.infer<typeof acquisitionNewsletterConsentResponseSchema>;
