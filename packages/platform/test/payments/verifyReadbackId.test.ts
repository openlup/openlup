import { describe, expect, it, vi } from "vitest";
import { verifyPaymentAttemptNow } from "../../src/payments/paymentVerifyNowService.js";
import type {
  PaymentProviderReconciliationProvider,
  VerifiableAttemptSnapshot,
} from "../../src/payments/contracts/reconciliation.js";

const AT = "2026-11-27T12:00:00.000Z";

function baseSnapshot(overrides: Partial<VerifiableAttemptSnapshot> = {}): VerifiableAttemptSnapshot {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderClientId: "22222222-2222-4222-8222-222222222222",
    orderMode: "one_time",
    paymentIntentId: "33333333-3333-4333-8333-333333333333",
    intentStatus: "processing",
    intentProviderPaymentId: "DISP-TITLE-1",
    paymentAttemptId: "44444444-4444-4444-8444-444444444444",
    paymentId: "55555555-5555-4555-8555-555555555555",
    attemptStatus: "processing",
    provider: "custom-rail",
    providerAttemptId: "DISP-TITLE-1",
    providerSessionId: "01KZXM9SVY8C9C2R70FSA63AJ",
    amountMinor: 14900,
    currency: "EUR",
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
      currency: "EUR",
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
        providerPaymentId: "01KZXM9SVY8C9C2R70FSA63AJ",
        attempt: expect.objectContaining({ providerPaymentId: "01KZXM9SVY8C9C2R70FSA63AJ" }),
      }),
    );
    expect(result).toMatchObject({
      status: "pending",
      verified: true,
      applied: false,
      providerPaymentId: "01KZXM9SVY8C9C2R70FSA63AJ",
    });
  });

  it("keeps existing fallback order for providers that omit resolveReadbackId", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "processing",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "EUR",
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
      currency: "EUR",
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

  it("treats explicit null from resolveReadbackId as unavailable without falling back to display-only ids", async () => {
    const readPayment = vi.fn();
    const snapshot = baseSnapshot({
      provider: "strict-rail",
      providerAttemptId: "DISP-TITLE-1",
      intentProviderPaymentId: "DISP-TITLE-1",
      providerSessionId: null,
    });

    const result = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: { applyTerminalResult: vi.fn() },
      providers: { "strict-rail": { readPayment, resolveReadbackId: () => null } },
      now: () => new Date(AT),
    });

    expect(readPayment).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "unavailable",
      verified: false,
      applied: false,
      providerPaymentId: null,
      attempt: null,
    });
  });

  it("honors an explicit input.providerPaymentId override without calling resolveReadbackId", async () => {
    const readPayment = vi.fn().mockResolvedValue({
      status: "pending",
      providerStatus: "pending",
      occurredAt: null,
      failureReason: null,
      amountMinor: null,
      currency: "EUR",
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
