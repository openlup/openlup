// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentRecoveryStatusResponse } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import { useCheckoutRecoveryGuidance } from "./useCheckoutRecoveryGuidance";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/domains/commerce/paymentRecoveryGuidanceClient", () => ({ getPaymentRecoveryStatus: read }));
const request = { orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", clientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const attempt = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const snapshot = (): PaymentRecoveryStatusResponse => ({
  contractVersion: "commerce.checkout.v2", ...request, status: "failed", orderStatus: "pending",
  payment: { intentStatus: "failed", attemptStatus: "failed", paymentAttemptId: attempt, provider: "example",
    providerPaymentId: "transaction", updatedAt: "2026-09-11T12:00:00Z" },
  failureReason: null, subscriptionActivation: { status: "not_applicable", subscriptionId: null }, nextAction: null,
  recoveryGuidance: { version: 1, paymentAttemptId: attempt, purchaseContext: "one_time", cause: "generic_decline",
    methodKind: "card", methodKey: "card", operation: "one_time_payment", restriction: null,
    actions: ["change_method"], consecutiveRefusals: 1, emphasis: "normal" },
});
const deferred = () => {
  let resolve!: (value: PaymentRecoveryStatusResponse) => void;
  return { promise: new Promise<PaymentRecoveryStatusResponse>((done) => { resolve = done; }), resolve: (value: PaymentRecoveryStatusResponse) => resolve(value) };
};
afterEach(() => { read.mockReset(); vi.useRealTimers(); });

describe("bounded authorized recovery guidance read", () => {
  it("reads once per identity, accepts snapshot current attempt when unknown, and passes token only in transport", async () => {
    read.mockResolvedValue(snapshot());
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: { ...request }, recoveryToken: "opaque-credential" }));
    await waitFor(() => expect(view.result.current.guidance?.paymentAttemptId).toBe(attempt));
    view.rerender();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(request, { signal: expect.any(AbortSignal), recoveryToken: "opaque-credential" });
    expect(JSON.stringify(read.mock.calls[0][0])).not.toContain("opaque-credential");
  });
  it("discards a late response after attempt replacement and clears existing guidance immediately", async () => {
    const late = deferred();
    read.mockResolvedValueOnce(snapshot()).mockReturnValueOnce(late.promise);
    const view = renderHook(({ paymentAttemptId }) => useCheckoutRecoveryGuidance({ statusRequest: request, paymentAttemptId }), { initialProps: { paymentAttemptId: attempt } });
    await waitFor(() => expect(view.result.current.guidance).not.toBeNull());
    view.rerender({ paymentAttemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    expect(view.result.current.guidance).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => late.resolve(snapshot()));
    expect(view.result.current.response).toBeNull();
  });
  it("generation protects a new submit even if the next attempt ID is not yet known", async () => {
    const first = deferred();
    const second = deferred();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = renderHook(({ enabled }) => useCheckoutRecoveryGuidance({ statusRequest: request, enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    view.rerender({ enabled: false });
    expect(read.mock.calls[0][1].signal.aborted).toBe(true);
    view.rerender({ enabled: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve(snapshot()));
    expect(view.result.current.guidance).toBeNull();
    await act(async () => second.resolve(snapshot()));
    expect(view.result.current.guidance?.paymentAttemptId).toBe(attempt);
  });
  it("aborts on current paid and ignores late refused state", async () => {
    const late = deferred();
    read.mockReturnValue(late.promise);
    const view = renderHook(({ currentPaid }) => useCheckoutRecoveryGuidance({ statusRequest: request, currentPaid }), { initialProps: { currentPaid: false } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    view.rerender({ currentPaid: true });
    expect(read.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => late.resolve(snapshot()));
    expect(view.result.current.guidance).toBeNull();
  });
  it.each(["paid", "processing", "expired", "requires_action"] as const)("does not advise another charge for %s", async (status) => {
    read.mockResolvedValue({ ...snapshot(), status });
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await waitFor(() => expect(view.result.current.response?.status).toBe(status));
    expect(view.result.current.guidance).toBeNull();
  });
  it.each(["succeeded", "refunded", "partially_refunded", "disputed"] as const)("paid precedence rejects stale failure beside %s intent", async (intentStatus) => {
    const value = snapshot(); value.payment.intentStatus = intentStatus;
    read.mockResolvedValue(value);
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await waitFor(() => expect(view.result.current.response).not.toBeNull());
    expect(view.result.current.guidance).toBeNull();
  });
  it("requires same order, intent and snapshot current attempt", async () => {
    const value = snapshot(); value.recoveryGuidance!.paymentAttemptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    read.mockResolvedValue(value);
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await waitFor(() => expect(view.result.current.response).not.toBeNull());
    expect(view.result.current.guidance).toBeNull();
    read.mockResolvedValue({ ...snapshot(), orderId: request.clientId });
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.response).toBeNull();
  });
  it("refresh reads again but never persists advice or invokes a submit", async () => {
    read.mockResolvedValue(snapshot());
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await waitFor(() => expect(view.result.current.guidance).not.toBeNull());
    read.mockResolvedValue({ ...snapshot(), status: "paid" });
    await act(async () => { expect((await view.result.current.refresh())?.status).toBe("paid"); });
    expect(view.result.current.guidance).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it("failed reads preserve legacy fallback and do not retry automatically", async () => {
    read.mockRejectedValue(new Error("unavailable"));
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.response).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("aborts a hanging read after the bounded window", async () => {
    vi.useFakeTimers();
    read.mockImplementation((_request, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(read.mock.calls[0][1].signal.aborted).toBe(true);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.guidance).toBeNull();
  });
  it.each(["disabled", "paid"] as const)("does not dispatch when %s wins before the reader module finishes loading", async (winner) => {
    let release!: () => void;
    let started!: () => void;
    const moduleReady = new Promise<void>((resolve) => { release = resolve; });
    const moduleStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.doMock("@/domains/commerce/paymentRecoveryGuidanceClient", async () => {
      started();
      await moduleReady;
      return { getPaymentRecoveryStatus: read };
    });
    read.mockResolvedValue(snapshot());
    try {
      const view = renderHook(({ enabled, currentPaid }) => useCheckoutRecoveryGuidance({ statusRequest: request, enabled, currentPaid }),
        { initialProps: { enabled: true, currentPaid: false } });
      await act(async () => { await moduleStarted; });
      expect(view.result.current.loading).toBe(true);
      expect(read).not.toHaveBeenCalled();
      view.rerender({ enabled: winner !== "disabled", currentPaid: winner === "paid" });
      await act(async () => { release(); await vi.dynamicImportSettled(); });
      expect(read).not.toHaveBeenCalled();
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.response).toBeNull();
      expect(view.result.current.guidance).toBeNull();
    } finally {
      release();
      vi.doMock("@/domains/commerce/paymentRecoveryGuidanceClient", () => ({ getPaymentRecoveryStatus: read }));
      // Consume the queued restore before the next case queues its own factory.
      await import("@/domains/commerce/paymentRecoveryGuidanceClient");
    }
  });
  it("includes an unresolved reader-module load in the same 10-second deadline and never dispatches after expiry", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const moduleReady = new Promise<void>((resolve) => { release = resolve; });
    const moduleStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.doMock("@/domains/commerce/paymentRecoveryGuidanceClient", async () => {
      started();
      await moduleReady;
      return { getPaymentRecoveryStatus: read };
    });
    read.mockResolvedValue(snapshot());
    try {
      const view = renderHook(() => useCheckoutRecoveryGuidance({ statusRequest: request }));
      await act(async () => { await moduleStarted; });
      expect(read).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
      expect(view.result.current.loading).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.response).toBeNull();
      expect(read).not.toHaveBeenCalled();
      await act(async () => { release(); await vi.dynamicImportSettled(); });
      expect(read).not.toHaveBeenCalled();
      expect(view.result.current.guidance).toBeNull();
    } finally {
      release();
      vi.doMock("@/domains/commerce/paymentRecoveryGuidanceClient", () => ({ getPaymentRecoveryStatus: read }));
      await import("@/domains/commerce/paymentRecoveryGuidanceClient");
    }
  });
});
