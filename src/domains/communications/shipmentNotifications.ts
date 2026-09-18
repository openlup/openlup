import { z } from "../../lib/validation/zod.js";

export const shipmentNotificationEventSchema = z
  .object({
    orderId: z.guid(),
    clientId: z.guid(),
    status: z.enum(["dispatched", "shipped", "delivered", "exception"]),
    trackingNumbers: z.array(z.string().trim().min(1).max(160)).max(20),
    trackingReferences: z
      .array(
        z
          .object({
            providerKind: z.string().trim().min(1).max(80),
            carrierKind: z.string().trim().min(1).max(80).nullable(),
            service: z.string().trim().min(1).max(120).nullable(),
            trackingNumber: z.string().trim().min(1).max(160),
            trackingUrl: z.string().url().max(500).nullable(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    trackingUrl: z.string().url().max(500).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const shipmentNotificationPlanSchema = z
  .object({
    templateSlug: z.enum([
      "commerce-shipment-dispatched",
      "commerce-shipment-delivered",
      "commerce-shipment-exception",
    ]),
    source: z.literal("shipment-status"),
    idempotencyKey: z.string().min(1).max(200),
    shouldNotifyCustomer: z.boolean(),
  })
  .strict();

export function planShipmentNotification(
  event: ShipmentNotificationEvent,
): ShipmentNotificationPlan {
  const templateSlug = templateForStatus(event.status);
  return {
    templateSlug,
    source: "shipment-status",
    idempotencyKey: [
      "shipment-status",
      event.orderId,
      event.status,
      trackingNumbersForIdempotency(event).join(","),
      event.occurredAt,
    ].join(":"),
    shouldNotifyCustomer: event.status !== "shipped" || trackingNumbersForIdempotency(event).length > 0,
  };
}

function templateForStatus(
  status: ShipmentNotificationEvent["status"],
): ShipmentNotificationPlan["templateSlug"] {
  if (status === "delivered") return "commerce-shipment-delivered";
  if (status === "exception") return "commerce-shipment-exception";
  return "commerce-shipment-dispatched";
}

function trackingNumbersForIdempotency(event: ShipmentNotificationEvent): string[] {
  return event.trackingReferences?.map((ref) => ref.trackingNumber) ?? event.trackingNumbers;
}

export type ShipmentNotificationEvent = z.infer<typeof shipmentNotificationEventSchema>;
export type ShipmentNotificationPlan = z.infer<typeof shipmentNotificationPlanSchema>;
