import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  cleanupDhlShipmentRequestSchema,
  cleanupDhlShipmentResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentDhlCleanupPort } from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentDhlCleanupHandlerDeps {
  cleanupPort: FulfillmentDhlCleanupPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createFulfillmentDhlCleanupHandler({
  cleanupPort,
  authorizeAdmin,
}: FulfillmentDhlCleanupHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    let authorized = false;
    try {
      authorized = await authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }

    if (!authorized) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = cleanupDhlShipmentRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid DHL cleanup request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await cleanupPort.cleanupDhlShipment(request.data);
      const response = cleanupDhlShipmentResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "DHL cleanup returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "DHL cleanup failed");
    }
  };
}
