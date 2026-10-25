import type { RequiredSchema } from "@openlup/core/readiness";

/** Complete host catalogue identity plus the selected native recovery graph.
 * Additional package operations retain their host-supplied schema obligations.
 */
export function m11CommerceSchema(catalogue: { version: string; migration: string }, requiredObjects: RequiredSchema["objects"]): RequiredSchema {
  const objects: RequiredSchema["objects"] = [
    ...requiredObjects,
    ...["clients", "commerce_orders", "commerce_order_draft_receipts", "commerce_settlement_intents", "commerce_checkout_recovery_tokens",
      "customer_communication_preferences", "outbox_events", "transactional_delivery_receipts"].map(name => ({ kind: "table" as const, name: `public.${name}` })),
    ...[
      ["commerce_enqueue_abandoned_cart_reminders", "integer"],
      ["commerce_enqueue_checkout_recovery_reminders", "integer"],
      ["commerce_checkout_reminder_delivery_authorize", "uuid,text"],
      ["commerce_checkout_recovery_try_timestamptz", "text"],
      ["commerce_outbox_compact_terminal", "integer,timestamp with time zone"],
    ].map(([name, signature]) => ({ kind: "function" as const, name: `public.${name}`, signature })),
  ];
  return { ...catalogue, objects: [...new Map(objects.map(object => [`${object.kind}:${object.name}:${object.signature ?? ""}`, object])).values()] };
}
