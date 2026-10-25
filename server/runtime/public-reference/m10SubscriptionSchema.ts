import type { RequiredSchema } from "@openlup/core/readiness";

/** The host supplies the complete installed catalogue identity, never a guessed tail. */
export function m10SubscriptionSchema(catalogue: { version: string; migration: string }): RequiredSchema {
  return { ...catalogue, objects: [
    ...["subscriptions", "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_renewal_operations",
      "subscription_cycles", "subscription_retry_obligations", "subscription_retry_receipts", "subscription_retry_recovery_authorizations",
      "subscription_command_receipts", "subscription_stock_wait_cases", "subscription_dunning_cases", "subscription_delivery_alignment_cases",
      "fulfillment_inventory_reservations", "commerce_settlement_intents"].map(name => ({ kind: "table" as const, name: `public.${name}` })),
    ...[
      ["subscription_claim_due_renewal", "text,text,jsonb,text,integer,timestamp with time zone"],
      ["subscription_delivery_alignment_admit_renewal", "uuid,timestamp with time zone,timestamp with time zone"],
      ["subscription_retry_apply_failure", "uuid,text,jsonb"], ["subscription_retry_open_case", "uuid,text,text"],
      ["subscription_retry_prepare", "uuid,text,jsonb,timestamp with time zone"], ["subscription_retry_record_recovery", "uuid,text,jsonb"],
      ["subscription_stock_wait_admit", "jsonb,jsonb,timestamp with time zone"],
      ["subscription_stock_wait_candidates", "integer,timestamp with time zone"],
      ["subscription_stock_wait_normal_due", "integer,timestamp with time zone"],
      ["subscription_stock_wait_mark_resumed", "uuid"],
      ["subscription_command_apply", "uuid,uuid,text,uuid,text,jsonb,timestamp with time zone"],
    ].map(([name, signature]) => ({ kind: "function" as const, name: `public.${name}`, signature })),
  ] };
}
