import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminShipmentsOverviewRequestSchema,
  adminShipmentsOverviewResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentShipmentsOverviewPort } from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentShipmentsOverviewHandlerDeps {
  overviewPort: FulfillmentShipmentsOverviewPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createFulfillmentShipmentsOverviewHandler({
  overviewPort,
  authorizeAdmin,
}: FulfillmentShipmentsOverviewHandlerDeps) {
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

    const request = adminShipmentsOverviewRequestSchema.safeParse({
      shippedFilter: scalarQuery(req.query.shippedFilter),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid shipments overview request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await overviewPort.getShipmentsOverview(request.data);
      const response = adminShipmentsOverviewResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Shipments overview returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Shipments overview read failed");
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
