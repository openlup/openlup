import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCheckoutRecoveryPolling } from "./useCheckoutRecoveryPolling";

const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));
const diagnosticActionKey = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flags")>();
  return {
    ...actual,
    createCustomerDiagnosticActionKeyWhenEnabled: vi.fn(() => diagnosticActionKey),
    loadCustomerDiagnosticReporterWhenEnabled: vi.fn(() => Promise.resolve(diagnosticReporter)),
  };
});

const TARGET = {
  orderId: "11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
};

describe("useCheckoutRecoveryPolling", () => {
  afterEach(() => {
    vi.useRealTimers();
    diagnosticReporter.reportCustomerJourneyDiagnostic.mockReset();
  });

  it("reports delayed verification without turning a nonterminal attempt into failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"));
    const readStatus = vi.fn(async () => ({
      status: "processing",
      orderStatus: "pending_payment",
      payment: { provider: "stripe", providerPaymentId: "pi_processing" },
    }));
    const onTerminalFailure = vi.fn();
    const onVerificationDelayed = vi.fn();
    const { result } = renderHook(() => useCheckoutRecoveryPolling({
      readStatus,
      onPaid: vi.fn(),
      onProviderPaymentId: vi.fn(),
      onRecoverableDecline: vi.fn(),
      onTerminalFailure,
      onVerificationDelayed,
      onRestorableAttempt: vi.fn(() => false),
    }));

    await act(async () => {
      result.current(TARGET);
      await Promise.resolve();
    });
    expect(readStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-07-21T10:02:01.000Z"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(onVerificationDelayed).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_readback", phase: "attempted", code: "observed", clientActionKey: diagnosticActionKey,
    });
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_readback", phase: "settled", code: "timeout", clientActionKey: diagnosticActionKey,
    });
  });

  it("keeps canonical expired status terminal", async () => {
    const onTerminalFailure = vi.fn();
    const { result } = renderHook(() => useCheckoutRecoveryPolling({
      readStatus: vi.fn(async () => ({ status: "expired", orderStatus: "expired" })),
      onPaid: vi.fn(),
      onProviderPaymentId: vi.fn(),
      onRecoverableDecline: vi.fn(),
      onTerminalFailure,
      onVerificationDelayed: vi.fn(),
      onRestorableAttempt: vi.fn(() => false),
    }));

    await act(async () => {
      result.current(TARGET);
      await Promise.resolve();
    });

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_readback", phase: "settled", code: "failed", clientActionKey: diagnosticActionKey,
    });
  });

  it("keeps a transport failure open until a later terminal readback", async () => {
    vi.useFakeTimers();
    const readStatus = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ status: "paid", orderStatus: "paid" });
    const onPaid = vi.fn();
    const { result } = renderHook(() => useCheckoutRecoveryPolling({
      readStatus,
      onPaid,
      onProviderPaymentId: vi.fn(),
      onRecoverableDecline: vi.fn(),
      onTerminalFailure: vi.fn(),
      onVerificationDelayed: vi.fn(),
      onRestorableAttempt: vi.fn(() => false),
    }));

    await act(async () => {
      result.current(TARGET);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(onPaid).toHaveBeenCalledTimes(1);
    const settled = diagnosticReporter.reportCustomerJourneyDiagnostic.mock.calls
      .map(([event]) => event)
      .filter((event) => event.phase === "settled");
    expect(settled).toEqual([expect.objectContaining({ code: "succeeded", clientActionKey: diagnosticActionKey })]);
  });

  it("cancels an in-flight read without manufacturing a terminal diagnostic", async () => {
    let resolveRead!: (snapshot: { status: string; orderStatus: string }) => void;
    const readStatus = vi.fn(() => new Promise<{ status: string; orderStatus: string }>((resolve) => {
      resolveRead = resolve;
    }));
    const onPaid = vi.fn();
    const { result, unmount } = renderHook(() => useCheckoutRecoveryPolling({
      readStatus,
      onPaid,
      onProviderPaymentId: vi.fn(),
      onRecoverableDecline: vi.fn(),
      onTerminalFailure: vi.fn(),
      onVerificationDelayed: vi.fn(),
      onRestorableAttempt: vi.fn(() => false),
    }));

    await act(async () => {
      result.current(TARGET);
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      resolveRead({ status: "paid", orderStatus: "paid" });
      await Promise.resolve();
    });

    expect(onPaid).not.toHaveBeenCalled();
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic.mock.calls.map(([event]) => event))
      .toEqual([expect.objectContaining({
        action: "checkout_recovery_readback", phase: "attempted", code: "observed", clientActionKey: diagnosticActionKey,
      })]);
  });
});
