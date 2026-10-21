import { expect, it } from "vitest";
import { mapOmnipackStockResponse, mapOmnipackStockMovementsResponse } from "../../../src/fulfillment/omnipack/mappers.js";
import { OmnipackProviderError, mayPostHaveSucceeded, sanitizeOmnipackProviderError } from "../../../src/fulfillment/omnipack/providerError.js";
import { stock, stockEvidence } from "./fixtures.js";

it("maps snapshot quantities and every unavailable bucket as evidence only", () => {
  expect(mapOmnipackStockResponse(stock)).toEqual(stockEvidence);
});
it("preserves movement occurrence, signed quantity, lot and expiry", () => {
  expect(mapOmnipackStockMovementsResponse({ _embedded: [{ sku: "SKU-A", occurredAt: "2026-06-10T08:30:00Z", quantity: -2, operationType: "order_shipped", warehouseDocumentNumber: "DOC-1", productLotNumber: "LOT-1", expirationDate: "2027-06-30" }] })).toEqual([{ provider: "omnipack", sku: "SKU-A", occurredAt: "2026-06-10T08:30:00Z", quantity: -2, operationType: "order_shipped", warehouseDocumentNumber: "DOC-1", lotNumber: "LOT-1", expirationDate: "2027-06-30" }]);
});
it("projects controlled errors, discards arbitrary failures and preserves POST ambiguity", () => {
  const error = new OmnipackProviderError({ operation: "createOrder", status: 503, code: "http_503", retryable: false, mayHaveSucceeded: true });
  Object.assign(error, { responseBody: { email: "recipient@example.test", address: "123 Example Street" } });
  expect(sanitizeOmnipackProviderError(error)).toEqual({ code: "http_503", mayHaveSucceeded: true, message: "OmniPack request failed: createOrder", operation: "createOrder", retryable: false, status: 503 });
  const sanitized = sanitizeOmnipackProviderError(new Error("recipient@example.test password placeholder"));
  expect(sanitized).toEqual({ code: "omnipack_provider_error", mayHaveSucceeded: true, message: "OmniPack request failed", operation: null, retryable: true, status: null });
  expect(JSON.stringify(sanitized)).not.toMatch(/recipient|password|placeholder/);
  for (const status of [null, 408, 409, 425, 429, 500, 503, 599]) expect(mayPostHaveSucceeded("POST", status)).toBe(true);
  for (const status of [400, 401, 403, 404, 422]) expect(mayPostHaveSucceeded("POST", status)).toBe(false);
  expect(mayPostHaveSucceeded("GET", 503)).toBe(false); expect(mayPostHaveSucceeded("post", null)).toBe(false);
});
