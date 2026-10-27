import type {
  AcquisitionCaseListResponse, AcquisitionCaseProjection, AcquisitionNewsletterConsentEvent,
  AcquisitionNewsletterConsentResponse, AcquisitionSurveyListQuery, AcquisitionSurveyListResponse,
  AcquisitionSurveySubmit, AcquisitionSurveySubmitResponse,
} from "./acquisition.js";

export type AcquisitionCaseFailureKind =
  | "conflict"
  | "invalid"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export type AcquisitionCaseResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; error: { kind: AcquisitionCaseFailureKind } };

export interface AcquisitionCaseListQuery {
  actorRef: string;
  scope: "public_tester_application";
  cursor?: string;
  limit: number;
}

export interface AcquisitionCaseGetQuery {
  actorRef: string;
  scope: "public_tester_application";
  caseRef: string;
}

export interface AcquisitionCasePort {
  list(query: AcquisitionCaseListQuery): Promise<AcquisitionCaseResult<AcquisitionCaseListResponse>>;
  get(query: AcquisitionCaseGetQuery): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
  activeCount(scope: "public_tester_application"): Promise<AcquisitionCaseResult<number>>;
  close(): Promise<void>;
}

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
