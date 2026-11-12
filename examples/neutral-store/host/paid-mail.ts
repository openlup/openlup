import { createPostgresBuyerCheckoutLinkPort, createPostgresCheckoutRecoveryWaves, createPostgresOperatorCheckoutLinkStore, createOutboxCheckoutRecoveryEmailHandler, createOutboxCheckoutExpiredEmailHandler } from '@openlup/platform/commerce/server';
import type { OrderPaymentLifecyclePort } from '@openlup/platform/commerce';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import { createCheckoutRecoveryWaveJob } from '@openlup/platform/composition';
import { withCheckoutRecoverySendEvidence } from '@openlup/platform/communications';
import { sandboxRecoveryPolicy, checkoutRecoverySchedule, checkoutWavePolicy } from '../owned/acquisition-policy.ts';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';
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
import { composeSizedPaidEmailNote } from './editor-mail.ts';
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
        if (send.parcelNote) body.push(send.parcelNote);
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
    extraHandlers: [createOutboxOrderPaidEmailHandler({ runtime, emailPort, recipientPort, linesPort,
      describeParcel: composeSizedPaidEmailNote(executor, config) })] });
  return { emailPort, registry, async run() {
    return runOutboxDispatchWorker({ store: createPostgresOutboxStore(executor), registry,
      knownEventTypes: PLATFORM_EVENT_VOCABULARY.map(entry => entry.eventType),
      config: { ...readOutboxDispatchConfig({}), batchSize: config.renewal.batchLimit, softBudgetMs: 15_000 },
      logger: { warn: () => {}, error: () => {} } });
  } };
}

/** One bounded local checkout-recovery pass, using the installed job and outbox owners. */
export async function runCheckoutRecovery(input: { executor: import('pg').Pool; config: StoreConfig; publicOrigin: string;
  capture?: PrivateCapture; now?: string; enabled?: boolean }) {
  const { executor, config } = input, at = input.now ?? new Date().toISOString(), schedule = checkoutRecoverySchedule;
  const policy = checkoutWavePolicy;
  const waves = createPostgresCheckoutRecoveryWaves(executor, policy);
  const capture = input.capture ?? createPrivateCapture();
  const job = createCheckoutRecoveryWaveJob({ enabled: () => input.enabled ?? schedule.enabled,
    jobName: `starter-checkout:${config.id}`, leaseSeconds: schedule.leaseSeconds, batchSize: schedule.batchSize,
    async bind() { return { ledger: createPostgresPlatformJobRunLedger(executor, {
      releaseCorrelation: () => ({ artifact: 'local-candidate' }), defaultFailureReason: 'checkout_recovery_failed' }),
      enqueue: waves.enqueue }; } });
  const enqueued = await job({ triggerKind: 'scheduler', invocationSource: 'local-demonstration' }, at);
  if ('skipped' in enqueued && enqueued.skipped || !enqueued.ok) return { enqueued };
  const expired = await waves.expire(schedule.batchSize, at);
  const initial = await waves.sweepInitial(schedule.batchSize, new Date(Date.parse(at) - schedule.initialTimeoutSeconds * 1000).toISOString(), at);
  const reconciled = await waves.reconcile(schedule.batchSize, at);
  const locale = (country: string | null | undefined): Locale =>
    (country ? config.renewal.notices.countryLocales?.[country.toUpperCase()] : undefined) ?? config.renewal.notices.locale;
  const recipients: OrderRecipientPort = { async resolve(id) {
    const row = (await executor.query(`SELECT c.email,c.first_name,c.country FROM public.commerce_orders o
      JOIN public.clients c ON c.id=o.client_id WHERE o.id=$1::uuid`, [id])).rows[0];
    return row?.email ? { email: row.email, firstName: row.first_name, country: row.country } : null;
  } };
  const lifecycle: OrderPaymentLifecyclePort = { async read(id) {
    const row = (await executor.query(`SELECT o.status,o.metadata,i.status AS payment_status,i.updated_at
      FROM public.commerce_orders o LEFT JOIN LATERAL (SELECT status,updated_at FROM public.commerce_settlement_intents
      WHERE order_id=o.id ORDER BY updated_at DESC,id DESC LIMIT 1) i ON true WHERE o.id=$1::uuid`, [id])).rows[0];
    return row ? { orderStatus: row.status, hasPayment: row.payment_status === 'settled',
      paymentStatus: row.payment_status === 'settled' ? 'succeeded' : row.payment_status,
      paymentUpdatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      subscriptionActivationAbandoned: row.metadata?.subscriptionActivation === 'abandoned' } : null;
  } };
  const key = (eventId: string) => `checkout-mail:${eventId}`;
  const send = async (send: { to: string; orderId: string; recoveryToken?: string | null; outboxEventId: string; locale?: Locale; signal: AbortSignal; linkSource?: string }, expired: boolean, final = false) => {
    send.signal.throwIfAborted();
    const language = send.locale ?? locale(null), selected = copy[language];
    const url = new URL(routes.completion[language], input.publicOrigin);
    if (send.recoveryToken) url.searchParams.set('token', send.recoveryToken);
    if (send.linkSource) url.searchParams.set('source', send.linkSource);
    const messageKey = key(send.outboxEventId);
    if (!await capture.read(messageKey)) await capture.writeOnce(messageKey, { schemaVersion: 1,
      kind: expired ? 'checkout_expired' : 'checkout_recovery', outboxEventId: send.outboxEventId,
      orderId: send.orderId, recipient: send.to, locale: language,
      subject: expired ? selected.checkoutExpiredSubject : final ? selected.checkoutFinalSubject : selected.checkoutFirstSubject,
      body: [expired ? selected.checkoutExpiredBody : selected.checkoutMailBody, ...(send.recoveryToken ? [url.href] : [])].join('\n'),
      recoveryUrl: send.recoveryToken ? url.href : null });
    if (!await capture.read(messageKey)) throw new Error('starter_private_capture_unavailable');
    return { ok: true, messageId: messageKey, httpStatus: 200, providerError: null, aborted: false };
  };
  const email: TransactionalEmailPort<Locale> = {
    findExistingSend: async (_template, eventId) => await capture.read(key(eventId)) !== null,
    sendCheckoutRecovery: sendInput => send(sendInput, false, sendInput.reminderHours > 1),
    sendCheckoutExpiredNotice: sendInput => send(sendInput, true),
    sendReturnApprovedNotice: refuse, sendReturnRejectedNotice: refuse, sendOrderConfirmation: refuse,
    sendOrderPaidConfirmation: refuse, sendPaymentFailedNotice: refuse, sendOrderCanceledNotice: refuse,
    sendOrderRefundedNotice: refuse, sendShipmentDispatchedNotice: refuse, sendShipmentDeliveredNotice: refuse,
    sendShipmentExceptionNotice: refuse,
  };
  const runtime: Pick<CommerceEmailRuntime<Locale>, 'resolveLocale' | 'formatMoney' | 'parseOutboxPayload' | 'mapSendOutcome'> = {
    resolveLocale: locale, formatMoney: (amount, currency) => `${currency} ${amount}`,
    parseOutboxPayload: (schema, payload) => { const parsed = schema.safeParse(payload); return parsed.success
      ? { ok: true, data: parsed.data } : { ok: false, outcome: { kind: 'discard', reason: 'invalid_payload' } }; },
    mapSendOutcome: outcome => outcome.ok ? { kind: 'processed' } : { kind: 'retry', reason: 'checkout_capture_failed' },
  };
  const automatic = createOutboxCheckoutRecoveryEmailHandler({ runtime,
    emailPort: withCheckoutRecoverySendEvidence(email, waves), recipientPort: recipients, lifecyclePort: lifecycle });
  const operator = createOutboxCheckoutRecoveryEmailHandler({ runtime, emailPort: email, recipientPort: recipients, lifecyclePort: lifecycle });
  const expiredHandler = createOutboxCheckoutExpiredEmailHandler({ runtime, emailPort: email, recipientPort: recipients, lifecyclePort: lifecycle });
  const registry = uniqueRegistry([
    { ...automatic, async handle(row, signal) {
      const operatorIssued = row.metadata.source === 'admin_payment_link';
      const buyerRequested = row.metadata.source === 'buyer_payment_link';
      const gate = buyerRequested ? await createPostgresBuyerCheckoutLinkPort(executor,{ lifetimeMs: sandboxRecoveryPolicy.buyerLifetimeMs, sendBucketMs: sandboxRecoveryPolicy.buyerSendBucketMs }).authorize(row.id,String(row.metadata.claimToken))
        : operatorIssued ? await createPostgresOperatorCheckoutLinkStore(executor).authorize(row.id, String(row.metadata.claimToken))
        : await waves.authorize(row.id, String(row.metadata.claimToken));
      if (!gate.authorized) return gate.reason === 'checkout_recovery_no_longer_allowed'
        ? { kind: 'retry' as const, reason: gate.reason }
        : { kind: 'processed' as const, detail: { skipped: gate.reason ?? 'not_authorized' } };
      // Reclaimed automatic mail must restore confirmed evidence even when the private send already exists.
      if (!operatorIssued && !buyerRequested && await capture.read(key(row.id))) await waves.recordConfirmedSend(row.id, key(row.id));
      return (operatorIssued || buyerRequested ? operator : automatic).handle(row, signal);
    } }, expiredHandler,
  ]);
  const delivered = await runOutboxDispatchWorker({ store: createPostgresOutboxStore(executor), registry,
    knownEventTypes: PLATFORM_EVENT_VOCABULARY.map(entry => entry.eventType),
    config: { ...readOutboxDispatchConfig({}), batchSize: schedule.batchSize, softBudgetMs: schedule.softBudgetMs }, logger: { warn: () => {}, error: () => {} } });
  return { enqueued, expired, initial, reconciled, delivered };
}
