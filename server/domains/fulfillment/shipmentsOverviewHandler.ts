import { createFulfillmentShipmentsOverviewHandler as createPlatformShipmentsOverviewHandler } from "@openlup/platform/fulfillment";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { adminShipmentsOverviewResponseSchema } from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentShipmentsOverviewPort } from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentShipmentsOverviewHandlerDeps {
  overviewPort: FulfillmentShipmentsOverviewPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createFulfillmentShipmentsOverviewHandler({
  overviewPort,
  authorizeAdmin,
}: FulfillmentShipmentsOverviewHandlerDeps) {
  const handler = createPlatformShipmentsOverviewHandler<VercelResponse>({
    overviewPort,
    authorizeAdmin: (req) => authorizeAdmin(req as VercelRequest),
    responseSchema: adminShipmentsOverviewResponseSchema,
    respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed },
  });
  return (req: VercelRequest, res: VercelResponse): Promise<void> => handler(req, res);
}
