import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import type { StoreConfig } from '../shared/config.ts';
import { dispatchAction, pendingBindings, type ActionContext } from '../host/bindings.ts';

const context: ActionContext = {
  commandKey: 'test-command-123456', actor: { customerRef: null, operatorRef: null }, config: Object.values(configurations)[0]!,
};

test('operator and account actions refuse before touching an injected store', async () => {
  let called = 0;
  const bindings = pendingBindings();
  bindings.actions['operator.orders'] = async () => { called++; return { ok: true, value: [] }; };
  bindings.actions['account.orders'] = async () => { called++; return { ok: true, value: [] }; };
  assert.deepEqual(await dispatchAction(bindings, 'operator.orders', {}, context), { ok: false, code: 'operator_required' });
  assert.deepEqual(await dispatchAction(bindings, 'account.orders', {}, context), { ok: false, code: 'customer_session_required' });
  assert.equal(called, 0);
});

test('missing native checkout binding cannot produce a fake order', async () => {
  const config = context.config;
  const input = { cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
    lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] },
  termsAccepted: true, termsRevision: config.legal.revision };
  assert.deepEqual(await dispatchAction(pendingBindings(), 'checkout.create', input, context),
    { ok: false, code: 'host_binding_required' });
});

test('host offer admission rejects a cart that the client attempts to underpay', async () => {
  let called = 0;
  const bindings = pendingBindings();
  bindings.actions['checkout.create'] = async () => { called++; return { ok: true, value: null }; };
  const result = await dispatchAction(bindings, 'checkout.create', { cart: { schemaVersion: 1,
    configuration: context.config.id, mode: 'one_time', lines: [{ sku: 'UNKNOWN', quantity: 1 }] },
  termsAccepted: true, termsRevision: context.config.legal.revision }, context);
  assert.equal(result.ok, false);
  assert.equal(called, 0);
});

test('declared customer identifiers in browser payload do not establish a session', async () => {
  const result = await dispatchAction(pendingBindings(), 'account.read',
    { customerRef: 'somebody-else', operatorRef: 'administrator' }, context);
  assert.deepEqual(result, { ok: false, code: 'customer_session_required' });
});

for (const original of Object.values(configurations)) {
  test(`${original.id}: a restorable partial selection still refuses before the checkout binding`, async () => {
    const config: StoreConfig = structuredClone(original);
    config.offer.minUnits = 3;
    let called = 0;
    const bindings = pendingBindings();
    bindings.actions['checkout.create'] = async () => { called++; return { ok: true, value: null }; };
    const result = await dispatchAction(bindings, 'checkout.create', {
      cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
        lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
      termsAccepted: true, termsRevision: config.legal.revision,
    }, { ...context, config });
    assert.deepEqual(result, { ok: false, code: 'minimum_units' });
    assert.equal(called, 0);
  });
}
