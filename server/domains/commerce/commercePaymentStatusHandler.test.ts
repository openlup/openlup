import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCommercePaymentStatusHandler } from "./commercePaymentStatusHandler.js";
import { PAYMENT_EXECUTION_PROVIDERS } from "../../../src/domains/payment/types.js";
import { paymentStatusResponseSchema } from "../../../src/domains/commerce/checkoutContracts.js";
import { PAYMENT_RECOVERY_GUIDANCE_HEADER, paymentRecoveryStatusResponseSchema } from "../../../src/domains/commerce/paymentRecoveryGuidanceContracts.js";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "../../../src/domains/commerce/paymentFailureDisplayContracts.js";
import { requestBff } from "../../../src/lib/bff/client.js";
import { bffSuccessSchema } from "../../../src/lib/bff/contracts.js";
import { DECLINE_FAILURE_REASONS } from "../../shared/finalizeDeclinedAttempt.js";

// Keep the old field set explicit; a modern field cannot expand this parser.
const legacyStatusSchema = paymentStatusResponseSchema.pick({
  contractVersion: true, orderId: true, paymentIntentId: true, status: true,
  orderStatus: true, payment: true, failureReason: true,
  subscriptionActivation: true, nextAction: true,
}).strict();

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_INTENT_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const JOURNEY_ID = "checkout:77777777-7777-4777-8777-777777777777";
const EMBEDDED_RAIL = PAYMENT_EXECUTION_PROVIDERS[2];

describe("commerce payment status handler", () => {
  it.each(["paid", "failed"] as const)("keeps an old strict client reading %s after deployment", async (status) => {
    const snapshot = {
      ...processingSnapshot(),
      orderStatus: status === "paid" ? "paid" : "pending_payment",
      intentStatus: status === "paid" ? "succeeded" as const : "failed" as const,
      attemptStatus: status === "paid" ? "succeeded" as const : "failed" as const,
      failureReason: status === "paid" ? null : DECLINE_FAILURE_REASONS.mandateUnsupported,
    };
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: { getPaymentStatus: async () => snapshot },
    });
    const res = createResponse();
    await handler(request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID }), res);
    const envelope = vi.mocked(res.json).mock.calls[0]![0];
    await expect(requestBff("/api/bff/commerce/payment-status", legacyStatusSchema, {
      fetcher: vi.fn(async () => new Response(JSON.stringify(envelope))),
    })).resolves.toMatchObject({ status, failureReason: snapshot.failureReason });
    const legacyBody = bffSuccessSchema(legacyStatusSchema).parse(envelope).data;
    expect(legacyBody).not.toHaveProperty("failureDisplay");
    expect(legacyStatusSchema.safeParse({ ...legacyBody, failureDisplay: null }).success).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it.each([undefined, "0", "2", " 1", "1, 1", ["1"]])("does not opt in from header %j", async (header) => {
    const res = createResponse();
    const req = request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID });
    req.headers[PAYMENT_FAILURE_DISPLAY_HEADER.toLowerCase()] = header;
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: { getPaymentStatus: async () => processingSnapshot() },
    });
    await handler(req, res);
    const body = bffSuccessSchema(legacyStatusSchema).parse(vi.mocked(res.json).mock.calls[0]![0]).data;
    expect(body).not.toHaveProperty("failureDisplay");
  });

  it.each(Object.values(DECLINE_FAILURE_REASONS))("returns the real mapped recovery for opted-in %s", async (reason) => {
    const res = createResponse();
    vi.mocked(res.getHeader!).mockReturnValue("Accept-Encoding, cookie");
    const req = request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID });
    req.headers[PAYMENT_FAILURE_DISPLAY_HEADER.toLowerCase()] = "1";
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: { getPaymentStatus: async () => ({
        ...processingSnapshot(), intentStatus: "failed", attemptStatus: "failed", failureReason: reason,
      }) },
    });
    await handler(req, res);
    const body = bffSuccessSchema(paymentStatusResponseSchema).parse(vi.mocked(res.json).mock.calls[0]![0]).data;
    expect(body).toMatchObject({ status: "failed", failureReason: reason, failureDisplay: reason });
    expect(res.setHeader).toHaveBeenCalledWith("Vary", `Accept-Encoding, cookie, Authorization, ${PAYMENT_FAILURE_DISPLAY_HEADER}, ${PAYMENT_RECOVERY_GUIDANCE_HEADER}`);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("returns local processing status without trusting provider/browser return data", async () => {
    const res = createResponse();
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: {
        async getPaymentStatus() {
          return {
            orderId: ORDER_ID,
            orderStatus: "pending_payment",
            clientId: CLIENT_ID,
            paymentIntentId: PAYMENT_INTENT_ID,
            intentStatus: "processing",
            paymentAttemptId: PAYMENT_ATTEMPT_ID,
            attemptStatus: "sent_to_provider",
            provider: EMBEDDED_RAIL,
            providerPaymentId: "pi_provider",
            updatedAt: "2026-06-06T10:00:00.000+00:00",
            failureReason: null,
            subscriptionActivationStatus: "not_applicable",
            subscriptionId: null,
          };
        },
      },
    });

    await handler(request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "commerce.checkout.v2",
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        orderStatus: "pending_payment",
        status: "processing",
        payment: {
          intentStatus: "processing",
          attemptStatus: "sent_to_provider",
          paymentAttemptId: PAYMENT_ATTEMPT_ID,
          provider: EMBEDDED_RAIL,
          providerPaymentId: "pi_provider",
          updatedAt: "2026-06-06T10:00:00.000+00:00",
        },
        failureReason: null,
        subscriptionActivation: { status: "not_applicable", subscriptionId: null },
        nextAction: null,
      },
      meta: { contractVersion: "commerce.checkout.v2" },
    });
  });

  it("rejects status reads for the wrong client", async () => {
    const res = createResponse();
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: {
        async getPaymentStatus() {
          return {
            orderId: ORDER_ID,
            orderStatus: "paid",
            clientId: OTHER_CLIENT_ID,
            paymentIntentId: PAYMENT_INTENT_ID,
            intentStatus: "succeeded",
            paymentAttemptId: PAYMENT_ATTEMPT_ID,
            attemptStatus: "succeeded",
            provider: EMBEDDED_RAIL,
            providerPaymentId: "pi_provider",
            updatedAt: "2026-06-06T10:00:00.000+00:00",
            failureReason: null,
            subscriptionActivationStatus: "active",
            subscriptionId: "66666666-6666-4666-8666-666666666666",
          };
        },
      },
    });

    await handler(request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Payment status does not belong to this client",
      },
    });
  });

  it("returns the same active action only for an exact continuation capability", async () => {
    const res = createResponse();
    const readActiveAction = vi.fn().mockResolvedValue({
      kind: "provider_embedded",
      provider: EMBEDDED_RAIL,
      clientSecret: "pi_client_secret_same_attempt",
    });
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: { async getPaymentStatus() { return processingSnapshot(); } },
      readContinuationClaims: () => ({
        version: 1,
        purpose: "commerce.checkout-payment-continuation.v1",
        expiresAt: 1_800_000_000,
        journeyId: JOURNEY_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: PAYMENT_ATTEMPT_ID,
        executionRail: EMBEDDED_RAIL,
      }),
      activeActionResolver: { readActiveAction },
    });

    await handler(request({
      orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      clientId: CLIENT_ID,
      journeyId: JOURNEY_ID,
    }), res);

    expect(readActiveAction).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentAttemptId: PAYMENT_ATTEMPT_ID,
      executionRail: EMBEDDED_RAIL,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextAction: {
          kind: "provider_embedded",
          provider: EMBEDDED_RAIL,
          clientSecret: "pi_client_secret_same_attempt",
        },
      }),
    }));
    expect(res.setHeader).toHaveBeenCalledWith("Vary", `Cookie, Authorization, ${PAYMENT_FAILURE_DISPLAY_HEADER}, ${PAYMENT_RECOVERY_GUIDANCE_HEADER}`);
  });

  it("does not disclose or call the resolver when the journey does not match", async () => {
    const res = createResponse();
    const readActiveAction = vi.fn();
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true,
      statusPort: { async getPaymentStatus() { return processingSnapshot(); } },
      readContinuationClaims: () => ({
        version: 1,
        purpose: "commerce.checkout-payment-continuation.v1",
        expiresAt: 1_800_000_000,
        journeyId: JOURNEY_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: PAYMENT_ATTEMPT_ID,
        executionRail: EMBEDDED_RAIL,
      }),
      activeActionResolver: { readActiveAction },
    });

    await handler(request({
      orderId: ORDER_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      clientId: CLIENT_ID,
      journeyId: "checkout:88888888-8888-4888-8888-888888888888",
    }), res);

    expect(readActiveAction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextAction: null }),
    }));
  });

  it.each([false, true])("negotiates guidance independently and uses one snapshot (display=%s)", async (display) => {
    const legacyRead = vi.fn(async () => processingSnapshot());
    const snapshot = { ...processingSnapshot(), intentStatus: "failed" as const, attemptStatus: "failed" as const,
      eligible: true, purchaseContext: "one_time" as const, historyComplete: true, tokenAuthorized: false,
      subscriptionStatus: null, observedSuccess: false,
      attempts: [{ id: PAYMENT_ATTEMPT_ID, status: "failed" as const, evidence: {
        refusalVerified: true, cause: "generic_decline" as const, certainty: "unknown" as const,
        disclosure: "safe" as const, method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" as const },
        operation: "one_time_payment" as const, advice: null,
      } }],
    };
    const getGuidanceSnapshot = vi.fn(async () => snapshot);
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => true, statusPort: { getPaymentStatus: legacyRead },
      readContinuationClaims: () => ({ version: 1, purpose: "commerce.checkout-payment-continuation.v1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600, journeyId: JOURNEY_ID, orderId: ORDER_ID,
        clientId: CLIENT_ID, paymentIntentId: PAYMENT_INTENT_ID, paymentAttemptId: PAYMENT_ATTEMPT_ID,
        executionRail: EMBEDDED_RAIL }),
      recoveryGuidance: { port: { getGuidanceSnapshot } },
    });
    const req = request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID, journeyId: JOURNEY_ID });
    req.headers[PAYMENT_RECOVERY_GUIDANCE_HEADER.toLowerCase()] = "1";
    if (display) req.headers[PAYMENT_FAILURE_DISPLAY_HEADER.toLowerCase()] = "1";
    const res = createResponse();
    await handler(req, res);
    const data = bffSuccessSchema(paymentRecoveryStatusResponseSchema).parse(vi.mocked(res.json).mock.calls[0]![0]).data;
    expect(data).toMatchObject({ status: "failed", recoveryGuidance: { consecutiveRefusals: 1, methodKey: "card" } });
    expect(Object.hasOwn(data, "failureDisplay")).toBe(display);
    expect(getGuidanceSnapshot).toHaveBeenCalledOnce();
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("leaves legacy status available without valid guidance authority", async () => {
    const getGuidanceSnapshot = vi.fn();
    const handler = createCommercePaymentStatusHandler({ mutationsEnabled: () => true,
      statusPort: { getPaymentStatus: async () => processingSnapshot() },
      recoveryGuidance: { port: { getGuidanceSnapshot } } });
    const req = request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID });
    req.headers[PAYMENT_RECOVERY_GUIDANCE_HEADER.toLowerCase()] = "1";
    const res = createResponse();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "processing", recoveryGuidance: null }) }));
    expect(getGuidanceSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed while provider payments are disabled", async () => {
    const res = createResponse();
    const handler = createCommercePaymentStatusHandler({
      mutationsEnabled: () => false,
      statusPort: { getPaymentStatus: vi.fn() },
    });

    await handler(request({ orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Provider payment status is disabled",
        details: {
          feature: "payment-status",
          featureFlag: "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
          reason: "feature_flag_disabled",
        },
      },
    });
  });
});

function request(query: Record<string, string>, method = "GET"): VercelRequest {
  return { method, query, body: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    getHeader: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function processingSnapshot() {
  return {
    orderId: ORDER_ID,
    orderStatus: "pending_payment",
    clientId: CLIENT_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    intentStatus: "processing" as const,
    paymentAttemptId: PAYMENT_ATTEMPT_ID,
    attemptStatus: "sent_to_provider" as const,
    provider: EMBEDDED_RAIL,
    providerPaymentId: "pi_provider",
    updatedAt: "2026-06-06T10:00:00.000+00:00",
    failureReason: null,
    subscriptionActivationStatus: "not_applicable" as const,
    subscriptionId: null,
  };
}
