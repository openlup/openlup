/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadStripeMock = vi.hoisted(() => vi.fn());
vi.mock("@stripe/stripe-js", () => ({ loadStripe: loadStripeMock }));

const reportCheckoutClientEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));

import {
  STRIPE_LOAD_TIMEOUT_MS,
  resetStripePromiseCacheForTests,
  useStripeLoader,
  useStripePromise,
} from "./useStripePromise";

beforeEach(() => {
  resetStripePromiseCacheForTests();
  loadStripeMock.mockReset();
  reportCheckoutClientEvent.mockReset();
  vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "pk_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("useStripeLoader", () => {
  it("reports ready once the provider script resolves", async () => {
    loadStripeMock.mockResolvedValue({ id: "stripe" });
    const { result } = renderHook(() => useStripeLoader());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loadStripeMock).toHaveBeenCalledWith("pk_test_key");
  });

  it("reports unconfigured, and never calls the loader, without a publishable key", () => {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "");
    const { result } = renderHook(() => useStripeLoader());

    expect(result.current.status).toBe("unconfigured");
    expect(result.current.stripePromise).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
  });

  it("surfaces a rejected load as a failure instead of an eternally pending promise", async () => {
    loadStripeMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useStripeLoader());

    await waitFor(() => expect(result.current.status).toBe("failed"));
  });

  // The core of the incident: the old module cached whatever `loadStripe`
  // returned, so ONE rejection poisoned every later mount for the whole session
  // and no retry could ever reach the network again.
  it("does not cache a rejected load, so a retry genuinely re-invokes the loader", async () => {
    loadStripeMock.mockRejectedValueOnce(new Error("network down"));
    loadStripeMock.mockResolvedValueOnce({ id: "stripe" });

    const { result } = renderHook(() => useStripeLoader());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(loadStripeMock).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loadStripeMock).toHaveBeenCalledTimes(2);
  });

  it("fails a load that never settles once the timeout budget is spent", async () => {
    vi.useFakeTimers();
    loadStripeMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStripeLoader());

    expect(result.current.status).toBe("loading");
    await act(async () => {
      vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("failed");
  });

  // P6: the buyer sees `failed` either way, but a refused script and a webview
  // that never answers are different incidents for us, and the rejection reason
  // is the only place that difference still exists.
  it("reports a refused load as a load failure", async () => {
    loadStripeMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useStripeLoader());

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("psp_loader", "psp_js_load_failed");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
  });

  it("reports a load that never settled as a timeout, not a failure", async () => {
    vi.useFakeTimers();
    loadStripeMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useStripeLoader());

    await act(async () => {
      vi.advanceTimersByTime(STRIPE_LOAD_TIMEOUT_MS + 1);
      await Promise.resolve();
    });

    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("psp_loader", "psp_js_load_timeout");
  });

  // A resolved-but-empty load leaves no card form either, so it is a failure
  // that has to be reported even though nothing rejected.
  it("reports a load that resolved without producing an instance", async () => {
    loadStripeMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStripeLoader());

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("psp_loader", "psp_js_load_failed");
  });

  it("reports the happy path too, because a load that worked is evidence", async () => {
    // ⛔ This used to assert SILENCE. A missing failure code and a payment step
    // that never loaded the script look identical in the drain, and the
    // 2026-09-02 report needed to tell them apart: nine card checkouts failed
    // without one of them reaching the provider.
    loadStripeMock.mockResolvedValue({ id: "stripe" });
    const { result } = renderHook(() => useStripeLoader());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("psp_loader", "psp_js_load_ok");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load across consumers", async () => {
    loadStripeMock.mockResolvedValue({ id: "stripe" });
    const first = renderHook(() => useStripeLoader());
    const second = renderHook(() => useStripeLoader());

    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(loadStripeMock).toHaveBeenCalledTimes(1);
  });
});

describe("useStripePromise", () => {
  // `WalletExpressRow` is out of this wave's scope and consumes exactly this
  // shape: a promise, or `null` when no key is configured.
  it("keeps returning the promise alone", async () => {
    loadStripeMock.mockResolvedValue({ id: "stripe" });
    const { result } = renderHook(() => useStripePromise());

    expect(result.current).toBeInstanceOf(Promise);
    await expect(result.current).resolves.toEqual({ id: "stripe" });
  });

  it("keeps returning null when no publishable key is configured", () => {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "");
    const { result } = renderHook(() => useStripePromise());

    expect(result.current).toBeNull();
  });
});
