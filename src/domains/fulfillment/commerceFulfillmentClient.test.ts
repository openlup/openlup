import { describe, expect, it, vi } from "vitest";
import { COMMERCE_FULFILLMENT_CONTRACT_VERSION } from "./commerceFulfillmentContracts";
import {
  createAdminCommerceFulfillmentOrder,
  cancelAdminCommerceFulfillmentOrder,
  getAdminCommerceFulfillmentOrderDetail,
  getAdminCommerceFulfillmentOrders,
  handOffAdminCommerceFulfillmentOrder,
  recordAdminCommerceFulfillmentTrackingEvent,
  recordAdminCommerceFulfillmentLabel,
  recordAdminCommerceFulfillmentProviderAttempt,
} from "./commerceFulfillmentClient";

describe("commerce fulfillment BFF client", () => {
  it("reads hidden admin commerce fulfillment orders with bearer auth", async () => {
    const fetcher = createFetcher(listResponse());

    await getAdminCommerceFulfillmentOrders("token", { page: 1, pageSize: 25 }, { fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/fulfillment/commerce-orders?page=1&pageSize=25",
      expect.objectContaining({ method: "GET" }),
    );
    expect(readAuth(fetcher)).toBe("Bearer token");
  });

  it("reads hidden admin commerce fulfillment detail by order id", async () => {
    const fetcher = createFetcher({ contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION, order: fulfillmentOrder() });

    await getAdminCommerceFulfillmentOrderDetail(
      "token",
      { orderId: "42222222-2222-4222-8222-222222222221" },
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/fulfillment/commerce-orders/detail?orderId=42222222-2222-4222-8222-222222222221",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts disabled-by-default mutation contracts", async () => {
    const fetcher = createFetcher(mutationResponse("created"));

    await createAdminCommerceFulfillmentOrder(
      "token",
      {
        idempotencyKey: "fulfillment-create-1",
        orderId: "42222222-2222-4222-8222-222222222221",
      },
      { fetcher },
    );
    await recordAdminCommerceFulfillmentProviderAttempt(
      "token",
      {
        idempotencyKey: "fulfillment-attempt-1",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
        providerKind: "noop_shipping",
        status: "recorded",
      },
      { fetcher },
    );
    await recordAdminCommerceFulfillmentLabel(
      "token",
      {
        idempotencyKey: "fulfillment-label-1",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
        providerKind: "noop_shipping",
        providerTrackingId: "NOOP-1",
      },
      { fetcher },
    );
    await handOffAdminCommerceFulfillmentOrder(
      "token",
      {
        idempotencyKey: "fulfillment-handoff-1",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
      },
      { fetcher },
    );
    await recordAdminCommerceFulfillmentTrackingEvent(
      "token",
      {
        idempotencyKey: "fulfillment-tracking-1",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
        status: "delivered",
      },
      { fetcher },
    );
    await cancelAdminCommerceFulfillmentOrder(
      "token",
      {
        idempotencyKey: "fulfillment-cancel-1",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
        reason: "Operator test",
      },
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/fulfillment/commerce-orders/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws typed BFF errors for disabled mutations", async () => {
    const fetcher = createRawFetcher(
      { ok: false, error: { code: "FORBIDDEN", message: "Commerce fulfillment mutations are not enabled" } },
      403,
    );

    await expect(
      createAdminCommerceFulfillmentOrder(
        "token",
        {
          idempotencyKey: "fulfillment-create-1",
          orderId: "42222222-2222-4222-8222-222222222221",
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

function listResponse() {
  return {
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    orders: [fulfillmentOrder()],
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}

function fulfillmentOrder() {
  return {
    id: "52222222-2222-4222-8222-222222222221",
    orderId: "42222222-2222-4222-8222-222222222221",
    clientId: "12222222-2222-4222-8222-222222222221",
    status: "created",
    providerKind: null,
    providerTrackingId: null,
    shippingAddress: {
      addressId: "32222222-2222-4222-8222-222222222221",
      clientId: "12222222-2222-4222-8222-222222222221",
      label: "Home",
      line1: "Prosta 1",
      line2: null,
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
    },
    lines: [{
      id: "62222222-2222-4222-8222-222222222221",
      orderItemId: "72222222-2222-4222-8222-222222222221",
      skuId: "82222222-2222-4222-8222-222222222221",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      title: "Lamb 400g",
      quantity: 2,
      inventoryReservationIds: ["92222222-2222-4222-8222-222222222221"],
      productSnapshot: {},
    }],
    payment: {
      paymentIntentId: "a2222222-2222-4222-8222-222222222221",
      paymentStatus: "succeeded",
      providerPaymentId: "pay_1",
    },
    inventory: {
      status: "reserved",
      reservationId: "92222222-2222-4222-8222-222222222221",
      reservationStatus: "reserved",
      expiresAt: "2026-06-05T10:30:00+00:00",
      locationId: "b2222222-2222-4222-8222-222222222221",
      locationCode: "pl-main",
    },
    omsEligibility: { allowed: true, reason: null },
    latestOperation: null,
    createdAt: "2026-06-05T10:00:00+00:00",
    updatedAt: "2026-06-05T10:00:00+00:00",
  };
}

function mutationResponse(status: "created" | "label_created" | "handed_over" | "delivered" | "cancelled") {
  return {
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
    orderId: "42222222-2222-4222-8222-222222222221",
    status,
    replayed: false,
  };
}

function createFetcher(data: unknown) {
  return createRawFetcher({ ok: true, data });
}

function createRawFetcher(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => payload,
  });
}

function readAuth(fetcher: ReturnType<typeof createRawFetcher>) {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  return new Headers(init.headers).get("Authorization");
}
