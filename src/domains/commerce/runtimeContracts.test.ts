import { describe, expect, it } from "vitest";
import {
  startHiddenCheckoutRuntimeRequestSchema,
  startHiddenCheckoutRuntimeResponseSchema,
} from "./runtimeContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

describe("hidden checkout runtime contracts", () => {
  it("allows one-time checkout without pet context", () => {
    expect(
      startHiddenCheckoutRuntimeRequestSchema.parse({
        idempotencyKey: "runtime-one-time-1",
        orderDraft: orderDraft(),
        mode: "one_time",
        clientId: "41111111-1111-4111-8111-111111111111",
        shippingAddressId: "45555555-5555-4555-8555-555555555555",
      }).petId,
    ).toBeUndefined();
  });

  it("requires pet context for subscription checkout", () => {
    const parsed = startHiddenCheckoutRuntimeRequestSchema.safeParse({
      idempotencyKey: "runtime-subscription-1",
      orderDraft: orderDraft(),
      mode: "subscription_cycle",
      clientId: "41111111-1111-4111-8111-111111111111",
      shippingAddressId: "45555555-5555-4555-8555-555555555555",
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps the barrier closed when the caller supplies the neutral command marker", () => {
    // The neutral seam produces its pet-less request internally
    // (commerceCheckoutCommandExecution), never through this schema. A marker
    // arriving in a request body is caller-controlled input, so it must not
    // unlock the subscription-requires-pet barrier.
    const parsed = startHiddenCheckoutRuntimeRequestSchema.safeParse({
      idempotencyKey: "runtime-subscription-marker-1",
      orderDraft: orderDraft(),
      mode: "subscription_cycle",
      clientId: "41111111-1111-4111-8111-111111111111",
      shippingAddressId: "45555555-5555-4555-8555-555555555555",
      metadata: { checkoutCommandVersion: "commerce.checkout_command.v1" },
    });

    expect(parsed.success).toBe(false);
  });

  it("validates the composed runtime response without provider checkout fields", () => {
    expect(() =>
      startHiddenCheckoutRuntimeResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        runtime: {
          orderId: "42222222-2222-4222-8222-222222222221",
          orderRef: "order_42222222-2222-4222-8222-222222222221",
          mode: "one_time",
          clientId: "41111111-1111-4111-8111-111111111111",
          petId: null,
          shippingAddressId: "45555555-5555-4555-8555-555555555555",
          total: { amountMinor: 1490, currency: "PLN" },
          finalizedReplayed: false,
          reservations: [
            {
              reservationId: "46666666-6666-4666-8666-666666666661",
              reservationIds: ["46666666-6666-4666-8666-666666666661"],
              orderItemId: "47777777-7777-4777-8777-777777777771",
              skuId: "48888888-8888-4888-8888-888888888881",
              sku: "OPENLUP-BEEF-ADULT-CAN-400G",
              status: "reserved",
              replayed: false,
            },
          ],
          payment: {
            paymentIntentId: "49999999-9999-4999-8999-999999999991",
            paymentId: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            paymentAttemptId: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
            status: "created",
            attemptStatus: "processing",
            provider: "hidden_rehearsal",
          },
          readiness: {
            omsEligibility: { allowed: false, reason: "order_not_paid" },
            fulfillmentCreate: { allowed: false, reason: "oms_blocked", omsReason: "order_not_paid" },
          },
          nextAction: { kind: "await_hidden_payment_result", provider: "hidden_rehearsal" },
        },
      }),
    ).not.toThrow();
  });
});

function orderDraft() {
  const quote = {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "OPENLUP-BEEF-ADULT-CAN-400G",
          productSlug: "beef",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 1380, currency: "PLN" },
            vatAmount: { amountMinor: 110, currency: "PLN" },
            grossAmount: { amountMinor: 1490, currency: "PLN" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 1490, currency: "PLN" },
      netTotal: { amountMinor: 1380, currency: "PLN" },
      taxTotal: { amountMinor: 110, currency: "PLN" },
    },
  };
  return {
    orderId: "order_42222222-2222-4222-8222-222222222221",
    status: "draft",
    paymentStatus: "not_started",
    idempotencyKey: "order-draft-1",
    quoteSnapshot: quote,
    replayed: false,
  };
}
