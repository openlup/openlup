import { describe, expect, it, vi } from "vitest";

import type { CreateOrderDraftResponse, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type {
  CommerceOrderDraftWritePort,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { CommerceOrderDraftPriceChangedError } from "../../../src/domains/commerce/ports.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  ExpiredCheckoutRecoveryConflictError,
  type ExpiredCheckoutRecoveryWritePort,
} from "./checkoutRecoveryOperations.js";
import {
  createExpiredCheckoutRecoveryService,
  ExpiredCheckoutRecoveryError,
} from "./expiredCheckoutRecoveryService.js";
import type { ExpiredCheckoutPaymentSafetyPort } from "./expiredCheckoutPaymentSafety.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "20000000-0000-4000-8000-000000000001";
const REPLACEMENT_ID = "60000000-0000-4000-8000-000000000001";
const PAYMENT_INTENT_ID = "70000000-0000-4000-8000-000000000001";
const PAYMENT_ATTEMPT_ID = "80000000-0000-4000-8000-000000000001";

describe("expired checkout recovery service", () => {
  it("recreates an expired order as a new payable Stripe order", async () => {
    const deps = depsFor();
    const service = createExpiredCheckoutRecoveryService(deps);

    await expect(service.recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).resolves.toMatchObject({
      orderId: REPLACEMENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      clientId: CLIENT_ID,
      status: "processing",
      provider: "stripe",
      providerPaymentId: "pi_replacement",
      clientAction: {
        kind: "provider_embedded",
        provider: "stripe",
        clientSecret: "pi_replacement_secret",
      },
    });

    expect(deps.quotePort.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "one_time" }),
      { clientId: CLIENT_ID },
    );
    expect(deps.orderDraftPort.createOrderDraft).toHaveBeenCalledWith(
      {
        idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
        quoteSnapshot: quote(),
      },
      { clientId: CLIENT_ID },
    );
    expect(deps.recoveryPort.prepareReplacement).toHaveBeenCalledWith({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      sourceOrderId: ORDER_ID,
      replacementOrderId: REPLACEMENT_ID,
    });
    expect(deps.runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      clientId: CLIENT_ID,
      shippingAddressId: "40000000-0000-4000-8000-000000000001",
      paymentProvider: "stripe",
      metadata: expect.objectContaining({
        recreatedFromOrderId: ORDER_ID,
        recoveryReason: "expired_checkout_recreate",
      }),
    }));
    expect(deps.compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
  });

  it("re-quotes an expired v2 order with its trusted persisted policy version", async () => {
    const deps = depsFor();
    const v2Order = order({
      quoteSnapshot: {
        ...quote(),
        quote: {
          ...quote().quote,
          context: {
            mode: "one_time",
            cadenceDays: null,
            promoCodes: [],
            petId: "50000000-0000-4000-8000-000000000001",
            pricingPolicy: {
              offerPolicyVersion: "commerce.offer-policy.v2",
              promotionEngineVersion: "promotion-engine.v2",
            },
          },
        },
      },
    });

    await expect(createExpiredCheckoutRecoveryService(deps).validate(v2Order)).resolves.toBe(true);

    expect(deps.quotePort.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "one_time" }),
      {
        clientId: CLIENT_ID,
        pricingPolicy: {
          offerPolicyVersion: "commerce.offer-policy.v2",
          promotionEngineVersion: "promotion-engine.v2",
        },
      },
    );
  });

  it("uses stable idempotency for draft, replacement prepare, runtime, and hidden apply", async () => {
    const deps = depsFor({ paymentProvider: "hidden_rehearsal" });
    const service = createExpiredCheckoutRecoveryService(deps);

    await expect(service.recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
    })).resolves.toMatchObject({ status: "paid", provider: "hidden_rehearsal" });

    const idempotencyKey = `checkout-recovery-recreate:${ORDER_ID}`;
    expect(deps.orderDraftPort.createOrderDraft).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey }),
      expect.anything(),
    );
    expect(deps.recoveryPort.prepareReplacement).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey }),
    );
    expect(deps.runtimePort.startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey }),
    );
    expect(deps.runtimePort.applyPaymentResult).toHaveBeenCalledWith({
      idempotencyKey: `${idempotencyKey}:apply-result`,
      orderId: REPLACEMENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      resultStatus: "succeeded",
      occurredAt: expect.any(String),
    });
  });

  it("reports order_changed on commercial drift before creating a draft", async () => {
    const deps = depsFor({ freshQuote: quote({ totalGross: money(5998), netTotal: money(5554), taxTotal: money(444) }) });
    const service = createExpiredCheckoutRecoveryService(deps);

    await expect(service.recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "order_changed" });
    await expect(service.recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toBeInstanceOf(ExpiredCheckoutRecoveryError);

    expect(deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
    expect(deps.recoveryPort.prepareReplacement).not.toHaveBeenCalled();
    expect(deps.runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(deps.compensationPort.cancelUnstartedPromotionOrder).not.toHaveBeenCalled();
  });

  it("does not create a draft when provider readback says the old payment succeeded", async () => {
    const deps = depsFor();
    vi.mocked(deps.paymentSafetyPort.verifyPriorPayment).mockResolvedValueOnce("paid");

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "paid" });

    expect(deps.quotePort.createQuote).not.toHaveBeenCalled();
    expect(deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
  });

  it("reports order_changed when the canonical draft rejects a stale promotion", async () => {
    const deps = depsFor();
    vi.mocked(deps.orderDraftPort.createOrderDraft).mockRejectedValueOnce(
      new CommerceOrderDraftPriceChangedError("promotion changed"),
    );

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "order_changed" });

    expect(deps.recoveryPort.prepareReplacement).not.toHaveBeenCalled();
    expect(deps.runtimePort.startRuntime).not.toHaveBeenCalled();
  });

  it("maps a stock conflict to order_changed and compensates the replacement order", async () => {
    const deps = depsFor();
    vi.mocked(deps.runtimePort.startRuntime).mockRejectedValueOnce(
      new CheckoutOrchestrationError("start_runtime: Inventory reservation conflict", REPLACEMENT_ID),
    );
    const service = createExpiredCheckoutRecoveryService(deps);

    await expect(service.recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "order_changed" });

    expect(deps.compensationPort.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      orderId: REPLACEMENT_ID,
      reason: "expired_checkout_recovery_failed",
    });
    expect(deps.compensationPort.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      orderId: REPLACEMENT_ID,
      reason: "expired_checkout_recovery_failed",
    });
  });

  it("fails closed and compensates when Stripe omits the client secret", async () => {
    const deps = depsFor();
    const response = runtime("stripe");
    response.runtime.payment.providerClientSecret = null;
    vi.mocked(deps.runtimePort.startRuntime).mockResolvedValueOnce(response);

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "execution_failed" });

    expect(deps.compensationPort.cancelAbandonedOrder).toHaveBeenCalled();
  });

  // Characterization of the post-PR 2297 split for a pet-less subscription
  // recovery. `commerce_orders.pet_id` is ON DELETE SET NULL, so a customer
  // deleting their pet leaves a legacy subscription order with petId null; the
  // restored finalize guard now refuses to re-finalize it. A neutral-seam order
  // is pet-less by design and keeps recovering, because finalize persists the
  // command metadata under `metadata.runtimeFinalize` and this service forwards
  // that record verbatim, so the discriminator survives the round trip.
  it("recovers a pet-less neutral order and forwards the marker that authorizes it", async () => {
    const deps = depsFor({ paymentProvider: "hidden_rehearsal" });

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order({
        mode: "subscription_cycle",
        petId: null,
        runtimeMetadata: { checkoutCommandVersion: "commerce.checkout_command.v1" },
      }),
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
    })).resolves.toMatchObject({ orderId: REPLACEMENT_ID, status: "paid" });

    expect(deps.runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription_cycle",
      petId: null,
      metadata: expect.objectContaining({
        checkoutCommandVersion: "commerce.checkout_command.v1",
      }),
    }));
    expect(deps.compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
  });

  it("surfaces the finalize refusal when a legacy pet-less subscription order is recovered", async () => {
    const deps = depsFor();
    // What the runtime port hands back for
    // `commerce_runtime_finalize_subscription_requires_pet` (22023): its RPC
    // error classifier routes every `commerce_runtime_finalize_*requires*`
    // condition to CommerceRuntimeConflictError with the SQLSTATE attached.
    // That classifier keeps its own unit test; this pins what the recovery
    // service does with the result.
    vi.mocked(deps.runtimePort.startRuntime).mockRejectedValueOnce(
      new CommerceRuntimeConflictError("Commerce order finalize conflict", { code: "22023" }),
    );

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order({ mode: "subscription_cycle", petId: null, runtimeMetadata: {} }),
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
    })).rejects.toMatchObject({ reason: "execution_failed" });

    expect(deps.runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      petId: null,
      metadata: expect.not.objectContaining({ checkoutCommandVersion: expect.anything() }),
    }));
    expect(deps.compensationPort.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      orderId: REPLACEMENT_ID,
      reason: "expired_checkout_recovery_failed",
    });
  });

  it("maps an atomic database quote conflict to order_changed and compensates the draft", async () => {
    const deps = depsFor();
    vi.mocked(deps.recoveryPort.prepareReplacement).mockRejectedValueOnce(
      new ExpiredCheckoutRecoveryConflictError("order_changed"),
    );

    await expect(createExpiredCheckoutRecoveryService(deps).recreate({
      order: order(),
      clientId: CLIENT_ID,
      paymentProvider: "stripe",
    })).rejects.toMatchObject({ reason: "order_changed" });

    expect(deps.runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(deps.compensationPort.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      orderId: REPLACEMENT_ID,
      reason: "expired_checkout_recovery_failed",
    });
  });
});

function depsFor(input: {
  freshQuote?: CreateQuoteResponse;
  paymentProvider?: "stripe" | "hidden_rehearsal";
} = {}) {
  const provider = input.paymentProvider ?? "stripe";
  const quotePort: CommerceQuotePort = {
    createQuote: vi.fn(async () => input.freshQuote ?? quote()),
  };
  const orderDraftPort: CommerceOrderDraftWritePort = {
    createOrderDraft: vi.fn(async () => draft()),
  };
  const runtimePort: CommerceCheckoutRuntimePort = {
    startRuntime: vi.fn(async () => runtime(provider)),
    applyPaymentResult: vi.fn(async (): ReturnType<CommerceCheckoutRuntimePort["applyPaymentResult"]> => ({
      contractVersion: "commerce.v0",
      paymentResult: {
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: PAYMENT_ATTEMPT_ID,
        paymentId: "90000000-0000-4000-8000-000000000001",
        orderId: REPLACEMENT_ID,
        status: "succeeded",
        kind: "one_time_paid",
        replayed: false,
      },
      reservationRelease: { attempted: false, releasedCount: 0 },
      readiness: null,
    })),
  };
  const recoveryPort: ExpiredCheckoutRecoveryWritePort = {
    prepareReplacement: vi.fn(async () => ({ replacementOrderId: REPLACEMENT_ID, replayed: false })),
  };
  const compensationPort: CheckoutCompensationPort = {
    releaseOrderReservations: vi.fn(async () => ({ releasedCount: 0 })),
    cancelUnstartedPromotionOrder: vi.fn(async () => ({ cancelled: true })),
    cancelAbandonedOrder: vi.fn(async () => ({ cancelled: true })),
  };
  const paymentSafetyPort: ExpiredCheckoutPaymentSafetyPort = {
    verifyPriorPayment: vi.fn(async (): Promise<"safe" | "paid" | "unavailable"> => "safe"),
  };
  return { quotePort, orderDraftPort, runtimePort, recoveryPort, compensationPort, paymentSafetyPort };
}

function order(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "OPENLUP-EXPIRED",
    clientId: CLIENT_ID,
    status: "expired",
    mode: "one_time_order",
    totalMinor: 4998,
    currency: "PLN",
    petName: "Lida",
    cadenceDays: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    customerEmail: "buyer@example.test",
    customerName: "Buyer",
    paymentIntentId: null,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    shippingAddressId: "40000000-0000-4000-8000-000000000001",
    petId: "50000000-0000-4000-8000-000000000001",
    quoteSnapshot: quote(),
    runtimeMetadata: { selectedDelivery: { providerKind: "omnipack" } },
    invoiceBuyerSnapshot: { email: "buyer@example.test", name: "Buyer" },
    recoveryRootOrderId: ORDER_ID,
    recreatedFromOrderId: null,
    technicallyExpired: true,
    ...overrides,
  };
}

function draft(): CreateOrderDraftResponse {
  return {
    contractVersion: "commerce.v0",
    orderDraft: {
      orderId: `order_${REPLACEMENT_ID}`,
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: `checkout-recovery-recreate:${ORDER_ID}`,
      quoteSnapshot: quote(),
      replayed: false,
    },
  };
}

function runtime(
  provider: "stripe" | "hidden_rehearsal",
): Awaited<ReturnType<CommerceCheckoutRuntimePort["startRuntime"]>> {
  return {
    contractVersion: "commerce.v0",
    runtime: {
      orderId: REPLACEMENT_ID,
      orderRef: `order_${REPLACEMENT_ID}`,
      mode: "one_time",
      clientId: CLIENT_ID,
      petId: "50000000-0000-4000-8000-000000000001",
      shippingAddressId: "40000000-0000-4000-8000-000000000001",
      total: money(4998),
      finalizedReplayed: false,
      reservations: [{
        reservationId: "a0000000-0000-4000-8000-000000000001",
        reservationIds: ["a0000000-0000-4000-8000-000000000001"],
        orderItemId: "c0000000-0000-4000-8000-000000000001",
        skuId: "b0000000-0000-4000-8000-000000000001",
        sku: "openlup-lamb-400g",
        status: "reserved",
        replayed: false,
      }],
      payment: {
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentId: "90000000-0000-4000-8000-000000000001",
        status: "processing",
        provider,
        providerAttemptId: provider === "stripe" ? "pi_replacement" : "hidden_rehearsal_attempt",
        providerClientSecret: provider === "stripe" ? "pi_replacement_secret" : null,
        providerRedirectUrl: null,
        providerNextActionKind: null,
        paymentAttemptId: PAYMENT_ATTEMPT_ID,
        attemptStatus: "processing",
      },
      readiness: {
        omsEligibility: { allowed: false, reason: "order_not_paid" },
        fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" },
      },
      nextAction: { kind: "await_hidden_payment_result", provider },
    },
  };
}

function quote(overrides: Partial<CreateQuoteResponse["quote"]> = {}): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [line()],
      discounts: [],
      subtotalGross: money(4998),
      discountTotalGross: money(0),
      shippingGross: money(0),
      shippingDiscountGross: money(0),
      totalGross: money(4998),
      netTotal: money(4628),
      taxTotal: money(370),
      context: {
        mode: "one_time",
        cadenceDays: null,
        promoCodes: [],
        petId: "50000000-0000-4000-8000-000000000001",
      },
      ...overrides,
    },
  };
}

function line(): CreateQuoteResponse["quote"]["lines"][number] {
  return {
    sku: "openlup-lamb-400g",
    productSlug: "jagniecina-entopro",
    quantity: 2,
    unitPriceGross: money(2499),
    lineSubtotalGross: money(4998),
    tax: {
      included: true,
      country: "PL",
      category: "pet_food",
      vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: money(4628),
      vatAmount: money(370),
      grossAmount: money(4998),
    },
  };
}

function money(amountMinor: number) {
  return { amountMinor, currency: "PLN" as const };
}
