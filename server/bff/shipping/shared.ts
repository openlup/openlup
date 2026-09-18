import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createValidatedDeliverySelectionPort } from "./deliverySelectionFactory.js";
import { createPickupPointSearchPort } from "./pickupPointSearchFactory.js";
import type { DeliverySelectionPort } from "../../domains/shipping/deliverySelectionPort.js";
import type { PickupPointSearchPort } from "../../domains/shipping/pickupPointSearchPort.js";

type DeliverySelectionHandlerFactory = (
  port: DeliverySelectionPort,
) => (req: VercelRequest, res: VercelResponse) => Promise<void>;

export function createHiddenDeliverySelectionRoute(factory: DeliverySelectionHandlerFactory) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    return factory(createValidatedDeliverySelectionPort())(req, res);
  };
}

type PickupPointSearchHandlerFactory = (
  port: PickupPointSearchPort,
) => (req: VercelRequest, res: VercelResponse) => Promise<void>;

export function createHiddenPickupPointSearchRoute(factory: PickupPointSearchHandlerFactory) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    return factory(createPickupPointSearchPort())(req, res);
  };
}
