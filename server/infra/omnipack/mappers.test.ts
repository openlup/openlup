import { describe, expect, it } from "vitest";
import { OMNIPACK_SIMULATOR_FIXTURES } from "./fixtures.js";
import {
  buildOmnipackCancelOrderRequest,
  mapOmnipackFulfilmentRequestsResponse,
  mapOmnipackFulfilmentsResponse,
  mapOmnipackOrderCreatedResponse,
  mapOmnipackStockMovementsResponse,
  mapOmnipackStockResponse,
  mapOmnipackWebhookPayload,
  sanitizeOmnipackPayload,
} from "./mappers.js";

describe("Omnipack mappers", () => {
  it("maps order creation and cancel request evidence", () => {
    expect(mapOmnipackOrderCreatedResponse(OMNIPACK_SIMULATOR_FIXTURES.placeOrderResponse)).toMatchObject({
      provider: "omnipack",
      providerOrderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
    });

    expect(buildOmnipackCancelOrderRequest("8125cbd6-2ff9-11eb-adc1-0242ac120002")).toEqual({
      method: "DELETE",
      path: "/orders/8125cbd6-2ff9-11eb-adc1-0242ac120002",
      providerOrderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
    });
  });

  it("maps stock and stock movements as provider evidence only", () => {
    expect(mapOmnipackStockResponse(OMNIPACK_SIMULATOR_FIXTURES.stockResponse)).toEqual([{
      provider: "omnipack",
      sku: "OPENLUP-KARMA-ADULT-2KG",
      totalQuantity: 48,
      forSaleQuantity: 35,
      reservedOrUnavailableQuantity: 13,
      stockTruth: "external_stock_master_with_local_reservations",
    }]);

    expect(mapOmnipackStockMovementsResponse(OMNIPACK_SIMULATOR_FIXTURES.stockMovementsResponse)).toEqual([{
      provider: "omnipack",
      sku: "OPENLUP-KARMA-ADULT-2KG",
      occurredAt: "2026-06-10T08:30:00+00:00",
      quantity: -2,
      operationType: "order_shipped",
      warehouseDocumentNumber: "WZ/2026/1001",
      lotNumber: "LOT-2026-06",
      expirationDate: "2027-06-30",
    }]);
  });

  it("maps fulfilments, fulfilment requests, and shipped webhooks", () => {
    expect(mapOmnipackFulfilmentsResponse(OMNIPACK_SIMULATOR_FIXTURES.fulfilmentsResponse)).toEqual([{
      provider: "omnipack",
      providerOrderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      fulfilmentNumber: "FUL-1001",
      externalNumber: "openlup-order-1001",
      orderNumber: "openlup-order-1001",
      createdAt: "2026-06-10T08:00:00+00:00",
      updatedAt: "2026-06-10T09:00:00+00:00",
      status: "shipped",
      subStatus: "handed_over_to_carrier",
      trackingNumbers: ["INPOST-TRACK-1001"],
      trackingReferences: [{
        provider: "omnipack",
        trackingNumber: "INPOST-TRACK-1001",
        trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
        carrier: null,
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      }],
      items: [{
        sku: "OPENLUP-KARMA-ADULT-2KG",
        quantity: 2,
        lotNumber: "LOT-2026-06",
        expirationDate: "2027-06-30",
      }],
    }]);

    expect(mapOmnipackFulfilmentRequestsResponse(OMNIPACK_SIMULATOR_FIXTURES.fulfilmentRequestsResponse)).toEqual([{
      provider: "omnipack",
      warehouseDocumentNumber: "PZ/2026/5001",
      warehouseName: "OMNIPACK-WAW",
      state: "accepted",
    }]);

    expect(mapOmnipackWebhookPayload(OMNIPACK_SIMULATOR_FIXTURES.webhooks.orderShipped)).toEqual({
      provider: "omnipack",
      event: "order.shipped",
      providerOrderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T09:00:00+00:00",
      trackingNumbers: ["INPOST-TRACK-1001"],
      trackingReferences: [{
        provider: "omnipack",
        trackingNumber: "INPOST-TRACK-1001",
        trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
        carrier: null,
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      }],
      shippingMethods: ["INPOST_PACZKOMAT"],
    });
  });

  it("maps real webhook bodies without event from the route-derived fallback", () => {
    expect(mapOmnipackWebhookPayload({
      orderId: "89791ce1-976d-479b-b849-5086bdffa291",
      shipments: [{
        trackingNo: "431327317541800124673586",
        shippingMethod: "InPost",
      }],
    }, "shipment.accepted")).toEqual({
      provider: "omnipack",
      event: "shipment.accepted",
      providerOrderId: "89791ce1-976d-479b-b849-5086bdffa291",
      orderNumber: null,
      fulfilmentNumber: null,
      occurredAt: null,
      trackingNumbers: ["431327317541800124673586"],
      trackingReferences: [{
        provider: "omnipack",
        trackingNumber: "431327317541800124673586",
        trackingUrl: null,
        carrier: null,
        carrierKind: "inpost",
        service: "InPost",
      }],
      shippingMethods: ["InPost"],
    });
  });

  it("sanitizes nested customer and auth fields from provider payload snippets", () => {
    expect(sanitizeOmnipackPayload({
      Authorization: "Basic secret",
      email: "client@example.test",
      phone: "+48000000000",
      street: "Secret 1",
      code: "ERR_BAD_REQUEST",
      orderId: "order-id",
      customer: {
        firstName: "Test",
        lastName: "Customer",
        address: { city: "Warszawa", postalCode: "00-001", countryCode: "PL" },
      },
      shipments: [{ trackingNo: "TRACK-1", shippingMethod: "INPOST" }],
    })).toEqual({
      code: "ERR_BAD_REQUEST",
      orderId: "order-id",
      customer: {},
      shipments: [{ trackingNo: "TRACK-1", shippingMethod: "INPOST" }],
    });
  });
});
