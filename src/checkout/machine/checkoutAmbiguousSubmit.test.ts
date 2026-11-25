import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckoutRequest, CheckoutResponse } from "@/domains/commerce/checkoutContracts";
import { BffClientError } from "@/lib/bff/client";

import { recoverAmbiguousCheckoutSubmit } from "./checkoutAmbiguousSubmit";

const { submitCheckout, reportCheckoutClientEvent } = vi.hoisted(() => ({
  submitCheckout: vi.fn(),
  reportCheckoutClientEvent: vi.fn(),
}));

vi.mock("@/domains/commerce/commerceClient", () => ({ submitCheckout }));
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));

/**
 * `vi.restoreAllMocks()` in the shared setup does not reset the calls or the
 * implementations of a `vi.fn()` mock, so this file resets its own.
 */
beforeEach(() => {
  submitCheckout.mockReset();
  reportCheckoutClientEvent.mockReset();
});

const JOURNEY_KEY = "checkout:11111111-1111-4111-8111-111111111111";

function checkoutRequest(): CheckoutRequest {
  return {
    intent: { idempotencyKey: JOURNEY_KEY, lines: [{ slug: "sample", quantity: 2 }] },
    paymentAttemptSequence: 0,
  } as unknown as CheckoutRequest;
}

const RESPONSE = { orderId: "22222222-2222-4222-8222-222222222222" } as unknown as CheckoutResponse;

function bffError(code: ConstructorParameters<typeof BffClientError>[0]["code"], status: number, details?: unknown) {
  return new BffClientError({ code, message: "synthetic failure", details }, status);
}

const timeoutError = () => bffError("UPSTREAM_UNAVAILABLE", 0, { reason: "timeout" });
const inFlightError = () => bffError("CONFLICT", 409, { reason: "provider_attempt_in_flight" });

describe("recoverAmbiguousCheckoutSubmit", () => {
  it.each([
    ["a typed 400 refusal", () => bffError("BAD_REQUEST", 400)],
    ["a plain Error", () => new Error("boom")],
    ["a conflict for another reason", () => bffError("CONFLICT", 409, { reason: "something_else" })],
    ["an upstream failure that is not a timeout", () => bffError("UPSTREAM_UNAVAILABLE", 503, { reason: "overloaded" })],
    ["an aborted request", () => new DOMException("aborted", "AbortError")],
    ["a thrown string", () => "boom"],
  ])("returns null and sends nothing for an error that is not ambiguous: %s", async (_label, make) => {
    await expect(
      recoverAmbiguousCheckoutSubmit({ error: make(), request: checkoutRequest(), options: null }),
    ).resolves.toBeNull();

    expect(submitCheckout).not.toHaveBeenCalled();
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it("reports an explicit in-flight refusal once and never replays it", async () => {
    const result = await recoverAmbiguousCheckoutSubmit({
      error: inFlightError(),
      request: checkoutRequest(),
      options: null,
    });

    expect(result).toEqual({ kind: "in_flight" });
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "submit_rejected_conflict");
    expect(submitCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ["no request", null],
    ["a request without an identity", { intent: {} } as unknown as CheckoutRequest],
  ])("reports the in-flight refusal even with %s", async (_label, request) => {
    const result = await recoverAmbiguousCheckoutSubmit({ error: inFlightError(), request, options: null });

    expect(result).toEqual({ kind: "in_flight" });
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("payment_form", "submit_rejected_conflict");
    expect(submitCheckout).not.toHaveBeenCalled();
  });

  it("reports no conflict event for a transport failure", async () => {
    submitCheckout.mockResolvedValue(RESPONSE);

    const result = await recoverAmbiguousCheckoutSubmit({
      error: new TypeError("Failed to fetch"),
      request: checkoutRequest(),
      options: null,
    });

    expect(result).toEqual({ kind: "recovered", response: RESPONSE });
    expect(submitCheckout).toHaveBeenCalledTimes(1);
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no request", null],
    ["a request without an intent", {} as unknown as CheckoutRequest],
    ["a request without an idempotency key", { intent: { lines: [] } } as unknown as CheckoutRequest],
    ["a request with an empty idempotency key", { intent: { idempotencyKey: "" } } as unknown as CheckoutRequest],
  ])("returns no_stable_identity without sending when there is %s", async (_label, request) => {
    const result = await recoverAmbiguousCheckoutSubmit({
      error: new TypeError("Failed to fetch"),
      request,
      options: null,
    });

    expect(result).toEqual({ kind: "no_stable_identity" });
    expect(submitCheckout).not.toHaveBeenCalled();
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it("replays the identical request exactly once", async () => {
    submitCheckout.mockResolvedValue(RESPONSE);
    const request = checkoutRequest();
    const snapshot = structuredClone(request);

    const result = await recoverAmbiguousCheckoutSubmit({
      error: new TypeError("Failed to fetch"),
      request,
      options: null,
    });

    expect(result).toEqual({ kind: "recovered", response: RESPONSE });
    expect(submitCheckout).toHaveBeenCalledTimes(1);
    // The same object, so the journey key and every field travel unchanged...
    expect(submitCheckout.mock.calls[0]![0]).toBe(request);
    // ...and the replay did not rewrite it on the way.
    expect(request).toEqual(snapshot);
  });

  it("gives the replay a 10 second deadline whatever the caller asked for", async () => {
    submitCheckout.mockResolvedValue(RESPONSE);
    const headers = new Headers({ "x-probe": "1" });
    const fetcher = vi.fn();
    const signal = new AbortController().signal;

    for (const options of [
      { timeoutMs: 30_000, headers, credentials: "include" as const, fetcher, signal },
      { timeoutMs: 1_000, headers, credentials: "include" as const, fetcher, signal },
    ]) {
      submitCheckout.mockClear();
      await recoverAmbiguousCheckoutSubmit({
        error: new TypeError("Failed to fetch"),
        request: checkoutRequest(),
        options,
      });
      // Every other field passes through; only the deadline is replaced.
      expect(submitCheckout.mock.calls[0]![1]).toStrictEqual({
        timeoutMs: 10_000,
        headers,
        credentials: "include",
        fetcher,
        signal,
      });
      // The caller's signal reaches the replay unchanged, not a copy.
      expect(submitCheckout.mock.calls[0]![1].signal).toBe(signal);
    }

    submitCheckout.mockClear();
    await recoverAmbiguousCheckoutSubmit({
      error: new TypeError("Failed to fetch"),
      request: checkoutRequest(),
      options: null,
    });
    expect(submitCheckout.mock.calls[0]![1]).toStrictEqual({ timeoutMs: 10_000 });
  });

  it("treats a timed-out first submit as ambiguous", async () => {
    submitCheckout.mockResolvedValue(RESPONSE);

    const result = await recoverAmbiguousCheckoutSubmit({
      error: timeoutError(),
      request: checkoutRequest(),
      options: null,
    });

    expect(result).toEqual({ kind: "recovered", response: RESPONSE });
    expect(submitCheckout).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", timeoutError],
    ["a transport failure", () => new TypeError("Failed to fetch")],
    ["a refusal", () => bffError("BAD_REQUEST", 400)],
  ])("does not replay a second time when the replay itself fails with %s", async (_label, make) => {
    submitCheckout.mockRejectedValue(make());

    const result = await recoverAmbiguousCheckoutSubmit({
      error: timeoutError(),
      request: checkoutRequest(),
      options: null,
    });

    expect(result).toEqual({ kind: "unknown" });
    expect(submitCheckout).toHaveBeenCalledTimes(1);
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it("keeps in_flight when the replay observes the open attempt", async () => {
    submitCheckout.mockRejectedValue(inFlightError());

    const result = await recoverAmbiguousCheckoutSubmit({
      error: new TypeError("Failed to fetch"),
      request: checkoutRequest(),
      options: null,
    });

    expect(result).toEqual({ kind: "in_flight" });
    expect(submitCheckout).toHaveBeenCalledTimes(1);
    // The conflict event belongs to the first failure only; the replay reports none.
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });
});
