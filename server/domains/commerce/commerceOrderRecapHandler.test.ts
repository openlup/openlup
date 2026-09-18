import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createCommerceOrderRecapHandler,
  type OrderRecapData,
} from "./commerceOrderRecapHandler.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

const RECAP: OrderRecapData = {
  orderId: ORDER_ID,
  orderRef: `order_${ORDER_ID}`,
  orderNumber: "VP-2026-00042",
  status: "paid",
  paymentStatus: "succeeded",
  mode: "subscription",
  checkoutKind: "subscription_initial",
  moneyReconciled: true,
  firstSubscriptionPricePresentation: null,
  petName: "Reksio",
  customerFirstName: "Anna",
  maskedEmail: "a***@example.com",
  cadenceDays: 21,
  nextDeliveryAt: "2026-07-01T00:00:00.000+00:00",
  items: [
    {
      title: "Jagnięcina 400g",
      quantity: 6,
      recipeName: "Jagnięcina",
      variantName: "400g",
      total: { amountMinor: 5400, currency: "PLN" },
      listTotal: null,
      discount: null,
      sku: "OPENLUP-LAMB-400",
      variantCode: "can_400g",
      catalogUnitGross: 900,
      catalogTotalGross: 5400,
      effectiveGross: 5400,
      effectiveNet: 5400,
      discountAllocated: 0,
      vatRateBps: 0,
    },
  ],
  totals: {
    subtotal: { amountMinor: 5400, currency: "PLN" },
    discount: { amountMinor: 0, currency: "PLN" },
    shipping: { amountMinor: 0, currency: "PLN" },
    shippingDiscount: { amountMinor: 0, currency: "PLN" },
    tax: { amountMinor: 0, currency: "PLN" },
    total: { amountMinor: 5400, currency: "PLN" },
  },
  shippingAddress: {
    line1: "Example Street 11",
    line2: null,
    city: "Kraków",
    postalCode: "30-001",
    country: "PL",
  },
  createdAt: "2026-06-16T10:00:00.000+00:00",
};

describe("commerce order recap handler", () => {
  it("returns the validated recap envelope for an owning client", async () => {
    const res = createResponse();
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => true,
      recapPort: { async getOrderRecap() { return RECAP; } },
    });

    await handler(request({ orderId: ORDER_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { contractVersion: "commerce.order.recap.v2", ...projectV2(RECAP) },
      meta: { contractVersion: "commerce.order.recap.v2" },
    });
    const serialized = JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]);
    expect(serialized).not.toContain("moneyReconciled");
    expect(serialized).not.toContain("checkoutKind");
    expect(serialized).not.toContain("catalogUnitGross");
  });

  it("returns the strict opt-in v3 analytics facts without changing the read port", async () => {
    const res = createResponse();
    const getOrderRecap = vi.fn(async () => RECAP);
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => true,
      recapPort: { getOrderRecap },
    });

    await handler(request({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      contractVersion: "commerce.order.recap.v3",
    }), res);

    expect(getOrderRecap).toHaveBeenCalledWith({ orderId: ORDER_ID, clientId: CLIENT_ID });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "commerce.order.recap.v3",
        ...projectV3(RECAP),
      },
      meta: { contractVersion: "commerce.order.recap.v3" },
    });
  });

  it("returns the strict opt-in v4 receipt presentation without changing V2/V3", async () => {
    const res = createResponse();
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => true,
      recapPort: {
        async getOrderRecap() {
          return {
            ...RECAP,
            firstSubscriptionPricePresentation: {
              catalogProductsMinor: 55_130,
              productDiscountMinor: 27_565,
              productPayableMinor: 27_565,
              shippingGrossMinor: 1_500,
              shippingDiscountMinor: 1_500,
              shippingEffectiveMinor: 0,
              totalMinor: 27_565,
              discountPercent: 50,
            },
          };
        },
      },
    });

    await handler(request({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      contractVersion: "commerce.order.recap.v4",
    }), res);

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        contractVersion: "commerce.order.recap.v4",
        firstSubscriptionPricePresentation: expect.objectContaining({
          catalogProductsMinor: 55_130,
          totalMinor: 27_565,
        }),
      }),
      meta: { contractVersion: "commerce.order.recap.v4" },
    });
  });

  it("returns 404 when the port resolves null (unknown or non-owning pair)", async () => {
    const res = createResponse();
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => true,
      recapPort: { async getOrderRecap() { return null; } },
    });

    await handler(request({ orderId: ORDER_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "NOT_FOUND", message: "Order recap not found" },
    });
  });

  it("rejects malformed requests before touching the port", async () => {
    const res = createResponse();
    const getOrderRecap = vi.fn();
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => true,
      recapPort: { getOrderRecap },
    });

    await handler(request({ orderId: "not-a-uuid", clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getOrderRecap).not.toHaveBeenCalled();
  });

  it("fails closed while provider payments are disabled", async () => {
    const res = createResponse();
    const handler = createCommerceOrderRecapHandler({
      mutationsEnabled: () => false,
      recapPort: { getOrderRecap: vi.fn() },
    });

    await handler(request({ orderId: ORDER_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function request(query: Record<string, string>, method = "GET"): VercelRequest {
  return { method, query, body: {}, headers: {} } as unknown as VercelRequest;
}

function projectV3(recap: OrderRecapData) {
  const { firstSubscriptionPricePresentation: _presentation, ...v3 } = recap;
  return v3;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function projectV2(recap: OrderRecapData) {
  return {
    orderId: recap.orderId,
    orderRef: recap.orderRef,
    orderNumber: recap.orderNumber,
    status: recap.status,
    paymentStatus: recap.paymentStatus,
    mode: recap.mode,
    petId: recap.petId,
    petName: recap.petName,
    customerFirstName: recap.customerFirstName,
    maskedEmail: recap.maskedEmail,
    cadenceDays: recap.cadenceDays,
    nextDeliveryAt: recap.nextDeliveryAt,
    items: recap.items.map((item) => ({
      title: item.title,
      quantity: item.quantity,
      recipeName: item.recipeName,
      variantName: item.variantName,
      total: item.total,
      listTotal: item.listTotal,
      discount: item.discount,
    })),
    totals: recap.totals,
    shippingAddress: recap.shippingAddress,
    createdAt: recap.createdAt,
  };
}
