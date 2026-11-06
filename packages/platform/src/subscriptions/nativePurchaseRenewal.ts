import { nativeInstant } from "./nativeInstant.js";
import { createHash } from "node:crypto";
import type { RenewalLine, RenewalRetainedTerms } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { nativeRenewalTermsSchema } from "./nativeRenewalTerms.js";
import { resolveNativePurchasePriceList } from "./nativePurchasePriceList.js";

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
  /** Legacy fixed amount; a retained threshold is evaluated after product discounts. */
  shippingAmountMinor: number;
  renewalTerms?: RenewalRetainedTerms;
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
      if (Object.hasOwn(facts, "renewalTerms")) nativeRenewalTermsSchema.parse(facts.renewalTerms);
      return response("SELECT public.subscription_register_renewal_purchase_with_shipping($1::uuid,$2::jsonb) AS response", [orderId, JSON.stringify({ ...facts, unattendedChargeAuthorizedAt: nativeInstant(facts.unattendedChargeAuthorizedAt) })]);
    },
    async complete(orderId: string) {
      const context = await resolveNativePurchasePriceList(executor, orderId, true);
      if (!context.templateAllowed) return response("SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response", [orderId]);
      // Renewal term lines do not exist before completion. Restricted order-item
      // readers use the admitted draft saved by the same admission statement.
      const source = context.orderReadable
        ? `SELECT item.sku_id AS variant_id,item.quantity,item.line_ordinal-1 AS sort_order,
            item.unit_amount_minor,o.currency_code FROM public.commerce_orders o
          JOIN public.commerce_order_items item ON item.order_id=o.id WHERE o.id=$1::uuid`
        : `SELECT sku.id AS variant_id,(item.line->>'quantity')::integer AS quantity,
            (item.ordinal-1)::integer AS sort_order,(item.line#>>'{unitPriceGross,amountMinor}')::bigint AS unit_amount_minor,
            o.currency_code FROM public.commerce_orders o
          CROSS JOIN LATERAL jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}')
            WITH ORDINALITY item(line,ordinal)
          JOIN public.catalog_skus sku ON sku.sku=item.line->>'sku' WHERE o.id=$1::uuid`;
      // One statement atomically writes the template and optional price context.
      // Completion remains its existing durable duty; a crash between statements
      // leaves the template intact and the attachment pending for retry.
      const contextUpdate = context.priceListId ? `, context AS (
        UPDATE public.subscriptions s SET price_list_id=$2::uuid,currency_code=$3
        FROM pending p WHERE s.id=p.id AND s.price_list_id IS NULL AND s.currency_code IS NULL
        RETURNING s.id
      )` : "";
      await executor.query(`WITH pending AS MATERIALIZED (
        SELECT s.id FROM public.subscription_activations a JOIN public.subscriptions s ON s.id=a.subscription_id
        WHERE a.order_id=$1::uuid AND a.state='active' AND s.template_version=1
          AND public.subscription_renewal_purchase_facts(s.id) IS NULL FOR UPDATE OF s
      ), template AS (
        INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
        SELECT p.id,l.variant_id,l.quantity,l.sort_order,false,l.unit_amount_minor,l.currency_code
        FROM pending p CROSS JOIN (${source}) l
        WHERE NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=p.id)
        ON CONFLICT(subscription_id,variant_id) DO NOTHING RETURNING id
      )${contextUpdate} SELECT id FROM pending`, context.priceListId ? [orderId, context.priceListId, context.currency] : [orderId]);
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
