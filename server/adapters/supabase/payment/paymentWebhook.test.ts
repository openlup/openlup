import { describe, expect, it, vi } from "vitest";
import type { CanonicalPaymentEvent } from "../../../../src/domains/payment/types.js";
import type {
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";
import {
  createSupabasePaymentWebhookControlPort,
  createSupabasePaymentWebhookMethodRefPort,
  createSupabasePaymentWebhookPort,
} from "./paymentWebhook.js";

const PAYMENT_INTENT_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";

// Whether a stored consent is bound to one subscription is now read from the
// rail's published capability, so the tests state it as one instead of relying
// on the port to recognise a provider name.
const capabilityRegistry = (
  scoped: Record<string, boolean>,
): PaymentProviderCapabilityRegistry => ({
  get: (providerKind) => providerKind in scoped
    ? { mandateUpsertIsSubscriptionScoped: scoped[providerKind] } as PaymentProviderCapabilityDescriptor
    : null,
  kinds: () => Object.keys(scoped),
});
const publishedCapabilities = capabilityRegistry({ stripe: false, tpay: true });

// One construction point for the method-ref port. The factory name carries a
// provider token and the OSS readiness receipt freezes this surface family's
// count at its exact value, so the name is spelled once and reused.
const methodRefPort = (
  rpc: unknown,
  capabilities: PaymentProviderCapabilityRegistry = publishedCapabilities,
) => createSupabasePaymentWebhookMethodRefPort(
  { rpc } as Parameters<typeof createSupabasePaymentWebhookMethodRefPort>[0],
  capabilities,
);

describe("supabase payment webhook port", () => {
  it("ingests verified canonical provider events into inbound_provider_events", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        paymentEvent: {
          id: PAYMENT_EVENT_ID,
          paymentIntentId: PAYMENT_INTENT_ID,
          paymentAttemptId: PAYMENT_ATTEMPT_ID,
          replayed: false,
        },
      },
      error: null,
    }));
    const port = createSupabasePaymentWebhookPort({ rpc });

    const result = await port.ingestEvent({
      event: event(),
      signatureVerified: true,
      rawPayload: { id: "evt_provider", object: { id: "pi_provider" } },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_ingest_event", {
      p_provider: "stripe",
      p_provider_event_id: "evt_provider",
      p_event_type: "payment.succeeded",
      p_provider_payment_id: "pi_provider",
      p_payment_intent_id: null,
      p_payment_attempt_id: null,
      p_amount_cents: 1299,
      p_currency: "PLN",
      p_signature_verified: true,
      p_payload: {
        id: "evt_provider",
        object: { id: "pi_provider" },
        __paymentTruth: {
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          evidence: {
            sourceKind: "accepted_event",
            sourceReference: "evt_provider",
            observedStatus: "payment.succeeded",
            observedAt: null,
            payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      },
    });
    expect(result).toEqual({
      paymentEventId: PAYMENT_EVENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentAttemptId: PAYMENT_ATTEMPT_ID,
      replayed: false,
    });
  });

  it("writes normalized provider events through payment-control ingest RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        paymentEvent: {
          id: PAYMENT_EVENT_ID,
          paymentIntentId: PAYMENT_INTENT_ID,
          paymentAttemptId: null,
          replayed: false,
        },
      },
      error: null,
    });
    const port = createSupabasePaymentWebhookControlPort({ rpc });

    await port.ingestPaymentEvent({
      provider: "stripe",
      providerEventId: "evt_123",
      eventType: "payment.succeeded",
      providerPaymentId: "pi_123",
      paymentIntentId: PAYMENT_INTENT_ID,
      amountMinor: 1490,
      currency: "PLN",
      occurredAt: "2026-06-06T12:00:00.000Z",
      rawPayload: { id: "evt_123" },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_ingest_event", {
      p_provider: "stripe",
      p_provider_event_id: "evt_123",
      p_event_type: "payment.succeeded",
      p_provider_payment_id: "pi_123",
      p_payment_intent_id: PAYMENT_INTENT_ID,
      p_payment_attempt_id: null,
      p_amount_cents: 1490,
      p_currency: "PLN",
      p_signature_verified: true,
      p_payload: {
        id: "evt_123",
        __paymentTruth: {
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          evidence: {
            sourceKind: "accepted_event",
            sourceReference: "evt_123",
            observedStatus: "payment.succeeded",
            observedAt: "2026-06-06T12:00:00.000Z",
            payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      },
    });
  });

  it("applies matched canonical results only through commerce_payment_control_apply_result", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        paymentResult: {
          paymentIntentId: PAYMENT_INTENT_ID,
          status: "failed",
          replayed: true,
        },
      },
      error: null,
    }));
    const port = createSupabasePaymentWebhookPort({ rpc });

    const result = await port.applyEventResult({
      idempotencyKey: "stripe:evt_provider:apply-result",
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentEventId: PAYMENT_EVENT_ID,
      resultStatus: "failed",
      occurredAt: "2026-06-06T12:00:00.000Z",
      failureReason: "provider_failed",
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_apply_result", {
      p_idempotency_key: "stripe:evt_provider:apply-result",
      p_payment_intent_id: PAYMENT_INTENT_ID,
      p_payment_event_id: PAYMENT_EVENT_ID,
      p_result_status: "failed",
      p_occurred_at: "2026-06-06T12:00:00.000Z",
      p_failure_reason: "provider_failed",
      // The webhook rail classifies nothing: it applies a generic failed reason
      // with no provider refusal evidence, so both additive args stay NULL.
      p_failure_class: null,
      p_failure_class_decided_by: null,
    });
    expect(result).toEqual({
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentEventId: PAYMENT_EVENT_ID,
      status: "failed",
      replayed: true,
    });
  });

  it("marks a setup event processed through the dedicated ledger-closer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { setupEventProcessed: { updated: true } },
      error: null,
    });
    const port = createSupabasePaymentWebhookControlPort({ rpc });

    const result = await port.markSetupEventProcessed?.({ paymentEventId: PAYMENT_EVENT_ID });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_mark_setup_event_processed", {
      p_payment_event_id: PAYMENT_EVENT_ID,
    });
    expect(result).toEqual({ updated: true });
  });

  it("maps a replayed setup-event closer to updated=false and surfaces RPC errors", async () => {
    const replayedRpc = vi.fn().mockResolvedValue({
      data: { setupEventProcessed: { updated: false } },
      error: null,
    });
    const replayed = await createSupabasePaymentWebhookControlPort({ rpc: replayedRpc })
      .markSetupEventProcessed?.({ paymentEventId: PAYMENT_EVENT_ID });
    expect(replayed).toEqual({ updated: false });

    const failingRpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      createSupabasePaymentWebhookControlPort({ rpc: failingRpc })
        .markSetupEventProcessed?.({ paymentEventId: PAYMENT_EVENT_ID }),
    ).rejects.toEqual({ message: "boom" });
  });

  it("upserts reusable method refs from Stripe or Tpay webhook facts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { paymentMethodRef: { replayed: false } },
      error: null,
    });
    const port = methodRefPort(rpc);

    await port.upsertFromWebhook({
      provider: "tpay",
      providerEventId: "evt_payid",
      eventType: "payment.requires_action",
      providerPaymentId: "tr_123",
      occurredAt: "2026-06-06T12:00:00.000Z",
      rawPayload: { payid: "payid_123" },
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        providerMethodRef: "payid_123",
        methodKind: "blik_payid",
        status: "active",
        consentSnapshot: { acceptedAt: "2026-06-06T12:00:00.000Z" },
      },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_method_ref_upsert", {
      p_idempotency_key: "provider-webhook:tpay:evt_payid:method-ref",
      p_client_id: "33333333-3333-4333-8333-333333333333",
      p_subscription_id: null,
      p_provider_kind: "tpay",
      p_method_kind: "blik_payid",
      p_provider_customer_ref: null,
      p_provider_method_ref: "payid_123",
      p_provider_mandate_ref: null,
      p_status: "active",
      p_active: true,
      p_expires_at: null,
      p_consent_snapshot: { acceptedAt: "2026-06-06T12:00:00.000Z" },
      p_raw_provider_payload: { payid: "payid_123" },
    });
  });

  it("writes the expiry the rail published, instead of the literal null it used to send", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { paymentMethodRef: { replayed: false } }, error: null });
    const port = methodRefPort(rpc);

    await port.upsertFromWebhook({
      provider: "stripe",
      providerEventId: "evt_expiry",
      eventType: "setup.succeeded",
      providerPaymentId: "seti_expiry",
      occurredAt: "2026-08-07T12:00:00.000Z",
      rawPayload: {},
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        providerCustomerRef: "cus_expiry",
        providerMethodRef: "pm_expiry",
        methodKind: "card",
        status: "active",
        consentSnapshot: { methodScheme: "visa", methodLastDigits: "4242", methodExpiresAt: "2029-06-30T23:59:59.999Z" },
      },
    });

    expect(rpc).toHaveBeenCalledWith(
      "commerce_payment_method_ref_upsert",
      expect.objectContaining({ p_expires_at: "2029-06-30T23:59:59.999Z" }),
    );
  });

  // Storage refuses an active row whose expiry is already past, and a raising
  // webhook is a provider retry that can never succeed. The row is written
  // without an expiry claim; the lifecycle rail is what retires it later.
  it("declines to claim an expiry that is already past for an active method", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { paymentMethodRef: { replayed: false } }, error: null });
    const port = methodRefPort(rpc);

    await port.upsertFromWebhook({
      provider: "stripe",
      providerEventId: "evt_dead_card",
      eventType: "setup.succeeded",
      providerPaymentId: "seti_dead",
      occurredAt: "2026-08-07T12:00:00.000Z",
      rawPayload: {},
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        providerCustomerRef: "cus_dead",
        providerMethodRef: "pm_dead",
        methodKind: "card",
        status: "active",
        consentSnapshot: { methodExpiresAt: "2026-07-31T23:59:59.999Z" },
      },
    });

    expect(rpc).toHaveBeenCalledWith(
      "commerce_payment_method_ref_upsert",
      expect.objectContaining({ p_expires_at: null, p_active: true }),
    );
  });

  it("completes the recovery retry handshake after the subscription-bound Stripe method is durable", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { paymentMethodRef: { replayed: false } }, error: null })
      .mockResolvedValueOnce({ data: { scheduled: true, reason: "ready" }, error: null });
    const port = methodRefPort(rpc);

    await port.upsertFromWebhook({
      provider: "stripe",
      providerEventId: "evt_recovery_setup",
      eventType: "setup.succeeded",
      providerPaymentId: "seti_recovery",
      occurredAt: "2026-07-21T12:00:00.000Z",
      rawPayload: { eventId: "evt_recovery_setup" },
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        subscriptionId: "44444444-4444-4444-8444-444444444444",
        providerCustomerRef: "cus_recovery",
        providerMethodRef: "pm_recovery",
        methodKind: "card",
        status: "active",
        consentSnapshot: { recoveryCaseId: "55555555-5555-4555-8555-555555555555" },
      },
    });

    expect(rpc).toHaveBeenNthCalledWith(2, "subscription_try_schedule_recovery_retry", {
      p_case_id: "55555555-5555-4555-8555-555555555555",
      p_payment_method_ref: "pm_recovery",
      p_requested_at: "2026-07-21T12:00:00.000Z",
    });
  });

  it("routes subscription-bound Tpay aliases through the card-precedence guard", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { paymentMethodRef: { replayed: false, subscriptionBindingSkipped: false } },
      error: null,
    });
    const port = methodRefPort(rpc);

    await port.upsertFromWebhook({
      provider: "tpay",
      providerEventId: "evt_alias",
      eventType: "setup.succeeded",
      providerPaymentId: "payid_1",
      occurredAt: "2026-07-22T12:00:00.000Z",
      rawPayload: {},
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        subscriptionId: "44444444-4444-4444-8444-444444444444",
        providerMethodRef: "payid_1",
        methodKind: "blik_payid",
        status: "active",
      },
    });

    expect(rpc).toHaveBeenCalledWith(
      "commerce_tpay_alias_method_ref_upsert_guarded",
      expect.objectContaining({ p_subscription_id: "44444444-4444-4444-8444-444444444444" }),
    );
  });

  it.each([
    ["a rail that does not scope stored consent to a subscription", capabilityRegistry({ tpay: false })],
    ["a rail this deployment publishes no capabilities for", capabilityRegistry({})],
  ])("takes the account-scoped upsert for %s", async (_label, capabilities) => {
    // The guarded write exists for consent that belongs to ONE subscription. It
    // is chosen by that capability, not by recognising a provider name, so a
    // rail without it keeps the account-scoped write even for an identical event.
    const rpc = vi.fn().mockResolvedValue({ data: { paymentMethodRef: { replayed: false } }, error: null });
    const port = methodRefPort(rpc, capabilities);

    await port.upsertFromWebhook({
      provider: "tpay",
      providerEventId: "evt_alias_unscoped",
      eventType: "setup.succeeded",
      providerPaymentId: "payid_2",
      occurredAt: "2026-07-22T12:00:00.000Z",
      rawPayload: {},
      reusableMethod: {
        clientId: "33333333-3333-4333-8333-333333333333",
        subscriptionId: "44444444-4444-4444-8444-444444444444",
        providerMethodRef: "payid_2",
        methodKind: "blik_payid",
        status: "active",
      },
    });

    expect(rpc).toHaveBeenCalledWith(
      "commerce_payment_method_ref_upsert",
      expect.objectContaining({ p_subscription_id: "44444444-4444-4444-8444-444444444444" }),
    );
  });

  it("activates the exact paid subscription from a verified card without charging it", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { paidActivationCardRecovery: { recovered: true, replayed: false } },
      error: null,
    });
    const port = createSupabasePaymentWebhookControlPort({ rpc });

    await expect(port.recoverPaidSubscriptionActivationWithCard!({
      idempotencyKey: "provider-webhook:stripe:evt_setup:paid-activation-card",
      subscriptionId: "44444444-4444-4444-8444-444444444444",
      paymentMethodRef: "pm_card",
      occurredAt: "2026-07-22T12:00:00.000Z",
    })).resolves.toEqual({ recovered: true, replayed: false, reason: null });

    expect(rpc).toHaveBeenCalledWith("subscription_recover_paid_activation_with_card", {
      p_idempotency_key: "provider-webhook:stripe:evt_setup:paid-activation-card",
      p_subscription_id: "44444444-4444-4444-8444-444444444444",
      p_payment_method_ref: "pm_card",
      p_occurred_at: "2026-07-22T12:00:00.000Z",
    });
  });

  it("confirms a provisional subscription via the webhook wrapper RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        webhookSubscriptionConfirm: {
          confirmed: true,
          confirmation: { subscriptionId: "sub_1", status: "active", replayed: false },
        },
      },
      error: null,
    });
    const port = createSupabasePaymentWebhookControlPort({ rpc });

    const result = await port.confirmSubscriptionActivation!({
      idempotencyKey: "provider-webhook:stripe:evt_sub:confirm",
      paymentIntentId: PAYMENT_INTENT_ID,
      occurredAt: "2026-06-06T12:00:00.000Z",
      methodRef: "pm_test_x",
      methodKind: "card",
    });

    expect(rpc).toHaveBeenCalledWith("commerce_webhook_confirm_subscription_from_intent", {
      p_idempotency_key: "provider-webhook:stripe:evt_sub:confirm",
      p_payment_intent_id: PAYMENT_INTENT_ID,
      p_payment_method_ref: "pm_test_x",
      p_payment_method_kind: "card",
      p_occurred_at: "2026-06-06T12:00:00.000Z",
    });
    expect(result).toEqual({ confirmed: true, status: "active" });
  });

  it("reports a one-time no-op confirm (confirmed=false) without a confirmation status", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        webhookSubscriptionConfirm: { confirmed: false, reason: "not_subscription_cycle" },
      },
      error: null,
    });
    const port = createSupabasePaymentWebhookControlPort({ rpc });

    const result = await port.confirmSubscriptionActivation!({
      idempotencyKey: "provider-webhook:stripe:evt_one:confirm",
      paymentIntentId: PAYMENT_INTENT_ID,
      occurredAt: "2026-06-06T12:00:00.000Z",
      methodRef: null,
      methodKind: null,
    });

    expect(result).toEqual({ confirmed: false, status: null });
  });
});

function event(): CanonicalPaymentEvent {
  return {
    provider_event_id: "evt_provider",
    event_type: "payment.succeeded",
    payment_provider_id: "pi_provider",
    amount_minor: 1299,
    raw_payload: { provider: "stripe", currency: "PLN" },
  };
}

// A provider callback reporting a refusal terminalises it here. The port input
// carries no provider field, so the signal reports an honest null rather than
// inferring one from the route that happened to receive the callback.
describe("terminal decline signal", () => {
  async function applyAndCaptureSignals(
    rpcResult: { status: string; replayed: boolean },
    input: { resultStatus: string; failureReason: string | null },
  ) {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const rpc = vi.fn(async () => ({
        data: {
          paymentResult: {
            paymentIntentId: PAYMENT_INTENT_ID,
            status: rpcResult.status,
            replayed: rpcResult.replayed,
          },
        },
        error: null,
      }));
      await createSupabasePaymentWebhookPort({ rpc }).applyEventResult({
        idempotencyKey: "provider:evt:apply-result",
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentEventId: PAYMENT_EVENT_ID,
        occurredAt: "2026-06-06T12:00:00.000Z",
        ...input,
      } as never);
      return consoleInfo.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("payment_decline_terminal"));
    } finally {
      consoleInfo.mockRestore();
    }
  }

  it("reports a refusal the callback actually applied", async () => {
    const signals = await applyAndCaptureSignals(
      { status: "failed", replayed: false },
      { resultStatus: "failed", failureReason: "provider_failed" },
    );

    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0])).toMatchObject({
      name: "payment_decline_terminal",
      domain: "payment",
      details: {
        provider: null,
        failureClass: null,
        failureReason: "provider_failed",
        resultStatus: "failed",
      },
    });
  });

  // Providers redeliver callbacks. The RPC absorbs the repeat; the signal must too.
  it("stays silent on a redelivered callback the control plane replayed", async () => {
    expect(await applyAndCaptureSignals(
      { status: "failed", replayed: true },
      { resultStatus: "failed", failureReason: "provider_failed" },
    )).toHaveLength(0);
  });

  it("stays silent when the callback confirmed a payment", async () => {
    expect(await applyAndCaptureSignals(
      { status: "succeeded", replayed: false },
      { resultStatus: "succeeded", failureReason: null },
    )).toHaveLength(0);
  });
});
