import { createProductReconciliationEvidenceHandler as createPlatformProductReconciliationEvidenceHandler } from "@openlup/platform/fulfillment";
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
  return createPlatformProductReconciliationEvidenceHandler<
    VercelRequest,
    VercelResponse,
    ReturnType<typeof adminProductReconciliationRequestSchema.parse>,
    ReturnType<typeof adminProductReconciliationResponseSchema.parse>
  >({
    evidencePort,
    authorizeAdmin,
    requestSchema: adminProductReconciliationRequestSchema,
    responseSchema: adminProductReconciliationResponseSchema,
    respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed },
  });
}
