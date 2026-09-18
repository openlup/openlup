import { describe, expect, it } from "vitest";
import {
  OMNIPACK_SIMULATOR_FIXTURES,
  OMNIPACK_SIMULATOR_RESOURCE_NAMES,
} from "./fixtures.js";

describe("Omnipack simulator fixtures", () => {
  it("covers every documented resource needed before credentials exist", () => {
    expect(OMNIPACK_SIMULATOR_RESOURCE_NAMES).toEqual([
      "POST /orders",
      "GET /stock",
      "GET /stock-movements",
      "GET /fulfilments",
      "GET /fulfilment-requests",
      "webhooks",
    ]);

    expect(OMNIPACK_SIMULATOR_FIXTURES.outboundOrderRequest).toMatchObject({
      orderNumber: "openlup-order-1001",
      items: [{ sku: "OPENLUP-KARMA-ADULT-2KG", quantity: 2 }],
      shippingDetails: {
        carrier: "INPOST",
        service: "PACZKOMAT",
        pickUpPoint: { name: "WAW01A" },
      },
    });
    expect(OMNIPACK_SIMULATOR_FIXTURES.placeOrderResponse).toHaveProperty("orderId");
  });

  it("keeps stock and fulfilment evidence separate from local inventory truth", () => {
    const stock = OMNIPACK_SIMULATOR_FIXTURES.stockResponse._embedded.stockItems[0];
    const movement = OMNIPACK_SIMULATOR_FIXTURES.stockMovementsResponse._embedded[0];
    const fulfilment = OMNIPACK_SIMULATOR_FIXTURES.fulfilmentsResponse._embedded.fulfilments[0];
    const request = OMNIPACK_SIMULATOR_FIXTURES.fulfilmentRequestsResponse._embedded.fulfilmentRequests[0];

    expect(stock).toMatchObject({
      sku: "OPENLUP-KARMA-ADULT-2KG",
      totalQuantity: 48,
      forSaleQuantity: 35,
      processingQuantity: 7,
    });
    expect(stock).toHaveProperty("withheldQuantity");
    expect(movement).toMatchObject({
      sku: "OPENLUP-KARMA-ADULT-2KG",
      quantity: -2,
      operationType: "order_shipped",
      warehouseDocumentNumber: "WZ/2026/1001",
    });
    expect(fulfilment).toMatchObject({
      orderNumber: "openlup-order-1001",
      status: "shipped",
      trackingNumbers: ["INPOST-TRACK-1001"],
      items: [{ productLotNumber: "LOT-2026-06" }],
    });
    expect(request).toMatchObject({
      warehouseDocumentNumber: "PZ/2026/5001",
      state: "accepted",
    });
  });

  it("includes webhook payloads for idempotent replay and tracking slices", () => {
    expect(Object.keys(OMNIPACK_SIMULATOR_FIXTURES.webhooks)).toEqual([
      "shipmentAccepted",
      "orderStartedProcessing",
      "orderPicked",
      "orderShipped",
      "orderDelivered",
    ]);
    expect(OMNIPACK_SIMULATOR_FIXTURES.webhooks.orderShipped).toMatchObject({
      event: "order.shipped",
      orderNumber: "openlup-order-1001",
      shipments: [{ trackingNo: "INPOST-TRACK-1001" }],
    });
    expect(OMNIPACK_SIMULATOR_FIXTURES.webhooks.orderDelivered).toMatchObject({
      event: "order.delivered",
      shipments: [{ shippingMethod: "INPOST_PACZKOMAT" }],
    });
  });
});
