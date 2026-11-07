import { PLATFORM_EVENT_VOCABULARY } from '@openlup/core/outbox';
import type { SqlExecutor } from '@openlup/core/readiness';
import { readOutboxDispatchConfig, runOutboxDispatchWorker, uniqueRegistry } from '@openlup/outbox';
import { createPostgresOutboxStore } from '@openlup/outbox/postgres';
import { createOutboxDispatchRegistry, createOutboxOrderPaidEmailHandler } from '@openlup/platform/commerce/server';
import { OUTBOX_ORDER_PAID_TEMPLATE_SLUG, uuidFromOrderRef } from '@openlup/platform/commerce';
import type { OrderPaidLinesPort,
  OrderRecipientPort, TransactionalEmailPort } from '@openlup/platform/commerce';
import type { CommerceEmailRuntime } from '@openlup/platform/commerce/server';
import type { StoreConfig, Locale } from '../shared/config.ts';
import { assertRenewalConfig } from '../shared/renewal-config.ts';
import { createPaidMailArtifacts, paidMailKey } from './paid-mail-artifact.ts';
import { createPrivateCapture, type PrivateCapture } from './private-capture.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;
const amount = (value: unknown): number => {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new Error('starter_paid_mail_money_unavailable');
  return result;
};
const refuse = async (): Promise<never> => { throw new Error('starter_paid_mail_method_not_selected'); };

/** Only the paid-email handler is registered; all other email methods refuse. */
export function createPaidMailHost(input: { executor: SqlExecutor; config: StoreConfig; capture?: PrivateCapture }) {
  const { executor, config } = input;
  assertRenewalConfig(config.renewal);
  const artifacts = createPaidMailArtifacts(input.capture ?? createPrivateCapture());
  const notices = config.renewal.notices;
  const resolveLocale = (country: string | null | undefined): Locale =>
    (country ? notices.countryLocales?.[country.toUpperCase()] : undefined) ?? notices.locale;
  const recipientPort: OrderRecipientPort = {
    async resolve(orderUuid) {
      const row = (await executor.query(`SELECT c.email,c.first_name,c.country FROM public.commerce_orders o
        JOIN public.clients c ON c.id=o.client_id WHERE o.id=$1::uuid`, [orderUuid])).rows[0];
      if (!row || !text(row.email)) return null;
      return { email: String(row.email), firstName: text(row.first_name), country: text(row.country) };
    },
  };
  const linesPort: OrderPaidLinesPort = {
    async read(orderUuid) {
      const order = (await executor.query(`SELECT currency_code,total_amount_minor,metadata
        FROM public.commerce_orders WHERE id=$1::uuid`, [orderUuid])).rows[0];
      if (!order || !text(order.currency_code)) return null;
      const rows = (await executor.query(`SELECT quantity,line_ordinal,source_line_ordinal,line_amount_minor,catalog_line_amount_minor,
        promotion_discount_allocated_minor FROM public.commerce_order_items
        WHERE order_id=$1::uuid ORDER BY line_ordinal`, [orderUuid])).rows;
      const draft = record(record(order.metadata).orderDraftSnapshot);
      const snapshots = Array.isArray(draft.lines) ? draft.lines : [];
      const lines = rows.map(row => {
        const snapshot = record(snapshots[Number(row.source_line_ordinal ?? row.line_ordinal) - 1]);
        return { label: text(snapshot.title) ?? text(snapshot.name), quantity: Number(row.quantity),
          lineTotalMinor: amount(row.catalog_line_amount_minor ?? row.line_amount_minor) };
      });
      return { currency: String(order.currency_code),
        subtotalMinor: lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
        discountMinor: rows.reduce((sum, row) => sum + amount(row.promotion_discount_allocated_minor ?? 0), 0),
        totalMinor: amount(order.total_amount_minor), lines };
    },
  };
  const emailPort: TransactionalEmailPort<Locale> = {
    async findExistingSend(template, eventId) {
      if (template !== OUTBOX_ORDER_PAID_TEMPLATE_SLUG) return refuse();
      return await artifacts.read(paidMailKey(eventId)) !== null;
    },
    async sendOrderPaidConfirmation(send) {
      send.signal.throwIfAborted();
      const key = paidMailKey(send.outboxEventId);
      if (!await artifacts.read(key)) {
        const order = (await executor.query('SELECT client_id FROM public.commerce_orders WHERE id=$1::uuid',
          [uuidFromOrderRef(send.orderId)])).rows[0];
        if (!order?.client_id) throw new Error('starter_paid_mail_identity_unavailable');
        const locale = send.locale ?? notices.locale, copy = notices.copy[locale].paid;
        const body = [copy.subject, `${copy.order}: ${send.orderId}`,
          ...send.items.map(item => `${item.name} — ${copy.quantity}: ${item.quantity} — ${item.lineTotalLabel}`)];
        if (send.totals?.subtotalLabel != null) body.push(`${copy.subtotal}: ${send.totals.subtotalLabel}`);
        if (send.totals?.discountLabel != null) body.push(`${copy.discount}: ${send.totals.discountLabel}`);
        if (send.totals) body.push(`${copy.total}: ${send.totals.totalLabel}`);
        send.signal.throwIfAborted();
        await artifacts.writeOnce(key, { schemaVersion: 1, kind: 'order_paid', messageKey: key,
          outboxEventId: send.outboxEventId, orderId: send.orderId, recipient: send.to,
          recipientReference: `client:${order.client_id}`, templateReference: `template:${OUTBOX_ORDER_PAID_TEMPLATE_SLUG}:${locale}`,
          locale, subject: copy.subject, body: body.join('\n') });
      }
      return { ok: true, messageId: key, httpStatus: 200, providerError: null, aborted: false };
    },
    sendReturnApprovedNotice: refuse, sendReturnRejectedNotice: refuse, sendOrderConfirmation: refuse,
    sendCheckoutRecovery: refuse, sendPaymentFailedNotice: refuse, sendCheckoutExpiredNotice: refuse,
    sendOrderCanceledNotice: refuse, sendOrderRefundedNotice: refuse, sendShipmentDispatchedNotice: refuse,
    sendShipmentDeliveredNotice: refuse, sendShipmentExceptionNotice: refuse,
  };
  const runtime: Parameters<typeof createOutboxOrderPaidEmailHandler<Locale>>[0]['runtime'] = {
    resolveLocale, genericItemLabel: locale => notices.copy[locale].paid.item,
    formatMoney: (amountMinor, currency) => new Intl.NumberFormat(notices.locale, { style: 'currency', currency }).format(amountMinor / 100),
    presentPaidOrder: () => null,
    parseOutboxPayload: (schema, payload) => {
      const parsed = schema.safeParse(payload);
      return parsed.success ? { ok: true, data: parsed.data }
        : { ok: false, outcome: { kind: 'discard', reason: 'invalid_payload' } };
    },
    mapSendOutcome: outcome => outcome.ok ? { kind: 'processed' } : { kind: 'retry', reason: 'starter_paid_mail_unavailable' },
  } satisfies Pick<CommerceEmailRuntime<Locale>, 'resolveLocale' | 'genericItemLabel' | 'formatMoney' | 'presentPaidOrder' | 'parseOutboxPayload' | 'mapSendOutcome'>;
  const registry = createOutboxDispatchRegistry({ uniqueRegistry, fulfillmentEnabled: false,
    extraHandlers: [createOutboxOrderPaidEmailHandler({ runtime, emailPort, recipientPort, linesPort })] });
  return { emailPort, registry, async run() {
    return runOutboxDispatchWorker({ store: createPostgresOutboxStore(executor), registry,
      knownEventTypes: PLATFORM_EVENT_VOCABULARY.map(entry => entry.eventType),
      config: { ...readOutboxDispatchConfig({}), batchSize: config.renewal.batchLimit, softBudgetMs: 15_000 },
      logger: { warn: () => {}, error: () => {} } });
  } };
}
