import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_CLIENT_EVENT_CODES,
  CHECKOUT_CLIENT_EVENT_PATH,
  reportCheckoutClientEvent,
  resetCheckoutClientEventDedupForTests,
} from "./checkoutClientEvent";

describe("reportCheckoutClientEvent", () => {
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetCheckoutClientEventDedupForTests();
  });

  afterEach(() => {
    setNavigator(originalNavigator);
    setFetch(originalFetch);
    vi.restoreAllMocks();
  });

  it("sends the closed payload through sendBeacon", async () => {
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    setNavigator({ sendBeacon } as unknown as Navigator);
    const fetchSpy = vi.fn();
    setFetch(fetchSpy as unknown as typeof fetch);

    reportCheckoutClientEvent("psp_loader", "psp_js_load_timeout");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0][0]).toBe(CHECKOUT_CLIENT_EVENT_PATH);
    const blob = sendBeacon.mock.calls[0][1] as Blob;
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toEqual({
      stage: "psp_loader",
      code: "psp_js_load_timeout",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // `sendBeacon` reports refusal by RETURNING FALSE, not by throwing — a queue
  // that is full, or a transport a webview declined. A caller that ignores the
  // return value silently loses exactly the reports this wave exists to collect.
  it("falls back to keepalive fetch when sendBeacon refuses the request", () => {
    setNavigator({ sendBeacon: vi.fn(() => false) } as unknown as Navigator);
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    setFetch(fetchSpy as unknown as typeof fetch);

    reportCheckoutClientEvent("quote_gate", "submit_blocked_quote_refreshing");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(CHECKOUT_CLIENT_EVENT_PATH);
    expect(init?.method).toBe("POST");
    expect(init?.keepalive).toBe(true);
    expect(init?.body).toBe(
      JSON.stringify({ stage: "quote_gate", code: "submit_blocked_quote_refreshing" }),
    );
  });

  it("falls back to fetch when the browser has no sendBeacon at all", () => {
    setNavigator({} as unknown as Navigator);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    setFetch(fetchSpy as unknown as typeof fetch);

    reportCheckoutClientEvent("route_error", "render_crash");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends one report per stage and code for the whole page session", () => {
    const sendBeacon = vi.fn(() => true);
    setNavigator({ sendBeacon } as unknown as Navigator);

    reportCheckoutClientEvent("route_error", "render_crash");
    reportCheckoutClientEvent("route_error", "render_crash");
    reportCheckoutClientEvent("route_error", "render_crash");

    expect(sendBeacon).toHaveBeenCalledTimes(1);

    // A different pair is a different fact and must still get through.
    reportCheckoutClientEvent("payment_form", "payment_element_not_ready");
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  // ⛔ Every call site fires while the purchase is ALREADY failing. A throw here
  // turns a recoverable dead end into a hard one.
  it("swallows a sendBeacon that throws", () => {
    setNavigator({
      sendBeacon: vi.fn(() => {
        throw new Error("beacon refused by the webview");
      }),
    } as unknown as Navigator);
    setFetch(undefined as unknown as typeof fetch);

    expect(() => reportCheckoutClientEvent("psp_loader", "psp_js_load_failed")).not.toThrow();
  });

  it("swallows a fetch that rejects, without producing an unhandled rejection", async () => {
    setNavigator({ sendBeacon: vi.fn(() => false) } as unknown as Navigator);
    const rejection = Promise.reject(new Error("network refused"));
    setFetch(vi.fn(() => rejection) as unknown as typeof fetch);

    expect(() => reportCheckoutClientEvent("psp_loader", "psp_js_load_failed")).not.toThrow();
    await expect(rejection.catch(() => "handled")).resolves.toBe("handled");
  });

  it("stays silent when the page has neither transport", () => {
    setNavigator(undefined as unknown as Navigator);
    setFetch(undefined as unknown as typeof fetch);

    expect(() => reportCheckoutClientEvent("quote_gate", "forced_return_to_summary")).not.toThrow();
  });
});

function setNavigator(value: Navigator | undefined): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function setFetch(value: typeof fetch | undefined): void {
  Object.defineProperty(globalThis, "fetch", {
    value,
    configurable: true,
    writable: true,
  });
}

// The vocabulary is pinned member-for-member against the ROUTE's copy in
// `server/bff/commerce/checkout-client-event.test.ts`, which is the falsifier
// that matters. What that test cannot state is the property the closed contract
// rests on: the codes are a vocabulary, not a schema, so widening the list must
// never widen the payload.
describe("the widened vocabulary stays a vocabulary", () => {
  beforeEach(() => {
    resetCheckoutClientEventDedupForTests();
  });

  it("carries the four card-report codes and nothing that could identify anyone", async () => {
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { sendBeacon } as unknown as Navigator,
    });

    const added = [
      "payment_step_abandoned",
      "payment_step_exited_back",
      "submit_rejected_conflict",
      "psp_confirm_no_response",
    ] as const;
    for (const code of added) {
      expect(CHECKOUT_CLIENT_EVENT_CODES).toContain(code);
      reportCheckoutClientEvent("payment_form", code);
    }

    expect(sendBeacon).toHaveBeenCalledTimes(added.length);
    for (const [index, code] of added.entries()) {
      const body = JSON.parse(await (sendBeacon.mock.calls[index][1] as Blob).text());
      // EXACTLY two keys. The first extra field anyone adds under incident
      // pressure is an identifier, so the count is asserted, not the absence of
      // one particular name.
      expect(Object.keys(body).sort()).toEqual(["code", "stage"]);
      expect(body).toEqual({ stage: "payment_form", code });
    }

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
  });

  // Every code has exactly one producer, and the departure listeners can fire
  // repeatedly on a page that is already in trouble. The dedup is what keeps
  // that from becoming a request loop aimed at an unauthenticated endpoint.
  it("still reports each new code at most once per page session", () => {
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { sendBeacon } as unknown as Navigator,
    });

    reportCheckoutClientEvent("payment_form", "payment_step_abandoned");
    reportCheckoutClientEvent("payment_form", "payment_step_abandoned");
    reportCheckoutClientEvent("payment_form", "payment_step_exited_back");

    expect(sendBeacon).toHaveBeenCalledTimes(2);

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
  });
});
