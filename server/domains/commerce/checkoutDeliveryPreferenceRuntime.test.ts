import { describe, expect, it, vi } from "vitest";
import { withCheckoutDeliveryPreferenceRuntime } from "./checkoutDeliveryPreferenceRuntime.js";
import { CLIENT_ID, ORDER_ID, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";

describe("withCheckoutDeliveryPreferenceRuntime", () => {
  it("upserts subscription delivery defaults after startRuntime succeeds", async () => {
    const store = { upsertDeliveryPreference: vi.fn().mockResolvedValue(undefined) };
    const runtime = withCheckoutDeliveryPreferenceRuntime(runtimePort(), store);

    await runtime.startRuntime(startRequest({
      mode: "subscription_cycle",
      saveForFutureUse: true,
      metadata: {
        selectedDelivery: {
          kind: "courier",
          deliveryKind: "courier",
          providerKind: "omnipack",
          carrierKind: "inpost",
          carrierCode: "INPOST",
          service: "inpost_courier_standard",
          serviceCode: "INPOST_COURIER_STANDARD",
          pickupPoint: null,
        },
      },
    }));

    expect(store.upsertDeliveryPreference).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT_ID,
      scope: "subscription",
      carrierKind: "inpost",
      serviceCode: "INPOST_COURIER_STANDARD",
    }));
    expect(store.upsertDeliveryPreference).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT_ID,
      scope: "any",
      carrierKind: "inpost",
      serviceCode: "INPOST_COURIER_STANDARD",
    }));
  });

  it("does not fail startRuntime when the delivery preference upsert fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = { upsertDeliveryPreference: vi.fn().mockRejectedValue(new Error("db unavailable")) };
    const runtime = withCheckoutDeliveryPreferenceRuntime(runtimePort(), store);

    try {
      await expect(runtime.startRuntime(startRequest({
        mode: "one_time",
        saveForFutureUse: false,
        metadata: {
          selectedDelivery: {
            kind: "courier",
            deliveryKind: "courier",
            providerKind: "omnipack",
            carrierKind: "dpd",
            carrierCode: "DPD",
            serviceCode: "DPD_COURIER_STANDARD",
            pickupPoint: null,
          },
        },
      }))).resolves.toMatchObject({ contractVersion: "commerce.v1" });
    } finally {
      warnSpy.mockRestore();
    }

    expect(store.upsertDeliveryPreference).toHaveBeenCalledTimes(1);
  });
});

function startRequest(
  overrides: Partial<Parameters<CommerceCheckoutRuntimePort["startRuntime"]>[0]>,
): Parameters<CommerceCheckoutRuntimePort["startRuntime"]>[0] {
  return {
    idempotencyKey: "checkout-1",
    orderDraft: {
      orderId: `order_${ORDER_ID}`,
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: "checkout-1",
      quoteSnapshot: quoteSnapshot(),
      replayed: false,
    },
    mode: "one_time",
    saveForFutureUse: false,
    clientId: CLIENT_ID,
    shippingAddressId: "address-1",
    petId: "pet-1",
    paymentProvider: "hidden_rehearsal",
    returnContext: "public",
    providerFlow: "one_time_payment",
    metadata: {},
    ...overrides,
  };
}

function runtimePort(): CommerceCheckoutRuntimePort {
  return {
    startRuntime: vi.fn().mockResolvedValue({
      contractVersion: "commerce.v1",
      runtime: { orderId: "order-1", orderRef: "order_order-1", payment: { paymentIntentId: "payment-1" } },
    }),
    applyPaymentResult: vi.fn().mockResolvedValue({ contractVersion: "commerce.v1" }),
  } as unknown as CommerceCheckoutRuntimePort;
}
