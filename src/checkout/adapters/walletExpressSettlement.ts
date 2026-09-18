import { paymentStatusUrlFor } from "@/checkout/machine/checkoutNavigation";

export type WalletFailureReason = "card_declined" | "expired" | "cancelled" | "technical";

export interface WalletPaymentContext {
  orderId: string;
  orderRef: string;
  paymentIntentId: string;
  clientId: string;
}

export type WalletCheckoutSettlement =
  | { kind: "disabled" }
  /**
   * No client payment context was confirmed. This can be a local wallet
   * validation failure or an ambiguous wallet-start readback; in both cases
   * the stable journey remains available for an idempotent retry.
   */
  | { kind: "retryable" }
  /**
   * The server refused this wallet submit because an attempt on this order is still
   * open. ⛔ Distinct from `retryable`: that one means the provider was never reached
   * and the buyer may simply press again, while this one is an authoritative refusal
   * that pressing again cannot clear. Collapsing the two is what cleared a live card
   * marker and then told the buyer their own details were the problem.
   */
  | { kind: "in_flight" }
  | { kind: "subscription_unavailable" }
  | { kind: "price_changed" }
  | { kind: "paid"; orderRef: string }
  | {
      kind: "status";
      orderRef: string;
      orderId?: string;
      paymentIntentId?: string;
      clientId?: string;
    }
  | {
      kind: "processing";
      orderId: string;
      orderRef: string;
      paymentIntentId: string;
      clientId: string;
    }
  | {
      kind: "failed";
      // Present only when the order was minted before the wallet confirmation
      // failed — lets the failure page offer targeted recovery.
      orderRef?: string;
      orderId?: string;
      paymentIntentId?: string;
      clientId?: string;
      reason?: WalletFailureReason;
      /**
       * Technical confirm errors are normally read back from payment-status so a
       * slow webhook cannot be mistaken for a failed charge. Stripe can also
       * resolve `confirmPayment` with a non-charge PaymentIntent status and no
       * error; in that case readback would strand the customer on "processing",
       * so the caller can force the retry/failure route.
       */
      forceFailurePage?: boolean;
    };

/**
 * Map a Stripe confirmation error to one of the failure-page reason buckets.
 * Deliberately conservative: only `expired`/`card_declined` are attributed to
 * the buyer's card. Unknown Stripe failures use technical copy so we do not
 * imply that the bank declined a wallet payment when our integration might have
 * failed before the issuer decision.
 */
export function mapStripeErrorToReason(error: {
  code?: string;
  decline_code?: string;
  type?: string;
}): WalletFailureReason {
  if (error.code === "expired_card" || error.decline_code === "expired_card") {
    return "expired";
  }
  if (
    error.code === "card_declined" ||
    error.type === "card_error" ||
    Boolean(error.decline_code)
  ) {
    return "card_declined";
  }
  return "technical";
}

type StripeConfirmError = {
  code?: string;
  decline_code?: string;
  type?: string;
};

const PRE_DISPATCH_STRIPE_ERROR_TYPES = new Set([
  "validation_error",
  "invalid_request_error",
  "authentication_error",
  "rate_limit_error",
]);

/**
 * Only an explicit issuer decision proves that retrying this provider attempt
 * is safe. Transport/API, idempotency, missing and future Stripe error types
 * can all be observed after a request reached Stripe, so they remain on the
 * authoritative payment-status readback path.
 */
export function walletSettlementFromConfirmError(
  error: StripeConfirmError,
  ctx: WalletPaymentContext,
): WalletCheckoutSettlement {
  if (PRE_DISPATCH_STRIPE_ERROR_TYPES.has(error.type ?? "")) {
    return { kind: "retryable" };
  }
  const deterministicIssuerFailure =
    error.type === "card_error"
    || error.code === "card_declined"
    || error.code === "expired_card"
    || Boolean(error.decline_code);
  return {
    kind: "failed",
    reason: mapStripeErrorToReason(error),
    ...(deterministicIssuerFailure ? { forceFailurePage: true } : {}),
    ...ctx,
  };
}

/**
 * The two reasons an issuer refusal keeps the buyer on the payment step rather
 * than routing to the failure page: the order stays `pending_payment` with its
 * stock hold, so the wallet row is a retry, not a destination.
 *
 * The row and the router MUST agree on this set. They once did not: the row set
 * its notice on the PaymentIntent-status branch, which can only ever yield
 * `cancelled`/`technical`, while a real issuer refusal arrives on the confirm-
 * error branch. The router declined to navigate, the row rendered nothing, and
 * the buyer watched the wallet sheet close onto a silent page.
 */
export function walletDeclineStaysInPlace(reason: WalletFailureReason | undefined): boolean {
  return reason === "card_declined" || reason === "expired";
}

export function walletSettlementFromConfirmPaymentIntentStatus(
  status: string | null | undefined,
  ctx: WalletPaymentContext,
): WalletCheckoutSettlement {
  if (
    !status ||
    status === "succeeded" ||
    status === "processing" ||
    status === "requires_action" ||
    status === "requires_capture"
  ) {
    return { kind: "processing", ...ctx };
  }
  if (status === "canceled") {
    return {
      kind: "failed",
      reason: "cancelled",
      forceFailurePage: true,
      ...ctx,
    };
  }
  if (
    status === "requires_payment_method" ||
    status === "requires_confirmation"
  ) {
    return {
      kind: "failed",
      reason: "technical",
      forceFailurePage: true,
      ...ctx,
    };
  }
  // Unknown future Stripe statuses should stay server-authoritative instead of
  // falsely closing a potentially chargeable payment.
  return { kind: "processing", ...ctx };
}

/** Browser return URL for the host-selected public or account status route. */
export function walletPaymentReturnUrl(returnPath: string, context: WalletPaymentContext): string {
  return `${window.location.origin}${paymentStatusUrlFor(returnPath, context)}`;
}
