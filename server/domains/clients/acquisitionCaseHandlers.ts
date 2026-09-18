import {
  ACQUISITION_CASE_CONTRACT_VERSION,
  ACQUISITION_CASE_SOURCE,
  type AcquisitionCaseListRequest,
  type AcquisitionCaseSubmitRequest,
  type AcquisitionCaseTransitionRequest,
} from "../../../src/domains/clients/acquisitionCaseContracts.js";
import type { AcquisitionCasePort } from "./acquisitionCasePorts.js";

const SCOPE = "public_tester_application" as const;

export interface AcquisitionCaseHandlerOptions {
  now?: () => string;
}

export function createAcquisitionCaseHandlers(
  port: AcquisitionCasePort,
  options: AcquisitionCaseHandlerOptions = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    submit(request: AcquisitionCaseSubmitRequest, context: {
      idempotencyKey: string;
      requesterKey: string;
    }) {
      return port.submit({
        scope: SCOPE,
        sourceKind: ACQUISITION_CASE_SOURCE,
        idempotencyKey: context.idempotencyKey,
        requesterKey: `${SCOPE}:${context.requesterKey}`,
        acceptedAt: now(),
        sourcePath: "/tester-application",
        request,
      });
    },
    list(actorRef: string, request: AcquisitionCaseListRequest) {
      return port.list({
        actorRef,
        scope: SCOPE,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        limit: request.limit,
      });
    },
    get(actorRef: string, caseRef: string) {
      return port.get({ actorRef, scope: SCOPE, caseRef });
    },
    transition(actorRef: string, idempotencyKey: string, request: AcquisitionCaseTransitionRequest) {
      return port.transition({ actorRef, scope: SCOPE, idempotencyKey, request });
    },
    async activeCount() {
      const result = await port.activeCount(SCOPE);
      return result.ok === false ? result : {
        ok: true as const,
        value: { activeTesterCount: result.value },
      };
    },
    contractVersion: ACQUISITION_CASE_CONTRACT_VERSION,
  };
}

export type AcquisitionCaseHandlers = ReturnType<typeof createAcquisitionCaseHandlers>;
