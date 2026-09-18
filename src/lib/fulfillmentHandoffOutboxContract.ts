import { z } from "./validation/zod.js";

export const COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE =
  "commerce.fulfillment.handed_over";

const sharedHandoffPayload = {
  orderUuid: z.guid(),
  occurredAt: z.string().datetime({ offset: true }),
};

export const commerceFulfillmentHandedOverPayloadSchema = z.union([
  z.object({ fulfillmentOrderId: z.guid(), ...sharedHandoffPayload }).strict(),
  z.object({ shipmentUuid: z.guid(), ...sharedHandoffPayload }).strict(),
]).transform((payload) => ({
  fulfillmentOrderId: "fulfillmentOrderId" in payload
    ? payload.fulfillmentOrderId
    : payload.shipmentUuid,
  orderUuid: payload.orderUuid,
  occurredAt: payload.occurredAt,
}));

export type CommerceFulfillmentHandedOverPayload = z.infer<
  typeof commerceFulfillmentHandedOverPayloadSchema
>;
