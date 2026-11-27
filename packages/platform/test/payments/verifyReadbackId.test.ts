import { describe, expect, it, vi } from "vitest";
import { verifyPaymentAttemptNow } from "../../src/payments/paymentVerifyNowService.js";
import type {
  PaymentProviderReconciliationProvider,
  VerifiableAttemptSnapshot,
} from "../../src/payments/contracts/reconciliation.js";
import { createTpayPaymentReconciliationProvider } from "../../src/payments/tpay/tpayPaymentReconciliationProvider.js";

const AT = "2026-11-27T12:00:00.000Z";

function baseSnapshot(overrides: Partial<VerifiableAttemptSnapshot> = {}): VerifiableAttemptSnapshot {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderClientId: "22222222-2222-4222-8222-222222222222",
    orderMode: "one_time",
    paymentIntentId: "33333333-3333-4333-8333-333333333333",
    intentStatus: "processing",
    intentProviderPaymentId: "TR-DISPLAY-TITLE",
    paymentAttemptId: "44444444-4444-4444-8444-444444444444",
    paymentId: "55555555-5555-4555-8555-555555555555",
    attemptStatus: "processing",
    provider: "tpay",
    providerAttemptId: "TR-DISPLAY-TITLE",
    providerSessionId: "01KZTPM9SVY8C9C2R70FSA63AJ",
    amountMinor: 14900,
    currency: "PLN",
    localUpdatedAt: AT,
    ...overrides,
  };
}

describe("verifyPaymentAttemptNow provider-owned resolveReadbackId", () => {
  it("consults provider.resolveReadbackId before falling back to providerAttemptId", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "pending",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "PLN",
      rawPayload: {},
    });
    const resolveReadbackId = vi.fn((snapshot: { providerSessionId?: string | null }) => snapshot.providerSessionId);
    const provider: PaymentProviderReconciliationProvider = { readPayment, resolveReadbackId };
    const snapshot = baseSnapshot({ provider: "custom-rail" });

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { "custom-rail": provider },
      now: () => new Date(AT),
    });

    expect(resolveReadbackId).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(readPayment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        providerPaymentId: "01KZTPM9SVY8C9C2R70FSA63AJ",
        attempt: expect.objectContaining({ providerPaymentId: "01KZTPM9SVY8C9C2R70FSA63AJ" }),
      }),
    );
    expect(result).toMatchObject({
      status: "pending",
      verified: true,
      applied: false,
      providerPaymentId: "01KZTPM9SVY8C9C2R70FSA63AJ",
    });
  });

  it("keeps existing fallback order for providers that omit resolveReadbackId", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "processing",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "PLN",
      rawPayload: {},
    });
    const snapshot = baseSnapshot({
      provider: "legacy-rail",
      providerAttemptId: "pi_attempt",
      intentProviderPaymentId: "pi_intent",
      providerSessionId: "cs_session",
    });

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { "legacy-rail": { readPayment } },
      now: () => new Date(AT),
    });

    expect(readPayment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerPaymentId: "pi_attempt" }),
    );
    expect(result.providerPaymentId).toBe("pi_attempt");
  });

  it("falls back to existing order when resolveReadbackId returns undefined", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "processing",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "PLN",
      rawPayload: {},
    });
    const snapshot = baseSnapshot({
      provider: "deferring-rail",
      providerAttemptId: null,
      intentProviderPaymentId: "pi_intent",
      providerSessionId: "cs_session",
    });

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { "deferring-rail": { readPayment, resolveReadbackId: () => undefined } },
      now: () => new Date(AT),
    });

    expect(readPayment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerPaymentId: "pi_intent" }),
    );
    expect(result.providerPaymentId).toBe("pi_intent");
  });

  it("treats explicit null from resolveReadbackId as unavailable instead of falling back to TR-* title", async () => {
    const getTransaction = vi.fn();
    const tpayProvider = createTpayPaymentReconciliationProvider({ getTransaction });
    const snapshot = baseSnapshot({
      provider: "tpay",
      providerAttemptId: "TR-7Y65-Z346CJX",
      intentProviderPaymentId: "TR-7Y65-Z346CJX",
      providerSessionId: null,
    });

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { tpay: tpayProvider },
      now: () => new Date(AT),
    });

    expect(getTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "unavailable",
      verified: false,
      applied: false,
      providerPaymentId: null,
      attempt: null,
    });
  });

  it("reads Tpay transaction via providerSessionId rather than TR-* providerAttemptId", async () => {
    const getTransaction = vi.fn().mockResolvedValue({
      transactionId: "01KZTPM9SVY8C9C2R70FSA63AJ",
      title: "TR-7Y65-Z346CJX",
      status: "correct",
      transactionPaymentUrl: null,
      amount: 149,
      currency: "PLN",
      requestId: "req-1",
      payments: { amountPaid: "149.00" },
    });
    const applyTerminalResult = vi.fn().mockResolvedValue({
      replayed: false,
      correctionStatus: "corrected",
      paymentResult: {
        paymentIntentId: "33333333-3333-4333-8333-333333333333",
        paymentAttemptId: "44444444-4444-4444-8444-444444444444",
        paymentId: "55555555-5555-4555-8555-555555555555",
        orderId: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        kind: "applied",
        replayed: false,
      },
      subscriptionWebhookDunning: null,
    });
    const tpayProvider = createTpayPaymentReconciliationProvider({ getTransaction });

    const result = await verifyPaymentAttemptNow({
      snapshot: baseSnapshot({
        provider: "tpay",
        providerAttemptId: "TR-7Y65-Z346CJX",
        intentProviderPaymentId: "TR-7Y65-Z346CJX",
        providerSessionId: "01KZTPM9SVY8C9C2R70FSA63AJ",
      }),
      applyPort: { applyTerminalResult },
      providers: { tpay: tpayProvider },
      now: () => new Date(AT),
    });

    expect(getTransaction).toHaveBeenCalledExactlyOnceWith("01KZTPM9SVY8C9C2R70FSA63AJ");
    expect(applyTerminalResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "tpay",
        providerPaymentId: "01KZTPM9SVY8C9C2R70FSA63AJ",
        resultStatus: "succeeded",
      }),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      verified: true,
      applied: true,
      providerPaymentId: "01KZTPM9SVY8C9C2R70FSA63AJ",
    });
  });

  it("honors an explicit input.providerPaymentId override without calling resolveReadbackId", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "pending",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "PLN",
      rawPayload: {},
    });
    const resolveReadbackId = vi.fn();

    const result = await verifyPaymentAttemptNow({
      snapshot: baseSnapshot({ provider: "custom-rail" }),
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { "custom-rail": { readPayment, resolveReadbackId } },
      providerPaymentId: "explicit-override-id",
      now: () => new Date(AT),
    });

    expect(resolveReadbackId).not.toHaveBeenCalled();
    expect(readPayment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerPaymentId: "explicit-override-id" }),
    );
    expect(result.providerPaymentId).toBe("explicit-override-id");
  });
});
