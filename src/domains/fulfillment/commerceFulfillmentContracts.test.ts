import { describe, expect, it } from "vitest";
import {
  COMMERCE_FULFILLMENT_CONTRACT_VERSION,
  adminCommerceFulfillmentOrderDetailResponseSchema,
  adminCommerceFulfillmentRecordLabelRequestSchema,
} from "./commerceFulfillmentContracts.js";

describe("commerce fulfillment integration contracts", () => {
  it("validates a cross-module fulfillment order snapshot", () => {
    const parsed = adminCommerceFulfillmentOrderDetailResponseSchema.parse({
      contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
      order: {
        id: "11111111-1111-4111-8111-111111111111",
        orderId: "22222222-2222-4222-8222-222222222222",
        clientId: "33333333-3333-4333-8333-333333333333",
        status: "created",
        providerKind: null,
        providerTrackingId: null,
        shippingAddress: {
          addressId: "44444444-4444-4444-8444-444444444444",
          clientId: "33333333-3333-4333-8333-333333333333",
          label: "Home",
          line1: "Karmowa 1",
          line2: null,
          city: "Warszawa",
          postalCode: "00-001",
          country: "PL",
        },
        lines: [{
          id: "55555555-5555-4555-8555-555555555555",
          orderItemId: "66666666-6666-4666-8666-666666666666",
          skuId: "77777777-7777-4777-8777-777777777777",
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          title: "Lamb 400g",
          quantity: 14,
          inventoryReservationIds: ["88888888-8888-4888-8888-888888888888"],
          productSnapshot: { sku: "OPENLUP-DOG-LAMB-CAN-400G" },
        }],
        payment: {
          paymentIntentId: "99999999-9999-4999-8999-999999999999",
          paymentStatus: "succeeded",
          providerPaymentId: "psp_1",
        },
        inventory: {
          status: "reserved",
          reservationId: "88888888-8888-4888-8888-888888888888",
          reservationStatus: "reserved",
          expiresAt: "2026-06-05T12:00:00+00:00",
          locationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          locationCode: "pl-main",
        },
        omsEligibility: { allowed: true, reason: null },
        latestOperation: null,
        createdAt: "2026-06-05T10:00:00+00:00",
        updatedAt: "2026-06-05T10:00:00+00:00",
      },
    });

    expect(parsed.order.lines[0].inventoryReservationIds).toHaveLength(1);
    expect(parsed.order.payment.paymentStatus).toBe("succeeded");
  });

  it("validates provider label recording without introducing a new tracking table contract", () => {
    expect(
      adminCommerceFulfillmentRecordLabelRequestSchema.parse({
        idempotencyKey: "fulfillment-label-1",
        fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
        providerKind: "noop_shipping",
        providerTrackingId: "noop_track_1",
      }),
    ).toMatchObject({
      providerKind: "noop_shipping",
      rawProviderPayload: {},
    });
  });
});
