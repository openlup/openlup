import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createDbBackedCommerceQuotePort } from "@openlup/platform/pricing";
import { createOutboxOrderPaidEmailHandler } from "@openlup/platform/commerce/server";
import type { TransactionalDeliveryReceiptStore } from "@openlup/platform/communications";
import type { createTransactionalDelivery } from "@openlup/platform/communications";

let sourceSequence = 1;
export async function refusedNoticeSources(owner: Pool, source: "event" | "reminder",
  refusal: "missing_recipient" | "disabled_control" | "consent_refused", count: number) {
  const ids: string[] = [], clients: string[] = [], unresolvedClients = new Set<string>();
  const template = source === "event" ? "subscription-welcome" : "subscription-renewal-upcoming";
  for (let index = 0; index <= count; index++) {
    const id = `00000000-0000-4000-8000-${String(sourceSequence++).padStart(12, "0")}`;
    const refused = index < count, subscription = randomUUID();
    const client = randomUUID();
    if (refused && refusal === "missing_recipient") unresolvedClients.add(client);
    ids.push(id); clients.push(client);
    // Installer-only source/policy fixtures. Dispatch and terminal writes use the real runtime.
    await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    // Queued historical sources do not ask the automatic future-reminder producer for extra work.
    await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2001-01-01T00:00:00Z')", [subscription, client]);
    if (source === "event") await owner.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key)
      VALUES($1,$2,$3,$4)`, [id, subscription, refused ? "subscription.activated" : "subscription.customer_self_service.cancel", `terminal-fixture:${id}`]);
    else if (refused) await owner.query(`INSERT INTO public.subscription_reminder_ledger(id,subscription_id,reminder_kind,reminder_day)
      VALUES($1,$2,'renewal_due_soon','2001-01-01')`, [id, subscription]);
    else {
      // The eligible pause source must pass the live-window check before this policy witness can dispatch it.
      await owner.query(`SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'pause',
        '{"pausePreset":"2_weeks"}'::jsonb,now()-interval '12 days')`, [client, `terminal-pause:${id}`, subscription]);
      await owner.query(`INSERT INTO public.subscription_reminder_ledger(id,subscription_id,reminder_kind,reminder_day)
        SELECT $1,subscription_id,'pause_ending',(ends_at AT TIME ZONE 'UTC')::date
        FROM public.subscription_pause_windows WHERE subscription_id=$2 AND idempotency_key=$3`, [id, subscription, `terminal-pause:${id}`]);
    }
    if (refused && refusal === "consent_refused") await owner.query("SELECT public.communications_record_recipient_consent($1,'transactional','suppressed',now())",
      [createHash("sha256").update(`${client}@example.invalid`).digest("hex")]);
  }
  if (refusal === "disabled_control") await owner.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES($1,false)", [template]);
  return { source, unresolvedClients, refused: ids.slice(0, count), eligible: ids[count]!, async changeCondition() {
    unresolvedClients.clear();
    if (refusal === "disabled_control") await owner.query("DELETE FROM public.communication_delivery_controls WHERE control_key=$1", [template]);
    for (const client of new Set(clients.slice(0, count))) {
      if (refusal === "consent_refused") await owner.query("SELECT public.communications_record_recipient_consent($1,'transactional','granted',now())",
        [createHash("sha256").update(`${client}@example.invalid`).digest("hex")]);
    }
  } };
}

/** A bounded recipient-read fault, not a fabricated result or schema/privilege change.
 * Valid native FKs and nonempty email exclude an absent client in an ordinary fixture.
 * The installed runtime still executes the real reader on the same held session. */
export function noticeSessionWithRecipientFault(db: PoolClient, unresolvedClients: ReadonlySet<string>) {
  return { query(text: string, values?: unknown[]) {
    const unresolved = text === "SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient"
      && unresolvedClients.has(String(values?.[0]));
    return db.query(text, unresolved ? [null] : values);
  } };
}

/** Only catalog/prices are installer seed data. Draft, lines, intent and paid events use native writers. */
export async function nativeNoticeOrder(admin: Pool, runtime: Pool, clientId?: string, mode: "one_time" | "subscription" = "one_time") {
  const product = randomUUID(), sku = `G8-${product}`, list = randomUUID();
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fictional item')", [product, sku]);
  await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES($1,$1,$2,'Fictional item',true)`, [product, sku]);
  await admin.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Fictional prices','AA','XXX')", [list]);
  await admin.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,100)", [list, product]);
  const client = clientId ?? (await runtime.query("INSERT INTO public.clients(email) VALUES($1) RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
  const tax = { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "fictional-proof" } as const;
  const quotePort = createDbBackedCommerceQuotePort({ isStrictD1Quote: false, taxProfile: tax, supportedTaxProfiles: [tax],
    regionCode: "AA", currency: "XXX", now: () => new Date().toISOString(), hasPromotionCodePort: false,
    quoteCatalogReadPort: { async listQuoteCatalogItems() {
      return (await runtime.query(`SELECT s.id AS "skuId",s.id AS "variantId",s.sku AS "skuCode",p.slug AS "productSlug"
        FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=$1`, [product])).rows.map(row => ({ ...row,
        netWeightG: 1, isAddon: false, isPrimarySku: true, sellability: { oneTime: true, subscription: true }, documentRevision: { id: null, digest: null } }));
    } },
    pricingResolverPort: { async resolvePrice(input) {
      const row = (await runtime.query(`SELECT e.variant_id AS "variantId",e.mode,e.min_qty AS "matchedMinQty",
        e.unit_price_minor AS "unitPriceMinor",e.amount_kind AS "amountKind",e.price_list_id AS "priceListId",e.id AS "priceEntryId"
        FROM public.price_entries e JOIN public.price_lists l ON l.id=e.price_list_id
        WHERE e.variant_id=$1 AND e.mode IN($2,'any') AND e.active AND l.currency=$3 LIMIT 1`,
      [input.variantId, input.mode, input.currency])).rows[0];
      return row ? { ...row, resolvedAt: input.atTime } : null;
    } },
    shippingFlatMinor: async () => 0, lineContext: () => ({}), quoteContext: request => () => ({ mode: request.mode, cadenceDays: request.cadenceDays, promoCodes: request.promoCodes }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }),
  });
  const quote = await quotePort.createServerAuthoritativeQuote({ mode, cadenceDays: 28, promoCodes: [], lines: [{ sku, quantity: 2 }] });
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.quote.context, lines: quote.quote.lines, totals: { totalGross: quote.quote.totalGross } };
  const response = (await runtime.query("SELECT public.commerce_create_order_draft_with_outbox($1,$2::jsonb,$3::jsonb,$4::uuid) AS result",
    [`draft:${product}`, quote, draft, client])).rows[0].result;
  const order = String(response.orderDraft.orderId).replace(/^order_/, "");
  const intent = (await runtime.query(`SELECT public.commerce_open_settlement_intent($1,$2::uuid,'captured',200,'XXX') AS result`,
    [`intent:${product}`, order])).rows[0].result.settlement.id as string;
  const settle = (db: Pool | PoolClient = runtime) => db.query("SELECT public.commerce_record_settlement($1,$2::uuid,'succeeded',$3) AS result",
    [`settle:${product}`, intent, `captured:${product}`]);
  return { client: String(client), order, intent, settle };
}

export function capturedPaidHandler(runtime: Pool, receipts: TransactionalDeliveryReceiptStore,
  delivery: ReturnType<typeof createTransactionalDelivery>, observed: { orderId: string; to: string; total: string | null }[]) {
  const unused = async () => { throw new Error("unexpected mail path"); };
  return createOutboxOrderPaidEmailHandler<"en">({
    runtime: {
      formatMoney: (minor, currency) => `${minor} ${currency}`, genericItemLabel: () => "Item", resolveLocale: () => "en",
      presentPaidOrder: () => null,
      parseOutboxPayload(schema, payload) {
        const parsed = schema.safeParse(payload);
        return parsed.success ? { ok: true, data: parsed.data } : { ok: false, outcome: { kind: "discard", reason: "invalid_payload" } };
      },
      mapSendOutcome: outcome => outcome.ok ? { kind: "processed" } : { kind: "retry", reason: "captured_failed" },
    },
    recipientPort: { async resolve(order) {
      const row = (await runtime.query(`SELECT c.email,c.first_name AS "firstName",c.country FROM public.commerce_orders o
        JOIN public.clients c ON c.id=o.client_id WHERE o.id=$1::uuid`, [order])).rows[0];
      return row ? { email: String(row.email), firstName: row.firstName as string | null, country: row.country as string | null } : null;
    } },
    linesPort: { async read(order) {
      const head = (await runtime.query("SELECT currency_code,total_amount_minor FROM public.commerce_orders WHERE id=$1::uuid", [order])).rows[0];
      if (!head) return null;
      const lines = (await runtime.query("SELECT quantity,line_amount_minor FROM public.commerce_order_items WHERE order_id=$1::uuid ORDER BY line_ordinal", [order])).rows;
      return { currency: String(head.currency_code), subtotalMinor: lines.reduce((sum, line) => sum + Number(line.line_amount_minor), 0),
        discountMinor: 0, totalMinor: Number(head.total_amount_minor), lines: lines.map(line => ({ label: null,
          quantity: Number(line.quantity), lineTotalMinor: Number(line.line_amount_minor) })) };
    } },
    emailPort: {
      async findExistingSend(_template, id) { return (await receipts.readReceipt(`paid-mail:${id}`))?.state === "accepted"; },
      async sendOrderPaidConfirmation(input) {
        observed.push({ orderId: input.orderId, to: input.to, total: input.totals?.totalLabel ?? null });
        const receipt = await delivery.send({ idempotencyKey: `paid-mail:${input.outboxEventId}`, recipientReference: input.orderId, templateReference: "commerce-order-paid" });
        return { ok: true, messageId: receipt.deliveryReference, httpStatus: 200, providerError: null, aborted: false };
      },
      sendOrderConfirmation: unused, sendCheckoutRecovery: unused, sendReturnApprovedNotice: unused, sendReturnRejectedNotice: unused,
      sendPaymentFailedNotice: unused, sendCheckoutExpiredNotice: unused, sendOrderCanceledNotice: unused, sendOrderRefundedNotice: unused,
      sendShipmentDispatchedNotice: unused, sendShipmentDeliveredNotice: unused, sendShipmentExceptionNotice: unused,
    },
  });
}
