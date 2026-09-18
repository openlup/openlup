import { buildStartedRuntimeResponse } from "../../server/domains/commerce/commerceRuntimeStartResponse.js";
import { declineFromError, declinedExecutionFacts } from "../../server/adapters/stripe/executionDecline.js";
import { createCommerceCheckoutHandler } from "../../server/domains/commerce/commerceCheckoutHandler.js";
import { CLIENT_ID, ORDER_ID, PAYMENT_INTENT_ID, PET_ID, createPorts, createResponse, intent, request } from "../../server/domains/commerce/commerceCheckoutHandler.testFixtures.js";
import { describe, expect, it, vi } from "vitest";
import { derivePaymentRecoveryGuidance, type PaymentRecoveryEvidence } from "@openlup/core/payment";
import { createPaymentRecoveryEvidenceNormalizer } from "../../server/adapters/paymentRecoveryGuidance.js";
import { stripeFailureEvidence, normalizeStripeFailureEvidence } from "../../server/adapters/stripe/stripeFailureEvidence.js";
import { tpayFailureEvidence, normalizeTpayFailureEvidence } from "../../server/adapters/tpay/tpayFailureEvidence.js";

import { readAuthorizedPaymentRecovery } from "../../server/domains/commerce/paymentRecoveryGuidanceAuthorization.js";
import { createCheckoutPaymentContinuationCodec } from "../../server/domains/commerce/checkoutPaymentContinuationCredential.js";
import { hasCheckoutRecoveryCopy, presentCheckoutRecoveryGuidance } from "../../src/checkout/machine/checkoutRecoveryGuidance.js";

const blik = { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" as const };
const stripe = (recurring: boolean) => stripeFailureEvidence({ id: "pi_test", status: "requires_payment_method",
  setup_future_usage: recurring ? "off_session" : null, metadata: { providerFlow: "one_time_payment" },
  payment_method: { id: "pm_code", type: "blik" },
  last_payment_error: { code: "card_declined", payment_method: { id: "pm_code", type: "blik" } },
}, { source: "readback", confirmedFailureEvent: true })!;
const tpay = (recurring: boolean) => tpayFailureEvidence({ source: "execution", providerPaymentId: "tx_test",
  refusalVerified: true, flow: recurring ? "blik_recurring_activation" : "blik_one_time",
  observation: { disposition: "present", code: "63" } });
const project = (evidence: PaymentRecoveryEvidence, previous = evidence) => derivePaymentRecoveryGuidance({
  paymentState: "failed", activeAttemptId: "current", historyComplete: true,
  attempts: [{ id: "current", status: "failed", evidence }, { id: "previous", status: "failed", evidence: previous }],
});

describe("portable checkout recovery adapter conformance", () => {
  it("maps actual Stripe and Tpay BLIK facts into one recurring-setup meaning", () => {
    const a = normalizeStripeFailureEvidence(stripe(true));
    const b = normalizeTpayFailureEvidence(tpay(true));
    expect(a).toEqual(b);
    // The operation is shared; neither adapter reads a refused agreement from it.
    expect(a).toMatchObject({ cause: "generic_decline", method: blik, operation: "recurring_setup" });
    expect(project(a)).toEqual(project(b));
  });
  it("does not confuse ordinary BLIK with recurring registration", () => {
    const a = normalizeStripeFailureEvidence(stripe(false));
    const b = normalizeTpayFailureEvidence(tpay(false));
    expect(a).toEqual(b);
    expect(project(a, b)).toMatchObject({ cause: "generic_decline", consecutiveRefusals: 2 });
  });
  it("requires an available locale before claiming recovery copy exists", () => {
    const getResource = vi.fn(() => "recovery copy");
    expect(hasCheckoutRecoveryCopy({ language: "", resolvedLanguage: undefined, getResource }, "checkout:recoveryGuidance.messages.c01")).toBe(false);
    expect(getResource).not.toHaveBeenCalled();
    expect(hasCheckoutRecoveryCopy({ language: "", resolvedLanguage: "pl", getResource }, "checkout:recoveryGuidance.messages.c01")).toBe(true);
    expect(getResource).toHaveBeenCalledWith("pl", "checkout", "recoveryGuidance.messages.c01");
  });
  it.each([false, true])("keeps a card alternative through actual recurring refusal and context-free readback (reverse=%s)", async (reverse) => {
    const execution = tpay(true);
    const readback = tpayFailureEvidence({ source: "readback", providerPaymentId: "tx_test",
      refusalVerified: true, flow: null, observation: { disposition: "present", code: "63" } });
    const observations = reverse ? [readback, execution] : [execution, readback];
    const evidence = createPaymentRecoveryEvidenceNormalizer()({ provider: "tpay", evidence: observations });
    // The cause remains conservative: retaining method context must not invent C07 certainty.
    expect(evidence).toMatchObject({ cause: "generic_decline", certainty: "unknown", method: blik,
      operation: "recurring_setup", advice: null });
    const paymentAttemptId = "44444444-4444-4444-8444-444444444444";
    const request = { orderId: ORDER_ID, clientId: CLIENT_ID, paymentIntentId: PAYMENT_INTENT_ID,
      journeyId: "checkout:55555555-5555-4555-8555-555555555555" };
    const now = Date.parse("2026-09-11T08:00:00Z");
    const codec = createCheckoutPaymentContinuationCodec("synthetic-test-signing-root-at-least-32-bytes",
      { now: () => new Date(now) })!;
    const claims = codec.verifyCookieHeader(codec.issue({ ...request, paymentAttemptId, executionRail: "tpay" }).setCookie)!;
    // Only the storage boundary is supplied; normalizer, authorization, core projection
    // and browser presentation all run, so neither side of the repaired seam is mocked.
    const result = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, now,
      deps: { port: { getGuidanceSnapshot: async () => ({ ...request, paymentAttemptId,
        orderStatus: "pending_payment", intentStatus: "failed", attemptStatus: "failed", provider: "tpay",
        providerPaymentId: "tx_test", updatedAt: new Date(now).toISOString(), failureReason: "provider_declined",
        subscriptionActivationStatus: "not_applicable", subscriptionId: PET_ID,
        subscriptionStatus: null, eligible: true, purchaseContext: "subscription_initial",
        tokenAuthorized: false, historyComplete: true, observedSuccess: false,
        attempts: [{ id: paymentAttemptId, status: "failed", evidence }],
      }) } } });
    expect(result?.guidance).toMatchObject({ methodKind: "blik", methodKey: "blik", cause: "generic_decline",
      operation: "recurring_setup", consecutiveRefusals: 1 });
    // A refused activation code without the mandate decision asks for a new code
    // first; card follows only where it is actually offered.
    expect(presentCheckoutRecoveryGuidance({ guidance: result!.guidance, methods: [
      { value: "blik", provider: "tpay" }, { value: "card", provider: "stripe" },
    ] })).toEqual({ messageKey: "checkout:recoveryGuidance.messages.c18", emphasis: "normal", actions: [
      { kind: "change_instrument", method: "blik", labelKey: "checkout:recoveryGuidance.actions.enterNewCode" },
      { kind: "change_method", method: "card", labelKey: "checkout:recoveryGuidance.actions.payByCard" }] });
    expect(presentCheckoutRecoveryGuidance({ guidance: result!.guidance, methods: [
      { value: "blik", provider: "tpay" }, { value: "transfer", provider: "tpay" },
    ] })).toMatchObject({ messageKey: "checkout:recoveryGuidance.messages.c18",
      actions: [{ kind: "change_instrument", method: "blik" }] });
  });
  it("preserves exact unsupported recurring guidance when normalized evidence has no advice", async () => {
    const execution = tpay(true);
    const readback = tpayFailureEvidence({ source: "readback", providerPaymentId: "tx_test",
      refusalVerified: true, flow: null, observation: { disposition: "present", code: "63" } });
    const evidence = createPaymentRecoveryEvidenceNormalizer()({ provider: "tpay", evidence: [execution, readback] });
    expect(evidence).toMatchObject({ cause: "generic_decline", certainty: "unknown", method: blik,
      operation: "recurring_setup", advice: null });
    const paymentAttemptId = "44444444-4444-4444-8444-444444444444";
    const request = { orderId: ORDER_ID, clientId: CLIENT_ID, paymentIntentId: PAYMENT_INTENT_ID,
      journeyId: "checkout:55555555-5555-4555-8555-555555555555" };
    const now = Date.parse("2026-09-11T08:00:00Z");
    const codec = createCheckoutPaymentContinuationCodec("synthetic-test-signing-root-at-least-32-bytes",
      { now: () => new Date(now) })!;
    const claims = codec.verifyCookieHeader(codec.issue({ ...request, paymentAttemptId, executionRail: "tpay" }).setCookie)!;
    const result = await readAuthorizedPaymentRecovery({ request, claims, authorization: undefined, now,
      deps: { port: { getGuidanceSnapshot: async () => ({ ...request, paymentAttemptId,
        orderStatus: "pending_payment", intentStatus: "failed", attemptStatus: "failed", provider: "tpay",
        providerPaymentId: "tx_test", updatedAt: new Date(now).toISOString(),
        failureReason: "blik_recurring_unsupported_bank", subscriptionActivationStatus: "not_applicable",
        subscriptionId: PET_ID, subscriptionStatus: "pending_activation", eligible: true,
        purchaseContext: "subscription_initial", tokenAuthorized: false, historyComplete: true,
        observedSuccess: false, attempts: [{ id: paymentAttemptId, status: "failed", provider: "tpay",
          providerFlow: "blik_recurring_activation", evidence }],
      }) } } });

    expect(result?.guidance).toEqual({ version: 1, paymentAttemptId,
      purchaseContext: "subscription_initial", cause: "recurring_setup_failed",
      methodKind: "blik", methodKey: "blik", operation: "recurring_setup",
      restriction: "method", actions: ["change_method"], consecutiveRefusals: 0,
      emphasis: "normal" });
    // The persisted mandate decision keeps its specific sentence ahead of the
    // generic method restriction it also carries.
    expect(presentCheckoutRecoveryGuidance({ guidance: result!.guidance, methods: [
      { value: "blik", provider: "tpay" }, { value: "card", provider: "stripe" },
    ] })).toMatchObject({ messageKey: "checkout:recoveryGuidance.messages.c07",
      actions: [{ kind: "change_method", method: "card" }] });
  });
  it("allows a synthetic third adapter without kernel or locale edits", () => {
    const normalize = createPaymentRecoveryEvidenceNormalizer([{ provider: "example_operator", normalize: (native) => ({
      refusalVerified: native.refusalVerified, cause: native.code === "E_AGREEMENT" ? "recurring_setup_failed" : "generic_decline",
      certainty: native.code === "E_AGREEMENT" ? "verified" : "unknown", disclosure: "safe",
      method: blik, operation: native.operation, advice: null,
    }) }]);
    const third = normalize({ provider: "example_operator", evidence: [{ ...tpay(true), code: "E_AGREEMENT", declineCode: null }] })!;
    // An adapter that actually proves a refused agreement may still name the setup cause.
    expect(third).toEqual({ refusalVerified: true, cause: "recurring_setup_failed", certainty: "verified",
      disclosure: "safe", method: blik, operation: "recurring_setup", advice: null });
    expect(project(third)).toMatchObject({ cause: "recurring_setup_failed", method: blik, operation: "recurring_setup" });
    expect(project(normalizeStripeFailureEvidence(stripe(true)))).toEqual(project(normalizeTpayFailureEvidence(tpay(true))));
  });
});

// Cross-layer producer conformance belongs beside adapter portability proof.
  it("carries the actual StripeCardError producer through finalized runtime and orchestration into refusal authority", async () => {
    const ports = createPorts();
    const paymentAttemptId = "66666666-6666-4666-8666-666666666666";
    const paymentId = "77777777-7777-4777-8777-777777777777";
    const execution = { provider: "stripe" as const, requestPayload: {}, ...declinedExecutionFacts(declineFromError({
      type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds",
      payment_intent: { id: "pi_actual_declined", status: "requires_payment_method" }, payment_method: { type: "card" },
    })!) };
    expect(execution).toMatchObject({ clientSecret: null, providerAttemptId: null,
      responsePayload: { providerAttemptId: "pi_actual_declined", failureEvidence: { providerPaymentId: "pi_actual_declined" } } });
    type Input = Parameters<typeof buildStartedRuntimeResponse>[0];
    const applyResult = vi.fn<Input["paymentPort"]["applyResult"]>(async () => ({ paymentIntentId: PAYMENT_INTENT_ID,
      paymentAttemptId, paymentId, orderId: ORDER_ID, status: "failed", kind: "recoverable_decline", replayed: false }));
    vi.mocked(ports.runtimePort.startRuntime).mockImplementation(async () => buildStartedRuntimeResponse({
      paymentExecutionIdempotencyKey: "actual-refusal", continuationActionOrigin: "fresh_execution", execution,
      paymentPort: { applyResult, createIntent: async () => { throw new Error("unexpected new intent"); },
        recordAttempt: async () => { throw new Error("unexpected new attempt"); } },
      readinessPort: { evaluateOrderReadiness: async () => ({ omsEligibility: { allowed: false, reason: "order_not_paid" },
        fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" } }) },
      order: { orderId: ORDER_ID, orderRef: `order_${ORDER_ID}`, mode: "one_time", clientId: CLIENT_ID, petId: PET_ID,
        shippingAddressId: CLIENT_ID, subscriptionId: null, subscriptionCycleId: null,
        total: { amountMinor: 12730, currency: "PLN" }, items: [], replayed: false }, reservations: [{ reservationId: paymentId, reservationIds: [paymentId],
        orderItemId: paymentAttemptId, skuId: CLIENT_ID, sku: "CORE", status: "reserved", replayed: false }],
      intent: { paymentIntentId: PAYMENT_INTENT_ID, paymentId, status: "created" },
      attempt: { paymentAttemptId, status: "processing" },
    }));
    const mintPaymentContinuationCookie = vi.fn(); const res = createResponse();
    await createCommerceCheckoutHandler({ ...ports, mintPaymentContinuationCookie })(
      request("POST", { intent: intent(), paymentProvider: "stripe" }), res);
    expect(applyResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resultStatus: "failed" }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", clientAction: { kind: "none" } }) }));
    expect(mintPaymentContinuationCookie).toHaveBeenCalledExactlyOnceWith(res, {
      journeyId: intent().idempotencyKey, clientId: CLIENT_ID, orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID, paymentAttemptId, executionRail: "stripe",
    });
    expect(applyResult.mock.invocationCallOrder[0]!).toBeLessThan(mintPaymentContinuationCookie.mock.invocationCallOrder[0]!);
    expect(ports.runtimePort.applyPaymentResult).not.toHaveBeenCalled();
    expect(ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
  });
