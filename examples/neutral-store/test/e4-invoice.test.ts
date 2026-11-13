import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { composeE4Capabilities } from '../host/e4-composition.ts';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
import type { ActionContext } from '../host/bindings.ts';

const principal = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const orderRef = 'fedcbafe-dcba-0fed-0cba-fedcbafedcba';
const context: ActionContext = { commandKey: 'invoice-command-123456',
  actor: { customerRef: 'client', operatorRef: null, principalRef: principal.toUpperCase() },
  config: Object.values(configurations)[0]! };

test('customer history uses only the native session principal and preserves uppercase selectors', async () => {
  const calls: unknown[][] = [];
  const buyer = { name: 'Frozen Example Buyer', address: { line2: 'Unit 2' }, source: 'customer_orderer_profile' };
  const pool = { async query(_sql: string, values: unknown[]) {
    calls.push(values);
    return { rows: [_sql.includes('customer_billing_buyer_read') ? { value: buyer } : { documents: [] }] };
  } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => false);
  assert.deepEqual(await actions['account.invoice']!({ orderRef: orderRef.toUpperCase(), accountRef: 'forged',
    principalRef: 'forged', actorUserId: 'forged', receipt: { ok: true } }, context),
  { ok: true, value: { kind: 'found', accountRef: principal.toUpperCase(), orderId: orderRef.toUpperCase(), documents: [], buyerSnapshot: buyer } });
  assert.deepEqual(calls, [[principal.toUpperCase(), orderRef.toUpperCase()], [orderRef.toUpperCase()]]);
});

test('foreign and mismatched documents refuse before artifact reads', async () => {
  let queries = 0;
  const pool = { async query(sql: string) {
    assert.ok(sql.includes('JOIN public.clients'));
    queries++;
    return { rows: queries === 1 ? [] : [{ documents: [] }] };
  } } as unknown as Pool;
  const action = composeE4Capabilities(pool, async () => false)['account.invoice']!;
  const input = { orderRef, documentRef: principal };
  assert.deepEqual(await action(input, context), { ok: false, code: 'starter_invoice_denied' });
  assert.deepEqual(await action(input, context), { ok: false, code: 'starter_invoice_denied' });
  assert.equal(queries, 2);
});

test('operator authorization runs before acquiring a connection or reading any order', async () => {
  const pool = { connect() { throw new Error('query_before_authorization'); } } as unknown as Pool;
  const action = composeE4Capabilities(pool, async () => false)['operator.invoice']!;
  assert.deepEqual(await action({ orderRef, operatorRef: principal }, context), { ok: false, code: 'operator_required' });
  assert.deepEqual(await action({ orderRef, accountRef: principal }, { ...context,
    actor: { customerRef: null, operatorRef: principal, sessionToken: 'revoked' } }), { ok: false, code: 'operator_required' });
});

for (const original of Object.values(configurations)) test(`${original.id} owns document and form values`, () => {
  const config = structuredClone(original);
  config.documents.sandbox = { enabled: false, providerRef: 'another-captured-provider' };
  config.returns.reasons = [{ code: 'local_reason', label: { en: 'Local reason', pl: 'Własny powód' } }];
  config.orderControls.holdReasons = [{ code: 'manual_support', label: { en: 'Local hold', pl: 'Własna blokada' } }];
  assert.doesNotThrow(() => assertConfig(config));
  config.documents.sandbox.providerRef = '';
  assert.throws(() => assertConfig(config), /starter_order_controls_configuration_invalid/);
});
