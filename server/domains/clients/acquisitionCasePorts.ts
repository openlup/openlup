import type { AcquisitionCaseProjection, AcquisitionCaseResult, AcquisitionCasePort as PortableAcquisitionCasePort } from "@openlup/platform/marketing/contracts";
import type { AcquisitionCaseSubmitRequest, AcquisitionCaseTransitionRequest } from "../../../src/domains/clients/acquisitionCaseContracts.js";

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
} from "@openlup/platform/marketing/contracts";
