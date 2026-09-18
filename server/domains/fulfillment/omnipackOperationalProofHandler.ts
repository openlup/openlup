import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { adminOmnipackOperationalProofResponseSchema } from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentOmnipackOperationalProofPort } from "../../../src/domains/fulfillment/ports.js";

export interface OmnipackOperationalProofHandlerDeps {
  proofPort: FulfillmentOmnipackOperationalProofPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createOmnipackOperationalProofHandler({
  proofPort,
  authorizeAdmin,
}: OmnipackOperationalProofHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);

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

    try {
      const result = await proofPort.getOmnipackOperationalProof();
      const response = adminOmnipackOperationalProofResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "OmniPack operational proof returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OmniPack operational proof read failed");
    }
  };
}
