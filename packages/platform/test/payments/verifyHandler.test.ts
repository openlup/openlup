import { describe, expect, it, vi } from "vitest";
import { createBffResponder } from "@openlup/platform/bff";
import { createCommercePaymentVerifyHandler } from "@openlup/platform/payments";

// Pins current behavior for OSS M07 extraction; must not change with refactors.
// Existing status mappers/header matrices are retained; this composes verify → stored status.
const ORDER = "11111111-1111-4111-8111-111111111111", CLIENT = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333", ATTEMPT = "44444444-4444-4444-8444-444444444444";
const AT = "2026-10-21T10:00:00.000Z";
const ids = { orderId: ORDER, clientId: CLIENT, paymentIntentId: INTENT };
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn() };
  res.status.mockReturnValue(res); return res;
}
function fixture() {
  const readVerifiableAttempt = vi.fn().mockResolvedValue({ orderId: ORDER, orderClientId: CLIENT, orderMode: "one_time",
    paymentIntentId: INTENT, intentStatus: "processing", intentProviderPaymentId: "pi_old", paymentAttemptId: ATTEMPT,
    paymentId: "payment-stored", attemptStatus: "processing", provider: "provider-a", providerAttemptId: "pi_stored",
    providerSessionId: "session-old", amountMinor: 9000, currency: "XXX", localUpdatedAt: AT });
  const applyTerminalResult = vi.fn();
  const readPayment = vi.fn().mockResolvedValue({ status: "unknown", providerStatus: "unrecognized", occurredAt: null,
    amountMinor: null, currency: null, failureReason: null, rawPayload: {} });
  const verify = createCommercePaymentVerifyHandler({ readPort: { readVerifiableAttempt }, applyPort: { applyTerminalResult },
    providers: { "provider-a": { readPayment } }, responder: createBffResponder(), mutationsEnabled: () => true, now: () => new Date(AT) });
  return { verify, readPayment, applyTerminalResult, readVerifiableAttempt };
}

describe("payment return truth characterization", () => {
  it("ignores browser paid/provider/attempt claims, reads the stored attempt and leaves unknown pending", async () => {
    const f = fixture(), verified = response();
    await f.verify({ method: "POST", body: { ...ids, status: "paid", providerPaymentId: "pi_browser",
      paymentAttemptId: "browser-attempt", amountMinor: 1, purpose: "recovery" }, headers: {} } as never, verified as never);
    expect(f.readVerifiableAttempt).toHaveBeenCalledExactlyOnceWith(ids);
    expect(f.readPayment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerPaymentId: "pi_stored",
      purpose: "active_checkout", attempt: expect.objectContaining({ paymentAttemptId: ATTEMPT, amountMinor: 9000 }) }));
    expect(verified.json).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "pending", verified: true, applied: false } }));
    expect(f.applyTerminalResult).not.toHaveBeenCalled();
  });

  it("denies a different stored owner before any provider read", async () => {
    const f = fixture(), denied = response();
    await f.verify({ method: "POST", body: { ...ids, clientId: ORDER }, headers: {} } as never, denied as never);
    expect(denied.status).toHaveBeenCalledWith(404); expect(f.readPayment).not.toHaveBeenCalled();
    expect(f.applyTerminalResult).not.toHaveBeenCalled();
  });

  it("routes terminal mismatched money to manual review while stored status remains processing", async () => {
    const f = fixture(), res = response();
    f.readPayment.mockResolvedValue({ status: "succeeded", providerStatus: "succeeded", amountMinor: 9001,
      currency: "XXX", occurredAt: AT, failureReason: null, rawPayload: {} });
    await f.verify({ method: "POST", body: ids, headers: {} } as never, res as never);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "manual_review", verified: true, applied: false } }));
    expect(f.applyTerminalResult).not.toHaveBeenCalled();

  });

});
