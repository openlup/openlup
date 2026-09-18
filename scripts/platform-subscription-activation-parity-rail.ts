// Verb half of the subscription-activation parity probe (wave C-D17): the one place where each
// bundle's own routines and tables are named, behind identically-shaped lifecycle verbs. The
// compared story lives in scripts/platform-subscription-activation-parity.ts and the fixtures it
// runs on in the -probe module beside this one.
import {
  AT, CADENCE, CHANNEL, CLIENT, CONSENT_REF, CURRENCY, MAIL, ORDERS, SOURCE, TOTAL,
  call, count, fingerprint, fixed,
  type Call, type Bundle, type Conn, type Row,
} from "./platform-subscription-activation-parity-probe.ts";

/** Each bundle reaches the same lifecycle facts through its own verbs. */
export function spineFor(sql: Conn, bundle: Bundle) {
  const kernel = bundle !== "managed";
  const key = (name: string): string => `${SOURCE}-${name}`;
  return {
    /** What the deployment may still sell, in whichever columns the bundle keeps it. */
    readiness: async (sku: string): Promise<Row> => (await sql.query(kernel
      ? `SELECT stock.for_sale_quantity AS "forSale", (stock.for_sale_quantity > 0) AS sellable
           FROM public.fulfillment_stock_current stock WHERE stock.source_key = $1 AND stock.sku = $2`
      : `SELECT stock.provider_for_sale_quantity AS "forSale", (stock.provider_for_sale_quantity > 0) AS sellable
           FROM public.fulfillment_provider_stock_current stock WHERE $1::text IS NOT NULL AND stock.sku = $2`,
      [SOURCE, sku])).rows[0] ?? { forSale: null, sellable: null },

    /** The durable way back. Upstream stores the contact itself; this kernel stores a reference. */
    continue: (sku: string, contactRef: string, name: string): Promise<Call> => kernel
      ? call(sql, `SELECT public.commerce_record_offer_continuation($1, $2, $3, $4, $5,
          '${AT}'::timestamptz) AS response`, [key(name), SOURCE, sku, contactRef, CONSENT_REF])
      : call(sql, `SELECT jsonb_build_object('continuationId',
          public.subscribe_product_stock_notification($1, $2, NULL, NULL, '{}'::jsonb)) AS response`,
        [sku, `${contactRef.slice(0, 12)}.${MAIL}`]),

    continuations: (sku: string): Promise<number> => count(sql, kernel
      ? `SELECT count(*)::int AS n FROM public.commerce_offer_continuations
          WHERE source_key = $1 AND sku = $2 AND status = 'waiting'`
      : `SELECT count(*)::int AS n FROM public.commerce_product_stock_notifications
          WHERE $1::text IS NOT NULL AND sku = $2 AND closed_at IS NULL`, [SOURCE, sku]),

    /** The checkout says a subscription is intended. This kernel writes that as a row it can later
     *  find; upstream writes it into the order's own metadata, which the seed already carries. */
    declare: (target: string, name: string): Promise<Call> => kernel
      ? call(sql, `SELECT public.subscription_declare_provisional_activation($1, $2, $3,
          '${AT}'::timestamptz) AS response`, [key(name), target, CADENCE])
      : call(sql, `SELECT (metadata #> '{quoteSnapshot,quote,context}') AS response
          FROM public.commerce_orders WHERE id = $1`, [target]),

    /** Ask for the money. Nothing has been captured yet at this point on either bundle. */
    open: async (target: string, name: string): Promise<void> => {
      if (kernel) {
        await call(sql, `SELECT public.commerce_open_settlement_intent($1, $2, $3, $4::bigint, $5,
          '{}'::jsonb, '${AT}'::timestamptz) AS response`, [key(`open-${name}`), target, CHANNEL, TOTAL, CURRENCY]);
        return;
      }
      await call(sql, `SELECT public.commerce_payment_control_create_intent($1, 'one_time_order', $2, NULL,
        NULL, $3::integer, $4, '{}'::jsonb) AS response`, [key(`open-${name}`), target, TOTAL, CURRENCY]);
    },

    /** Money enters through the explicitly configured captured capability and nothing else: an
     *  opaque channel that settles without contacting anything. No provider result is invented. */
    capture: async (target: string, name: string, reference: string): Promise<void> => {
      const intent = await intentOf(sql, kernel, target);
      if (kernel) {
        await call(sql, `SELECT public.commerce_record_settlement($1, $2, 'succeeded', $3, '{}'::jsonb,
          '${AT}'::timestamptz) AS response`, [key(`settle-${name}`), intent, reference]);
        return;
      }
      await call(sql, `SELECT public.commerce_payment_control_record_attempt($1, $2, $3, NULL, NULL,
        'sent_to_provider', NULL, '{}'::jsonb, '{}'::jsonb) AS response`, [key(`attempt-${name}`), intent, CHANNEL]);
      await call(sql, `SELECT public.commerce_payment_control_apply_result($1, $2, NULL, 'succeeded',
        '${AT}'::timestamptz, NULL) AS response`, [key(`result-${name}`), intent]);
    },

    /** The activation itself. Both bundles take a key and a payment identity, and compare both. */
    activate: async (target: string, name: string, reference: string): Promise<Call> => {
      if (kernel) {
        return call(sql, `SELECT public.subscription_activate_from_captured_payment($1, $2, $3)
          AS response`, [key(name), target, fingerprint(reference)]);
      }
      return call(sql, `SELECT public.subscription_activate_from_paid_checkout_order($1, $2, $3, $4,
        'captured', '${AT}'::timestamptz) AS response`,
      [key(name), target, await intentOf(sql, kernel, target), fingerprint(reference)]);
    },

    /** The customer-facing answer, read entirely out of the database. */
    readback: async (target: string): Promise<Row> => (await sql.query(kernel
      ? `SELECT o.status AS "orderStatus", s.status AS "subscriptionStatus", s.cadence_days AS "cadenceDays",
           (extract(epoch FROM s.next_cycle_at - s.started_at) / 86400)::int AS "slidDays"
         FROM public.commerce_orders o
         LEFT JOIN public.subscription_activations a ON a.order_id = o.id
         LEFT JOIN public.subscriptions s ON s.id = a.subscription_id WHERE o.id = $1`
      : `SELECT o.status AS "orderStatus", s.status AS "subscriptionStatus", s.cadence_days AS "cadenceDays",
           (extract(epoch FROM s.next_cycle_at - s.started_at) / 86400)::int AS "slidDays"
         FROM public.commerce_orders o
         LEFT JOIN public.subscriptions s ON s.id = o.subscription_id WHERE o.id = $1`, [target])).rows[0] ?? {},

    /** How many subscriptions this buyer ended up with. One activation means one, never two. */
    subscriptions: (): Promise<number> =>
      count(sql, `SELECT count(*)::int AS n FROM public.subscriptions WHERE client_id = $1`, [CLIENT]),

    /** How many settlements this probe has asked for. The continuation branch must ask for none. */
    intents: (): Promise<number> => count(sql, `SELECT count(*)::int AS n FROM public.${
      kernel ? "commerce_settlement_intents" : "commerce_payment_intents"} WHERE order_id = ANY($1::uuid[])`, [ORDERS]),

    /** How many of this probe's checkouts ended cancelled. A repeat compensation must not add one. */
    cancelledOrders: (): Promise<number> => count(sql,
      `SELECT count(*)::int AS n FROM public.commerce_orders
        WHERE id = ANY($1::uuid[]) AND status = 'cancelled'`, [ORDERS]),

    compensate: (target: string, name: string): Promise<Call> => kernel
      ? call(sql, `SELECT public.commerce_compensate_abandoned_checkout($1, $2, $3,
          '${AT}'::timestamptz) AS response`, [key(name), target, "abandoned_checkout"])
      : call(sql, `SELECT public.commerce_cancel_abandoned_checkout($1, $2, $3) AS response`,
        [key(name), target, "abandoned_checkout"]),

    orderStatus: async (target: string): Promise<string | null> => String((await sql.query(
      `SELECT status FROM public.commerce_orders WHERE id = $1`, [target])).rows[0]?.status ?? "") || null,
  };
}

export const intentOf = async (sql: Conn, kernel: boolean, target: string): Promise<string> =>
  String((await sql.query(`SELECT id FROM public.${
    kernel ? "commerce_settlement_intents" : "commerce_payment_intents"} WHERE order_id = $1`, [target]))
    .rows[0]?.id ?? fixed(9, 99));
