/** @vitest-environment jsdom -- the engine drives React state and window timers. */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCheckoutPaymentWait, type CheckoutPaymentWaitOptions } from "./useCheckoutPaymentWait";
import { createAccountConfiguratorDraftScope } from "@/checkout/composer/configuratorDraftStore";
import { PAYMENT_FAILURE_DISPLAY_REASONS } from "@/domains/commerce/paymentFailureDisplayContracts";

const { mockGetCommercePaymentStatus, mockVerifyPaymentNow, mockClearPersistedForm } = vi.hoisted(() => ({
  mockGetCommercePaymentStatus: vi.fn(),
  mockVerifyPaymentNow: vi.fn(),
  mockClearPersistedForm: vi.fn(),
}));

vi.mock("@/domains/commerce/commerceClient", () => ({
  getCommercePaymentStatus: mockGetCommercePaymentStatus,
}));

vi.mock("@/domains/commerce/paymentVerifyClient", () => ({
  verifyCommercePaymentNowBounded: mockVerifyPaymentNow,
}));

vi.mock("@/checkout/composer/configuratorFormStore", () => ({
  clearPersistedConfiguratorFormData: mockClearPersistedForm,
}));

const STATUS_REQUEST = {
  orderId: "44444444-4444-4444-8444-444444444444",
  paymentIntentId: "55555555-5555-4555-8555-555555555555",
  clientId: "66666666-6666-4666-8666-666666666666",
};

const stillProcessing = {
  status: "processing",
  orderId: STATUS_REQUEST.orderId,
  paymentIntentId: STATUS_REQUEST.paymentIntentId,
  subscriptionActivation: { status: "not_applicable", subscriptionId: null },
};

/** React state lands inside act(), so the polling loop cannot warn. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function mount(overrides: Partial<CheckoutPaymentWaitOptions> = {}) {
  const onPaid = vi.fn();
  const onTerminal = vi.fn();
  const options: CheckoutPaymentWaitOptions = {
    statusRequest: STATUS_REQUEST,
    draftScope: { kind: "public" },
    onPaid,
    onTerminal,
    ...overrides,
  };
  // Re-created every render on purpose: a real host passes inline arrows, and the
  // engine must not treat that as a reason to restart its clock.
  const view = renderHook(() => useCheckoutPaymentWait({ ...options }));
  return { ...view, onPaid, onTerminal };
}

afterEach(() => {
  vi.useRealTimers();
  mockGetCommercePaymentStatus.mockReset();
  mockVerifyPaymentNow.mockReset();
  mockClearPersistedForm.mockReset();
  sessionStorage.clear();
});

describe("useCheckoutPaymentWait", () => {
  it("replaces the seeded identity and clears it on an authoritative null", async () => {
    vi.useFakeTimers();
    mockGetCommercePaymentStatus
      .mockResolvedValueOnce({ ...stillProcessing, payment: { providerPaymentId: "current-reference" } })
      .mockResolvedValue({ ...stillProcessing, payment: { providerPaymentId: null } });
    const { result } = mount({ initialProviderPaymentId: "stale-reference" });
    await advance(0);
    expect(result.current.providerPaymentId).toBe("current-reference");
    await advance(5000);
    expect(result.current.providerPaymentId).toBe("");
    expect(result.current.status).toBe("processing");
  });

  it("hands a settled payment to the host instead of navigating itself", async () => {
    const paid = { ...stillProcessing, status: "paid" };
    mockGetCommercePaymentStatus.mockResolvedValue(paid);

    const { onPaid, onTerminal } = mount();

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(onPaid).toHaveBeenCalledWith(paid);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  /**
   * Trap the extraction exists to close: the underlying clear defaults to the
   * PUBLIC draft when called with no argument. A host mounted inside an
   * account-scoped configurator would silently wipe the wrong buyer's draft, so
   * the scope must travel from the caller all the way to the clear.
   */
  it("clears the draft the CALLER named, not the default public one", async () => {
    mockGetCommercePaymentStatus.mockResolvedValue({ ...stillProcessing, status: "paid" });
    const scope = createAccountConfiguratorDraftScope(STATUS_REQUEST.clientId);

    const { onPaid } = mount({ draftScope: scope });

    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(mockClearPersistedForm).toHaveBeenCalledWith(scope);
  });

  it("reports the resolved display bucket to the host, never the provider's own reason", async () => {
    mockGetCommercePaymentStatus.mockResolvedValue({
      ...stillProcessing,
      status: "failed",
      // The two differ on purpose here: the host must receive the bucket, and
      // the provider-native identity must not leave the server.
      failureReason: "a_provider_native_identity",
      failureDisplay: "blik_recurring_unsupported_bank",
    });

    const { onTerminal, onPaid } = mount();

    await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    expect(onTerminal).toHaveBeenCalledWith("failed", "blik_recurring_unsupported_bank", true);
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("reports no bucket when the refusal maps to none", async () => {
    mockGetCommercePaymentStatus.mockResolvedValue({
      ...stillProcessing,
      status: "failed",
      failureReason: "provider_declined",
      failureDisplay: null,
    });

    const { onTerminal } = mount();

    await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    expect(onTerminal).toHaveBeenCalledWith("failed", null, true);
  });

  it.each(PAYMENT_FAILURE_DISPLAY_REASONS)("recovers only a known display reason from an older server: %s", async (failureReason) => {
    mockGetCommercePaymentStatus.mockResolvedValue({ ...stillProcessing, status: "failed", failureReason });
    const { onTerminal } = mount();
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith("failed", failureReason, true));
  });

  it.each(["unknown_native_code", "provider_declined_extra", " provider_declined", null])("does not guess an older server's refusal %s", async (failureReason) => {
    mockGetCommercePaymentStatus.mockResolvedValue({ ...stillProcessing, status: "failed", failureReason });
    const { onTerminal } = mount();
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith("failed", null, failureReason !== null));
  });

  it("falls back to a full-page redirect when the host does not own one", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockGetCommercePaymentStatus.mockResolvedValue({
      ...stillProcessing,
      nextAction: { kind: "redirect", url: "https://secure.example/continue" },
    });

    mount({ statusRequest: { ...STATUS_REQUEST, journeyId: "checkout:77777777-7777-4777-8777-777777777777" } });
    await advance(100);

    expect(assign).toHaveBeenCalledWith("https://secure.example/continue");
    vi.unstubAllGlobals();
  });

  it("says so at the cap, keeps listening, and never calls the wait a failure", async () => {
    vi.useFakeTimers();
    mockGetCommercePaymentStatus.mockResolvedValue(stillProcessing);
    mockVerifyPaymentNow.mockResolvedValue({ status: "pending", verified: true, applied: false });

    const { result, onTerminal, onPaid } = mount();
    await advance(125_000);

    expect(result.current.waitExhausted).toBe(true);
    const callsAtCap = mockGetCommercePaymentStatus.mock.calls.length;

    // Flagged but NOT stopped. The wait stops promising, not listening: a late
    // webhook still lands the buyer on their terminal on its own, which is what
    // removes the need for a "check again" button rather than relabelling one.
    await advance(60_000);
    const callsAfter = mockGetCommercePaymentStatus.mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsAtCap);
    // ...and at the slower cadence, not the pre-cap one: 60s of 10s polling is
    // ~6 reads, nowhere near the ~24 that 2.5s polling would have made.
    expect(callsAfter - callsAtCap).toBeLessThanOrEqual(8);
    // Reaching the cap is NOT a failure: routing away from here is how a buyer
    // whose payment DID go through gets charged twice.
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("resumes the wait, as a re-read, when the buyer asks again", async () => {
    vi.useFakeTimers();
    mockGetCommercePaymentStatus.mockResolvedValue(stillProcessing);
    mockVerifyPaymentNow.mockResolvedValue({ status: "pending", verified: true, applied: false });

    const { result, onPaid } = mount();
    await advance(185_000);
    const callsAtCap = mockGetCommercePaymentStatus.mock.calls.length;

    mockGetCommercePaymentStatus.mockResolvedValue({ ...stillProcessing, status: "paid" });
    await act(async () => { result.current.checkAgain(); });
    await advance(3_000);

    expect(result.current.waitExhausted).toBe(false);
    expect(mockGetCommercePaymentStatus.mock.calls.length).toBeGreaterThan(callsAtCap);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("does not carry an exhausted wait into the next one", async () => {
    // The controller outlives a single wait. If the flag survived, the next wait
    // would open already marked exhausted, and the funnel instrument built on it
    // would report an ending for a wait that had only just begun.
    vi.useFakeTimers();
    mockGetCommercePaymentStatus.mockResolvedValue(stillProcessing);
    const options: CheckoutPaymentWaitOptions = {
      statusRequest: STATUS_REQUEST,
      draftScope: { kind: "public" },
      onPaid: vi.fn(),
      onTerminal: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ request }: { request: CheckoutPaymentWaitOptions["statusRequest"] }) =>
        useCheckoutPaymentWait({ ...options, statusRequest: request }),
      { initialProps: { request: STATUS_REQUEST } },
    );

    await advance(185_000);
    expect(result.current.waitExhausted).toBe(true);

    rerender({ request: null });

    expect(result.current.waitExhausted).toBe(false);
  });

  it("stays completely idle without a pollable identity", () => {
    mount({ statusRequest: null });

    expect(mockGetCommercePaymentStatus).not.toHaveBeenCalled();
  });

});
