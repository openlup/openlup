import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { CommerceRuntimeConflictError } from "../../src/domains/commerce/runtimePorts.js";
import {
  createCheckoutInlineRecoveryPayHandler,
  checkoutInlineRecoveryTransitionKey,
} from "../../server/domains/commerce/checkoutInlineRecoveryPayHandler.js";
import type { PaymentRecoverySnapshot } from "../../server/domains/commerce/paymentRecoveryGuidanceAuthorization.js";
import type { CheckoutRecoveryOrderSnapshot } from "../../server/domains/commerce/checkoutRecoveryOrderPort.js";
import type { CheckoutRecoveryPayService } from "../../server/domains/commerce/checkoutRecoveryPayService.js";
import type { ProviderRecoveryAction } from "../../server/domains/payment/checkoutRecoveryPaymentResolver.js";

const ids = {
  orderId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333", paymentAttemptId: "44444444-4444-4444-8444-444444444444",
  retryRequestId: "55555555-5555-4555-8555-555555555555", nextAttemptId: "66666666-6666-4666-8666-666666666666",
};
const journeyId = "checkout:77777777-7777-4777-8777-777777777777";
const baseRequest = { orderId: ids.orderId, clientId: ids.clientId, paymentIntentId: ids.paymentIntentId,
  retryRequestId: ids.retryRequestId, journeyId, expectedPaymentAttemptId: ids.paymentAttemptId,
  paymentMethod: "card" as const, paymentProvider: "stripe" as const };
const claims = { version: 1 as const, purpose: "commerce.checkout-payment-continuation.v1" as const,
  expiresAt: 4_000_000_000, journeyId, ...ids, executionRail: "tpay" as const };

function snapshot(overrides: Partial<PaymentRecoverySnapshot> = {}): PaymentRecoverySnapshot {
  return { orderId: ids.orderId, clientId: ids.clientId, paymentIntentId: ids.paymentIntentId,
    paymentAttemptId: ids.paymentAttemptId, orderStatus: "pending_payment", intentStatus: "failed",
    attemptStatus: "failed", provider: "tpay", providerPaymentId: "TR-old", updatedAt: "2026-09-12T12:00:00Z",
    failureReason: "provider_declined", subscriptionActivationStatus: "not_applicable", subscriptionId: null,
    subscriptionStatus: null, eligible: true, purchaseContext: "one_time", tokenAuthorized: false,
    historyComplete: true, observedSuccess: false, attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
      refusalVerified: true, cause: "generic_decline", certainty: "verified", disclosure: "safe", advice: null,
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" }, operation: "one_time_payment",
    } }], ...overrides };
}

function order(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return { orderId: ids.orderId, orderRef: `order_${ids.orderId}`, orderNumber: "ORDER-1", clientId: ids.clientId,
    status: "pending_payment", mode: "one_time_order", totalMinor: 12900, currency: "XTS", petName: "Luna",
    cadenceDays: null, createdAt: "2026-09-12T10:00:00Z", customerEmail: "buyer@example.invalid",
    customerName: "Buyer", paymentIntentId: ids.paymentIntentId, paymentIntentStatus: "failed",
    subscriptionId: null, subscriptionCycleId: null, technicallyExpired: false,
    priorPaymentEvidence: { paymentIntentId: ids.paymentIntentId, paymentAttemptId: ids.paymentAttemptId,
      provider: "tpay", providerPaymentId: "TR-old", idempotencyKey: "old-key", retryRequestId: null }, ...overrides };
}

function response(): VercelResponse {
  const headers = new Map<string, unknown>();
  const res = { setHeader: vi.fn((name: string, value: unknown) => headers.set(name, value)),
    getHeader: vi.fn((name: string) => headers.get(name)), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res); vi.mocked(res.json).mockReturnValue(res);
  return res;
}
function request(body: unknown = baseRequest): VercelRequest {
  return { method: "POST", body, query: {}, headers: { cookie: "signed=opaque", authorization: "Bearer must-be-ignored" } } as unknown as VercelRequest;
}
function body(res: VercelResponse) { return vi.mocked(res.json).mock.calls[0]?.[0] as Record<string, unknown>; }

function setup(input: { claims?: typeof claims | null; snapshot?: PaymentRecoverySnapshot | null;
  order?: CheckoutRecoveryOrderSnapshot | null;
  pay?: ReturnType<typeof vi.fn<CheckoutRecoveryPayService["pay"]>>;
  action?: ProviderRecoveryAction | null;
  enabled?: boolean } = {}) {
  const value = input.snapshot === undefined ? snapshot() : input.snapshot;
  const getGuidanceSnapshot = vi.fn(async () => value);
  const getRecoveryOrder = vi.fn(async () => input.order === undefined ? order() : input.order);
  const pay = input.pay ?? vi.fn<CheckoutRecoveryPayService["pay"]>(async (payInput) => ({ orderId: ids.orderId, clientId: ids.clientId,
    paymentIntentId: ids.paymentIntentId, status: "processing" as const, paymentAttemptId: ids.nextAttemptId,
    provider: payInput.paymentProvider, providerPaymentId: "pi-new", clientAction: payInput.paymentProvider === "stripe"
      ? { kind: "provider_embedded" as const, provider: "stripe" as const, clientSecret: "secret" }
      : { kind: "none" as const } }));
  const mintContinuation = vi.fn();
  const readActiveAction = vi.fn(async () => input.action ?? null);
  const handler = createCheckoutInlineRecoveryPayHandler({ recoveryEnabled: () => input.enabled ?? true,
    readContinuationClaims: () => input.claims === undefined ? claims : input.claims,
    mintContinuation, recoveryGuidance: { port: { getGuidanceSnapshot } },
    orderPort: { getRecoveryOrder }, payService: { pay }, activeActionResolver: { readActiveAction } });
  return { handler, getGuidanceSnapshot, getRecoveryOrder, pay, mintContinuation, readActiveAction };
}

describe("inline exact-order recovery handler", () => {
  it("derives the transition key, pays the frozen exact order, and rotates authority", async () => {
    const d = setup(); const res = response(); await d.handler(request(), res);
    expect(d.pay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      order: expect.objectContaining({ orderId: ids.orderId, totalMinor: 12900, currency: "XTS" }),
      idempotencyKey: `checkout-inline-recovery:${ids.paymentAttemptId}`,
      exactInlineRetry: { expectedPaymentAttemptId: ids.paymentAttemptId,
        retryRequestId: ids.retryRequestId, purchaseContext: "one_time" },
    }));
    expect(d.mintContinuation).toHaveBeenCalledWith(res, expect.objectContaining({
      paymentAttemptId: ids.nextAttemptId, executionRail: "stripe" }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("executes a server-proven legacy BLIK refusal fallback on the same exact aggregate", async () => {
    const state = snapshot({ attempts: [{ id: ids.paymentAttemptId, status: "failed", provider: "tpay",
      providerFlow: "blik_one_time", evidence: null }] });
    const d = setup({ snapshot: state }); const res = response();
    await d.handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(d.pay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      order: expect.objectContaining({ orderId: ids.orderId }),
      exactInlineRetry: expect.objectContaining({ expectedPaymentAttemptId: ids.paymentAttemptId }),
    }));
  });

  it("pins the new idempotency dialect byte for byte", () => {
    expect(checkoutInlineRecoveryTransitionKey(ids.paymentAttemptId))
      .toBe("checkout-inline-recovery:44444444-4444-4444-8444-444444444444");
  });

  it.each([null, { ...claims, orderId: ids.nextAttemptId }, { ...claims, clientId: ids.nextAttemptId },
    { ...claims, paymentIntentId: ids.nextAttemptId }, { ...claims, journeyId: `checkout:${ids.nextAttemptId}` },
    { ...claims, paymentAttemptId: ids.nextAttemptId }])(
    "rejects missing or mismatched cookie claims before every durable read %#", async (claim) => {
      const d = setup({ claims: claim as typeof claims | null }); const res = response();
      await d.handler(request(), res);
      expect(res.status).toHaveBeenCalledWith(401); expect(d.getGuidanceSnapshot).not.toHaveBeenCalled();
      expect(d.getRecoveryOrder).not.toHaveBeenCalled(); expect(d.pay).not.toHaveBeenCalled();
      expect(d.mintContinuation).not.toHaveBeenCalled();
    });

  it.each([
    ["paid order", snapshot({ orderStatus: "paid" }), order()],
    ["processing intent", snapshot({ intentStatus: "processing" }), order({ paymentIntentStatus: "processing" })],
    ["active attempt", snapshot({ attemptStatus: "processing" }), order()],
    ["expired order", snapshot(), order({ technicallyExpired: true })],
    ["paused subscription", snapshot({ purchaseContext: "subscription_initial", subscriptionId: ids.nextAttemptId,
      subscriptionStatus: "paused" }), order({ mode: "subscription_cycle", subscriptionId: ids.nextAttemptId })],
  ] as const)("fails closed without payment or cookie for %s", async (_name, state, orderValue) => {
    const d = setup({ snapshot: state, order: orderValue }); const res = response(); await d.handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(409); expect(d.pay).not.toHaveBeenCalled();
    expect(d.mintContinuation).not.toHaveBeenCalled();
  });

  it("admits a fresh BLIK code on the same method only with instrument-level guidance", async () => {
    const noMethodChange = snapshot({ attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
      refusalVerified: true, cause: "generic_decline", certainty: "verified", disclosure: "safe", advice: null,
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" }, operation: "one_time_payment",
    } }] });
    const d = setup({ snapshot: noMethodChange }); const res = response();
    const sameBlikRequest = { ...baseRequest, paymentMethod: "blik" as const, paymentProvider: "tpay" as const,
      paymentExecution: { provider: "tpay" as const, flow: "blik_one_time" as const, blikToken: "123456" } };
    await d.handler(request(sameBlikRequest), res);
    expect(res.status).toHaveBeenCalledWith(200); expect(d.pay).toHaveBeenCalledOnce();
  });

  it("blocks same-method BLIK when exact evidence prohibits the whole method", async () => {
    const state = snapshot({ attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
      refusalVerified: true, cause: "operation_unsupported", certainty: "verified", disclosure: "safe",
      advice: { code: "do_not_try_again", scope: "method" },
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" }, operation: "recurring_setup",
    } }] });
    const d = setup({ snapshot: state }); const res = response();
    await d.handler(request({ ...baseRequest, paymentMethod: "blik", paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } }), res);
    expect(res.status).toHaveBeenCalledWith(409); expect(d.pay).not.toHaveBeenCalled();
    expect(d.mintContinuation).not.toHaveBeenCalled();
  });

  it("rejects guidance without an exact supported predecessor method", async () => {
    const state = snapshot({ attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
      refusalVerified: true, cause: "generic_decline", certainty: "verified", disclosure: "safe", advice: null,
      method: null, operation: "one_time_payment",
    } }] });
    const d = setup({ snapshot: state }); const res = response();
    await d.handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(d.pay).not.toHaveBeenCalled();
    expect(d.mintContinuation).not.toHaveBeenCalled();
  });

  it("accepts subscription Model O BLIK only while pending activation", async () => {
    const subId = ids.nextAttemptId;
    const state = snapshot({ purchaseContext: "subscription_initial", subscriptionId: subId,
      subscriptionStatus: "pending_activation", subscriptionActivationStatus: "not_applicable",
      attempts: [{ id: ids.paymentAttemptId, status: "failed", evidence: {
        refusalVerified: true, cause: "generic_decline", certainty: "verified", disclosure: "safe", advice: null,
        method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" }, operation: "recurring_setup",
      } }] });
    const d = setup({ snapshot: state, order: order({ mode: "subscription_cycle", subscriptionId: subId }) });
    const res = response();
    await d.handler(request({ ...baseRequest, paymentMethod: "blik", paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_recurring_activation", blikToken: "123456", recurringModel: "O" } }), res);
    expect(d.pay).toHaveBeenCalledWith(expect.objectContaining({ paymentProvider: "tpay",
      paymentExecution: expect.objectContaining({ flow: "blik_recurring_activation", recurringModel: "O" }) }));
  });

  describe("BLIK activation refusal on a first subscription order", () => {
    const subId = ids.nextAttemptId;
    const activationRefusal = { refusalVerified: true, cause: "generic_decline" as const, certainty: "unknown" as const,
      disclosure: "safe" as const, advice: null, operation: "recurring_setup" as const,
      method: { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" as const } };
    const refused = (overrides: Partial<PaymentRecoverySnapshot> = {}) => snapshot({ purchaseContext: "subscription_initial",
      subscriptionId: subId, subscriptionStatus: "pending_activation", attempts: [{ id: ids.paymentAttemptId,
        status: "failed", provider: "tpay", providerFlow: "blik_recurring_activation", evidence: activationRefusal }],
      ...overrides });
    const subscriptionOrder = () => order({ mode: "subscription_cycle", subscriptionId: subId });
    const freshCode = { ...baseRequest, paymentMethod: "blik" as const, paymentProvider: "tpay" as const,
      paymentExecution: { provider: "tpay" as const, flow: "blik_recurring_activation" as const, blikToken: "123456",
        recurringModel: "O" as const } };

    it("admits a fresh code on the same order when no mandate decision was persisted", async () => {
      const d = setup({ snapshot: refused(), order: subscriptionOrder() }); const res = response();
      await d.handler(request(freshCode), res);
      expect(res.status).toHaveBeenCalledWith(200); expect(d.pay).toHaveBeenCalledOnce();
    });

    it.each([["with complete proofs", true], ["without complete proofs", false]] as const)(
      "never re-offers a refused agreement %s, but keeps card on the same order", async (_name, historyComplete) => {
        const state = refused({ failureReason: "blik_recurring_unsupported_bank", historyComplete });
        const blik = setup({ snapshot: state, order: subscriptionOrder() }); const blikRes = response();
        await blik.handler(request(freshCode), blikRes);
        expect(blikRes.status).toHaveBeenCalledWith(409); expect(blik.pay).not.toHaveBeenCalled();
        expect(JSON.stringify(body(blikRes))).toContain("recovery_action_not_allowed");
        expect(blik.mintContinuation).not.toHaveBeenCalled();
        const card = setup({ snapshot: state, order: subscriptionOrder() }); const cardRes = response();
        await card.handler(request(), cardRes);
        expect(cardRes.status).toHaveBeenCalledWith(200); expect(card.pay).toHaveBeenCalledOnce();
      });
  });

  it("returns an exact failed response-loss replay and rotates without provider dispatch", async () => {
    const prepareKey = `${checkoutInlineRecoveryTransitionKey(ids.paymentAttemptId)}:payment-execution:prepare-attempt`;
    const state = snapshot({ paymentAttemptId: ids.nextAttemptId, provider: "stripe" });
    const d = setup({ snapshot: state, order: order({ priorPaymentEvidence: { paymentIntentId: ids.paymentIntentId,
      paymentAttemptId: ids.nextAttemptId, provider: "stripe", providerPaymentId: "pi-new",
      idempotencyKey: prepareKey, retryRequestId: ids.retryRequestId } }) });
    const res = response(); await d.handler(request(), res);
    expect(d.pay).not.toHaveBeenCalled(); expect(d.mintContinuation).toHaveBeenCalled();
    expect(body(res)).toMatchObject({ ok: true, data: { orderRef: `order_${ids.orderId}`,
      status: "failed", paymentAttemptId: ids.nextAttemptId } });
  });

  it("rejects a competing tab nonce without rotating or dispatching", async () => {
    const prepareKey = `${checkoutInlineRecoveryTransitionKey(ids.paymentAttemptId)}:payment-execution:prepare-attempt`;
    const d = setup({ snapshot: snapshot({ paymentAttemptId: ids.nextAttemptId, provider: "stripe" }),
      order: order({ priorPaymentEvidence: { paymentIntentId: ids.paymentIntentId,
        paymentAttemptId: ids.nextAttemptId, provider: "stripe", providerPaymentId: "pi-new",
        idempotencyKey: prepareKey, retryRequestId: "88888888-8888-4888-8888-888888888888" } }) });
    const res = response(); await d.handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(409); expect(d.pay).not.toHaveBeenCalled();
    expect(d.mintContinuation).not.toHaveBeenCalled();
  });

  it("re-reads a lost Stripe action twice before rotating the cookie", async () => {
    const prepareKey = `${checkoutInlineRecoveryTransitionKey(ids.paymentAttemptId)}:payment-execution:prepare-attempt`;
    const state = snapshot({ paymentAttemptId: ids.nextAttemptId, provider: "stripe",
      attemptStatus: "requires_action", intentStatus: "requires_action" });
    const d = setup({ snapshot: state, action: { kind: "provider_embedded", provider: "stripe", clientSecret: "secret" },
      order: order({ paymentIntentStatus: "requires_action", priorPaymentEvidence: { paymentIntentId: ids.paymentIntentId,
        paymentAttemptId: ids.nextAttemptId, provider: "stripe", providerPaymentId: "pi-new",
        idempotencyKey: prepareKey, retryRequestId: ids.retryRequestId } }) });
    const res = response(); await d.handler(request(), res);
    expect(d.readActiveAction).toHaveBeenCalledOnce(); expect(d.pay).not.toHaveBeenCalled();
    expect(d.mintContinuation).toHaveBeenCalledWith(res, expect.objectContaining({ paymentAttemptId: ids.nextAttemptId }));
  });

  it.each([
    ["created", "created"],
    ["processing", "processing"],
  ] as const)("rotates exact lost Stripe %s authority when provider action readback still lags",
    async (_name, attemptStatus) => {
      const prepareKey = `${checkoutInlineRecoveryTransitionKey(ids.paymentAttemptId)}:payment-execution:prepare-attempt`;
      const state = snapshot({ paymentAttemptId: ids.nextAttemptId, provider: "stripe",
        attemptStatus, intentStatus: attemptStatus === "created" ? "created" : "processing" });
      const d = setup({ snapshot: state, action: null,
        order: order({ paymentIntentStatus: state.intentStatus, priorPaymentEvidence: {
          paymentIntentId: ids.paymentIntentId, paymentAttemptId: ids.nextAttemptId,
          provider: "stripe", providerPaymentId: null, idempotencyKey: prepareKey,
          retryRequestId: ids.retryRequestId,
        } }) });
      const res = response(); await d.handler(request(), res);
      expect(d.pay).not.toHaveBeenCalled();
      expect(d.mintContinuation).toHaveBeenCalledWith(res,
        expect.objectContaining({ paymentAttemptId: ids.nextAttemptId }));
      expect(body(res)).toMatchObject({ ok: true, data: {
        status: "processing", paymentAttemptId: ids.nextAttemptId, clientAction: { kind: "none" },
      } });
    });

  it("does not rotate when provider admission rejects the exact predecessor", async () => {
    const pay = vi.fn(async () => { throw new CommerceRuntimeConflictError("race", { reason: "predecessor" }); });
    const d = setup({ pay }); const res = response(); await d.handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(409); expect(d.mintContinuation).not.toHaveBeenCalled();
  });
});
