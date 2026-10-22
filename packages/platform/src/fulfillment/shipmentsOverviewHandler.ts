import { isNativeUnsupported, type FulfillmentHandlerRequest, type FulfillmentHandlerResponder } from './handlerSupport.js';
import {
  adminShipmentsOverviewRequestSchema,
} from "./overviewSchemas.js";
import type { FulfillmentShipmentsOverviewResponse } from './contracts/read.js';
import type { FulfillmentShipmentsOverviewPort } from "./ports.js";

export interface FulfillmentShipmentsOverviewHandlerDeps<Response> {
  respond: FulfillmentHandlerResponder<Response>;
  overviewPort: FulfillmentShipmentsOverviewPort;
  responseSchema: { safeParse(input: unknown): { success: true; data: FulfillmentShipmentsOverviewResponse } | { success: false } };
  authorizeAdmin: (req: FulfillmentHandlerRequest) => Promise<boolean>;
}

export function createFulfillmentShipmentsOverviewHandler<Response>({
  respond,
  overviewPort,
  responseSchema: adminShipmentsOverviewResponseSchema,
  authorizeAdmin,
}: FulfillmentShipmentsOverviewHandlerDeps<Response>) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: FulfillmentHandlerRequest, res: Response): Promise<void> {
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
      if (isNativeUnsupported(result)) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Native fulfillment operation unsupported", { details: result });
        return;
      }
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
