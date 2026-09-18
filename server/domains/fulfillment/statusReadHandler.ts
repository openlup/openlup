import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  shipmentStatusReadRequestSchema,
  shipmentStatusReadResponseSchema,
} from "../../../src/domains/fulfillment/contracts.js";
import {
  FulfillmentNotFoundError,
  type FulfillmentReadPort,
} from "../../../src/domains/fulfillment/ports.js";

export interface FulfillmentStatusReadHandlerDeps {
  readPort: FulfillmentReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createFulfillmentStatusReadHandler({
  readPort,
  authorizeAdmin,
}: FulfillmentStatusReadHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    if (!(await authorizeAdmin(req))) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = shipmentStatusReadRequestSchema.safeParse({
      shipmentId: scalarQuery(req.query.shipmentId),
      trackingNumber: scalarQuery(req.query.trackingNumber),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid shipment status request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await readPort.getShipmentStatus(request.data);
      const response = shipmentStatusReadResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Fulfillment read port returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof FulfillmentNotFoundError) {
        sendBffError(res, "NOT_FOUND", error.message);
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Fulfillment status read failed");
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
