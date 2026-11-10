import type { Pool } from 'pg';
import { createPostgresCommerceOmsPort, createPostgresCommerceOmsControlPlane } from '@openlup/platform/commerce/server/postgres';
import { CommerceOmsConflictError } from '@openlup/platform/commerce';
import { isUuid } from './recurring-fence.ts';
import type { ActionContext, ApplicationBindings, ActionBinding } from './bindings.ts';

/** Human admission and Commerce resolution are repeated before every native invocation, including replay. */
export function composeOrderHolds(pool: Pool, authorize: (context: ActionContext) => Promise<boolean>): ApplicationBindings['actions'] {
  const action = (release: boolean): ActionBinding => async (payload, context) => {
    if (!context.actor.operatorRef || !await authorize(context)) return { ok: false, code: 'operator_required' };
    const target = release ? payload.holdRef : payload.orderRef;
    if (Object.keys(payload).some(key => !['locale', release ? 'holdRef' : 'orderRef', ...(release ? [] : ['reason']), 'note'].includes(key))
      || !isUuid(target) || (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.length > 1000))
      || (!release && !context.config.orderControls.holdReasons.some(choice => choice.code === payload.reason))) return { ok: false, code: 'starter_input_invalid' };
    const actor = await createPostgresCommerceOmsControlPlane(pool).resolveOperator(context.actor.operatorRef);
    if (!actor) return { ok: false, code: 'operator_required' };
    const common = { actorUserId: actor, idempotencyKey: context.commandKey, note: payload.note as string | undefined };
    try {
      const port = createPostgresCommerceOmsPort(pool);
      const value = release ? await port.releaseHold({ ...common, holdId: target.toLowerCase() })
        : await port.createHold({ ...common, orderId: target.toLowerCase(), reason: payload.reason as Parameters<typeof port.createHold>[0]['reason'] });
      return { ok: true, value, replayed: value.replayed };
    } catch (error) {
      if (error instanceof CommerceOmsConflictError) return { ok: false, code: 'starter_order_hold_conflict' };
      throw error;
    }
  };
  return { 'operator.hold': action(false), 'operator.release': action(true) };
}
