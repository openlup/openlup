import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPostgresRetryStore } from '@openlup/platform/subscriptions';
import type { ApplicationBindings, ActionContext } from './bindings.ts';
import { isUuid, sameUuid } from './recurring-fence.ts';

const refused = (code = 'starter_recovery_unavailable') => ({ ok: false as const, code });
const success = (state: string) => ({ ok: true as const, value: { state } });
export const isRecoveryToken = (value: unknown): value is string => typeof value === 'string'
  && /^(?:rcv_)?[A-Za-z0-9_-]{43}$/.test(value);

/** Positive ownership chain. Neither URL shape nor order mode establishes it. */
async function readOwned(db: PoolClient, tokenHash: string, context: ActionContext) {
  return (await db.query(`SELECT token.id AS token_id, orders.id AS order_id, cases.id AS case_id,
      obligation.id AS obligation_id, operation.id AS operation_id, subscription.id AS subscription_id,
      subscription.status AS subscription_status, cases.status AS case_status, obligation.state,
      orders.status AS order_status, intent.status AS intent_status, obligation.next_retry_at,
      token.revoked_at IS NULL AND token.expires_at>now() AS active_token,
      method.health_state,method.method_ref,method.evidence_ref,
      terms.settlement_channel_key,terms.authorization_ref,terms.unattended_charge_authorized_at,
      grant_row.id AS authorization_id,grant_row.consumed_at,
      to_char(grant_row.authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS authorized_at,
      receipt.id IS NOT NULL AS scheduled,
      to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_now
    FROM public.commerce_checkout_recovery_tokens token
    JOIN public.commerce_orders orders ON orders.id=token.order_id AND orders.client_id=token.client_id
    JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
    JOIN public.subscription_renewal_operations operation ON operation.id=cycle.renewal_operation_id
    JOIN public.subscriptions subscription ON subscription.id=cycle.subscription_id
      AND subscription.id=operation.subscription_id AND subscription.client_id=token.client_id
    JOIN public.clients client ON client.id=subscription.client_id
    JOIN public.subscription_retry_obligations obligation ON obligation.renewal_operation_id=operation.id
      AND obligation.cycle_id=cycle.id AND obligation.order_id=orders.id AND obligation.subscription_id=subscription.id
    JOIN public.subscription_dunning_cases cases ON cases.id=obligation.case_id
      AND cases.cycle_id=cycle.id AND cases.subscription_id=subscription.id AND cases.client_id=token.client_id
    JOIN public.commerce_settlement_intents intent ON intent.id=obligation.settlement_intent_id
      AND intent.order_id=orders.id AND intent.renewal_operation_id=operation.id
    LEFT JOIN public.subscription_method_states method ON method.subscription_id=subscription.id
    LEFT JOIN public.subscription_renewal_terms terms ON terms.subscription_id=subscription.id
    LEFT JOIN public.subscription_retry_recovery_authorizations grant_row ON grant_row.obligation_id=obligation.id
      AND grant_row.token_id=token.id AND grant_row.retry_attempt=obligation.retry_attempt
    LEFT JOIN public.subscription_retry_receipts receipt ON receipt.obligation_id=obligation.id
      AND receipt.kind='schedule' AND receipt.receipt_key='starter-recovery:'||grant_row.id::text
      AND receipt.input->>'authorizationId'=grant_row.id::text
    WHERE token.token_hash=$1 AND token.client_id=$2::uuid AND client.principal_id=$3::uuid`,
  [tokenHash, context.actor.customerRef, context.actor.principalRef])).rows[0] ?? null;
}

/** This route authorizes/schedules only. The native retry driver owns execution. */
export function composeAuthenticatedRecovery(pool: Pool): ApplicationBindings['actions'] {
  return {
    'payment.recover': async (payload, context) => {
      if (!context.actor.customerRef || !context.actor.principalRef) return refused('customer_session_required');
      if (Object.keys(payload).some(key => !['locale', 'token', 'action', 'orderRef', 'caseRef', 'operationRef'].includes(key))
        || !isRecoveryToken(payload.token) || !['read', 'authorize'].includes(String(payload.action ?? 'authorize'))
        || ['orderRef', 'caseRef', 'operationRef'].some(key => payload[key] !== undefined && !isUuid(payload[key]))) return refused();
      const hash = createHash('sha256').update(payload.token).digest('hex');
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        let row = await readOwned(db, hash, context);
        if (!row) return refused();
        // Same owner order as the native recovery lane; re-read after all locks.
        await db.query('SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE', [row.subscription_id]);
        await db.query('SELECT id FROM public.subscription_retry_obligations WHERE id=$1 FOR UPDATE', [row.obligation_id]);
        await db.query('SELECT id FROM public.subscription_dunning_cases WHERE id=$1 FOR UPDATE', [row.case_id]);
        await db.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [row.order_id]);
        await db.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE id=$1 FOR UPDATE', [row.token_id]);
        row = await readOwned(db, hash, context);
        if (!row || (payload.orderRef !== undefined && !sameUuid(payload.orderRef, row.order_id))
          || (payload.caseRef !== undefined && !sameUuid(payload.caseRef, row.case_id))
          || (payload.operationRef !== undefined && !sameUuid(payload.operationRef, row.operation_id))) return refused();
        // Only an owned durable schedule receipt may reconcile a consumed token.
        if (row.authorization_id && row.scheduled) {
          const state = row.state === 'recovered' && row.case_status === 'recovered'
            && ['paid', 'fulfillment_pending'].includes(row.order_status) && row.intent_status === 'settled'
            ? 'recovered' : row.state === 'prepared' ? 'awaiting_confirmation' : 'authorized_retry';
          await db.query('COMMIT');
          return success(state);
        }
        if (row.active_token !== true || row.subscription_status !== 'active' || row.case_status !== 'open'
          || row.state !== 'waiting' || row.order_status !== 'pending_payment' || row.intent_status !== 'failed') return refused();
        if (row.health_state !== 'healthy' || !row.method_ref || !row.evidence_ref
          || row.settlement_channel_key !== 'sandbox' || !row.authorization_ref || !row.unattended_charge_authorized_at) {
          return success('method_unavailable');
        }
        if (payload.action === 'read') return success(row.next_retry_at === null ? 'exhausted' : 'awaiting_confirmation');
        const store = createPostgresRetryStore(db);
        const authorization = await store.authorizeRecovery(row.operation_id, row.token_id, row.method_ref, row.evidence_ref, row.server_now);
        if (!isUuid(authorization.id) || !sameUuid(authorization.token_id, row.token_id)
          || !sameUuid(authorization.obligation_id, row.obligation_id)) return refused();
        const authorized = await readOwned(db, hash, context);
        if (!authorized?.authorized_at) return refused();
        const scheduled = await store.scheduleRecovery(row.operation_id, `starter-recovery:${authorization.id}`,
          authorization.id, authorized.authorized_at);
        if (scheduled.scheduled !== true || !sameUuid(scheduled.obligationId, row.obligation_id)) return refused();
        const committed = await readOwned(db, hash, context);
        if (committed?.scheduled !== true) return refused();
        await db.query('COMMIT');
        return success('authorized_retry');
      } catch { return refused(); }
      finally { await db.query('ROLLBACK').catch(() => {}); db.release(); }
    },
  };
}
