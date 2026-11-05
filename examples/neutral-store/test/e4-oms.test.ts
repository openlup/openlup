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

for (const operation of ['operator.shipments', 'operator.shipment'] as const) {
  test(`${operation} refuses foreign authority and invalid selectors before connecting`, async () => {
    const pool = { connect() { throw new Error('shipment_query_before_admission'); } } as unknown as Pool;
    const input = operation === 'operator.shipment' ? { shipmentRef: 'wrong-object' } : { pageSize: 101 };
    assert.deepEqual(await composeE4Capabilities(pool, async () => false)[operation]!(input, context),
      { ok: false, code: 'operator_required' });
    assert.deepEqual(await composeE4Capabilities(pool, async () => true)[operation]!(input, context),
      { ok: false, code: 'starter_input_invalid' });
    assert.deepEqual(await composeE4Capabilities(pool, async () => true)[operation]!(
      { ...(operation === 'operator.shipment' ? { shipmentRef: 'abcdefab-cdef-4abc-8def-abcdefabcdef' } : {}),
        operatorRef: 'forged' }, context), { ok: false, code: 'starter_input_invalid' });
    if (operation === 'operator.shipment') {
      assert.deepEqual(await composeE4Capabilities(pool, async () => true)[operation]!({ documentRef: 'forged' }, context),
        { ok: false, code: 'starter_input_invalid' });
    }
  });
}

test('shipment list and missing detail use one read-only snapshot and release it', async () => {
  const calls: string[] = [];
  const pool = { async connect() { return {
    async query(sql: string) {
      calls.push(sql);
      return { rows: sql.startsWith('WITH selected') ? [{ total: 0, shipments: null }] : [] };
    }, release() { calls.push('release'); },
  }; } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => true);
  assert.deepEqual(await actions['operator.shipments']!({}, context), { ok: true,
    value: { contractVersion: 'commerce.fulfillment.v0', orders: [], totalCount: 0, page: 1, pageSize: 25 } });
  assert.deepEqual(await actions['operator.shipment']!({ shipmentRef: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' }, context),
    { ok: false, code: 'starter_shipment_not_found' });
  assert.equal(calls.filter(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 2);
  assert.equal(calls.filter(sql => sql === 'COMMIT').length, 2);
  assert.equal(calls.filter(sql => sql === 'ROLLBACK').length, 2);
  assert.equal(calls.filter(sql => sql === 'release').length, 2);
});
