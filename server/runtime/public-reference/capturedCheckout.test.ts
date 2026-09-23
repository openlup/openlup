import { describe, expect, it, vi } from "vitest";
import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import type { CheckoutCommandRuntimeResult } from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { createReferenceCheckoutHandler } from "../../domains/commerce/referenceCheckoutHandler.js";
import { resolveSubscriptionPaymentMethodStatus } from "../../../src/domains/subscription/paymentMethodLifecycle.js";

const ingestPaymentEvent = vi.fn();
const applyPaymentResult = vi.fn();
const confirmSubscriptionActivation = vi.fn();
const upsertFromWebhook = vi.fn();
const persistCheckoutCommand = vi.fn();
vi.mock("../../adapters/supabase/payment/paymentWebhookGateway.js", () => ({
  createPaymentWebhookControlPortViaGateway: () => ({ ingestPaymentEvent, applyPaymentResult, confirmSubscriptionActivation }),
  createPaymentWebhookMethodRefPortViaGateway: () => ({ upsertFromWebhook }),
}));
vi.mock("../../adapters/supabase/configuratorIntentPersistence.js", () => ({
  createSupabaseConfiguratorIntentPersistencePort: () => ({ persistCheckoutCommand }),
}));

import { assertNoRecordedOutcomeChange, createCapturedReferenceCheckoutHandler, readCapturedCheckoutEvidence, resumeRecordedCheckout, settleCapturedCheckout } from "./capturedCheckout.js";

const ids = {
  order: "11111111-1111-4111-8111-111111111111",
  client: "22222222-2222-4222-8222-222222222222",
  intent: "33333333-3333-4333-8333-333333333333",
  attempt: "44444444-4444-4444-8444-444444444444",
  payment: "55555555-5555-4555-8555-555555555555",
  subscription: "66666666-6666-4666-8666-666666666666",
};
const command: CheckoutCommandV1 = {
  version: "commerce.checkout_command.v1", idempotencyKey: "reference-checkout-001", mode: "subscription", cadenceDays: 30,
  lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
  customer: { firstName: "Alex", lastName: "Taylor", email: "alex@example.test", phone: "+12025550123" },
  shippingAddress: { street: "1 Reference Way", postalCode: "10001", city: "Warsaw", country: "PL" },
  currency: "PLN",
};
function checkout(status: "processing" | "failed" = "processing"): CheckoutCommandRuntimeResult {
  return {
    persistence: { idempotencyKey: command.idempotencyKey, clientId: ids.client, subjectId: null, shippingAddressId: ids.client, replayed: false },
    runtime: { runtime: {
      orderId: ids.order, clientId: ids.client, total: { amountMinor: 1490, currency: "PLN" },
      payment: { paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, status, attemptStatus: status },
    } } as CheckoutCommandRuntimeResult["runtime"],
    settlement: null,
  } as CheckoutCommandRuntimeResult;
}
function applied(replayed: boolean) {
  return {
    contractVersion: "commerce.v0" as const,
    paymentResult: { paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, paymentId: ids.payment,
      orderId: ids.order, status: "succeeded" as const, kind: "capture", replayed },
    reservationRelease: { attempted: false, releasedCount: 0 },
    readiness: { omsEligibility: { allowed: true, reason: null }, fulfillmentCreate: { allowed: true, reason: null, omsReason: null } },
  };
}
function gateway(outcome: "captured" | "refused", override: Record<string, unknown> = {}): DataGatewayPort {
  const rows = {
    commerce_payment_attempts: {
      id: ids.attempt, payment_intent_id: ids.intent, payment_id: ids.payment, provider: "stripe",
      idempotency_key: `${command.idempotencyKey}:payment-execution:prepare-attempt`, status: "processing", amount_cents: 1490,
      currency: "PLN", created_at: "2026-09-23T12:00:00.000Z",
      request_payload: { source: "reference_store.local.payment_simulator.v1", runtimeIdempotencyKey: command.idempotencyKey },
      response_payload: { providerCall: true, providerCallPlanned: true, outcome }, ...override,
    },
    commerce_payment_intents: {
      id: ids.intent, order_id: ids.order, subscription_id: ids.subscription,
      target_kind: "subscription_cycle", payment_id: ids.payment, active_attempt_id: ids.attempt,
      amount_cents: 1490, currency: "PLN",
    },
  };
  const client = { from: (table: keyof typeof rows) => ({ select: () => ({ eq: () => ({
    single: async () => ({ data: rows[table], error: null }),
    limit: async () => ({ data: table === "commerce_payment_attempts" ? [rows[table]] : [], error: null }),
  }) }) }) };
  return { asService: (work) => work(client), asActor: vi.fn() } as DataGatewayPort;
}

describe("captured reference checkout", () => {
  it("requires disposable-profile proof before opening a service gateway", async () => {
    const asService = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() } as unknown as HttpResponse;
    await createCapturedReferenceCheckoutHandler({
      gateway: { asService, asActor: vi.fn() } as unknown as DataGatewayPort,
      outcome: "captured", assertDisposable: async () => { throw new Error("not disposable"); },
    })({ method: "POST", body: { command }, headers: {}, query: {} } as HttpRequest, response);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(asService).not.toHaveBeenCalled();
  });

  it("rejects browser attempts to supply paid/provider/outcome before any checkout write", async () => {
    const startCheckout = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() } as unknown as HttpResponse;
    const request = { method: "POST", body: { command, paid: true, provider: "stripe", outcome: "captured" }, headers: {}, query: {} } as HttpRequest;
    await createReferenceCheckoutHandler({
      startCheckout, checkRateLimit: vi.fn(), admitProfile: () => true,
    })(request, response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("requires the exact persisted issued attempt and intent, including amount", async () => {
    await expect(readCapturedCheckoutEvidence(gateway("captured", { payment_intent_id: ids.order }), command, checkout()))
      .rejects.toThrow("reference_payment_evidence_mismatch");
    await expect(readCapturedCheckoutEvidence(gateway("captured", { amount_cents: 1491 }), command, checkout()))
      .rejects.toThrow("reference_payment_evidence_mismatch");
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
  });

  it("refuses a changed operator outcome before replay can write a different attempt", async () => {
    await expect(assertNoRecordedOutcomeChange(gateway("refused"), command, "captured"))
      .rejects.toThrow("Reference payment outcome differs from the recorded attempt");
    await expect(assertNoRecordedOutcomeChange(gateway("refused"), command, "refused"))
      .resolves.toBe(true);
  });

  it("revalidates the original command before resuming a prepared attempt", async () => {
    const receipt = { finalizedOrder: { orderId: ids.order, clientId: ids.client, mode: "subscription_cycle", total: { amountMinor: 1490, currency: "PLN" } } };
    const draft = { orderDraft: { quoteSnapshot: { quote: { currency: "PLN" } } } };
    const reads: string[] = [];
    const client = { from: (table: string) => {
      const filters: Record<string, string> = {};
      return { select: () => ({
        eq(column: string, value: string) { filters[column] = value; return this; },
        async single() {
          reads.push(`${table}:${filters.scope ?? filters.idempotency_key ?? filters.id}`);
          if (table === "commerce_idempotency_keys") return { data: { status: "completed", response_payload: filters.scope === "commerce.checkout_order_finalize" ? receipt : draft }, error: null };
          if (table === "commerce_payment_attempts") return { data: { id: ids.attempt, payment_intent_id: ids.intent, status: "processing" }, error: null };
          return { data: { id: ids.intent, order_id: ids.order, active_attempt_id: ids.attempt, status: "processing" }, error: null };
        },
      }) };
    } };
    const db = { asService: (work: (client: unknown) => Promise<unknown>) => work(client) } as DataGatewayPort;
    persistCheckoutCommand.mockRejectedValueOnce(new Error("canonical command fingerprint conflict"));
    await expect(resumeRecordedCheckout(db, command)).rejects.toThrow("canonical command fingerprint conflict");
    expect(reads).toEqual([]);
    persistCheckoutCommand.mockResolvedValueOnce({ idempotencyKey: command.idempotencyKey, clientId: ids.client, subjectId: null, shippingAddressId: ids.client, replayed: true });
    const resumed = await resumeRecordedCheckout(db, command);
    expect(persistCheckoutCommand).toHaveBeenCalledWith(command);
    expect(resumed.runtime.runtime.payment).toMatchObject({ paymentIntentId: ids.intent, paymentAttemptId: ids.attempt });
    expect(reads).toHaveLength(4);
  });

  it("resumes at each durable payment-control step after a lost HTTP response", async () => {
    ingestPaymentEvent.mockClear();
    applyPaymentResult.mockClear();
    upsertFromWebhook.mockClear();
    confirmSubscriptionActivation.mockClear();
    ingestPaymentEvent.mockResolvedValue({ paymentEventId: ids.payment, paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, replayed: false });
    applyPaymentResult.mockResolvedValue(applied(false));
    upsertFromWebhook.mockResolvedValue({ replayed: false });
    confirmSubscriptionActivation.mockResolvedValue({ confirmed: true, status: "active" });
    const db = gateway("captured");
    const first = await settleCapturedCheckout(db, command, checkout(), applyPaymentResult);
    expect(first.settlement?.paymentResult.status).toBe("succeeded");
    expect(ingestPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({
      paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, eventType: "payment.succeeded",
      occurredAt: "2026-09-23T12:00:00.000Z",
      reusableMethod: expect.objectContaining({ clientId: ids.client, subscriptionId: ids.subscription }),
    }));
    expect(ingestPaymentEvent.mock.invocationCallOrder[0]).toBeLessThan(applyPaymentResult.mock.invocationCallOrder[0]);
    expect(applyPaymentResult.mock.invocationCallOrder[0]).toBeLessThan(upsertFromWebhook.mock.invocationCallOrder[0]);
    expect(upsertFromWebhook.mock.invocationCallOrder[0]).toBeLessThan(confirmSubscriptionActivation.mock.invocationCallOrder[0]);
    const registered = upsertFromWebhook.mock.calls[0][0].reusableMethod;
    expect(resolveSubscriptionPaymentMethodStatus({
      clientId: ids.client, methodClientId: registered.clientId, providerKind: "stripe",
      providerCustomerRef: registered.providerCustomerRef, providerMethodRef: registered.providerMethodRef,
      methodKind: registered.methodKind, methodStatus: registered.status, methodActive: true,
    }).canAttemptCharge).toBe(true);
    ingestPaymentEvent.mockResolvedValue({ paymentEventId: ids.payment, paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, replayed: true });
    applyPaymentResult.mockResolvedValue(applied(true));
    const replay = await settleCapturedCheckout(db, command, checkout(), applyPaymentResult);
    expect(replay.settlement?.paymentResult.replayed).toBe(true);
    expect(ingestPaymentEvent.mock.calls[0]?.[0].providerEventId).toBe(ingestPaymentEvent.mock.calls[1]?.[0].providerEventId);
  });

  it("resumes after payment was applied but method registration failed", async () => {
    ingestPaymentEvent.mockClear();
    applyPaymentResult.mockClear();
    upsertFromWebhook.mockClear();
    confirmSubscriptionActivation.mockClear();
    ingestPaymentEvent.mockResolvedValue({ paymentEventId: ids.payment, paymentIntentId: ids.intent, paymentAttemptId: ids.attempt, replayed: true });
    applyPaymentResult.mockResolvedValue(applied(true));
    upsertFromWebhook.mockRejectedValueOnce(new Error("method store interrupted")).mockResolvedValue({ replayed: false });
    confirmSubscriptionActivation.mockResolvedValue({ confirmed: true, status: "active" });
    const db = gateway("captured");
    await expect(settleCapturedCheckout(db, command, checkout(), applyPaymentResult)).rejects.toThrow("method store interrupted");
    expect(confirmSubscriptionActivation).not.toHaveBeenCalled();
    const recovered = await settleCapturedCheckout(db, command, checkout(), applyPaymentResult);
    expect(recovered.settlement?.paymentResult.status).toBe("succeeded");
    expect(ingestPaymentEvent.mock.calls[0]?.[0].providerEventId).toBe(ingestPaymentEvent.mock.calls[1]?.[0].providerEventId);
    expect(applyPaymentResult.mock.calls[0]?.[0].idempotencyKey).toBe(applyPaymentResult.mock.calls[1]?.[0].idempotencyKey);
    expect(confirmSubscriptionActivation).toHaveBeenCalledTimes(1);
  });

  it("keeps a recorded refusal failed even when a caller wants capture", async () => {
    ingestPaymentEvent.mockClear();
    const refused = checkout("failed");
    expect(await settleCapturedCheckout(gateway("refused"), command, refused, applyPaymentResult)).toBe(refused);
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
  });
});
