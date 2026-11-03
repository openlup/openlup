import { nativeInstant } from "./nativeInstant.js";
import { createHash } from "node:crypto";
import type { RenewalLine } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Server-owned purchase facts. Sandbox authorization is never a real mandate. */
export interface NativeRenewalPurchaseFacts {
  settlementChannelKey: "sandbox";
  authorizationRef: string;
  unattendedChargeAuthorizedAt: string;
  payerAccountRef: string | null;
  methodRef: string;
  methodEvidenceRef: string;
  stockSourceKey: string;
  templateId: string;
  cadenceDays: number;
  currency: string;
  lines: readonly RenewalLine[];
  /** Native preparation currently supports line totals only. */
  shippingAmountMinor: 0;
  acquisitionRef: string | null;
}
export type SandboxMethodHealth = "healthy" | "method_missing" | "mandate_not_chargeable_unattended" | "pending_activation";

/** No driver or connection lifecycle is selected. Register before activation;
 * completion failure leaves the activation's durable duty open for another worker. */
export function createPostgresPurchaseRenewalWriter(executor: SubscriptionQueryExecutor) {
  async function response(sql: string, values: unknown[]) {
    return subscriptionRecord((await executor.query(sql, values)).rows[0]?.response);
  }
  return {
    async register(orderId: string, facts: NativeRenewalPurchaseFacts) {
      return response("SELECT public.subscription_register_renewal_purchase($1::uuid,$2::jsonb) AS response", [orderId, JSON.stringify({ ...facts, unattendedChargeAuthorizedAt: nativeInstant(facts.unattendedChargeAuthorizedAt) })]);
    },
    complete(orderId: string) {
      return response("SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response", [orderId]);
    },
    async pending(limit = 100) {
      const rows = (await executor.query("SELECT public.subscription_pending_renewal_attachments($1::integer) AS response", [limit])).rows[0]?.response;
      if (!Array.isArray(rows)) throw new Error("subscription_renewal_pending_response_invalid");
      return rows.map(subscriptionRecord);
    },
    transitionMethod(input: { subscriptionId: string; eventKey: string; expectedState: SandboxMethodHealth;
      healthState: SandboxMethodHealth; methodRef: string; evidenceRef: string }) {
      return response("SELECT public.subscription_transition_sandbox_method($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text) AS response",
        [input.subscriptionId, input.eventKey, input.expectedState, input.healthState, input.methodRef, input.evidenceRef]);
    },
    async readMethod(subscriptionId: string): Promise<Record<string, unknown> | null> {
      const row = (await executor.query(`SELECT m.health_state AS "healthState",m.method_ref AS "methodRef",
        m.evidence_ref AS "evidenceRef" FROM public.subscription_method_states m
        JOIN public.subscription_renewal_terms t ON t.subscription_id=m.subscription_id
        WHERE m.subscription_id=$1::uuid AND t.settlement_channel_key='sandbox'`, [subscriptionId])).rows[0];
      return row ?? null;
    },
  };
}

/** Requires independently committed queries, never an enclosing transaction.
 * The host declares first; saved purchase facts survive activation ACK loss. */
export async function activateNativePurchaseWithRenewal(executor: SubscriptionQueryExecutor, input: {
  orderId: string; idempotencyKey: string; capturedReference: string; facts: NativeRenewalPurchaseFacts;
}) {
  const writer = createPostgresPurchaseRenewalWriter(executor);
  // A failed facts writer must not withhold already-paid customer service.
  // Activation captures an enumerable duty even when facts need resubmission.
  let registered = false;
  let registrationConflict: unknown;
  try { await writer.register(input.orderId, input.facts); registered = true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") registrationConflict = error;
  }
  const fingerprint = createHash("sha256").update(input.capturedReference).digest("hex");
  const activation = subscriptionRecord((await executor.query(
    "SELECT public.subscription_activate_from_captured_payment($1::text,$2::uuid,$3::text) AS response",
    [input.idempotencyKey, input.orderId, fingerprint])).rows[0]?.response);
  if (typeof activation.activatedAt === "string") activation.activatedAt = nativeInstant(activation.activatedAt);
  if (registrationConflict) throw registrationConflict;
  try {
    if (!registered) return { activation, renewalAttachment: "pending" as const };
    await writer.complete(input.orderId);
    return { activation, renewalAttachment: "complete" as const };
  } catch {
    return { activation, renewalAttachment: "pending" as const };
  }
}
