import type {
  AcquisitionNewsletterConsentEvent,
  AcquisitionNewsletterConsentResponse,
  AcquisitionSurveyListQuery,
  AcquisitionSurveyListResponse,
  AcquisitionSurveySubmit,
  AcquisitionSurveySubmitResponse,
} from "../../../../src/domains/marketing/research/acquisitionEvidenceContracts.js";

export type AcquisitionEvidenceFailure = "invalid" | "not_found" | "conflict" | "unavailable";
export type AcquisitionEvidenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: AcquisitionEvidenceFailure } };

export interface AcquisitionEvidencePort {
  submitSurvey(input: AcquisitionSurveySubmit & { idempotencyKey: string }): Promise<AcquisitionEvidenceResult<AcquisitionSurveySubmitResponse>>;
  listSurveys(input: AcquisitionSurveyListQuery & { actorReference: string }): Promise<AcquisitionEvidenceResult<AcquisitionSurveyListResponse>>;
  applyNewsletterConsent(input: AcquisitionNewsletterConsentEvent): Promise<AcquisitionEvidenceResult<AcquisitionNewsletterConsentResponse>>;
  close(): Promise<void>;
}
