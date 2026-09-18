import type { AsyncCheckoutStatus } from "./checkoutContracts.js";
import type { PaymentAttemptStatus, PaymentIntentStatus } from "../payment/types.js";

export function deriveAsyncCheckoutStatus(input: {
  intentStatus: PaymentIntentStatus;
  attemptStatus: PaymentAttemptStatus | null;
  orderStatus: string;
}): AsyncCheckoutStatus {
  if (input.intentStatus === "succeeded" || input.orderStatus === "paid") return "paid";
  if (input.intentStatus === "expired" || input.attemptStatus === "expired") return "expired";
  if (
    input.intentStatus === "failed" ||
    input.intentStatus === "cancelled" ||
    input.attemptStatus === "blocked_preflight" ||
    input.attemptStatus === "failed" ||
    input.attemptStatus === "cancelled"
  ) {
    return "failed";
  }
  if (input.intentStatus === "requires_action" || input.attemptStatus === "requires_action") {
    return "requires_action";
  }
  if (input.intentStatus === "created" || input.attemptStatus === "created" || input.attemptStatus === null) {
    return "pending_provider_action";
  }
  return "processing";
}
