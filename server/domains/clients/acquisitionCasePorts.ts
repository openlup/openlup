import type {
  AcquisitionCaseListResponse,
  AcquisitionCaseProjection,
  AcquisitionCaseSubmitRequest,
  AcquisitionCaseTransitionRequest,
} from "../../../src/domains/clients/acquisitionCaseContracts.js";

export type AcquisitionCaseFailureKind =
  | "conflict"
  | "invalid"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export type AcquisitionCaseResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; error: { kind: AcquisitionCaseFailureKind } };

export interface AcquisitionCaseSubmitCommand {
  scope: "public_tester_application";
  sourceKind: "tester_application";
  idempotencyKey: string;
  requesterKey: string;
  acceptedAt: string;
  sourcePath: "/tester-application";
  request: AcquisitionCaseSubmitRequest;
}

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

export interface AcquisitionCaseTransitionCommand {
  actorRef: string;
  scope: "public_tester_application";
  idempotencyKey: string;
  request: AcquisitionCaseTransitionRequest;
}

export interface AcquisitionCasePort {
  submit(command: AcquisitionCaseSubmitCommand): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
  list(query: AcquisitionCaseListQuery): Promise<AcquisitionCaseResult<AcquisitionCaseListResponse>>;
  get(query: AcquisitionCaseGetQuery): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
  transition(command: AcquisitionCaseTransitionCommand): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
  activeCount(scope: "public_tester_application"): Promise<AcquisitionCaseResult<number>>;
  close(): Promise<void>;
}
