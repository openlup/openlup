import type { CheckoutClientAction } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CheckoutCookieResponse, CheckoutPaymentContinuationMinter } from "./checkoutPaymentContinuationCredential.js";

/** A separate guard: refusal diagnostics must not widen existing action authority. */
export function mintCheckoutRefusalContinuation(input: {
  mint?: CheckoutPaymentContinuationMinter;
  res: CheckoutCookieResponse;
  journeyId: string;
  clientId: string;
  requestRail: string;
  response: { status: string; clientAction?: CheckoutClientAction };
  result: { orderId: string; paymentIntentId: string; paymentAttemptId: string | null;
    executionRail: string; continuationActionOrigin: "fresh_execution" | null;
    status: string; runtimePaymentStatus?: string; paymentAttemptStatus?: string | null };
}): void {
  const { result, response } = input;
  if (!input.mint || result.continuationActionOrigin !== "fresh_execution"
    || result.runtimePaymentStatus !== "failed" || result.paymentAttemptStatus !== "failed" || response.status !== "failed"
    || (response.clientAction && response.clientAction.kind !== "none")
    || !result.orderId || !result.paymentIntentId || !result.paymentAttemptId
    || result.executionRail !== input.requestRail
    || (result.executionRail !== "stripe" && result.executionRail !== "tpay")) return;
  try {
    input.mint(input.res, { journeyId: input.journeyId, clientId: input.clientId,
      orderId: result.orderId, paymentIntentId: result.paymentIntentId,
      paymentAttemptId: result.paymentAttemptId, executionRail: result.executionRail });
  } catch { /* Optional guidance must never turn a settled refusal into an error. */ }
}
