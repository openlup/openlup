import type { OrderPaymentLifecycleState } from "./outboxOrderDraftEmailPorts.js";

/**
 * Skip reason meaning "the payer is inside a live payment session right now".
 * Exported because it is the one skip reason a caller must treat as TRANSIENT;
 * every other reason in this module is a settled fact about the order.
 */
export const PAYMENT_SESSION_ACTIVE = "payment_session_active";

const SUCCESSFUL_PAYMENT_STATUSES = new Set(["succeeded", "paid", "captured"]);
const ACTIVE_PAYMENT_STATUSES = new Set(["pending", "requires_action", "created", "processing"]);
const FRESH_PAYMENT_ACTIVITY_MS = 15 * 60 * 1000;

export function shouldSkipOrderDraftConfirmation(
  state: OrderPaymentLifecycleState | null,
): string | null {
  if (state === null) return "order_unavailable";
  if (state.orderStatus !== "draft") return "order_no_longer_draft";
  if (state.hasPayment) return "order_no_longer_draft";
  if (state.paymentStatus && state.paymentStatus !== "not_started") return "order_no_longer_draft";
  return null;
}

/**
 * Eligibility for the checkout-recovery NUDGE only.
 *
 * `payment_session_active` below is a politeness rule: do not remind someone to
 * pay while they are paying. It is correct here and wrong for a decline notice
 * — see {@link shouldSkipPaymentFailedNotice}. A caller acting on this reason
 * must defer rather than drop, because the nudge's emit key is once-per-order.
 */
export function shouldSkipCheckoutRecovery(
  state: OrderPaymentLifecycleState | null,
): string | null {
  if (state === null) return "order_unavailable";
  if (state.orderStatus !== "pending_payment") return "order_not_pending_payment";
  if (state.paymentStatus && SUCCESSFUL_PAYMENT_STATUSES.has(state.paymentStatus)) {
    return "order_already_paid";
  }
  if (
    state.paymentStatus &&
    ACTIVE_PAYMENT_STATUSES.has(state.paymentStatus) &&
    isFreshPaymentActivity(state.paymentUpdatedAt)
  ) {
    return PAYMENT_SESSION_ACTIVE;
  }
  return null;
}

/**
 * Eligibility for an OPERATOR-ISSUED recovery link.
 *
 * Deliberately not {@link shouldSkipCheckoutRecovery}. That gate is written for
 * the cron nudge, and its first rule — leave `pending_payment` and we go quiet —
 * is exactly wrong here. A human looked at the order and decided to send this
 * link, and the orders they send it for are largely the ones that have ALREADY
 * left `pending_payment`: `expired` is the ordinary case, and the redeem rail
 * recreates such an order from its frozen quote when the customer opens the link.
 * Reusing the cron gate would skip those as `order_not_pending_payment`, the
 * operator would have promised an email that never arrives, and nothing anywhere
 * would report a failure. The mint side has already run the full recovery
 * eligibility for this order, so what is left here is only what can have changed
 * between the mint and the send.
 *
 * What still suppresses: the order is gone, or the money is in. Both make the
 * email actively wrong rather than merely late.
 *
 * `payment_session_active` behaves exactly as it does for the nudge, and for the
 * same reason: do not tell someone to finish paying while they are paying. The
 * caller must DEFER on it rather than drop, because a dropped operator link is
 * the silent no-send this whole path is written to prevent.
 */
export function shouldSkipOperatorCheckoutRecovery(
  state: OrderPaymentLifecycleState | null,
): string | null {
  if (state === null) return "order_unavailable";
  if (state.orderStatus === "paid") return "order_already_paid";
  if (state.paymentStatus && SUCCESSFUL_PAYMENT_STATUSES.has(state.paymentStatus)) {
    return "order_already_paid";
  }
  if (
    state.paymentStatus &&
    ACTIVE_PAYMENT_STATUSES.has(state.paymentStatus) &&
    isFreshPaymentActivity(state.paymentUpdatedAt)
  ) {
    return PAYMENT_SESSION_ACTIVE;
  }
  return null;
}

/**
 * Eligibility for the RECOVERABLE-DECLINE notice.
 *
 * Deliberately not `shouldSkipCheckoutRecovery`, though the two once shared it.
 * That gate answers "should we nudge someone who has not paid yet", and it is
 * right for a nudge to stay quiet while the payer is inside a live session —
 * nobody needs a reminder to do the thing they are doing.
 *
 * A decline notice answers a different question: something already failed, and
 * the payer is entitled to know. Suppressing it because a SECOND attempt is
 * in flight lost a real buyer on 2026-08-20: her first refusal was swallowed
 * as `payment_session_active` because she had opened a second attempt 17 s
 * earlier, that attempt then declined too, and the emit key
 * `payment_failed:<order_id>` is once-per-order — so the second failure could
 * never produce a second event. She was never told anything.
 *
 * What still suppresses: the order is gone, already paid, or has left
 * `pending_payment`. A successful retry produces exactly those states, so the
 * ordinary "declined then paid" sequence stays quiet on its own — but only
 * because the EMIT holds the row back three minutes (`available_at`, see
 * `20260821160000_payment_failed_notice_claim_delay`). That delay is what buys
 * this gate the time to be true; without it the dispatch cron claims within
 * ~60 s and the read below runs before the buyer can finish retrying.
 * ⛔ Shortening it re-opens the race silently: nothing here would fail.
 */
export function shouldSkipPaymentFailedNotice(
  state: OrderPaymentLifecycleState | null,
): string | null {
  if (state === null) return "order_unavailable";
  if (state.orderStatus !== "pending_payment") return "order_not_pending_payment";
  if (state.paymentStatus && SUCCESSFUL_PAYMENT_STATUSES.has(state.paymentStatus)) {
    return "order_already_paid";
  }
  return null;
}

export function shouldSkipCheckoutExpired(
  state: OrderPaymentLifecycleState | null,
): string | null {
  if (state === null) return "order_unavailable";
  if (state.orderStatus === "expired") return null;
  // ⛔ The activation sweep writes `cancelled`, never `expired`, so a first
  // subscription abandoned at the 24h window would fail an `expired`-only gate
  // and the buyer would hear nothing at all. Accepted ONLY with the sweep's own
  // marker, so an ordinary cancellation still cannot reach this template.
  if (state.orderStatus === "cancelled" && state.subscriptionActivationAbandoned === true) return null;
  return "order_not_expired";
}

function isFreshPaymentActivity(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < FRESH_PAYMENT_ACTIVITY_MS;
}
