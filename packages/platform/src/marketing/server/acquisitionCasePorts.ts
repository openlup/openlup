import type { AcquisitionCaseProjection, AcquisitionCaseResult, AcquisitionCasePort as PortableAcquisitionCasePort } from "../contracts/index.js";
import type { AcquisitionAddressReference, AcquisitionCaseProjection as Projection } from "../contracts/index.js";

/** Historical commands retained by the server adapter; public admission routes remain host-owned. */
export interface AcquisitionCaseSubmitRequest {
  contact: { email: string };
  consent: { accepted: true; consentVersion: string; policyVersion: string; locale: Projection["consent"]["locale"] };
  addressReference: AcquisitionAddressReference;
}
export interface AcquisitionCaseTransitionRequest {
  view: "acquisition_case_v1";
  caseRef: string;
  expectedVersion: number;
  transition: "approve" | "activate" | "reject" | "withdraw";
  reason?: string | undefined;
}

export interface AcquisitionCaseSubmitCommand {
  scope: "public_tester_application";
  sourceKind: "tester_application";
  idempotencyKey: string;
  requesterKey: string;
  acceptedAt: string;
  sourcePath: "/tester-application";
  request: AcquisitionCaseSubmitRequest;
}

export interface AcquisitionCaseTransitionCommand {
  actorRef: string;
  scope: "public_tester_application";
  idempotencyKey: string;
  request: AcquisitionCaseTransitionRequest;
}

export interface AcquisitionCasePort extends PortableAcquisitionCasePort {
  submit(command: AcquisitionCaseSubmitCommand): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
  transition(command: AcquisitionCaseTransitionCommand): Promise<AcquisitionCaseResult<AcquisitionCaseProjection>>;
}

export type {
  AcquisitionCaseFailureKind, AcquisitionCaseResult, AcquisitionCaseListQuery, AcquisitionCaseGetQuery,
} from "../contracts/index.js";
