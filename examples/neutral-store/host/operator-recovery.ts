import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createOperatorRecovery, createPostgresOperatorAuthority } from '@openlup/platform/account-support';
import type { ApplicationBindings } from './bindings.ts';
import { createPrivateCapture } from './private-capture.ts';
import { createNoticeArtifacts, type NoticeArtifactV1 } from './notice-artifact.ts';
import { isUuid, sameUuid } from './recurring-fence.ts';
import { routes } from '../shared/routes.ts';
import { demoRecoveryConfiguration } from '../shared/recovery-config.ts';
import { isRecoveryToken } from './authenticated-recovery.ts';

const refused = () => ({ ok: false as const, code: 'starter_recovery_unavailable' });

/** Native human authority revalidates the seat even on a command replay. */
export function composeOperatorRecovery(pool: Pool): ApplicationBindings['actions'] {
  return {
    'operator.recovery': async (payload, context) => {
      const actor = context.actor.operatorRef;
      if (!actor || !context.actor.requestOrigin) return refused();
      if (Object.keys(payload).some(key => !['locale', 'customerRef', 'caseRef'].includes(key))
        || !isUuid(payload.customerRef) || !isUuid(payload.caseRef)
        || !['en', 'pl'].includes(String(payload.locale))) return refused();
      const language = payload.locale as 'en' | 'pl';
      const customerId = payload.customerRef.toLowerCase(), caseId = payload.caseRef.toLowerCase();
      const commandKey = 'starter-operator-recovery:' + createHash('sha256')
        .update(JSON.stringify([actor.toLowerCase(), context.commandKey])).digest('hex');
      // The native private URL carries the opaque command correlation, never a
      // second bearer index. It lets the original receipt find its exact notice.
      const marker = createHash('sha256').update(commandKey).digest('hex');
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('customer-support-recovery:'||$1,0))", [commandKey]);
        const prior = (await db.query('SELECT response FROM public.customer_recovery_commands WHERE idempotency_key=$1', [commandKey])).rows[0];
        const findNotice = async () => (await db.query(`SELECT notice.id,notice.recovery_url_path,notice.attempt_count,notice.status
          FROM public.subscription_dunning_notifications notice
          WHERE notice.case_id=$1::uuid AND notice.notification_kind='payment_recovery'
            AND right(notice.recovery_url_path,length($2::text))=$2::text`, [caseId, '&recovery=' + marker])).rows;
        const existing = prior ? await findNotice() : [];
        if (prior && prior.response?.outcome !== 'refused' && existing.length !== 1) return refused();
        let raw: string | undefined;
        if (existing[0]) raw = new URL(existing[0].recovery_url_path, context.actor.requestOrigin).searchParams.get('token') ?? undefined;
        if (raw !== undefined && !isRecoveryToken(raw)) return refused();
        const authority = createPostgresOperatorAuthority({ run: work => work(db) }, {
          operatorId: actor, now: () => Date.now(),
          ...(raw ? { createOpaqueToken: () => raw! } : {}),
          recoveryPath: token => {
            const url = new URL(routes.repair[language], context.actor.requestOrigin);
            url.searchParams.set('token', token); url.searchParams.set('recovery', marker);
            return url.pathname + url.search;
          },
        });
        const result = await createOperatorRecovery({ graph: 'native', authority }).execute({
          actor: { graph: 'native', operatorId: actor, role: 'admin', isMachineActor: false },
          subject: { subjectId: customerId }, idempotencyKey: commandKey,
          reason: null, expectedVersion: null, evidence: [],
          command: { action: 'issue_recovery', subjectId: customerId, caseId, idempotencyKey: commandKey },
        });
        if ('outcome' in result && result.outcome === 'refused') { await db.query('COMMIT'); return refused(); }
        if (!('outcome' in result) || !['issued', 'replayed'].includes(result.outcome)) return refused();
        const notices = await findNotice();
        if (notices.length !== 1) return refused();
        const notice = notices[0]!;
        const url = new URL(notice.recovery_url_path, context.actor.requestOrigin);
        raw = url.searchParams.get('token') ?? undefined;
        if (!isRecoveryToken(raw) || url.origin !== context.actor.requestOrigin || url.pathname !== routes.repair[language]) return refused();
        const row = (await db.query(`SELECT token.id AS token_id,orders.id AS order_id,client.id AS client_id,client.email,
            obligation.id AS obligation_id,obligation.subscription_id,operation.id AS operation_id,cases.id AS case_id,
            to_char(token.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
          FROM public.commerce_checkout_recovery_tokens token
          JOIN public.commerce_orders orders ON orders.id=token.order_id AND orders.client_id=token.client_id
          JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
          JOIN public.subscription_renewal_operations operation ON operation.id=cycle.renewal_operation_id
          JOIN public.subscription_retry_obligations obligation ON obligation.renewal_operation_id=operation.id
            AND obligation.order_id=orders.id AND obligation.cycle_id=cycle.id
          JOIN public.subscription_dunning_cases cases ON cases.id=obligation.case_id AND cases.cycle_id=cycle.id
            AND cases.client_id=token.client_id AND cases.subscription_id=obligation.subscription_id
          JOIN public.clients client ON client.id=token.client_id
          WHERE token.token_hash=$1 AND token.client_id=$2::uuid AND cases.id=$3::uuid
            AND token.revoked_at IS NULL AND token.expires_at>now() AND cases.status='open'
            AND obligation.state='waiting' AND orders.status='pending_payment'`,
        [createHash('sha256').update(raw).digest('hex'), customerId, caseId])).rows[0];
        if (!row || !sameUuid(row.client_id, payload.customerRef)) return refused();
        const key = `subscription-notice:dunning:${notice.id}`;
        const capture = createNoticeArtifacts(createPrivateCapture());
        const priorArtifact = await capture.read(key);
        if (prior && !priorArtifact) return refused();
        const copy = context.config.recovery ?? demoRecoveryConfiguration;
        const record: NoticeArtifactV1 = { schemaVersion: 1, kind: 'payment_recovery', messageKey: key, locale: language,
          noticeId: notice.id, subscriptionId: row.subscription_id, recipient: row.email, subject: copy.message.subject[language],
          body: [copy.message.body[language], url.href, `${copy.message.expiryLabel[language]} ${row.expires_at}`].join('\n'),
          recoveryUrl: url.href, token: raw, expiresAt: row.expires_at,
          clientId: row.client_id, orderId: row.order_id, caseId: row.case_id,
          operationId: row.operation_id, obligationId: row.obligation_id,
          recipientReference: `client:${row.client_id}`, templateReference: `template:subscription-payment-recovery:${language}` };
        await capture.writeOnce(key, record);
        if (!await capture.read(key)) return refused();
        await db.query('COMMIT');
        // Captured material stays private. Queue delivery and payment are later facts.
        return { ok: true as const, value: { state: 'queued' }, replayed: result.outcome === 'replayed' };
      } catch { return refused(); }
      finally { await db.query('ROLLBACK').catch(() => {}); db.release(); }
    },
  };
}
