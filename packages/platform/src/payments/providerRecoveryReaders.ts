import { z } from "zod";
import type { PaymentRecoveryEvidence } from "@openlup/core/payment";
import type { ExpiredPaymentSafetyOrder } from "./expiredCheckoutSafety.js";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";

const id = z.guid(), at = z.string().datetime({ offset: true });
const status = z.enum(["created", "blocked_preflight", "sent_to_provider", "requires_action", "processing", "succeeded", "failed", "cancelled", "expired"]);
const snapshot = z.object({ snapshot: z.object({ orderId: id, clientId: id, orderStatus: z.string(), paymentIntentId: id,
  intentStatus: z.enum(["created", "requires_action", "processing", "succeeded", "failed", "expired", "cancelled", "refunded", "partially_refunded", "disputed"]),
  paymentAttemptId: id.nullable(), attemptStatus: status.nullable(), provider: z.string().nullable(), providerPaymentId: z.string().nullable(),
  updatedAt: at, failureReason: z.string().nullable(), orderMode: z.enum(["one_time", "subscription_cycle"]),
  activationState: z.enum(["provisional", "active", "compensated"]).nullable(), subscriptionId: id.nullable(), subscriptionStatus: z.string().nullable(),
  paidAt: at.nullable(), hasExactGap: z.boolean() }).strict(), eligible: z.boolean(), tokenAuthorized: z.boolean(),
  observedSuccess: z.boolean(), historyComplete: z.boolean(), attempts: z.array(z.object({ id, status, provider: z.string(),
    providerPaymentId: z.string().nullable(), providerFlow: z.string().nullable(), createdAt: at, evidence: z.array(z.unknown()).max(32) }).strict()).max(100) }).strict();

/** Uses the same bounded atomic snapshot and host-selected evidence normalizer. */
export function createPostgresProviderPaymentRecoveryGuidancePort(db: PaymentProviderExecutor,
  normalize: (input: { provider: string; evidence: unknown[] }) => PaymentRecoveryEvidence | null) {
  return { async getGuidanceSnapshot(input: { orderId: string; paymentIntentId: string; recoveryTokenId?: string }) {
    const value = (await db.query("SELECT public.commerce_checkout_payment_guidance_snapshot($1::uuid,$2::uuid,$3::uuid) AS result",
      [input.orderId, input.paymentIntentId, input.recoveryTokenId ?? null])).rows[0]?.result;
    if (value === null) return null;
    const parsed = snapshot.safeParse(value);
    if (!parsed.success) throw new Error("payment_recovery_snapshot_invalid");
    const { snapshot: s, ...rest } = parsed.data;
    if (s.orderId !== input.orderId.toLowerCase() || s.paymentIntentId !== input.paymentIntentId.toLowerCase()) throw new Error("payment_recovery_snapshot_identity_mismatch");
    const purchaseContext: "one_time" | "subscription_initial" | null = rest.eligible ? s.orderMode === "one_time" ? "one_time" : "subscription_initial" : null;
    const subscriptionActivationStatus: "active" | "not_applicable" = s.orderMode === "subscription_cycle" && s.subscriptionStatus === "active" ? "active" : "not_applicable";
    return { ...s, ...rest, purchaseContext, subscriptionActivationStatus,
      attempts: rest.attempts.map(a => ({ id: a.id, status: a.status, provider: a.provider, providerFlow: a.providerFlow,
        evidence: rest.observedSuccess || !a.evidence.length ? null : normalize({ provider: a.provider, evidence: a.evidence }) })) };
  } };
}

/** Missing handles and local absence never establish provider absence. */
export function createPostgresProviderExpiredCheckoutSafety(db: PaymentProviderExecutor): {
  verifyPriorPayment(order: ExpiredPaymentSafetyOrder): Promise<"safe" | "paid" | "unavailable">;
} {
  return { async verifyPriorPayment(order) {
    try {
      const intent = (await db.query("SELECT id,status,amount_minor,currency_code FROM public.commerce_settlement_intents WHERE order_id=$1::uuid", [order.orderId])).rows[0];
      if (!intent) return "unavailable";
      if (intent.status === "settled") return "paid";
      const parsed = z.object({ orderId: id, settlementStatus: z.string(), amountMinor: z.number().int(), currency: z.string(),
        paymentAttempt: z.object({ status, providerAttemptId: z.string().nullable() }), observedSuccess: z.boolean(), observedFailure: z.boolean() }).safeParse(
        (await db.query("SELECT public.payment_provider_attempt_read($1::uuid,NULL::uuid) AS result", [intent.id])).rows[0]?.result);
      if (!parsed.success) return "unavailable";
      const a = parsed.data;
      if (a.observedSuccess || a.settlementStatus === "settled") return "paid";
      return a.orderId === order.orderId.toLowerCase() && ["failed", "expired"].includes(a.paymentAttempt.status)
        && a.paymentAttempt.providerAttemptId !== null && a.observedFailure && a.amountMinor === order.totalMinor
        && Number(intent.amount_minor) === order.totalMinor && a.currency === order.currency && intent.currency_code === order.currency ? "safe" : "unavailable";
    } catch { return "unavailable"; }
  } };
}
