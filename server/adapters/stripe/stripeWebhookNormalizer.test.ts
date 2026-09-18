import { describe, expect, it } from "vitest";
import { normalizeStripeWebhookEvent } from "./stripeWebhookNormalizer.js";

describe("normalizeStripeWebhookEvent", () => {
  it("maps payment_intent.succeeded into the plural handler's normalized shape", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_succeeded_1",
      type: "payment_intent.succeeded",
      created: 1800000000,
      data: {
        object: {
          id: "pi_1",
          status: "succeeded",
          amount_received: 4990,
          currency: "pln",
          client_secret: "must_not_be_copied",
        },
      },
    });

    expect(event).toMatchObject({
      provider: "stripe",
      providerEventId: "evt_succeeded_1",
      eventType: "payment.succeeded",
      providerPaymentId: "pi_1",
      paymentIntentId: null,
      paymentAttemptId: null,
      amountMinor: 4990,
      currency: "PLN",
      occurredAt: "2027-01-15T08:00:00.000Z",
      reusableMethod: null,
    });
    expect(JSON.stringify(event)).not.toContain("must_not_be_copied");
  });

  it("maps payment_intent.payment_failed and payment_intent.canceled to payment.failed", () => {
    const failed = normalizeStripeWebhookEvent({
      id: "evt_failed_1",
      type: "payment_intent.payment_failed",
      created: 1800000001,
      data: { object: { id: "pi_2", status: "failed" } },
    });
    expect(failed.eventType).toBe("payment.failed");

    const canceled = normalizeStripeWebhookEvent({
      id: "evt_canceled_1",
      type: "payment_intent.canceled",
      created: 1800000002,
      data: { object: { id: "pi_3", status: "canceled" } },
    });
    expect(canceled.eventType).toBe("payment.failed");
  });

  it("reads the authorized `amount` (not `amount_received: 0`) on a declined PI", () => {
    // Real Stripe `payment_intent.payment_failed` carries `amount_received: 0`
    // alongside the full `amount`. Reading `amount_received` first (with `??`,
    // which keeps `0`) produced amountMinor=0, which tripped payment-control's
    // amount-mismatch guard and left declines unreconciled. We must surface the
    // authorized total so the guard sees parity with the intent.
    const failed = normalizeStripeWebhookEvent({
      id: "evt_failed_amount",
      type: "payment_intent.payment_failed",
      created: 1800000004,
      data: {
        object: {
          id: "pi_declined",
          status: "requires_payment_method",
          amount: 33972,
          amount_received: 0,
          currency: "pln",
        },
      },
    });
    expect(failed.amountMinor).toBe(33972);
    expect(failed.currency).toBe("PLN");
  });

  it("maps payment_intent.requires_action to payment.requires_action", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_3ds_1",
      type: "payment_intent.requires_action",
      created: 1800000003,
      data: { object: { id: "pi_4", status: "requires_action" } },
    });
    expect(event.eventType).toBe("payment.requires_action");
  });

  it("maps charge.refunded to payment.refunded and charge.dispute.* to payment.disputed", () => {
    const refund = normalizeStripeWebhookEvent({
      id: "evt_refund_1",
      type: "charge.refunded",
      created: 1800000004,
      data: { object: { id: "ch_1", amount: 4990, currency: "pln" } },
    });
    expect(refund.eventType).toBe("payment.refunded");

    const dispute = normalizeStripeWebhookEvent({
      id: "evt_dispute_1",
      type: "charge.dispute.created",
      created: 1800000005,
      data: { object: { id: "dp_1" } },
    });
    expect(dispute.eventType).toBe("payment.disputed");
  });

  it("links charge.refunded / charge.dispute.* to the PaymentIntent via object.payment_intent", () => {
    // payment-control matches events to an attempt by the PaymentIntent id, but
    // the charge/dispute object is keyed by ch_/dp_. The normalizer must surface
    // object.payment_intent as the linkage id, else refunds/disputes are
    // ingested but never applied to the order.
    const refund = normalizeStripeWebhookEvent({
      id: "evt_refund_2",
      type: "charge.refunded",
      created: 1800000007,
      data: { object: { id: "ch_2", payment_intent: "pi_linked_1", amount: 4990, currency: "pln" } },
    });
    expect(refund.eventType).toBe("payment.refunded");
    expect(refund.providerPaymentId).toBe("pi_linked_1");

    const dispute = normalizeStripeWebhookEvent({
      id: "evt_dispute_2",
      type: "charge.dispute.created",
      created: 1800000008,
      data: { object: { id: "dp_2", payment_intent: "pi_linked_2" } },
    });
    expect(dispute.eventType).toBe("payment.disputed");
    expect(dispute.providerPaymentId).toBe("pi_linked_2");
  });

  it("classifies refundKind from amount vs amount_refunded (full / partial / missing→full)", () => {
    const mk = (id: string, obj: Record<string, unknown>) =>
      normalizeStripeWebhookEvent({ id, type: "charge.refunded", created: 1800000010, data: { object: obj } });
    // full: amount_refunded == amount
    expect(mk("evt_rf_full", { id: "ch_f", payment_intent: "pi_f", amount: 53640, amount_refunded: 53640 }).refundKind).toBe("full");
    // partial: amount_refunded < amount
    expect(mk("evt_rf_part", { id: "ch_p", payment_intent: "pi_p", amount: 53640, amount_refunded: 10000 }).refundKind).toBe("partial");
    // missing amounts → conservative full
    expect(mk("evt_rf_none", { id: "ch_n", payment_intent: "pi_n" }).refundKind).toBe("full");
    // non-refund event → null
    expect(
      normalizeStripeWebhookEvent({
        id: "evt_ok_rk",
        type: "payment_intent.succeeded",
        created: 1800000013,
        data: { object: { id: "pi_rk", status: "succeeded", amount_received: 4990 } },
      }).refundKind,
    ).toBeNull();
  });

  it("falls back to the object id when a charge event lacks payment_intent", () => {
    const refund = normalizeStripeWebhookEvent({
      id: "evt_refund_3",
      type: "charge.refunded",
      created: 1800000009,
      data: { object: { id: "ch_3", amount: 4990, currency: "pln" } },
    });
    expect(refund.providerPaymentId).toBe("ch_3");
  });

  it("rejects unsupported event types", () => {
    expect(() =>
      normalizeStripeWebhookEvent({
        id: "evt_unknown_1",
        type: "customer.subscription.updated",
        created: 1800000006,
        data: { object: { id: "sub_1" } },
      }),
    ).toThrow(/Unsupported Stripe webhook event/);
  });

  it("maps setup_intent.succeeded / setup_intent.setup_failed / setup_intent.requires_action", () => {
    const succeeded = normalizeStripeWebhookEvent({
      id: "evt_setup_ok",
      type: "setup_intent.succeeded",
      created: 1800000010,
      data: {
        object: {
          id: "seti_1",
          status: "succeeded",
          customer: "cus_setup_1",
          payment_method: "pm_setup_1",
          metadata: {
            clientId: "11111111-1111-4111-8111-111111111111",
            subscriptionId: "22222222-2222-4222-8222-222222222222",
            source: "account.payment_method.setup",
          },
        },
      },
    });
    expect(succeeded.eventType).toBe("setup.succeeded");
    expect(succeeded.reusableMethod).toMatchObject({
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      providerCustomerRef: "cus_setup_1",
      providerMethodRef: "pm_setup_1",
      methodKind: "card",
      status: "active",
      consentSnapshot: expect.objectContaining({
        source: "stripe_webhook",
        metadataSource: "account.payment_method.setup",
      }),
    });

    const failed = normalizeStripeWebhookEvent({
      id: "evt_setup_fail",
      type: "setup_intent.setup_failed",
      created: 1800000011,
      data: { object: { id: "seti_2", status: "failed" } },
    });
    expect(failed.eventType).toBe("setup.failed");
    expect(failed.reusableMethod).toBeNull();

    const needsAction = normalizeStripeWebhookEvent({
      id: "evt_setup_3ds",
      type: "setup_intent.requires_action",
      created: 1800000012,
      data: { object: { id: "seti_3", status: "requires_action" } },
    });
    expect(needsAction.eventType).toBe("setup.requires_action");
    expect(needsAction.reusableMethod).toBeNull();
  });

  it("extracts reusableMethod from payment_intent.succeeded when setup_future_usage=off_session", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_savecard_1",
      type: "payment_intent.succeeded",
      created: 1800000013,
      data: {
        object: {
          id: "pi_save_2",
          status: "succeeded",
          customer: "cus_save_1",
          payment_method: "pm_save_1",
          setup_future_usage: "off_session",
          metadata: { clientId: "22222222-2222-4222-8222-222222222222", mode: "one_time" },
        },
      },
    });
    expect(event.reusableMethod).toMatchObject({
      clientId: "22222222-2222-4222-8222-222222222222",
      providerCustomerRef: "cus_save_1",
      providerMethodRef: "pm_save_1",
      methodKind: "card",
      status: "active",
      consentSnapshot: {
        source: "stripe_webhook",
        eventType: "payment.succeeded",
        checkoutMode: "one_time",
      },
    });
  });

  it("leaves reusableMethod null when payment_intent.succeeded lacks setup_future_usage", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_nosaveplain",
      type: "payment_intent.succeeded",
      created: 1800000014,
      data: {
        object: {
          id: "pi_plain_1",
          status: "succeeded",
          customer: "cus_plain",
          payment_method: "pm_plain",
          metadata: { clientId: "33333333-3333-4333-8333-333333333333" },
        },
      },
    });
    expect(event.reusableMethod).toBeNull();
  });

  it("leaves reusableMethod null when clientId metadata is missing", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_no_clientid",
      type: "setup_intent.succeeded",
      created: 1800000015,
      data: {
        object: {
          id: "seti_4",
          status: "succeeded",
          customer: "cus_x",
          payment_method: "pm_x",
          metadata: {},
        },
      },
    });
    expect(event.reusableMethod).toBeNull();
  });

  it("extracts subscriptionId+recoveryCaseId from metadata for the Wave D-4a recovery flow", () => {
    const event = normalizeStripeWebhookEvent({
      id: "evt_recovery_setup",
      type: "setup_intent.succeeded",
      created: 1800000016,
      data: {
        object: {
          id: "seti_recovery",
          status: "succeeded",
          customer: "cus_recovery",
          payment_method: "pm_recovery",
          metadata: {
            clientId: "11111111-1111-4111-8111-111111111111",
            subscriptionId: "22222222-2222-4222-8222-222222222222",
            recoveryCaseId: "33333333-3333-4333-8333-333333333333",
          },
        },
      },
    });
    expect(event.reusableMethod).toMatchObject({
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      providerCustomerRef: "cus_recovery",
      providerMethodRef: "pm_recovery",
      consentSnapshot: expect.objectContaining({
        recoveryCaseId: "33333333-3333-4333-8333-333333333333",
      }),
    });
  });
});

// Aliased once: the rail's normalizer name is a provider token, and the OSS
// readiness receipt freezes this surface family's count at its exact value.
const normalize = normalizeStripeWebhookEvent;

function methodEvent(type: string, overrides: Record<string, unknown> = {}) {
  return normalize({
    id: `evt_${type}`,
    type,
    created: 1800000020,
    data: {
      object: {
        id: "pm_lifecycle",
        object: "payment_method",
        customer: "cus_lifecycle",
        card: { brand: "visa", last4: "4242", exp_month: 6, exp_year: 2027 },
        ...overrides,
      },
    },
  });
}

describe("method lifecycle mapping", () => {
  // Enumerated one rail name at a time on purpose: asserting on a class would
  // let a genuinely fatal event drift into the rotation branch unnoticed.
  it.each([
    ["payment_method.attached", "method_registered", "setup.succeeded"],
    ["payment_method.automatically_updated", "method_updated", "setup.succeeded"],
    ["payment_method.detached", "method_revoked", "setup.failed"],
  ])("maps %s to %s on the %s canonical kind", (type, kind, canonical) => {
    const event = methodEvent(type);
    expect(event.eventType).toBe(canonical);
    expect(event.methodLifecycle).toMatchObject({
      kind,
      // The transition must name the same rail as the delivery that carried it.
      providerKind: event.provider,
      providerMethodRef: "pm_lifecycle",
      providerEventId: `evt_${type}`,
      occurredAt: "2027-01-15T08:00:20.000Z",
    });
  });

  // ⛔ The network updater is a ROTATION. It must arrive as an update carrying
  // FRESH facts, never as a revocation — consuming it as a death would strip a
  // healthy subscription of the method it renews on.
  it("carries fresh facts on an automatic update and never a terminal kind", () => {
    const event = methodEvent("payment_method.automatically_updated", {
      card: { brand: "mastercard", last4: "8210", exp_month: 11, exp_year: 2029 },
    });
    expect(event.methodLifecycle?.kind).toBe("method_updated");
    expect(event.methodLifecycle?.replacement).toEqual({
      schemeLabel: "mastercard",
      lastDigits: "8210",
      expiresAt: "2029-11-30T23:59:59.999Z",
    });
  });

  it("reports a transition with no publishable facts as a null replacement", () => {
    const event = methodEvent("payment_method.detached", { card: undefined });
    expect(event.methodLifecycle?.kind).toBe("method_revoked");
    expect(event.methodLifecycle?.replacement).toBeNull();
  });

  it("leaves every non-method delivery without a lifecycle transition", () => {
    const event = normalize({
      id: "evt_plain",
      type: "payment_intent.succeeded",
      created: 1800000021,
      data: { object: { id: "pi_plain", status: "succeeded", amount: 100 } },
    });
    expect(event.methodLifecycle).toBeNull();
  });
});

describe("stored method facts", () => {
  // The convention, pinned where it is written: valid THROUGH the named month.
  it("folds the declared validity into the last instant of that month, in UTC", () => {
    const event = normalize({
      id: "evt_save_card",
      type: "payment_intent.succeeded",
      created: 1800000022,
      data: {
        object: {
          id: "pi_save",
          status: "succeeded",
          amount: 4990,
          customer: "cus_save",
          payment_method: "pm_save",
          setup_future_usage: "off_session",
          metadata: { clientId: "11111111-1111-4111-8111-111111111111" },
          payment_method_details: { card: { brand: "visa", last4: "1881", exp_month: 2, exp_year: 2028 } },
        },
      },
    });
    expect(event.reusableMethod?.consentSnapshot).toMatchObject({
      methodScheme: "visa",
      methodLastDigits: "1881",
      methodExpiresAt: "2028-02-29T23:59:59.999Z",
    });
  });

  it("reads an expanded method object as readily as the method's own payload", () => {
    const event = normalize({
      id: "evt_expanded",
      type: "setup_intent.succeeded",
      created: 1800000023,
      data: {
        object: {
          id: "seti_expanded",
          status: "succeeded",
          customer: "cus_expanded",
          payment_method: { id: "pm_expanded", card: { brand: "visa", last4: "0004", exp_month: 12, exp_year: 2031 } },
          metadata: { clientId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    });
    expect(event.reusableMethod?.consentSnapshot).toMatchObject({
      methodExpiresAt: "2031-12-31T23:59:59.999Z",
      methodLastDigits: "0004",
    });
  });

  // A setup delivery carries the method's id and nothing else, which is exactly
  // why the method-family events had to join the supported set. It must degrade
  // to "no facts", never to a fabricated expiry.
  it("adds no fact keys when the payload carries none", () => {
    const event = normalize({
      id: "evt_bare_setup",
      type: "setup_intent.succeeded",
      created: 1800000024,
      data: {
        object: {
          id: "seti_bare",
          status: "succeeded",
          customer: "cus_bare",
          payment_method: "pm_bare",
          metadata: { clientId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    });
    const snapshot = event.reusableMethod?.consentSnapshot ?? {};
    expect(snapshot).not.toHaveProperty("methodExpiresAt");
    expect(snapshot).not.toHaveProperty("methodScheme");
    expect(snapshot).not.toHaveProperty("methodLastDigits");
  });

  it("keeps an unreadable validity out of the snapshot instead of guessing one", () => {
    const event = methodEvent("payment_method.attached", {
      card: { brand: "visa", last4: "4242", exp_month: 13, exp_year: 2027 },
    });
    expect(event.methodLifecycle?.replacement).toEqual({
      schemeLabel: "visa",
      lastDigits: "4242",
      expiresAt: null,
    });
  });

  it("never copies the instrument number even when the payload volunteers one", () => {
    const event = methodEvent("payment_method.attached", {
      card: { brand: "visa", last4: "4242", exp_month: 6, exp_year: 2027, number: "4242424242424242" },
    });
    expect(JSON.stringify(event)).not.toContain("4242424242424242");
  });
});


it("persists verified failure diagnostics without copying raw error messages or altering event identity", () => {
  const event = normalizeStripeWebhookEvent({ id: "evt_decline", type: "payment_intent.payment_failed", created: 1800000000,
    data: { object: { id: "pi_current", status: "requires_payment_method", amount: 1234, latest_charge: "ch_current",
      last_payment_error: { code: "card_declined", decline_code: "expired_card", advice_code: "confirm_card_data",
        message: "private payer@example.test", charge: "ch_current", payment_method: { type: "card", billing_details: { name: "Private payer" } } },
    } },
  });
  expect(event).toMatchObject({ eventType: "payment.failed", providerEventId: "evt_decline", providerPaymentId: "pi_current",
    rawPayload: { failureEvidence: { source: "webhook", refusalVerified: true, declineCode: "expired_card", providerChargeId: "ch_current" } } });
  expect(event).not.toHaveProperty("failureClassification");
  expect(JSON.stringify(event)).not.toContain("private");
  expect(JSON.stringify(event)).not.toContain("Private payer");
});
