import { describe, expect, it, vi } from "vitest";

import {
  createCheckoutActivePaymentActionResolver,
  projectCheckoutActionReadProviders,
} from "./checkoutActivePaymentActionResolver.js";
import type { PaymentProviderRecoveryProvider } from "./checkoutRecoveryPaymentResolver.js";
import type { VerifiableAttemptSnapshot } from "./paymentVerifyNowService.js";
import { PSP_PROVIDER_KINDS } from "../../../src/domains/payment/pspIntegrationPlan.js";

const EMBEDDED_RAIL = PSP_PROVIDER_KINDS[0];
const REDIRECT_RAIL = PSP_PROVIDER_KINDS[1];

const SNAPSHOT: VerifiableAttemptSnapshot = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderClientId: "22222222-2222-4222-8222-222222222222",
  orderMode: "one_time",
  paymentIntentId: "33333333-3333-4333-8333-333333333333",
  intentStatus: "processing",
  intentProviderPaymentId: "pi_exact",
  paymentAttemptId: "44444444-4444-4444-8444-444444444444",
  paymentId: "55555555-5555-4555-8555-555555555555",
  attemptStatus: "sent_to_provider",
  provider: EMBEDDED_RAIL,
  providerAttemptId: "pi_exact",
  providerSessionId: null,
  amountMinor: 1490,
  currency: "USD",
  localUpdatedAt: "2026-08-20T12:00:00.000Z",
};

const AUTHORITY = {
  orderId: SNAPSHOT.orderId,
  clientId: SNAPSHOT.orderClientId,
  paymentIntentId: SNAPSHOT.paymentIntentId,
  paymentAttemptId: SNAPSHOT.paymentAttemptId,
  executionRail: EMBEDDED_RAIL,
};

describe("checkout active payment action resolver", () => {
  it("returns the same provider action after two matching canonical reads", async () => {
    const readVerifiableAttempt = vi.fn().mockResolvedValue(SNAPSHOT);
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "requires_payment_method", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" },
    });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt },
      providers: { [EMBEDDED_RAIL]: provider(readRecoveryPayment) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toEqual({
      kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret",
    });
    expect(readVerifiableAttempt).toHaveBeenCalledTimes(2);
    expect(readRecoveryPayment).toHaveBeenCalledWith(expect.objectContaining({ purpose: "active_checkout" }));
  });

  it("does not read the provider for stale authority or terminal local truth", async () => {
    const readRecoveryPayment = vi.fn();
    const readVerifiableAttempt = vi.fn()
      .mockResolvedValueOnce({ ...SNAPSHOT, paymentAttemptId: "66666666-6666-4666-8666-666666666666" })
      .mockResolvedValueOnce({ ...SNAPSHOT, intentStatus: "succeeded" });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt },
      providers: { [EMBEDDED_RAIL]: provider(readRecoveryPayment) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
    expect(readRecoveryPayment).not.toHaveBeenCalled();
  });

  it("suppresses mismatches and a webhook race after the provider read", async () => {
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "pending", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "redirect", url: "https://payments.example/pay" },
    });
    const readVerifiableAttempt = vi.fn()
      .mockResolvedValueOnce({ ...SNAPSHOT, provider: REDIRECT_RAIL, providerAttemptId: null, providerSessionId: "tx" })
      .mockResolvedValueOnce({ ...SNAPSHOT, provider: REDIRECT_RAIL, providerAttemptId: null, providerSessionId: "tx", intentStatus: "succeeded" });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt },
      providers: { [REDIRECT_RAIL]: provider(readRecoveryPayment, "tx") },
    });

    await expect(resolver.readActiveAction({ ...AUTHORITY, executionRail: REDIRECT_RAIL })).resolves.toBeNull();
    expect(readRecoveryPayment).toHaveBeenCalledTimes(1);
  });

  it("returns the same validated redirect for an unchanged redirect rail", async () => {
    const redirectSnapshot = {
      ...SNAPSHOT,
      provider: REDIRECT_RAIL,
      providerAttemptId: null,
      providerSessionId: "tx",
    };
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "pending", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "redirect", url: "https://payments.example/pay" },
    });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt: vi.fn().mockResolvedValue(redirectSnapshot) },
      providers: { [REDIRECT_RAIL]: provider(readRecoveryPayment, "tx") },
    });

    await expect(resolver.readActiveAction({
      ...AUTHORITY,
      executionRail: REDIRECT_RAIL,
    })).resolves.toEqual({ kind: "redirect", url: "https://payments.example/pay" });
  });

  it("suppresses an action that belongs to a different execution rail", async () => {
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "pending", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "redirect", url: "https://payments.example/pay" },
    });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt: vi.fn().mockResolvedValue(SNAPSHOT) },
      providers: { [EMBEDDED_RAIL]: provider(readRecoveryPayment) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
  });

  it("suppresses a pre-read action when canonical live state changes during readback", async () => {
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "pending", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" },
    });
    const readVerifiableAttempt = vi.fn()
      .mockResolvedValueOnce(SNAPSHOT)
      .mockResolvedValueOnce({
        ...SNAPSHOT,
        attemptStatus: "requires_action",
        localUpdatedAt: "2026-08-20T12:00:01.000Z",
      });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt },
      providers: { [EMBEDDED_RAIL]: provider(readRecoveryPayment) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
    expect(readRecoveryPayment).toHaveBeenCalledTimes(1);
  });

  it("projects adapter dependencies to read-only methods", () => {
    const projected = projectCheckoutActionReadProviders({
      [EMBEDDED_RAIL]: {
        ...provider(vi.fn()),
        closePayment: vi.fn(),
      },
    });

    expect(Object.keys(projected[EMBEDDED_RAIL] ?? {}).sort()).toEqual([
      "readRecoveryPayment",
      "resolvePaymentReference",
    ]);
    expect("closePayment" in (projected[EMBEDDED_RAIL] ?? {})).toBe(false);
  });

  it.each([
    ["identity", { identityMatches: false }],
    ["money", { configuredMoneyMatches: false }],
    ["manual", { manualReviewRequired: true }],
    ["unknown", { status: { status: "unknown" } }],
  ] as const)("suppresses unsafe %s readback evidence", async (_case, override) => {
    const readRecoveryPayment = vi.fn().mockResolvedValue({
      status: { status: "pending", providerStatus: "pending", occurredAt: null, failureReason: null, amountMinor: 1490, currency: "USD", rawPayload: {} },
      identityMatches: true,
      configuredMoneyMatches: true,
      manualReviewRequired: false,
      clientAction: { kind: "provider_embedded", provider: EMBEDDED_RAIL, clientSecret: "secret" },
      ...override,
    });
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt: vi.fn().mockResolvedValue(SNAPSHOT) },
      providers: { [EMBEDDED_RAIL]: provider(readRecoveryPayment) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
  });

  it("fails closed when readback throws", async () => {
    const resolver = createCheckoutActivePaymentActionResolver({
      readPort: { readVerifiableAttempt: vi.fn().mockResolvedValue(SNAPSHOT) },
      providers: { [EMBEDDED_RAIL]: provider(vi.fn().mockRejectedValue(new Error("unavailable"))) },
    });

    await expect(resolver.readActiveAction(AUTHORITY)).resolves.toBeNull();
  });
});

function provider(
  readRecoveryPayment: PaymentProviderRecoveryProvider["readRecoveryPayment"],
  reference = "pi_exact",
): PaymentProviderRecoveryProvider {
  return {
    resolvePaymentReference: () => reference,
    readRecoveryPayment,
    readPayment: vi.fn(),
  };
}
