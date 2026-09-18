import { z } from "../../../../src/lib/validation/zod.js";
import { ORDER_STATUSES } from "../../../../src/domains/commerce/types.js";
import { PAYMENT_ATTEMPT_STATUSES, PAYMENT_INTENT_STATUSES } from "../../../../src/domains/payment/types.js";
import { deriveSubscriptionActivationStatus } from "../../../../src/domains/payment/contracts.js";
import type { PaymentRecoveryEvidence } from "@openlup/core/payment";
import type {
  PaymentRecoverySnapshot, PaymentRecoverySnapshotPort,
} from "../../../domains/commerce/paymentRecoveryGuidanceAuthorization.js";

export interface PaymentRecoveryGuidanceClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown; error: { code?: string; message?: string } | null;
  }>;
}

const identifier = z.string().uuid();
const nullableText = z.string().min(1).max(240).nullable();
const timestamp = z.string().datetime({ offset: true });
const snapshotSchema = z.object({
  orderId: identifier, orderStatus: z.enum(ORDER_STATUSES), clientId: identifier,
  paymentIntentId: identifier, intentStatus: z.enum(PAYMENT_INTENT_STATUSES),
  paymentAttemptId: identifier.nullable(), attemptStatus: z.enum(PAYMENT_ATTEMPT_STATUSES).nullable(),
  provider: nullableText, providerPaymentId: nullableText, updatedAt: timestamp,
  failureReason: nullableText, subscriptionId: identifier.nullable(),
  orderMode: z.string().min(1).max(80), subscriptionStatus: nullableText,
  paidAt: timestamp.nullable(), hasExactGap: z.boolean(),
}).strict();
const responseSchema = z.object({
  snapshot: snapshotSchema,
  eligible: z.boolean(), tokenAuthorized: z.boolean(), historyComplete: z.boolean(), observedSuccess: z.boolean(),
  attempts: z.array(z.object({
    id: identifier, status: z.enum(PAYMENT_ATTEMPT_STATUSES), provider: z.string().min(1).max(240),
    providerPaymentId: nullableText, providerFlow: nullableText, createdAt: timestamp,
    evidence: z.array(z.unknown()).max(32),
  }).strict()).max(100),
}).strict();

/** A single RPC owns both legacy status and the optional evidence extension. */
export function createSupabasePaymentRecoveryGuidancePort(
  client: PaymentRecoveryGuidanceClient,
  normalize: (input: { provider: string; evidence: unknown[] }) => PaymentRecoveryEvidence | null,
): PaymentRecoverySnapshotPort {
  return {
    async getGuidanceSnapshot(input): Promise<PaymentRecoverySnapshot | null> {
      const { data, error } = await client.rpc("commerce_checkout_payment_guidance_snapshot", {
        p_order_id: input.orderId,
        p_payment_intent_id: input.paymentIntentId,
        p_recovery_token_id: input.recoveryTokenId ?? null,
      });
      // Missing migration and operational read errors must invoke the handler's
      // legacy fallback, not masquerade as an authoritative missing order.
      if (error) throw new Error("payment_recovery_snapshot_unavailable");
      if (data === null) return null;
      const parsed = responseSchema.safeParse(data);
      if (!parsed.success) throw new Error("payment_recovery_snapshot_invalid");
      const { snapshot, eligible, tokenAuthorized, historyComplete, observedSuccess, attempts } = parsed.data;
      if (snapshot.orderId !== input.orderId || snapshot.paymentIntentId !== input.paymentIntentId) {
        throw new Error("payment_recovery_snapshot_identity_mismatch");
      }
      const { orderMode, subscriptionStatus, paidAt, hasExactGap, ...legacy } = snapshot;
      const purchaseContext = eligible && orderMode === "one_time" ? "one_time"
        : eligible && orderMode === "subscription_cycle" ? "subscription_initial" : null;
      if (eligible && !purchaseContext) throw new Error("payment_recovery_snapshot_context_invalid");
      return {
        ...legacy,
        paymentAttemptId: legacy.paymentAttemptId ?? null, attemptStatus: legacy.attemptStatus ?? null,
        provider: legacy.provider ?? null, providerPaymentId: legacy.providerPaymentId ?? null,
        failureReason: legacy.failureReason ?? null, subscriptionId: legacy.subscriptionId ?? null,
        subscriptionActivationStatus: deriveSubscriptionActivationStatus({
          orderMode, orderStatus: snapshot.orderStatus, intentStatus: snapshot.intentStatus,
          subscriptionStatus, paidAt, hasExactGap,
        }),
        subscriptionStatus,
        eligible, purchaseContext, tokenAuthorized, historyComplete, observedSuccess,
        attempts: attempts.map((attempt) => ({
          id: attempt.id, status: attempt.status,
          provider: attempt.provider, providerFlow: attempt.providerFlow,
          // The provider adapter owns method/operation provenance. Never infer
          // a card from a provider name or fill unknown evidence from a flow.
          evidence: attempt.evidence.length
            ? normalize({ provider: attempt.provider, evidence: attempt.evidence }) : null,
        })),
      };
    },
  };
}
