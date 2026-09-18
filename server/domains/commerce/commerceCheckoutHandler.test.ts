import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutContracts.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import { CommerceOrderDraftPriceChangedError } from "../../../src/domains/commerce/ports.js";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import {
  ProviderAttemptExecutionError,
  ProviderAttemptFinalizationError,
  ProviderAttemptInFlightError,
  ProviderAttemptPostDispatchError,
} from "../../shared/preparedProviderAttempt.js";
import {
  CLIENT_ID,
  ORDER_ID,
  PAYMENT_INTENT_ID,
  PET_ID,
  createPorts,
  createResponse,
  intent,
  quoteSnapshot,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

describe("commerce checkout BFF handler", () => {
  it("returns the paid checkout envelope on the happy path", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    // The whole saga threads the same idempotency key through every step.
    expect(vi.mocked(ports.persistencePort.persistIntent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ports.quotePort.createQuote)).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "one_time", petId: PET_ID }),
      { clientId: CLIENT_ID },
    );
    // The saga persists the provisioned customer onto the order draft via the
    // OUT-OF-BAND options arg (not the request body) so the outbox dispatcher's
    // recipient port can resolve an email.
    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "intent-2026-06-05-rex" }),
      { clientId: CLIENT_ID },
    );
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "one_time",
        clientId: CLIENT_ID,
        petId: PET_ID,
        metadata: expect.objectContaining({
          invoiceBuyerSnapshot: {
            name: "Anna Kowalska",
            email: "anna@example.com",
            taxId: null,
            companyName: null,
            source: "checkout_invoice_preference",
            address: {
              line1: "Testowa 12",
              line2: null,
              city: "Warszawa",
              postalCode: "00-001",
              country: "PL",
              source: "checkout_shipping_address",
            },
          },
        }),
      }),
    );
    expect(vi.mocked(ports.runtimePort.applyPaymentResult)).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, resultStatus: "succeeded" }),
    );
    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        checkoutKind: "one_time",
        orderRef: `order_${ORDER_ID}`,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        // Wave A introduced `paymentIntentId` propagation; Wave C surfaces
        // `clientAction.kind === "none"` for the hidden_rehearsal no-op path,
        // mirroring the new stripe-aware response shape used by Wave C's FE.
        status: "paid",
        paymentIntentId: PAYMENT_INTENT_ID,
        clientAction: { kind: "none" },
        subscription: {
          requested: false,
          cadenceDays: null,
          activationStatus: "not_applicable",
        },
        payment: { requiresReusablePaymentMethod: false },
        authoritativeQuote: quoteSnapshot(),
      },
      meta: { contractVersion: CHECKOUT_CONTRACT_VERSION },
    });
  });

  it.each(["stripe", "tpay"] as const)("mints refusal authority through the real orchestration for fresh %s", async (provider) => {
    const ports = createPorts();
    const paymentAttemptId = "66666666-6666-4666-8666-666666666666";
    vi.mocked(ports.runtimePort.startRuntime).mockResolvedValue({ runtime: {
      orderId: ORDER_ID, payment: { paymentIntentId: PAYMENT_INTENT_ID, paymentAttemptId,
        provider, providerClientSecret: provider === "stripe" ? "pi_secret_existing" : null,
        providerAttemptId: "provider_refused", providerRedirectUrl: null, providerNextActionKind: null,
        continuationActionOrigin: "fresh_execution", status: "failed", attemptStatus: "failed",
        declineMandateUnsupported: false },
    } } as never);
    const mintPaymentContinuationCookie = vi.fn();
    const res = createResponse();
    await createCommerceCheckoutHandler({ ...ports, mintPaymentContinuationCookie })(request("POST", {
      intent: intent(), paymentProvider: provider,
      ...(provider === "tpay" ? { paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } } : {}),
    }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", clientAction: { kind: "none" } }) }));
    expect(mintPaymentContinuationCookie).toHaveBeenCalledExactlyOnceWith(res, {
      journeyId: intent().idempotencyKey, clientId: CLIENT_ID, orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID, paymentAttemptId, executionRail: provider,
    });
    expect(ports.runtimePort.applyPaymentResult).not.toHaveBeenCalled();
    expect(ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
  });

  it("returns failed and mints continuation authority for a recurring-method refusal", async () => {
    const ports = {
      ...createPorts(),
      subscriptionCheckoutContractEnabled: () => true,
    };
    const paymentAttemptId = "66666666-6666-4666-8666-666666666666";
    vi.mocked(ports.runtimePort.startRuntime).mockResolvedValue({ runtime: {
      orderId: ORDER_ID,
      payment: {
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId,
        provider: "tpay",
        providerClientSecret: null,
        providerAttemptId: "provider_refused",
        providerRedirectUrl: null,
        providerNextActionKind: null,
        continuationActionOrigin: "fresh_execution",
        status: "failed",
        attemptStatus: "failed",
        declineMandateUnsupported: true,
      },
    } } as never);
    const mintPaymentContinuationCookie = vi.fn();
    const res = createResponse();

    await createCommerceCheckoutHandler({ ...ports, mintPaymentContinuationCookie })(request("POST", {
      intent: intent("subscription"),
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "123456",
      },
    }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        checkoutKind: "subscription_initial",
        status: "failed",
        clientAction: { kind: "none" },
      }),
    }));
    expect(mintPaymentContinuationCookie).toHaveBeenCalledExactlyOnceWith(res, {
      journeyId: intent("subscription").idempotencyKey,
      clientId: CLIENT_ID,
      orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentAttemptId,
      executionRail: "tpay",
    });
    expect(ports.runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription_cycle",
      paymentExecution: expect.objectContaining({ flow: "blik_recurring_activation" }),
    }));
    expect(ports.runtimePort.applyPaymentResult).not.toHaveBeenCalled();
    expect(ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
  });


  it("blocks checkout before order/payment creation when the authoritative quote differs", async () => {
    const res = createResponse();
    const ports = createPorts();
    const authoritativeQuote = quoteSnapshot({ amountMinor: 25460, currency: "PLN" });
    vi.mocked(ports.quotePort.createQuote).mockResolvedValue(authoritativeQuote);

    await createCommerceCheckoutHandler(ports)(
      request("POST", {
        intent: intent(),
        expectedQuote: {
          totalGross: { amountMinor: 12730, currency: "PLN" },
          promotionAcceptanceToken: "opaque.signed-token",
        },
      }),
      res,
    );

    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.applyPaymentResult)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        checkoutKind: "one_time",
        status: "price_changed",
        priceChanged: true,
        expectedQuote: {
          totalGross: { amountMinor: 12730, currency: "PLN" },
        },
        authoritativeQuote,
      },
      meta: { contractVersion: CHECKOUT_CONTRACT_VERSION },
    });
  });

  it.each([
    ["card", { paymentProvider: "stripe" }],
    ["BLIK", {
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    }],
    ["PBL", {
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "108" },
    }],
  ] as const)("keeps a returning +alias quote stable before %s provider work", async (_rail, payment) => {
    const res = createResponse();
    const ports = createPorts();
    const baseClientId = "66666666-6666-4666-8666-666666666666";
    const currency = quoteSnapshot().quote.currency;
    const returningQuote = quoteSnapshot({ amountMinor: 19_817, currency });
    const firstOrderQuote = quoteSnapshot({ amountMinor: 18_774, currency });
    const events: string[] = [];
    const originalPersist = vi.mocked(ports.persistencePort.persistIntent).getMockImplementation()!;
    vi.mocked(ports.persistencePort.persistIntent).mockImplementation(async (...args) => {
      events.push("persist_alias_client");
      return originalPersist(...args);
    });
    const resolvePricingEligibilityClientId = vi.fn().mockImplementation(async () => {
      events.push("resolve_base_eligibility");
      return baseClientId;
    });
    vi.mocked(ports.quotePort.createQuote).mockImplementation(async (_request, options) => {
      events.push(`quote:${options?.clientId ?? "anonymous"}`);
      return options?.clientId === baseClientId ? returningQuote : firstOrderQuote;
    });

    await createCommerceCheckoutHandler({ ...ports, resolvePricingEligibilityClientId })(
      request("POST", {
        intent: {
          ...intent(),
          contact: { ...intent().contact, email: "anna+staging-loop@example.com" },
        },
        expectedQuote: { totalGross: returningQuote.quote.totalGross },
        ...payment,
      }),
      res,
    );

    expect(resolvePricingEligibilityClientId).toHaveBeenCalledWith("anna+staging-loop@example.com");
    expect(events.slice(0, 3)).toEqual([
      "resolve_base_eligibility",
      "persist_alias_client",
      `quote:${baseClientId}`,
    ]);
    expect(ports.orderDraftPort.createOrderDraft).toHaveBeenCalledWith(
      expect.any(Object),
      { clientId: CLIENT_ID },
    );
    expect(ports.runtimePort.startRuntime).toHaveBeenCalledTimes(1);
    expect(vi.mocked(res.json).mock.calls.at(-1)?.[0]).not.toMatchObject({
      data: { status: "price_changed" },
    });
  });

  it("fails closed before persistence when pricing eligibility lookup fails", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler({
      ...ports,
      resolvePricingEligibilityClientId: vi.fn().mockRejectedValue(new Error("lookup unavailable")),
    })(request("POST", { intent: intent() }), res);

    expect(ports.persistencePort.persistIntent).not.toHaveBeenCalled();
    expect(ports.quotePort.createQuote).not.toHaveBeenCalled();
    expect(ports.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
    expect(ports.runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: { feature: "checkout", stage: "customer_eligibility" },
      }),
    }));
  });

  it("rejects a direct promotion checkout without an expected quote before provisioning", async () => {
    const res = createResponse();
    const ports = { ...createPorts(), promotionAcceptanceEnforced: true };

    await createCommerceCheckoutHandler(ports)(request("POST", {
      intent: { ...intent(), promoCodes: ["SAVE80"] },
    }), res);

    expect(ports.checkRateLimit).not.toHaveBeenCalled();
    expect(ports.persistencePort.persistIntent).not.toHaveBeenCalled();
    expect(ports.quotePort.createQuote).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        details: expect.objectContaining({ reason: "promotion_expected_quote_missing" }),
      }),
    }));
  });

  it("preserves legacy promo checkout without an expected quote when v2 enforcement is off", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(request("POST", {
      intent: { ...intent(), promoCodes: ["LEGACY10"] },
    }), res);

    expect(ports.persistencePort.persistIntent).toHaveBeenCalledTimes(1);
    expect(ports.orderDraftPort.createOrderDraft).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("re-quotes as price_changed when the final promotion capacity is lost atomically", async () => {
    const res = createResponse();
    const ports = createPorts();
    const quotedWithCode = quoteSnapshot({ amountMinor: 2_000, currency: "PLN" });
    const quoteAfterCapacityLoss = quoteSnapshot({ amountMinor: 5_000, currency: "PLN" });
    vi.mocked(ports.quotePort.createQuote)
      .mockResolvedValueOnce(quotedWithCode)
      .mockResolvedValueOnce(quoteAfterCapacityLoss);
    vi.mocked(ports.orderDraftPort.createOrderDraft).mockRejectedValue(
      new CommerceOrderDraftPriceChangedError(),
    );
    const checkoutIntent = { ...intent(), promoCodes: ["SAVE80"] };

    await createCommerceCheckoutHandler(ports)(
      request("POST", {
        intent: checkoutIntent,
        expectedQuote: { totalGross: quotedWithCode.quote.totalGross },
      }),
      res,
    );

    expect(ports.quotePort.createQuote).toHaveBeenCalledTimes(2);
    expect(ports.orderDraftPort.createOrderDraft).toHaveBeenCalledTimes(1);
    expect(ports.runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        checkoutKind: "one_time",
        status: "price_changed",
        priceChanged: true,
        expectedQuote: { totalGross: quotedWithCode.quote.totalGross },
        authoritativeQuote: quoteAfterCapacityLoss,
      },
      meta: { contractVersion: CHECKOUT_CONTRACT_VERSION },
    });
  });

  it("links the customer account (best-effort) after payment start", async () => {
    const res = createResponse();
    const linkCustomerAccount = vi.fn().mockResolvedValue(undefined);
    const ports = { ...createPorts(), linkCustomerAccount };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(linkCustomerAccount).toHaveBeenCalledWith("anna@example.com");
    expect(vi.mocked(ports.runtimePort.startRuntime).mock.invocationCallOrder[0]).toBeLessThan(
      linkCustomerAccount.mock.invocationCallOrder[0] ?? 0,
    );
    expect(linkCustomerAccount.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.runtimePort.applyPaymentResult).mock.invocationCallOrder[0] ?? 0,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("emits safe checkout stage timing logs for latency triage", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = createResponse();
    const linkCustomerAccount = vi.fn().mockResolvedValue(undefined);
    const ports = { ...createPorts(), linkCustomerAccount };
    let logs: Array<Record<string, unknown>> = [];

    try {
      await createCommerceCheckoutHandler(ports)(
        request("POST", { intent: intent() }, { "x-request-id": "req_checkout_1" }),
        res,
      );
      logs = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.map((log) => log.stage)).toEqual([
      "rate_limit",
      "persist_intent",
      "quote",
      "order_draft",
      "start_runtime",
      "account_link",
      "apply_payment_result",
      "total",
    ]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "checkout_stage",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          route: "/api/bff/commerce/checkout",
          outcome: "success",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("anna@example.com");
    expect(JSON.stringify(logs)).not.toContain(PAYMENT_INTENT_ID);
    expect(JSON.stringify(logs)).not.toContain("req_checkout_1");
  });

  it("passes a normalized B2B invoice buyer snapshot to runtime finalization", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(
      request("POST", {
        intent: intent(),
        invoicePreference: {
          kind: "b2b_vat",
          companyName: "Example Company Sp. z o.o.",
          taxId: "123-456-32-18",
          address: {
            line1: "Krolewska 1",
            line2: "lok. 2",
            city: "Krakow",
            postalCode: "30-001",
            country: "PL",
          },
        },
      }),
      res,
    );

    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          invoiceBuyerSnapshot: {
            name: "Example Company Sp. z o.o.",
            email: "anna@example.com",
            taxId: "1234563218",
            companyName: "Example Company Sp. z o.o.",
            source: "checkout_invoice_preference",
            address: {
              line1: "Krolewska 1",
              line2: "lok. 2",
              city: "Krakow",
              postalCode: "30-001",
              country: "PL",
              source: "checkout_invoice_billing_address",
            },
          },
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects invalid B2B invoice preference before provisioning", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(
      request("POST", {
        intent: intent(),
        invoicePreference: {
          kind: "b2b_vat",
          companyName: "Invalid NIP Sp. z o.o.",
          taxId: "123",
          address: {
            line1: "Krolewska 1",
            city: "Krakow",
            postalCode: "30-001",
            country: "PL",
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(vi.mocked(ports.persistencePort.persistIntent)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
  });

  it("still returns the paid order when the account link fails (best-effort)", async () => {
    const res = createResponse();
    const linkCustomerAccount = vi.fn().mockRejectedValue(new Error("link down"));
    const ports = { ...createPorts(), linkCustomerAccount };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(linkCustomerAccount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: expect.objectContaining({ status: "paid" }) }),
    );
  });

  it("rejects non-POST methods with 405 and never touches downstream ports", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(request("GET"), res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(vi.mocked(ports.checkRateLimit)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.persistencePort.persistIntent)).not.toHaveBeenCalled();
  });

  it("returns 400 before touching downstream ports when subscription checkout is disabled", async () => {
    const res = createResponse();
    const ports = createPorts();

    await createCommerceCheckoutHandler(ports)(
      request("POST", { intent: intent("subscription") }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "BAD_REQUEST" }),
      }),
    );
    expect(vi.mocked(ports.persistencePort.persistIntent)).not.toHaveBeenCalled();
  });

  it("maps subscription checkout to a subscription quote and subscription-cycle initial order runtime", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      subscriptionCheckoutContractEnabled: () => true,
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent("subscription") }), res);

    expect(vi.mocked(ports.quotePort.createQuote)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        cadenceDays: 21,
        lines: [expect.objectContaining({ modeAtLine: "subscription" })],
      }),
      { clientId: CLIENT_ID },
    );
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription_cycle",
        metadata: expect.objectContaining({
          checkoutKind: "subscription_initial",
          checkoutIntent: "subscription_initial",
          cadenceDays: 21,
          requiresReusablePaymentMethod: true,
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          checkoutKind: "subscription_initial",
          subscription: {
            requested: true,
            cadenceDays: 21,
            activationStatus: "pending_payment_success",
          },
          payment: { requiresReusablePaymentMethod: true },
        }),
      }),
    );
  });

  it("translates an upstream failure to 503 and compensates the reservation", async () => {
    const res = createResponse();
    const linkCustomerAccount = vi.fn().mockResolvedValue(undefined);
    const ports = { ...createPorts(), linkCustomerAccount };
    // startRuntime succeeds (reserves inventory), then payment apply throws.
    vi.mocked(ports.runtimePort.applyPaymentResult).mockRejectedValue(
      new Error("boom: payment provider unavailable"),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(linkCustomerAccount).toHaveBeenCalledWith("anna@example.com");
    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex:checkout-compensation",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed",
    });
    expect(vi.mocked(ports.compensationPort.cancelUnstartedPromotionOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed_before_runtime",
    });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          details: expect.objectContaining({ stage: "orchestrate_order" }),
        }),
      }),
    );
  });

  it.each([
    ["PSP dispatch throws after prepare", () => new ProviderAttemptExecutionError(new Error("tpay_request_timeout"))],
    ["durable finalization throws after PSP dispatch", () => new ProviderAttemptFinalizationError(new Error("payment_control_timeout"))],
    ["post-dispatch runtime tail throws", () => new ProviderAttemptPostDispatchError(new Error("readiness_timeout"))],
  ])("preserves the order and returns in-flight conflict when %s", async (_scenario, uncertainError) => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(uncertainError());

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.compensationPort.cancelUnstartedPromotionOrder)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({
            stage: "start_runtime",
            reason: "provider_attempt_in_flight",
          }),
        }),
      }),
    );
  });

  it("cleans up a fresh consumed-journey draft and returns its typed conflict", async () => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new CommerceRuntimeConflictError("Commerce checkout journey already completed", {
        code: "23505",
        reason: "journey_consumed",
      }),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex:checkout-compensation",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed",
    });
    expect(vi.mocked(ports.compensationPort.cancelUnstartedPromotionOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_journey_consumed",
    });
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_journey_consumed",
    });
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({ reason: "journey_consumed" }),
        }),
      }),
    );
  });

  it("retains compensation for a pre-dispatch startRuntime failure", async () => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new Error("payment_control_prepared_attempt_unavailable"),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex:checkout-compensation",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed",
    });
    expect(vi.mocked(ports.compensationPort.cancelUnstartedPromotionOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed_before_runtime",
    });
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed_before_provider_dispatch",
    });
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: expect.objectContaining({ stage: "orchestrate_order" }),
      }),
    }));
  });

  it("maps inventory reservation conflicts to stock unavailable checkout rejection", async () => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new CommerceRuntimeConflictError("Inventory reservation conflict", { code: "23505" }),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex:checkout-compensation",
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed",
    });
    expect(vi.mocked(ports.compensationPort.cancelUnstartedPromotionOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_stock_unavailable",
    });
    // The order (and any provisional subscription) was already finalized before
    // the stock check ran — it must be cancelled, not left as a phantom
    // pending_activation subscription (see BUGS.md CJ01-Y).
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledWith({
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: ORDER_ID,
      reason: "checkout_stock_unavailable",
    });
    expect(vi.mocked(ports.compensationPort.cancelAbandonedOrder)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({ reason: "stock_unavailable" }),
        }),
      }),
    );
  });

  it("still returns the stock-unavailable 409 when the abandoned-order cancellation itself fails", async () => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new CommerceRuntimeConflictError("Inventory reservation conflict", { code: "23505" }),
    );
    vi.mocked(ports.compensationPort.cancelAbandonedOrder).mockRejectedValue(
      new Error("boom: compensation rpc unavailable"),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({ reason: "stock_unavailable" }),
        }),
      }),
    );
  });

  it("maps replayed prepared provider attempts to checkout conflict without compensation", async () => {
    const res = createResponse();
    const ports = createPorts();
    vi.mocked(ports.runtimePort.startRuntime).mockRejectedValue(
      new ProviderAttemptInFlightError({
        paymentAttemptId: "attempt-1",
        status: "created",
        providerAttemptId: null,
        providerSessionId: null,
      }),
    );

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.compensationPort.releaseOrderReservations)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({ reason: "provider_attempt_in_flight" }),
        }),
      }),
    );
  });
});
