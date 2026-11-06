import { customerCauseForFailureClass } from '@openlup/core/payment';
import { createHash } from 'node:crypto';
import { generateCheckoutRecoveryToken } from '@openlup/platform/commerce/server';
import { createTransactionalDelivery, TransactionalDeliveryConflictError } from '@openlup/platform/communications';
import type { NativeLifecycleNotice } from '@openlup/platform/subscriptions';
import type { TransactionalDeliveryCommand, TransactionalDeliveryReceiptStore } from '@openlup/platform/communications/contracts';
import type { PrivateCapture } from './private-capture.ts';
import { createNoticeArtifacts, isNoticeKind, type NoticeArtifactV1 } from './notice-artifact.ts';
import { assertRenewalConfig } from '../shared/renewal-config.ts';
import type { StoreConfig } from '../shared/config.ts';
import { routes } from '../shared/routes.ts';

interface Executor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
const fail = (): never => { throw new Error('starter_notice_identity_unavailable'); };
const sameId = (left: string | null, right: string | null) => left === null || right === null
  ? left === right : left.replace(/[{}-]/g, '').toLowerCase() === right.replace(/[{}-]/g, '').toLowerCase();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/** One native binding owns each fact. No outbox delivery handler is mounted alongside it. */
export function createLifecycleNoticeHost(input: {
  config: StoreConfig; publicOrigin: string;
  withTransaction<T>(work: (db: Executor) => Promise<T>): Promise<T>;
  capture: PrivateCapture; receipts: TransactionalDeliveryReceiptStore;
}) {
  const { config } = input;
  const capture = createNoticeArtifacts(input.capture);
  assertRenewalConfig(config.renewal);
  const origin = new URL(input.publicOrigin);
  if (origin.origin !== input.publicOrigin || origin.username || origin.password) throw new Error('starter_notice_origin_invalid');

  async function authority(db: Executor, notice: NativeLifecycleNotice) {
    await db.query(`SELECT s.id FROM public.subscriptions s JOIN public.subscription_dunning_notifications n
      ON n.subscription_id=s.id WHERE n.id=$1::uuid FOR UPDATE OF s`, [notice.id]);
    await db.query(`SELECT obligation.id FROM public.subscription_retry_obligations obligation
      JOIN public.subscription_dunning_notifications n ON n.case_id=obligation.case_id
      WHERE n.id=$1::uuid FOR UPDATE OF obligation`, [notice.id]);
    await db.query(`SELECT c.id FROM public.subscription_dunning_cases c JOIN public.subscription_dunning_notifications n
      ON n.case_id=c.id WHERE n.id=$1::uuid FOR UPDATE OF c`, [notice.id]);
    const row = (await db.query(`SELECT n.id,n.case_id,n.subscription_id,n.recipient_ref,n.notification_kind,n.attempt_count,
      c.status AS case_status,s.status AS subscription_status,obligation.id AS obligation_id,
      obligation.renewal_operation_id AS operation_id,obligation.order_id,
      n.recovery_url_path,n.payload,obligation.state AS obligation_state,
      to_char((CASE WHEN n.notification_kind='payment_expired'
        THEN n.created_at+make_interval(secs=>$4::integer)
        ELSE COALESCE((n.payload->>'nextRetryAt')::timestamptz,n.created_at)+make_interval(secs=>$5::integer) END)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
      FROM public.subscription_dunning_notifications n
      JOIN public.subscription_dunning_cases c ON c.id=n.case_id
      JOIN public.subscriptions s ON s.id=n.subscription_id AND s.client_id=n.recipient_ref AND c.client_id=s.client_id
      JOIN public.subscription_retry_obligations obligation ON obligation.case_id=c.id
        AND obligation.subscription_id=s.id AND obligation.cycle_id=c.cycle_id
      JOIN public.subscription_renewal_operations operation ON operation.id=obligation.renewal_operation_id
        AND operation.subscription_id=s.id
      JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=operation.id
        AND intent.id=obligation.settlement_intent_id AND intent.order_id=obligation.order_id
      JOIN public.commerce_orders o ON o.id=obligation.order_id AND o.client_id=s.client_id
        AND o.subscription_cycle_id=c.cycle_id AND o.status='pending_payment'
      WHERE n.id=$1::uuid AND s.id=$2::uuid AND s.client_id=$3::uuid
        AND n.status='sending' AND n.lease_expires_at>clock_timestamp()
      FOR UPDATE OF o`, [notice.id, notice.subscriptionId, notice.clientId,
    config.renewal.recovery.exhaustedTtlSeconds, config.renewal.recovery.activeGraceSeconds])).rows[0];
    if (!row || row.subscription_status !== 'active' || !['open', 'expired'].includes(String(row.case_status))
      || row.obligation_state === 'recovered' || row.notification_kind !== notice.kind) return fail();
    return row;
  }
  async function readToken(db: Executor, record: NoticeArtifactV1) {
    if (!record.token || !record.orderId || !record.expiresAt) return fail();
    const rows = (await db.query(`SELECT token.id FROM public.commerce_checkout_recovery_tokens token
      JOIN public.commerce_orders o ON o.id=token.order_id AND o.client_id=token.client_id AND o.status='pending_payment'
      JOIN public.subscription_retry_obligations obligation ON obligation.order_id=o.id
        AND obligation.case_id=$5::uuid AND obligation.renewal_operation_id=$6::uuid AND obligation.state<>'recovered'
      JOIN public.subscriptions s ON s.id=obligation.subscription_id AND s.id=$7::uuid
        AND s.client_id=token.client_id AND s.status='active'
      JOIN public.subscription_dunning_cases c ON c.id=obligation.case_id AND c.subscription_id=s.id
        AND c.client_id=token.client_id AND c.cycle_id=o.subscription_cycle_id AND c.status IN('open','expired')
      WHERE token.token_hash=$1 AND token.order_id=$2::uuid AND token.client_id=$3::uuid
        AND token.expires_at=$4::timestamptz AND token.expires_at>clock_timestamp() AND token.revoked_at IS NULL`,
    [hash(record.token), record.orderId, record.clientId, record.expiresAt, record.caseId, record.operationId, record.subscriptionId])).rows;
    if (rows.length !== 1) return fail();
    return String(rows[0]!.id);
  }
  async function bind(notice: NativeLifecycleNotice, recipient: { email: string; firstName: string | null; country: string | null }) {
    if (!isNoticeKind(notice.kind)) return fail();
    const kind = notice.kind;
    return input.withTransaction(async db => {
      const owner = (await db.query('SELECT status FROM public.subscriptions WHERE id=$1::uuid AND client_id=$2::uuid',
        [notice.subscriptionId, notice.clientId])).rows[0];
      if (!owner) return fail();
      const existing = await capture.read(notice.messageKey);
      if (existing === null) {
        if (await input.receipts.readReceipt(notice.messageKey)) return fail();
        if (notice.source === 'dunning') {
          const claim = (await db.query(`SELECT attempt_count FROM public.subscription_dunning_notifications
            WHERE id=$1::uuid AND status='sending' AND lease_expires_at>clock_timestamp()`, [notice.id])).rows[0];
          if (Number(claim?.attempt_count) !== 1) return fail();
        }
      }
      let record = existing;
      const needsToken = notice.source === 'dunning' && ['payment_failed', 'payment_expired', 'payment_recovery'].includes(notice.kind);
      const current = needsToken ? await authority(db, notice) : null;
      if (record && (record.kind !== kind || !sameId(record.noticeId, notice.id) || !sameId(record.subscriptionId, notice.subscriptionId)
        || !sameId(record.clientId, notice.clientId) || record.recipient !== recipient.email
        || !sameId(record.caseId, current ? String(current.case_id) : null)
        || !sameId(record.operationId, current ? String(current.operation_id) : null)
        || !sameId(record.orderId, current ? String(current.order_id) : null)
        || !sameId(record.obligationId, current ? String(current.obligation_id) : null))) return fail();
      if (!record) {
        // A reclaimed command cannot regenerate missing private bearer material.
        if (needsToken && Number(current?.attempt_count) !== 1) return fail();
        let token: string | null = null, expiresAt: string | null = null;
        if (needsToken) {
          if (notice.kind === 'payment_recovery') {
            const path = new URL(String(current?.recovery_url_path), input.publicOrigin);
            token = path.searchParams.get('token');
            if (!token || !/^(?:rcv_)?[A-Za-z0-9_-]{43}$/.test(token)) return fail();
            const issued = (await db.query(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
              FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1 AND order_id=$2::uuid
                AND client_id=$3::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
            [hash(token), current?.order_id, notice.clientId])).rows[0];
            if (!issued) return fail();
            expiresAt = String(issued.expires_at);
          } else { token = generateCheckoutRecoveryToken(); expiresAt = String(current?.expires_at); }
        }
        const locale = (recipient.country ? config.renewal.notices.countryLocales?.[recipient.country.toUpperCase()] : undefined)
          ?? config.renewal.notices.locale, copy = config.renewal.notices.copy[locale];
        const subject = notice.kind in copy ? copy[notice.kind as keyof typeof copy] : copy.lifecycle;
        const payload = notice.payload;
        const amount = Number.isSafeInteger(payload.amountMinor) && typeof payload.currency === 'string'
          ? `${String(payload.amountMinor)} ${payload.currency} (${copy.minorUnits})` : copy.unknown;
        const url = token ? new URL(routes.repair[locale], input.publicOrigin) : null;
        if (url && token) url.searchParams.set('token', token);
        const lines = [subject, `${copy.amount}: ${amount}`];
        if (['payment_failed', 'payment_expired', 'payment_recovery'].includes(notice.kind)) {
          const cause = customerCauseForFailureClass(typeof payload.failureClass === 'string' ? payload.failureClass : null);
          const descriptions = { needs_confirmation: copy.needsConfirmation, method_cannot_recur: copy.cannotRecur,
            method_dead: copy.methodDead, method_data_invalid: copy.methodDataInvalid, method_missing: copy.methodMissing, unknown: copy.unknown };
          lines.push(`${copy.cause}: ${descriptions[cause]}`);
        }
        if (notice.kind.startsWith('payment_') && owner.status === 'active') lines.push(copy.active);
        else lines.push(`${copy.status}: ${String(owner.status)}`);
        if (typeof payload.nextRetryAt === 'string') lines.push(`${copy.retry}: ${new Intl.DateTimeFormat(locale, {
          timeZone: config.market.timezone, dateStyle: 'long' }).format(new Date(payload.nextRetryAt))}`);
        if (notice.kind === 'subscription.address_changed') lines.push(payload.outcome === 'applied' ? copy.addressApplied
          : payload.outcome === 'applied_from_next_parcel' ? copy.addressNextParcel : copy.address);
        if (url) lines.push(`${copy.repair}: ${url.href}`, `${copy.expires}: ${expiresAt}`);
        record = { schemaVersion: 1, kind, messageKey: notice.messageKey, noticeId: notice.id,
          subscriptionId: notice.subscriptionId, clientId: notice.clientId,
          caseId: current ? String(current.case_id) : null, operationId: current ? String(current.operation_id) : null,
          orderId: current ? String(current.order_id) : null,
          obligationId: current ? String(current.obligation_id) : null, token, recoveryUrl: url?.href ?? null, expiresAt, recipient: recipient.email,
          recipientReference: `client:${notice.clientId}`, templateReference: `template:${notice.templateSlug}:${locale}`,
          locale, subject, body: lines.join('\n') };
        await capture.writeOnce(notice.messageKey, record);
        const committed = await capture.read(notice.messageKey);
        if (!committed) return fail();
        if (Object.keys(record).some(key => committed[key as keyof NoticeArtifactV1] !== record![key as keyof NoticeArtifactV1])) return fail();
      }
      let tokenId: string | undefined;
      if (needsToken) {
        // Read first: reissuing even the SAME hash would revoke its own token.
        const prior = (await db.query(`SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1`, [hash(record.token!)])).rows;
        if (!prior.length) {
          if (existing !== null || notice.kind === 'payment_recovery' || Number(current?.attempt_count) !== 1) return fail();
          await db.query('SELECT public.dunning_lifecycle_issue_recovery_token($1::uuid,$2,$3::timestamptz)',
            [record.caseId, hash(record.token!), record.expiresAt]);
        }
        tokenId = await readToken(db, record);
      }
      return { recipientReference: record.recipientReference, templateReference: record.templateReference,
        ...(tokenId ? { accessGrantReference: `token:${tokenId}` } : {}) };
    });
  }
  const engine = createTransactionalDelivery({ store: input.receipts, delivery: {
    async deliver(command: TransactionalDeliveryCommand) {
      const record = await capture.read(command.idempotencyKey);
      if (!record) return fail();
      if (record.recipientReference !== command.recipientReference || record.templateReference !== command.templateReference) return fail();
      if (record.token) {
        const tokenId = await input.withTransaction(db => readToken(db, record));
        if (command.accessGrantReference !== `token:${tokenId}`) return fail();
      } else if (command.accessGrantReference !== undefined) return fail();
      return { deliveryReference: `captured-notice:${hash(command.idempotencyKey)}` };
    },
  } });
  return { bind, delivery: { async send(command: TransactionalDeliveryCommand) {
    if (!await capture.read(command.idempotencyKey)) return fail();
    try { return await engine.send(command); }
    catch (error) {
      if (error instanceof TransactionalDeliveryConflictError) return { state: 'failed' as const, deliveryReference: null, retryable: false };
      throw error;
    }
  }, async readReceipt(key: string) {
    const receipt = await input.receipts.readReceipt(key);
    if (receipt?.state === 'accepted' && !await capture.read(key)) return fail();
    return receipt;
  } } };
}
