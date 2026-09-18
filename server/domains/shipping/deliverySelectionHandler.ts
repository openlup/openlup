import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  DELIVERY_SELECTION_CONTRACT_VERSION,
  deliveryOptionsResponseSchema,
  pickupPointValidationRequestSchema,
  pickupPointValidationResponseSchema,
} from "../../../src/domains/shipping/deliverySelectionContracts.js";
import {
  PICKUP_POINT_SEARCH_CONTRACT_VERSION,
  pickupPointSearchRequestSchema,
  pickupPointSearchResponseSchema,
} from "../../../src/domains/shipping/pickupPointSearchContracts.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";
import type { PickupPointSearchPort } from "./pickupPointSearchPort.js";

export function createDeliveryOptionsHandler(port: DeliverySelectionPort) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

export function createPickupPointSearchHandler(port: PickupPointSearchPort) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

export function createPickupPointValidationHandler(port: DeliverySelectionPort) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
