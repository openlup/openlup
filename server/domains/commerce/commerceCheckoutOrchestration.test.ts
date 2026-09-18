import { describe, expect, it, vi } from "vitest";

import {
  CONFIGURATOR_INTENT_VERSION,
  configuratorIntentSchema,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  CommerceRuntimeConflictError,
  type CommerceCheckoutRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import {
  CheckoutOrchestrationError,
  orchestratePaidOrder,
} from "./commerceCheckoutOrchestration.js";
import {
  ProviderAttemptExecutionError,
  ProviderAttemptFinalizationError,
  ProviderAttemptPostDispatchError,
} from "../../shared/preparedProviderAttempt.js";

// Follow-up to #762 — source-side guard. When a Stripe checkout reaches the
// orchestration `processing` tail with NO clientSecret, the provider call was
// inconsistent (drift / unwired adapter). The saga preserves its aggregate for
// reconciliation — never return an unpayable `pending_payment` order or release
// stock after this post-dispatch contract failure. Its healthy sibling
// (clientSecret present) must still succeed.

const ORDER_UUID = "44444444-4444-4444-8444-444444444444";
const ORDER_REF = `order_${ORDER_UUID}`;
const PAYMENT_INTENT_ID = "99999999-9999-4999-8999-999999999999";

describe("checkout orchestration — Stripe embedded clientSecret invariant", () => {
  it("keeps the required-pet legacy path on its existing quote, draft, and runtime interfaces", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: "pi_secret_ok" });
    const deps = makeDeps(runtimePort);

    await orchestratePaidOrder(deps);

    expect(deps.quoteSpy.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({ petId: deps.provisioned.petId }),
      expect.objectContaining({ clientId: deps.provisioned.clientId }),
    );
    expect(deps.orderDraftSpy.createOrderDraft).toHaveBeenCalledTimes(1);
    expect(runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      petId: deps.provisioned.petId,
      paymentProvider: deps.paymentProvider,
    }));
  });

  it("preserves a Stripe runtime with no clientSecret for reconciliation", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: null });

    const promise = orchestratePaidOrder(makeDeps(runtimePort));

    await expect(promise).rejects.toBeInstanceOf(CheckoutOrchestrationError);
    await expect(promise).rejects.toMatchObject({
      orderIdForCompensation: null,
      reason: "provider_attempt_in_flight",
    });
    expect(runtimePort.startRuntime).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "processing" }, { attemptStatus: "processing" }, { continuationActionOrigin: null },
    { paymentAttemptId: null }, { paymentIntentId: "" }, { provider: "tpay" },
  ])("keeps missing-secret uncertainty blocked when refusal proof is incomplete: %j", async (override) => {
    const runtimePort = makeRuntimePort({ providerClientSecret: null });
    vi.mocked(runtimePort.startRuntime).mockResolvedValue({ runtime: { orderId: ORDER_UUID, payment: {
      paymentIntentId: PAYMENT_INTENT_ID, paymentAttemptId: "66666666-6666-4666-8666-666666666666",
      provider: "stripe", providerClientSecret: null, status: "failed", attemptStatus: "failed",
      continuationActionOrigin: "fresh_execution", ...override,
    } } } as never);
    await expect(orchestratePaidOrder(makeDeps(runtimePort))).rejects.toMatchObject({
      orderIdForCompensation: null, reason: "provider_attempt_in_flight",
    });
    expect(runtimePort.applyPaymentResult).not.toHaveBeenCalled();
  });

  it.each([
    ["provider dispatch", () => new ProviderAttemptExecutionError(new Error("tpay_request_timeout"))],
    ["durable finalization", () => new ProviderAttemptFinalizationError(new Error("payment_control_timeout"))],
    ["post-dispatch runtime tail", () => new ProviderAttemptPostDispatchError(new Error("readiness_timeout"))],
  ])("marks %s failure as non-compensable in-flight work", async (_stage, uncertainError) => {
    const runtimePort = makeRuntimePort({ providerClientSecret: "pi_secret_ok" });
    vi.mocked(runtimePort.startRuntime).mockRejectedValue(uncertainError());

    await expect(orchestratePaidOrder(makeDeps(runtimePort))).rejects.toMatchObject({
      orderIdForCompensation: null,
      reason: "provider_attempt_in_flight",
    });
  });

  it("marks a consumed journey with its fresh draft as compensable", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: "pi_secret_ok" });
    vi.mocked(runtimePort.startRuntime).mockRejectedValue(
      new CommerceRuntimeConflictError("Commerce checkout journey already completed", {
        code: "23505",
        reason: "journey_consumed",
      }),
    );

    await expect(orchestratePaidOrder(makeDeps(runtimePort))).rejects.toMatchObject({
      orderIdForCompensation: ORDER_UUID,
      reason: "journey_consumed",
    });
  });

  it("returns a processing result when Stripe provides a clientSecret", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: "pi_secret_ok" });

    const result = await orchestratePaidOrder(makeDeps(runtimePort));

    expect(result.status).toBe("processing");
    expect(result.providerClientSecret).toBe("pi_secret_ok");
  });

  it("returns a retryable refusal without running a fallible account-link write", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: null });
    vi.mocked(runtimePort.startRuntime).mockResolvedValue({
      runtime: {
        orderId: ORDER_UUID,
        payment: {
          paymentIntentId: PAYMENT_INTENT_ID,
          paymentAttemptId: "55555555-5555-4555-8555-555555555555",
          provider: "tpay",
          providerClientSecret: null,
          providerAttemptId: null,
          providerRedirectUrl: null,
          providerNextActionKind: null,
          continuationActionOrigin: "fresh_execution",
          status: "failed",
          attemptStatus: "failed",
          declineMandateUnsupported: false,
        },
      },
    } as never);
    const onPaymentStarted = vi.fn().mockResolvedValue(undefined);

    const result = await orchestratePaidOrder({
      ...makeDeps(runtimePort),
      paymentProvider: "tpay",
      onPaymentStarted,
    });

    expect(result).toMatchObject({ status: "failed", runtimePaymentStatus: "failed", paymentAttemptStatus: "failed", continuationActionOrigin: "fresh_execution", executionRail: "tpay" });
    expect(onPaymentStarted).not.toHaveBeenCalled();
  });

  it("publishes an unsupported recurring-method refusal as failed", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: null });
    vi.mocked(runtimePort.startRuntime).mockResolvedValue({
      runtime: {
        orderId: ORDER_UUID,
        payment: {
          paymentIntentId: PAYMENT_INTENT_ID,
          paymentAttemptId: "55555555-5555-4555-8555-555555555555",
          provider: "tpay",
          providerClientSecret: null,
          providerAttemptId: null,
          providerRedirectUrl: null,
          providerNextActionKind: null,
          continuationActionOrigin: "fresh_execution",
          status: "failed",
          attemptStatus: "failed",
          declineMandateUnsupported: true,
        },
      },
    } as never);

    const result = await orchestratePaidOrder({
      ...makeDeps(runtimePort),
      paymentProvider: "tpay",
    });

    expect(result).toMatchObject({
      status: "failed",
      runtimePaymentStatus: "failed",
      paymentAttemptStatus: "failed",
      continuationActionOrigin: "fresh_execution",
      executionRail: "tpay",
    });
    expect(runtimePort.applyPaymentResult).not.toHaveBeenCalled();
  });

  it("preserves the signed pricing-policy versions in runtime metadata", async () => {
    const runtimePort = makeRuntimePort({ providerClientSecret: "pi_secret_ok" });

    await orchestratePaidOrder(makeDeps(runtimePort, {
      pricingPolicy: {
        offerPolicyVersion: "commerce.offer-policy.v2",
        promotionEngineVersion: "promotion-engine.v2",
        pricingPolicyToken: "pp1.this-is-a-long-enough-placeholder-token-for-contracts.signature",
      },
    }));

    expect(runtimePort.startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          offerPolicyVersion: "commerce.offer-policy.v2",
          promotionEngineVersion: "promotion-engine.v2",
        }),
      }),
    );
  });
});

function makeDeps(
  runtimePort: CommerceCheckoutRuntimePort,
  context?: { pricingPolicy: {
    offerPolicyVersion: "commerce.offer-policy.v2";
    promotionEngineVersion: "promotion-engine.v2";
    pricingPolicyToken: string;
  } },
) {
  const quotePort = {
    createQuote: vi.fn().mockResolvedValue({
      quote: {
        totalGross: { amountMinor: 21233, currency: "PLN" },
        ...(context ? { context } : {}),
      },
    }),
  };
  const orderDraftPort = {
    createOrderDraft: vi.fn().mockResolvedValue({ orderDraft: { orderId: ORDER_REF } }),
  };
  return {
    intent: configuratorIntentSchema.parse(makeIntent()),
    provisioned: {
      clientId: "11111111-1111-4111-8111-111111111111",
      petId: "55555555-5555-4555-8555-555555555555",
      addressId: "22222222-2222-4222-8222-222222222222",
    },
    checkoutKind: "one_time" as const,
    // Casts: the ports use broad structural interfaces; the fakes only implement
    // the methods this saga path calls.
    quotePort: quotePort as never,
    orderDraftPort: orderDraftPort as never,
    quoteSpy: quotePort,
    orderDraftSpy: orderDraftPort,
    runtimePort,
    paymentProvider: "stripe" as const,
    invoicePreference: { kind: "b2c_named" as const },
    now: () => new Date("2026-06-20T10:00:00.000Z"),
  };
}

function makeRuntimePort(payment: { providerClientSecret: string | null }): CommerceCheckoutRuntimePort {
  return {
    startRuntime: vi.fn().mockResolvedValue({
      runtime: {
        orderId: ORDER_UUID,
        payment: {
          paymentIntentId: PAYMENT_INTENT_ID,
          providerClientSecret: payment.providerClientSecret,
          providerAttemptId: payment.providerClientSecret ? "pi_real_1" : null,
          providerRedirectUrl: null,
          providerNextActionKind: null,
        },
      },
    }),
    applyPaymentResult: vi.fn(),
  } as unknown as CommerceCheckoutRuntimePort;
}

function makeIntent() {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-stripe-invariant",
    locale: "pl",
    mode: "one_time",
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Maks",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: { firstName: "Anna", lastName: "Kowalska", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [{ variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 }],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: false },
    consciousAllergenOverride: false,
  };
}
