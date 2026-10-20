import type {
  DeliveryOptionsResponse, PickupPointSearchRequest, PickupPointSearchResponse,
  PickupPointValidationRequest, PickupPointValidationResponse,
} from "./contracts/index.js";

type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { flatten(): unknown } };
};

/** The host supplies its existing validators, including provider policy and errors. */
export interface DeliverySelectionSchemas {
  deliveryOptionsResponseSchema: Schema<DeliveryOptionsResponse>;
  pickupPointValidationRequestSchema: Schema<PickupPointValidationRequest>;
  pickupPointValidationResponseSchema: Schema<PickupPointValidationResponse>;
  pickupPointSearchRequestSchema: Schema<PickupPointSearchRequest>;
  pickupPointSearchResponseSchema: Schema<PickupPointSearchResponse>;
}
