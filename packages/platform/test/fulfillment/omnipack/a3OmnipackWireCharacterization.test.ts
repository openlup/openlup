import { expect, it, vi } from "vitest";
import { createOmnipackClient } from "../../../src/fulfillment/omnipack/client.js";
import { config, jsonResponse, stock, stockEvidence } from "./fixtures.js";

it("binds Basic authentication and the exact POST body to the configured origin", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ orderId: "provider-1" }, 201));
  const body = '{"orderNumber":"ORDER-1"}';
  expect(await createOmnipackClient(config, fetchImpl).createOrder(body)).toMatchObject({ provider: "omnipack", providerOrderId: "provider-1" });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.toString()).toBe("https://warehouse.example.test/orders");
  expect(init).toMatchObject({ method: "POST", body, headers: { Authorization: `Basic ${Buffer.from("example:placeholder").toString("base64")}` } });
});
it("never repeats ambiguous POSTs including response loss and missing acceptance proof", async () => {
  for (const status of [408, 409, 425, 429, 500, 503, 599]) {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: `HTTP_${status}` }, status));
    await expect(createOmnipackClient(config, fetchImpl).createOrder("{}")).rejects.toMatchObject({
      name: "OmnipackProviderError", operation: "createOrder", status, retryable: false, mayHaveSucceeded: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  }
  const lost = vi.fn(async () => { throw new TypeError("response lost"); });
  await expect(createOmnipackClient(config, lost).createOrder("{}")).rejects.toMatchObject({ status: null, code: "network_error", mayHaveSucceeded: true });
  expect(lost).toHaveBeenCalledOnce();
  const missing = vi.fn(async () => jsonResponse({ orderId: "" }));
  await expect(createOmnipackClient(config, missing).createOrder("{}")).rejects.toThrow("omnipack_order_response_invalid");
  expect(missing).toHaveBeenCalledOnce();
});
it("retries a safe GET and maps authoritative stock evidence", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ code: "TEMPORARY" }, 503)).mockResolvedValueOnce(jsonResponse(stock));
  await expect(createOmnipackClient(config, fetchImpl).getStock()).resolves.toEqual(stockEvidence);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
