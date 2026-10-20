import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { DeliverySelectionSchemas } from "./handlerSchemas.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";
import type { PickupPointSearchPort } from "./pickupPointSearchPort.js";

export const DELIVERY_SELECTION_CONTRACT_VERSION = "shipping.delivery_selection.v1";
export const PICKUP_POINT_SEARCH_CONTRACT_VERSION = "shipping.pickup_point_search.v1";

export function createDeliveryOptionsHandler(port: DeliverySelectionPort, schemas: DeliverySelectionSchemas, responder: BffResponder) {
  const { deliveryOptionsResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const response = deliveryOptionsResponseSchema.safeParse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      options: await port.listOptions(),
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Delivery options returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data, { contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION });
  };
}

export function createPickupPointSearchHandler(port: PickupPointSearchPort, schemas: DeliverySelectionSchemas, responder: BffResponder) {
  const { pickupPointSearchRequestSchema, pickupPointSearchResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = pickupPointSearchRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid pickup point search request", {
        details: request.error.flatten(),
      });
      return;
    }

    const points = await port.searchPickupPoints(request.data);
    const response = pickupPointSearchResponseSchema.safeParse({
      contractVersion: PICKUP_POINT_SEARCH_CONTRACT_VERSION,
      carrierKind: request.data.carrierKind,
      points,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Pickup point search returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data, { contractVersion: PICKUP_POINT_SEARCH_CONTRACT_VERSION });
  };
}

export function createPickupPointValidationHandler(port: DeliverySelectionPort, schemas: DeliverySelectionSchemas, responder: BffResponder) {
  const { pickupPointValidationRequestSchema, pickupPointValidationResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = pickupPointValidationRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid pickup point validation request", {
        details: request.error.flatten(),
      });
      return;
    }

    const pickupPoint = await port.validatePickupPoint(request.data);
    const response = pickupPointValidationResponseSchema.safeParse({
      contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION,
      valid: Boolean(pickupPoint),
      pickupPoint,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Pickup point validation returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data, { contractVersion: DELIVERY_SELECTION_CONTRACT_VERSION });
  };
}
