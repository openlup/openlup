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

// Admin catalog-vs-3PL reconciliation read endpoint (W7d) over
// omnipack_product_reconciliation_evidence. Read-only: lists SKU-level
// comparison rows between local product catalog and OmniPack product catalog.
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
