import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createOmnipackClient } from "../../../src/fulfillment/omnipack/client.js";
import { buildOmnipackDispatchCommand } from "../../../src/fulfillment/omnipack/omnipackDispatchPayload.js";
import { candidate, config, jsonResponse, stock, stockEvidence } from "./fixtures.js";

it("requests fresh credentials for every HTTP attempt and retains no returned credential object", async () => {
  let generation = 0; let reads = 0;
  const credentials = vi.fn(() => { const current = ++generation; return { username: "example", get password() { reads++; return `placeholder-${current}`; } }; });
  const authorization: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => { authorization.push(new Headers(init?.headers).get("authorization")); return jsonResponse({}, authorization.length === 1 ? 503 : 200); });
  const client = createOmnipackClient({ ...config, credentials }, fetchImpl);
  expect(credentials).not.toHaveBeenCalled();
  await client.getStock(); await client.getProduct("SKU-A");
  expect(credentials).toHaveBeenCalledTimes(3); expect(reads).toBe(3);
  expect(authorization).toEqual([1, 2, 3].map(n => `Basic ${Buffer.from(`example:placeholder-${n}`).toString("base64")}`));
});
it("preserves definitive HTTP rejection status and fallback code when its body is unreadable", async () => {
  const rejectedFetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(Error("unreadable")); } }), { status: 400 }));
  await expect(createOmnipackClient(config, rejectedFetch).createOrder("{}")).rejects.toMatchObject({
    status: 400, code: "http_400", mayHaveSucceeded: false, retryable: false,
  });
  expect(rejectedFetch).toHaveBeenCalledTimes(1);
});
it("sends the exact once-materialized bytes whose hash was prepared", async () => {
  const prepared = buildOmnipackDispatchCommand(candidate());
  prepared.providerPayload.shippingDetails.address.name = "Changed after preparation";
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    expect(init?.body).toBe(prepared.body);
    expect(createHash("sha256").update(init!.body as string).digest("hex")).toBe(prepared.requestFingerprint);
    expect(JSON.parse(init!.body as string).shippingDetails.address.name).toBe("Example Recipient");
    return jsonResponse({ orderId: "provider-1" });
  });
  await createOmnipackClient(config, fetchImpl).createOrder(prepared.body); expect(fetchImpl).toHaveBeenCalledOnce();
});
it("has no environment reader, ambient fetch default or import-time transport call", async () => {
  const root = new URL("../../../src/fulfillment/omnipack/", import.meta.url);
  for (const file of readdirSync(root)) {
    const source = readFileSync(new URL(file, root), "utf8");
    expect(source).not.toMatch(/\bprocess\b|\bimport\s*\(|\beval\s*\(|\bglobalThis\b|=\s*fetch\b/);
  }
  vi.resetModules();
  const imported = await import("../../../src/fulfillment/omnipack/client.js");
  const fetchImpl = vi.fn(); const credentials = vi.fn();
  imported.createOmnipackClient({ ...config, credentials }, fetchImpl);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(credentials).not.toHaveBeenCalled();
});
it("enforces timeout across stalled response body reads and cancels the stream", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel }), { status: 200 }));
    const deadline = 50;
    let settled = false;
    const pending = createOmnipackClient({ ...config, timeoutMs: deadline, safeReadRetries: 0 }, fetchImpl).getStock();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(pending).rejects.toMatchObject({ status: null, code: "network_error", retryable: false });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("refuses oversized response bodies and cancels the stream", async () => {
  const cancel = vi.fn();
  const chunk = new Uint8Array(1024 * 1024);
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      emitted += 1;
      controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
  await expect(createOmnipackClient({ ...config, safeReadRetries: 0 }, fetchImpl).getStock()).rejects.toMatchObject({
    status: null,
    code: "network_error",
    retryable: false,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(emitted).toBe(6);

  const declaredCancel = vi.fn();
  const declaredStream = new ReadableStream({ start() {}, cancel: declaredCancel });
  const declaredFetch = vi.fn(async () => new Response(declaredStream, {
    status: 200,
    headers: { "Content-Length": String(5 * 1024 * 1024 + 1) },
  }));
  await expect(createOmnipackClient({ ...config, safeReadRetries: 0 }, declaredFetch).getStock()).rejects.toMatchObject({
    status: null,
    code: "network_error",
    retryable: false,
  });
  expect(declaredCancel).toHaveBeenCalledOnce();
});
it("respects and caps Retry-After delay on retryable GET responses", async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "RATE_LIMITED" }), { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse(stock));
    const pending = createOmnipackClient({ ...config, timeoutMs: 5_000, safeReadRetries: 1 }, fetchImpl).getStock();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(stockEvidence);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const cappedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "RATE_LIMITED" }), { status: 429, headers: { "Retry-After": "60" } }))
      .mockResolvedValueOnce(jsonResponse(stock));
    const capped = createOmnipackClient({ ...config, timeoutMs: 15_000, safeReadRetries: 1 }, cappedFetch).getStock();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cappedFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capped).resolves.toEqual(stockEvidence);
    expect(cappedFetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
