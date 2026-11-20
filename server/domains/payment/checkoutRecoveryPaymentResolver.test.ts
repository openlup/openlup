import { describe, expect, it, vi } from "vitest";
import {
  createCheckoutRecoveryPaymentResolver,
  type PaymentProviderRecoveryProvider,
  type ProviderRecoveryRead,
} from "./checkoutRecoveryPaymentResolver.js";
import type { VerifiableAttemptSnapshot } from "./paymentVerifyNowService.js";
import type { ProviderReconciliationStatus } from "./paymentProviderReconciliationContracts.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const paymentIntentId = "22222222-2222-4222-8222-222222222222";

function snapshot(overrides: Partial<VerifiableAttemptSnapshot> = {}): VerifiableAttemptSnapshot {
  return {
    orderId,
    orderClientId: "33333333-3333-4333-8333-333333333333",
    orderMode: "one_time_order",
    paymentIntentId,
    intentStatus: "processing",
    intentProviderPaymentId: null,
    paymentAttemptId: "44444444-4444-4444-8444-444444444444",
    paymentId: "55555555-5555-4555-8555-555555555555",
    attemptStatus: "processing",
    provider: "fake",
    providerAttemptId: "provider_1",
    providerSessionId: null,
    amountMinor: 14900,
    currency: "PLN",
    localUpdatedAt: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function status(overrides: Partial<ProviderReconciliationStatus> = {}): ProviderReconciliationStatus {
  return {
    status: "pending",
    providerStatus: "processing",
    occurredAt: null,
    failureReason: null,
    amountMinor: 14900,
    currency: "PLN",
    rawPayload: {},
    ...overrides,
  };
}

function subject(input: {
  first?: VerifiableAttemptSnapshot | null;
  reread?: VerifiableAttemptSnapshot | null;
  provider?: PaymentProviderRecoveryProvider;
}) {
  const first = input.first === undefined ? snapshot() : input.first;
  const reread = input.reread === undefined ? first : input.reread;
  const reads = [first, reread];
  const readPort = { readVerifiableAttempt: vi.fn(async () => reads.shift() ?? null) };
  const applyTerminalResult = vi.fn(async () => ({ replayed: false, correctionStatus: "corrected" }));
  const provider = input.provider ?? recoveryProvider();
  return {
    resolver: createCheckoutRecoveryPaymentResolver({
      readPort,
      applyPort: { applyTerminalResult } as never,
      providers: { fake: provider } as never,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    }),
    readPort,
    applyTerminalResult,
    provider,
  };
}

describe("checkout recovery payment resolver", () => {
  it("allows a clean created intent with no attempt to use the existing pay route", async () => {
    const { resolver } = subject({ first: null });
    await expect(resolver.resolve({ orderId, paymentIntentId, intentStatus: "created" }))
      .resolves.toEqual({ kind: "retry_new" });
  });

  it("returns retry_new after interactive payment-control terminalizes an old prepared attempt", async () => {
    const { resolver, provider, applyTerminalResult } = subject({
      first: snapshot({ attemptStatus: "failed", intentStatus: "failed" }),
    });

    await expect(resolver.resolve({ orderId, paymentIntentId, intentStatus: "failed" }))
      .resolves.toEqual({ kind: "retry_new" });
    expect(provider.readRecoveryPayment).not.toHaveBeenCalled();
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it("fails closed when an active attempt has no provider capability", async () => {
    const { resolver } = createNoProvider();
    await expect(resolver.resolve({ orderId, paymentIntentId, intentStatus: "processing" }))
      .resolves.toEqual({ kind: "awaiting_provider" });
  });

  it("fails closed when an active attempt has no canonical provider reference", async () => {
    const provider = recoveryProvider({ reference: null });
    const { resolver } = subject({
      first: snapshot({ providerAttemptId: null, providerSessionId: null }),
      provider,
    });
    await expect(resolver.resolve({ orderId, paymentIntentId, intentStatus: "processing" }))
      .resolves.toEqual({ kind: "awaiting_provider" });
    expect(provider.readRecoveryPayment).not.toHaveBeenCalled();
  });

  it("returns a continuation from one provider read without applying a payment", async () => {
    const provider = recoveryProvider({
      read: {
        status: status(),
        identityMatches: true,
        manualReviewRequired: false,
        clientAction: { kind: "redirect", url: "https://secure.tpay.com/pay/abc" },
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });
    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({
      kind: "resume_existing",
      clientAction: { kind: "redirect", url: "https://secure.tpay.com/pay/abc" },
    });
    expect(provider.readRecoveryPayment).toHaveBeenCalledTimes(1);
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it("resumes a configured pending payment even when its settled amount is still zero", async () => {
    const provider = recoveryProvider({
      read: {
        status: status({ amountMinor: 0 }),
        configuredMoneyMatches: true,
        clientAction: { kind: "redirect", url: "https://secure.tpay.com/pay/abc" },
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });

    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({
      kind: "resume_existing",
      clientAction: { kind: "redirect", url: "https://secure.tpay.com/pay/abc" },
    });
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it("keeps pending and unknown provider reads fail-closed", async () => {
    const provider = recoveryProvider({
      read: {
        status: status({ status: "unknown", providerStatus: "timeout" }),
        identityMatches: true,
        manualReviewRequired: false,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });
    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "awaiting_provider" });
    expect(provider.readRecoveryPayment).toHaveBeenCalledTimes(1);
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it("sends amount mismatch to manual review without applying truth", async () => {
    const provider = recoveryProvider({
      read: {
        status: status({ status: "failed", amountMinor: 1 }),
        identityMatches: true,
        manualReviewRequired: false,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });
    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "manual_review" });
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it.each([
    ["missing amount", { amountMinor: null }],
    ["missing currency", { currency: null }],
    ["currency mismatch", { currency: "EUR" }],
  ])("sends adapter-reported %s to manual review before returning a continuation", async (_case, overrides) => {
    const provider = recoveryProvider({
      read: {
        status: status(overrides),
        configuredMoneyMatches: false,
        clientAction: { kind: "redirect", url: "https://secure.tpay.com/pay/abc" },
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });

    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "manual_review" });
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it.each(["refunded", "chargeback"])(
    "honors adapter money-moved status %s without applying truth or allowing retry",
    async (providerStatus) => {
    const provider = recoveryProvider({
      read: {
        status: status({ status: "failed", providerStatus }),
        identityMatches: true,
        manualReviewRequired: true,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });

    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "manual_review" });
    expect(applyTerminalResult).not.toHaveBeenCalled();
    },
  );

  it("sends an adapter-reported identity mismatch to manual review without applying truth", async () => {
    const provider = recoveryProvider({
      read: {
        status: status({ status: "succeeded" }),
        identityMatches: false,
        manualReviewRequired: false,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult } = subject({ provider });
    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "manual_review" });
    expect(applyTerminalResult).not.toHaveBeenCalled();
  });

  it("re-reads after a terminal response so a webhook race wins", async () => {
    const provider = recoveryProvider({
      read: {
        status: status({ status: "failed", providerStatus: "canceled", failureReason: "declined" }),
        identityMatches: true,
        manualReviewRequired: false,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult, readPort } = subject({
      provider,
      reread: snapshot({ attemptStatus: "succeeded", intentStatus: "succeeded" }),
    });
    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: "paid" });
    expect(applyTerminalResult).toHaveBeenCalledTimes(1);
    expect(readPort.readVerifiableAttempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["succeeded", "paid"],
    ["failed", "retry_new"],
  ] as const)("applies exact terminal %s truth once and returns %s", async (terminal, expected) => {
    const provider = recoveryProvider({
      read: {
        status: status({
          status: terminal,
          providerStatus: terminal,
          failureReason: terminal === "failed" ? "declined" : null,
        }),
        identityMatches: true,
        manualReviewRequired: false,
        clientAction: null,
      },
    });
    const { resolver, applyTerminalResult } = subject({
      provider,
      reread: snapshot({ attemptStatus: terminal, intentStatus: terminal }),
    });

    await expect(resolver.resolve({ orderId, paymentIntentId })).resolves.toEqual({ kind: expected });
    expect(applyTerminalResult).toHaveBeenCalledTimes(1);
  });
});

describe("checkout recovery payment resolver read purpose", () => {
  // A redeem happens while the buyer is holding the recovery link open, so the
  // read must be made as a live checkout. Without the purpose the adapter
  // answers as reconciliation does, and an attempt minted a minute earlier by
  // the pay route is closed under the buyer instead of being handed back
  // (measured in production on 2026-08-23). What the purpose then MEANS is the
  // adapter's own business and is pinned in the adapter's own test.
  it("tells the provider this is an active checkout, not a reconciliation sweep", async () => {
    const { resolver, provider } = subject({});
    await resolver.resolve({ orderId, paymentIntentId });

    expect(provider.readRecoveryPayment).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "active_checkout" }),
    );
  });
});

function recoveryProvider(input: {
  reference?: string | null;
  read?: Partial<ProviderRecoveryRead> & Pick<ProviderRecoveryRead, "status">;
} = {}): PaymentProviderRecoveryProvider {
  const recoveryRead: ProviderRecoveryRead = {
    status: input.read?.status ?? status(),
    identityMatches: true,
    configuredMoneyMatches: true,
    manualReviewRequired: false,
    clientAction: null,
    ...input.read,
  };
  return {
    resolvePaymentReference: vi.fn(() =>
      input.reference === undefined ? "provider_1" : input.reference
    ),
    readPayment: vi.fn(async () => recoveryRead.status),
    readRecoveryPayment: vi.fn(async () => recoveryRead),
  };
}

function createNoProvider() {
  const readPort = { readVerifiableAttempt: vi.fn(async () => snapshot()) };
  return {
    resolver: createCheckoutRecoveryPaymentResolver({
      readPort,
      applyPort: { applyTerminalResult: vi.fn() } as never,
      providers: {},
    }),
  };
}
