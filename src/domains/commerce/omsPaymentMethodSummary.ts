import type { OmsPaymentAttemptRow, OmsPaymentIntentRow } from "./omsReadModelRows.js";

export interface OmsPaymentMethodSummary {
  provider: string | null;
  label: string | null;
}

export function paymentMethodForOrder(
  orderId: string,
  paymentIntents: OmsPaymentIntentRow[],
  paymentAttempts: OmsPaymentAttemptRow[],
): OmsPaymentMethodSummary {
  const intent = paymentIntents.find((candidate) => candidate.id && candidate.order_id === orderId) ?? null;
  if (!intent) return { provider: null, label: null };
  const attempt = paymentAttempts.find((candidate) => candidate.id === intent.active_attempt_id)
    ?? paymentAttempts.find((candidate) => candidate.payment_intent_id === intent.id)
    ?? null;
  if (!attempt) return { provider: null, label: null };
  return { provider: attempt.provider, label: paymentMethodLabel(attempt) };
}

function paymentMethodLabel(attempt: OmsPaymentAttemptRow): string {
  const provider = attempt.provider.toLowerCase();
  if (provider.includes("stripe")) return "Karta";
  if (provider.includes("tpay")) return "BLIK";
  if (provider.includes("blik")) return "BLIK";
  if (provider.includes("card")) return "Karta";
  return attempt.provider;
}
