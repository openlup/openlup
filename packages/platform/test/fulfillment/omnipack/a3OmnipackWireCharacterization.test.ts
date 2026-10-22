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
  for (const status of [307, 308, 408, 409, 425, 429, 500, 503, 599]) {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: `HTTP_${status}` }, status));
    await expect(createOmnipackClient(config, fetchImpl).createOrder("{}")).rejects.toMatchObject({
      name: "OmnipackProviderError", operation: "createOrder", status, retryable: false, mayHaveSucceeded: status >= 400,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]).toEqual([expect.any(URL), expect.objectContaining({ redirect: "error" })]);
  }
  const lost = vi.fn(async () => { throw new TypeError("response lost"); });
  await expect(createOmnipackClient(config, lost).createOrder("{}")).rejects.toMatchObject({ status: null, code: "network_error", mayHaveSucceeded: true });
  expect(lost).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  try {
    const deadline = 5;
    const timedOut = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("deadline elapsed")), { once: true });
    }));
    let settled = false;
    const pending = createOmnipackClient({ ...config, timeoutMs: deadline }, timedOut).createOrder("{}");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(pending)
      .rejects.toMatchObject({ status: null, code: "network_error", mayHaveSucceeded: true });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    expect(timedOut.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await rejection;
    expect(timedOut).toHaveBeenCalledOnce();
    expect(timedOut.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}" });
  } finally {
    vi.useRealTimers();
  }
  const missing = vi.fn(async () => jsonResponse({ orderId: "" }));
  await expect(createOmnipackClient(config, missing).createOrder("{}")).rejects.toThrow("omnipack_order_response_invalid");
  expect(missing).toHaveBeenCalledOnce();
});
it("retries a safe GET and maps authoritative stock evidence", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ code: "TEMPORARY" }, 503)).mockResolvedValueOnce(jsonResponse(stock));
  await expect(createOmnipackClient(config, fetchImpl).getStock()).resolves.toEqual(stockEvidence);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
