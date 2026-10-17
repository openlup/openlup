// BFF health route.
//
// GET answers the deployment's health payload, validated by the deployment's strict contract, with
// the payload's contract version in `meta`; any other method answers 405 with `Allow: GET`. A
// payload that fails its own contract answers INTERNAL rather than an unchecked body.

import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "./envelope.js";

export interface HealthContract<T extends { contractVersion: string }> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface HealthHandlerOptions<T extends { contractVersion: string }> {
  responder: BffResponder;
  /** The deployment's strict health contract. */
  contract: HealthContract<T>;
  /** Builds this request's health payload: service identity, release provenance and the rest. */
  read: () => unknown;
}

export function createHealthHandler<T extends { contractVersion: string }>(
  options: HealthHandlerOptions<T>,
): (req: HttpRequest, res: HttpResponse) => void {
  return function health(req, res) {
    if (req.method !== "GET") {
      options.responder.sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    const result = options.contract.safeParse(options.read());
    if (!result.success) {
      options.responder.sendBffError(res, "INTERNAL", "Health contract is invalid");
      return;
    }
    options.responder.sendBffSuccess(res, result.data, { contractVersion: result.data.contractVersion });
  };
}
