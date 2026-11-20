import { createFulfillmentLowStockEvidenceHandler as createPlatformLowStockEvidenceHandler } from "@openlup/platform/fulfillment";
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
  return createPlatformLowStockEvidenceHandler<
    VercelRequest,
    VercelResponse,
    ReturnType<typeof adminLowStockEvidenceRequestSchema.parse>,
    ReturnType<typeof adminLowStockEvidenceResponseSchema.parse>
  >({
    evidencePort,
    authorizeAdmin,
    requestSchema: adminLowStockEvidenceRequestSchema,
    responseSchema: adminLowStockEvidenceResponseSchema,
    respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed },
  });
}
