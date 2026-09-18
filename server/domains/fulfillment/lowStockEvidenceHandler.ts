import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminLowStockEvidenceRequestSchema,
  adminLowStockEvidenceResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentLowStockEvidencePort } from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentLowStockEvidenceHandlerDeps {
  evidencePort: FulfillmentLowStockEvidencePort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

// Admin shortage-UX read endpoint (W7b) over omnipack_low_stock_evidence. Read-only:
// it lists the open/resolved low-stock evidence rows the stock-sync worker (W7a)
// records. Stock remains EVIDENCE/warn — nothing here blocks sales.
export function createFulfillmentLowStockEvidenceHandler({
  evidencePort,
  authorizeAdmin,
}: FulfillmentLowStockEvidenceHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
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

    const request = adminLowStockEvidenceRequestSchema.safeParse({
      statusFilter: scalarQuery(req.query.statusFilter),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid low-stock evidence request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await evidencePort.getLowStockEvidence(request.data);
      const response = adminLowStockEvidenceResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Low-stock evidence returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Low-stock evidence read failed");
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
