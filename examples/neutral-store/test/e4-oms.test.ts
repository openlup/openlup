import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { composeE4Capabilities } from '../host/e4-composition.ts';
import { configurations } from '../owned/store.config.ts';
import { dispatchAction, type ActionContext } from '../host/bindings.ts';

const context: ActionContext = { actor: { customerRef: null, operatorRef: 'verified-operator' },
  commandKey: 'hold-command-123456', config: Object.values(configurations)[0]! };

test('hold and release remain unmounted and refuse after operator admission without I/O', async () => {
  const pool = { connect() { throw new Error('deferred_connection_touched'); } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => { throw new Error('deferred_authorizer_touched'); });
  const bindings = { actions, authenticate: async () => context.actor, close: async () => {} };
  for (const operation of ['operator.hold', 'operator.release'] as const) {
    assert.equal(actions[operation], undefined);
    assert.deepEqual(await dispatchAction(bindings, operation, { orderRef: 'forged', holdRef: 'forged' }, context),
      { ok: false, code: 'starter_order_hold_unavailable' });
    assert.deepEqual(await dispatchAction(bindings, operation, {},
      { ...context, actor: { customerRef: null, operatorRef: null } }), { ok: false, code: 'operator_required' });
  }
});
