import type { OmsPaymentMethodSummary } from "../contracts/omsTypes.js";
import type { OmsReadModelProjections } from "./omsReadModelProjections.js";
import type { OmsPaymentAttemptRow,OmsPaymentIntentRow } from "./omsReadModelRows.js";
export type { OmsPaymentMethodSummary } from "../contracts/omsTypes.js";

export function paymentMethodForOrder(
  orderId: string,
  paymentIntents: OmsPaymentIntentRow[],
  paymentAttempts: OmsPaymentAttemptRow[],
  projections?: OmsReadModelProjections,
): OmsPaymentMethodSummary {
  const intent = paymentIntents.find((candidate) => candidate.id && candidate.order_id === orderId) ?? null;
  if (!intent) return { provider: null, label: null };
  const attempt = paymentAttempts.find((candidate) => candidate.id === intent.active_attempt_id)
    ?? paymentAttempts.find((candidate) => candidate.payment_intent_id === intent.id)
    ?? null;
  if (!attempt) return { provider: null, label: null };
  return { provider: attempt.provider, label: projections?.paymentMethodLabel?.(attempt) ?? attempt.provider };
}
