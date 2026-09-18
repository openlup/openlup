import { describe, expect, it } from "vitest";
import {
  PAYMENT_SESSION_ACTIVE,
  shouldSkipCheckoutRecovery,
  shouldSkipOperatorCheckoutRecovery,
  shouldSkipCheckoutExpired,
  shouldSkipOrderDraftConfirmation,
  shouldSkipPaymentFailedNotice,
} from "./orderEmailEligibility.js";

describe("order email eligibility", () => {
  it("allows draft confirmation only for draft orders without a payment", () => {
    expect(shouldSkipOrderDraftConfirmation({
      orderStatus: "draft",
      paymentStatus: null,
      hasPayment: false,
    })).toBeNull();
    expect(shouldSkipOrderDraftConfirmation(null)).toBe("order_unavailable");
    expect(shouldSkipOrderDraftConfirmation({
      orderStatus: "paid",
      paymentStatus: "succeeded",
      hasPayment: true,
    })).toBe("order_no_longer_draft");
    expect(shouldSkipOrderDraftConfirmation({
      orderStatus: "draft",
      paymentStatus: "pending",
      hasPayment: true,
    })).toBe("order_no_longer_draft");
  });

  it("allows checkout recovery only for unpaid pending-payment orders", () => {
    expect(shouldSkipCheckoutRecovery({
      orderStatus: "pending_payment",
      paymentStatus: "pending",
      paymentUpdatedAt: "2026-01-01T00:00:00.000Z",
      hasPayment: true,
    })).toBeNull();
    expect(shouldSkipCheckoutRecovery(null)).toBe("order_unavailable");
    expect(shouldSkipCheckoutRecovery({
      orderStatus: "draft",
      paymentStatus: null,
      hasPayment: false,
    })).toBe("order_not_pending_payment");
    expect(shouldSkipCheckoutRecovery({
      orderStatus: "pending_payment",
      paymentStatus: "succeeded",
      hasPayment: true,
    })).toBe("order_already_paid");
    expect(shouldSkipCheckoutRecovery({
      orderStatus: "pending_payment",
      paymentStatus: "pending",
      paymentUpdatedAt: new Date().toISOString(),
      hasPayment: true,
    })).toBe("payment_session_active");
  });

  // The decline notice deliberately does NOT share the nudge's session gate.
  // Production 2026-08-20: a refusal was swallowed as
  // `payment_session_active` because the buyer had opened a second attempt 17 s
  // earlier; that attempt declined too, and the once-per-order emit key
  // meant no second event could ever exist. She was told nothing.
  // The operator gate answers a different question from the cron gate: a human
  // already decided to send this link, and the orders they send it for have
  // usually LEFT pending_payment. Only "gone" and "already paid" may silence it.
  it("keeps an operator-issued link alive for an order that has left pending_payment", () => {
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "expired",
      paymentStatus: "failed",
      hasPayment: true,
    })).toBeNull();
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "cancelled",
      paymentStatus: null,
      hasPayment: false,
    })).toBeNull();
  });

  it("still silences an operator-issued link once the order is gone or paid", () => {
    expect(shouldSkipOperatorCheckoutRecovery(null)).toBe("order_unavailable");
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "paid",
      paymentStatus: null,
      hasPayment: true,
    })).toBe("order_already_paid");
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "expired",
      paymentStatus: "succeeded",
      hasPayment: true,
    })).toBe("order_already_paid");
  });

  // Same politeness rule as the nudge, and the same transient reason: the caller
  // must defer on it, never drop.
  it("defers an operator-issued link while the payer is inside a live session", () => {
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "expired",
      paymentStatus: "processing",
      paymentUpdatedAt: new Date().toISOString(),
      hasPayment: true,
    })).toBe(PAYMENT_SESSION_ACTIVE);
    expect(shouldSkipOperatorCheckoutRecovery({
      orderStatus: "expired",
      paymentStatus: "processing",
      paymentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      hasPayment: true,
    })).toBeNull();
  });

  it("sends the decline notice even while another attempt is in flight", () => {
    expect(shouldSkipPaymentFailedNotice({
      orderStatus: "pending_payment",
      paymentStatus: "pending",
      paymentUpdatedAt: new Date().toISOString(),
      hasPayment: true,
    })).toBeNull();
  });

  it("still suppresses the decline notice on settled order states", () => {
    expect(shouldSkipPaymentFailedNotice(null)).toBe("order_unavailable");
    expect(shouldSkipPaymentFailedNotice({
      orderStatus: "pending_payment",
      paymentStatus: "succeeded",
      hasPayment: true,
    })).toBe("order_already_paid");
    // A completed retry moves the order off pending_payment, which is how the
    // ordinary "declined then paid" sequence stays quiet without the session gate.
    expect(shouldSkipPaymentFailedNotice({
      orderStatus: "paid",
      paymentStatus: "succeeded",
      hasPayment: true,
    })).toBe("order_not_pending_payment");
  });
});

// ⛔ A buyer whose FIRST subscription payment never confirmed used to hear
// nothing at all: the cancellation email is deliberately suppressed (correctly -
// they never had a live subscription) and the expired-checkout template could not
// reach them, because its producers require `expired` AND `mode = 'one_time'`
// while the activation sweep writes `cancelled` on a `subscription_cycle`.
describe("shouldSkipCheckoutExpired", () => {
  it("swept-subscription-admitted-plain-cancellation-refused", () => {
    // The swept first subscription: admitted, so the one honest message reaches it.
    expect(shouldSkipCheckoutExpired({
      orderStatus: "cancelled",
      paymentStatus: "processing",
      hasPayment: true,
      subscriptionActivationAbandoned: true,
    })).toBeNull();

    // ⛔ An ordinary cancellation carries no marker and must NOT reach this
    // template: its copy tells the buyer to complete a payment for an order that
    // was cancelled for some other reason entirely.
    expect(shouldSkipCheckoutExpired({
      orderStatus: "cancelled",
      paymentStatus: "cancelled",
      hasPayment: true,
    })).toBe("order_not_expired");

    // The one-time rail is untouched by this wave.
    expect(shouldSkipCheckoutExpired({
      orderStatus: "expired",
      paymentStatus: "expired",
      hasPayment: true,
    })).toBeNull();

    expect(shouldSkipCheckoutExpired(null)).toBe("order_unavailable");
  });
});
