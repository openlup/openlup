import { describe, expect, it, vi } from "vitest";
import { createCheckoutActivePaymentActionResolver, createCheckoutRecoveryPaymentResolver } from "@openlup/platform/payments";
import type { VerifiableAttemptSnapshot, PaymentRecoveryAction } from "@openlup/platform/payments/contracts";

const snapshot: VerifiableAttemptSnapshot = { orderId: "order-original", orderClientId: "client-original", orderMode: "one_time",
  paymentIntentId: "intent-original", intentStatus: "processing", paymentAttemptId: "attempt-original",
  paymentId: "payment-original", attemptStatus: "processing", provider: "provider-a", providerAttemptId: "remote-original",
  providerSessionId: null, intentProviderPaymentId: "remote-original", amountMinor: 9100, currency: "XXX", localUpdatedAt: "2026-10-21T10:00:00Z" };
const authority = { orderId: snapshot.orderId, clientId: snapshot.orderClientId, paymentIntentId: snapshot.paymentIntentId,
  paymentAttemptId: snapshot.paymentAttemptId, executionRail: snapshot.provider };
function fixture() {
  const action: PaymentRecoveryAction = { provider: "provider-a", kind: "redirect", url: "https://example.test/existing" };
  const reading = { status: { status: "pending" as const, providerStatus: "pending", occurredAt: null,
    amountMinor: 9100, currency: "XXX", failureReason: null, rawPayload: {} }, identityMatches: true,
    configuredMoneyMatches: true, manualReviewRequired: false, clientAction: action };
  const read = vi.fn().mockResolvedValue(snapshot), providerRead = vi.fn().mockResolvedValue(reading), apply = vi.fn();
  const deps = { readPort: { readVerifiableAttempt: read }, applyPort: { applyTerminalResult: apply },
    providers: { "provider-a": { resolvePaymentReference: () => "remote-original", readRecoveryPayment: providerRead, readPayment: vi.fn() } },
    railHandoffKinds: (rail: string): readonly ("redirect" | "client-confirmed")[] => rail === "provider-a" ? ["redirect"] : [] };
  return { deps, action, reading, read, providerRead, apply, active: createCheckoutActivePaymentActionResolver(deps),
    recovery: createCheckoutRecoveryPaymentResolver(deps) };
}
describe("public repair authority", () => {
  it("denies a different owner before reading any provider and retains recovery pending/terminal ordering", async () => {
    const f = fixture();
    expect(await f.active.readActiveAction({ ...authority, clientId: "other-owner" })).toBeNull();
    expect(f.providerRead).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(await f.recovery.resolve({ orderId: snapshot.orderId, paymentIntentId: snapshot.paymentIntentId }))
      .toEqual({ kind: "resume_existing", clientAction: f.action });
    expect(f.providerRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ purpose: "active_checkout" }));
    f.read.mockResolvedValue({ ...snapshot, attemptStatus: "succeeded" });
    expect(await f.recovery.resolve({ orderId: snapshot.orderId, paymentIntentId: snapshot.paymentIntentId })).toEqual({ kind: "paid" });
    expect(f.providerRead).toHaveBeenCalledTimes(1);
  });
  it("keeps checkout in review when the provider observed capture but SQL did not settle it", async () => {
    const f = fixture();
    const input = { orderId: snapshot.orderId, paymentIntentId: snapshot.paymentIntentId };
    f.providerRead.mockResolvedValue({ ...f.reading, clientAction: null,
      status: { ...f.reading.status, status: "succeeded", capturedAmountBasis: "provider_capture_v1" } });
    f.apply.mockResolvedValue({ correctionStatus: "ignored", replayed: false,
      paymentResult: { kind: "ignored_success_requiring_review" } });
    const readCaptureReview = vi.fn(async () => false);
    const recovery = createCheckoutRecoveryPaymentResolver({ ...f.deps, applyPort: { ...f.deps.applyPort, readCaptureReview } });
    expect(await recovery.resolve(input)).toEqual({ kind: "manual_review" });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(readCaptureReview).toHaveBeenCalledExactlyOnceWith({ ...input, paymentAttemptId: snapshot.paymentAttemptId });
    f.read.mockResolvedValue({ ...snapshot, intentStatus: "cancelled", attemptStatus: "failed", captureReviewRequired: true });
    f.providerRead.mockClear();
    expect(await recovery.resolve(input)).toEqual({ kind: "manual_review" });
    expect(f.providerRead).not.toHaveBeenCalled();
    expect(readCaptureReview).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("discards a provider handoff when stored review commits during the provider read", async () => {
    const f = fixture();
    f.providerRead.mockImplementation(async () => {
      f.read.mockResolvedValue({ ...snapshot, captureReviewRequired: true, intentStatus: "cancelled", attemptStatus: "failed" });
      return f.reading;
    });
    expect(await f.recovery.resolve({ orderId: snapshot.orderId, paymentIntentId: snapshot.paymentIntentId }))
      .toEqual({ kind: "manual_review" });
    expect(f.providerRead).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("binds the exact attempt, rail capability and second canonical read, failing closed on races or unknown", async () => {
    const f = fixture();
    expect(await f.active.readActiveAction({ ...authority, paymentAttemptId: "stale-attempt" })).toBeNull();
    expect(f.providerRead).not.toHaveBeenCalled();
    expect(await f.active.readActiveAction(authority)).toBe(f.action);
    const unknownCapabilities = createCheckoutActivePaymentActionResolver({ ...f.deps, railHandoffKinds: () => [] });
    expect(await unknownCapabilities.readActiveAction(authority)).toBeNull();
    f.read.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, paymentAttemptId: "new-attempt" });
    expect(await f.active.readActiveAction(authority)).toBeNull();
    f.read.mockResolvedValue(snapshot); f.reading.clientAction = { ...f.action, provider: "provider-b" };
    expect(await f.active.readActiveAction(authority)).toBeNull();
    f.reading.clientAction = f.action; f.providerRead.mockResolvedValue({ ...f.reading, status: { status: "unknown" } });
    expect(await f.active.readActiveAction(authority)).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
  });
});
