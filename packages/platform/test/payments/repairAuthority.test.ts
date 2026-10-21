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
