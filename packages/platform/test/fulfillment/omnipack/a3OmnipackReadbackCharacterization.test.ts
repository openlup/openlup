import { expect, it, vi } from "vitest";
import { createOmnipackClient } from "../../../src/fulfillment/omnipack/client.js";
import { mapOmnipackFulfilmentsResponse, mapOmnipackFulfilmentRequestsResponse, mapOmnipackStockMovementsResponse, mapOmnipackStockResponse, mapOmnipackWebhookPayload } from "../../../src/fulfillment/omnipack/mappers.js";
import { config, jsonResponse } from "./fixtures.js";

it("preserves exact readback query encoding and endpoint selection", async () => {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo) => { urls.push(url.toString()); return jsonResponse({}); });
  const client = createOmnipackClient(config, fetchImpl);
  await client.getStockMovements({ startLocalDate: "2026-06-01", endLocalDate: "2026-06-10", page: 2 });
  await client.getFulfilments({ page: 0, size: 50 }); await client.getFulfilmentRequests();
  expect(urls).toEqual(["https://warehouse.example.test/stock-movements?startLocalDate=2026-06-01&endLocalDate=2026-06-10&page=2", "https://warehouse.example.test/fulfilments?page=0&size=50", "https://warehouse.example.test/fulfilment-requests"]);
});
it("maps fulfillment correlation and tracking evidence without duplicate tracking numbers", () => {
  const row = { orderId: "provider-1", fulfilmentNumber: "FUL-1", externalNumber: "ORDER-1", orderNumber: "ORDER-1", createdAt: "2026-06-10T08:00:00Z", updatedAt: "2026-06-10T09:00:00Z", status: "shipping", subStatus: "handed_over", shipments: [{ trackingNo: "TRACK-1", shippingMethod: "EXAMPLE_STANDARD", trackingUrl: "https://tracking.example.test/TRACK-1" }], trackingNumbers: ["TRACK-1", "TRACK-2"], items: [{ sku: "SKU-A", quantity: 2, productLotNumber: "LOT-1", expirationDate: "2027-06-30" }] };
  const refs = [{ provider: "omnipack", trackingNumber: "TRACK-1", trackingUrl: "https://tracking.example.test/TRACK-1", carrier: null, carrierKind: "example", service: "EXAMPLE_STANDARD" }, { provider: "omnipack", trackingNumber: "TRACK-2", trackingUrl: null, carrier: null, carrierKind: null, service: null }];
  expect(mapOmnipackFulfilmentsResponse({ _embedded: { fulfilments: [row] } })).toEqual([{ provider: "omnipack", providerOrderId: "provider-1", fulfilmentNumber: "FUL-1", externalNumber: "ORDER-1", orderNumber: "ORDER-1", createdAt: row.createdAt, updatedAt: row.updatedAt, status: "shipping", subStatus: "handed_over", trackingNumbers: ["TRACK-1", "TRACK-2"], trackingReferences: refs, items: [{ sku: "SKU-A", quantity: 2, lotNumber: "LOT-1", expirationDate: "2027-06-30" }] }]);
  expect(mapOmnipackWebhookPayload({ ...row, occurredAt: row.updatedAt }, "order.shipped")).toMatchObject({ event: "order.shipped", providerOrderId: "provider-1", trackingNumbers: ["TRACK-1"], trackingReferences: [refs[0]] });
  expect(mapOmnipackFulfilmentRequestsResponse({ _embedded: { fulfilmentRequests: [{ warehouseDocumentNumber: "DOC-1", warehouseName: "EXAMPLE", state: "accepted" }] } })).toEqual([{ provider: "omnipack", warehouseDocumentNumber: "DOC-1", warehouseName: "EXAMPLE", state: "accepted" }]);
});
it("keeps empty or missing collections empty without manufacturing absence evidence", () => {
  for (const body of [{}, null, { _embedded: {} }, { _embedded: { fulfilments: [], fulfilmentRequests: [], stockItems: [] } }]) {
    expect(mapOmnipackFulfilmentsResponse(body)).toEqual([]); expect(mapOmnipackFulfilmentRequestsResponse(body)).toEqual([]); expect(mapOmnipackStockResponse(body)).toEqual([]);
  }
  expect(mapOmnipackStockMovementsResponse({ _embedded: [] })).toEqual([]);
});
