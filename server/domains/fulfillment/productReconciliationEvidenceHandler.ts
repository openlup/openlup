import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminProductReconciliationRequestSchema,
  adminProductReconciliationResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentProductReconciliationEvidencePort } from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentProductReconciliationEvidenceHandlerDeps {
  evidencePort: FulfillmentProductReconciliationEvidencePort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

// Admin read endpoint (Wave F) over omnipack_product_reconciliation_evidence — mirrors the W7b
// low-stock-evidence read. Read-only: it lists the open/resolved reconciliation rows the product
// pull records for OmniPack-side products/EANs it could not safely ingest. Resolves nothing.
export function createFulfillmentProductReconciliationEvidenceHandler({
  evidencePort,
  authorizeAdmin,
}: FulfillmentProductReconciliationEvidenceHandlerDeps) {
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

    const request = adminProductReconciliationRequestSchema.safeParse({
      statusFilter: scalarQuery(req.query.statusFilter),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid product reconciliation request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await evidencePort.getProductReconciliationEvidence(request.data);
      const response = adminProductReconciliationResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Product reconciliation returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Product reconciliation read failed");
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
