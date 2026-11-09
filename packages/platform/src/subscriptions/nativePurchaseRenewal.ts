import { nativeInstant } from "./nativeInstant.js";
import { createHash } from "node:crypto";
import type { RenewalLine, RenewalRetainedTerms } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { nativeRenewalTermsSchema } from "./nativeRenewalTerms.js";
import { bestEffortNativePurchaseTemplate, resolveNativePurchasePriceList } from "./nativePurchasePriceList.js";

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
      const completed = await response("SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response", [orderId]);
      await bestEffortNativePurchaseTemplate(executor, async () => {
        const id = String(completed.subscriptionId);
        const lines = (await executor.query(`SELECT sku.id AS variant_id,
            sum((item.line->>'quantity')::bigint)::integer AS quantity,(min(item.ordinal)-1)::integer AS sort_order,
            min((item.line#>>'{unitPriceGross,amountMinor}')::bigint) AS unit_price_minor,
            count(DISTINCT (item.line#>>'{unitPriceGross,amountMinor}')::bigint)::integer AS price_count,
            coalesce((SELECT (role->>'isAddon')::boolean FROM jsonb_array_elements(
              public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,linePricing}') role
              WHERE role->>'sku'=sku.sku),false) AS is_addon,o.currency_code
          FROM public.subscriptions s JOIN public.commerce_orders o ON o.id=$2::uuid
          CROSS JOIN LATERAL jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}') WITH ORDINALITY item(line,ordinal)
          JOIN public.catalog_skus sku ON sku.sku=item.line->>'sku'
          WHERE s.id=$1::uuid AND s.template_version=1
            AND NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id)
          GROUP BY s.id,sku.id,sku.sku,o.currency_code`, [id, orderId])).rows;
        if (!lines.length) return;
        if (lines.some(line => line.price_count !== 1)) {
          console.warn("subscription_template_unavailable", "ambiguous_line_price");
          return;
        }
        const context = await resolveNativePurchasePriceList(executor, orderId);
        const contextUpdate = context.priceListId ? `, context AS (
          UPDATE public.subscriptions s SET price_list_id=$3::uuid,currency_code=$4
          FROM eligible e WHERE s.id=e.id AND s.price_list_id IS NULL AND s.currency_code IS NULL RETURNING s.id
        )` : "";
        // Lines and context are atomic with each other, after the durable completion.
        await executor.query(`WITH locked AS MATERIALIZED (
          SELECT id FROM public.subscriptions WHERE id=$1::uuid AND template_version=1 FOR UPDATE
        ), eligible AS MATERIALIZED (
          SELECT id FROM locked WHERE NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=locked.id)
        ), template AS (
          INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
          SELECT e.id,l.variant_id,l.quantity,l.sort_order,l.is_addon,l.unit_price_minor,l.currency_code
          FROM eligible e CROSS JOIN jsonb_to_recordset($2::jsonb) AS l(variant_id uuid,quantity integer,sort_order integer,
            is_addon boolean,unit_price_minor bigint,currency_code text)
          ON CONFLICT(subscription_id,variant_id) DO NOTHING RETURNING id
        )${contextUpdate} SELECT id FROM eligible`, context.priceListId
          ? [id, JSON.stringify(lines), context.priceListId, context.currency] : [id, JSON.stringify(lines)]);
        if (context.reason) console.warn("subscription_price_list_unresolved", context.reason);
      });
      return completed;
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
