import {
  createDeliveryOptionsHandler as createOptions,
  createPickupPointSearchHandler as createSearch,
  createPickupPointValidationHandler as createValidation,
  type DeliverySelectionSchemas,
} from "@openlup/platform/shipping";
import { bffResponder } from "../../_lib/bff/response.js";
import {
  deliveryOptionsResponseSchema, pickupPointValidationRequestSchema, pickupPointValidationResponseSchema,
} from "../../../src/domains/shipping/deliverySelectionContracts.js";
import {
  pickupPointSearchRequestSchema, pickupPointSearchResponseSchema,
} from "../../../src/domains/shipping/pickupPointSearchContracts.js";
import type { DeliverySelectionPort } from "./deliverySelectionPort.js";
import type { PickupPointSearchPort } from "./pickupPointSearchPort.js";

const schemas: DeliverySelectionSchemas = {
  deliveryOptionsResponseSchema, pickupPointValidationRequestSchema, pickupPointValidationResponseSchema,
  pickupPointSearchRequestSchema, pickupPointSearchResponseSchema,
};
export function createDeliveryOptionsHandler(port: DeliverySelectionPort) {
  return createOptions(port, schemas, bffResponder);
}
export function createPickupPointSearchHandler(port: PickupPointSearchPort) {
  return createSearch(port, schemas, bffResponder);
}
export function createPickupPointValidationHandler(port: DeliverySelectionPort) {
  return createValidation(port, schemas, bffResponder);
}
