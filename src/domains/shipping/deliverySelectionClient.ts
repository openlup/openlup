import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  deliveryOptionsResponseSchema,
  pickupPointValidationResponseSchema,
  type DeliveryOptionsResponse,
  type PickupPointValidationRequest,
  type PickupPointValidationResponse,
} from "./deliverySelectionContracts";
import {
  pickupPointSearchResponseSchema,
  type PickupPointSearchRequest,
  type PickupPointSearchResponse,
} from "./pickupPointSearchContracts";

export function getDeliveryOptions(
  options: BffRequestOptions = {},
): Promise<DeliveryOptionsResponse> {
  return requestBff("/api/bff/shipping/delivery-options", deliveryOptionsResponseSchema, {
    ...options,
    method: "GET",
  });
}

export function validatePickupPoint(
  request: PickupPointValidationRequest,
  options: BffRequestOptions = {},
): Promise<PickupPointValidationResponse> {
  return requestBff("/api/bff/shipping/pickup-point-validation", pickupPointValidationResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

export function searchPickupPoints(
  request: PickupPointSearchRequest,
  options: BffRequestOptions = {},
): Promise<PickupPointSearchResponse> {
  return requestBff("/api/bff/shipping/pickup-point-search", pickupPointSearchResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}
