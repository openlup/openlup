import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { composePortalCapabilities, composeE4Capabilities } from '../host/e4-composition.ts';
import { configurations } from '../owned/store.config.ts';
import { type ActionContext } from '../host/bindings.ts';

const context: ActionContext = { actor: { customerRef: null, operatorRef: 'verified-operator' },
  commandKey: 'hold-command-123456', config: Object.values(configurations)[0]! };

test('hold and release recheck admission on every replay before storage', async () => {
  let checks = 0;
  const pool = { query() { throw new Error('unauthorized_store_touched'); } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => { checks++; return false; });
  for (const operation of ['operator.hold', 'operator.release'] as const) {
    for (const commandKey of [context.commandKey, context.commandKey, 'another-command-123'])
      assert.deepEqual(await actions[operation]!({}, { ...context, commandKey }), { ok: false, code: 'operator_required' });
  }
  assert.equal(checks, 6);
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


for (const operation of ['operator.paymentLink', 'operator.replacement', 'operator.cancelFulfillment'] as const) {
  test(`${operation} rechecks human admin admission before validation and storage on every replay`, async () => {
    let checks = 0;
    const pool = { query() { throw new Error('unauthorized_store_touched'); } } as unknown as Pool;
    const action = composePortalCapabilities(pool, async () => { checks++; return false; })[operation]!;
    for (const commandKey of [context.commandKey, context.commandKey, 'another-command-123']) {
      assert.deepEqual(await action({ actorUserId: 'forged', confirmed: true }, { ...context, commandKey }), { ok: false, code: 'operator_required' });
    }
    assert.equal(checks, 3);
  });
}

test('profile/correction bindings reject caller identity and command keys before native access', async () => {
  const pool = { query() { throw new Error('unvalidated_account_store_touched'); } } as unknown as Pool;
  const actor = { principalRef: 'abcdefab-cdef-4abc-8def-abcdefabcdef', customerRef: 'abcdefab-cdef-4abc-8def-abcdefabcdee', operatorRef: null };
  const actions = composePortalCapabilities(pool, async () => false);
  for (const operation of ['account.profile', 'account.invoiceCorrection'] as const) {
    for (const payload of [{ principalId: actor.principalRef }, { idempotencyKey: 'browser-command-key' }, { email: 'other@example.test' }]) {
      assert.deepEqual(await actions[operation]!(payload, { ...context, actor }), { ok: false, code: 'starter_input_invalid' });
    }
    assert.deepEqual(await actions[operation]!({}, context), { ok: false, code: 'customer_session_required' });
  }
});

test('parcel mutations require the explicit confirmation before a native call', async () => {
  const pool = { query() { throw new Error('unconfirmed_parcel_store_touched'); } } as unknown as Pool;
  const actions = composePortalCapabilities(pool, async () => true);
  for (const operation of ['operator.replacement', 'operator.cancelFulfillment'] as const) {
    assert.deepEqual(await actions[operation]!({ orderRef: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
      shipmentRef: 'abcdefab-cdef-4abc-8def-abcdefabcdef', reason: 'lost', confirmed: false }, context),
    { ok: false, code: 'starter_input_invalid' });
  }
});

test('a disabled local checkout-recovery pass creates no job or database work', async () => {
  const { runCheckoutRecovery } = await import('../host/paid-mail.ts');
  const executor = { query() { throw new Error('disabled_checkout_persistence_touched'); } } as unknown as Pool;
  assert.deepEqual(await runCheckoutRecovery({ executor, config: context.config, publicOrigin: 'http://127.0.0.1:4319', enabled: false }),
    { enqueued: { ok: true, skipped: true, reason: 'checkout_recovery_disabled' } });
});


test('fulfillment cancellation retains the native 240-character reason boundary', async () => {
  const pool = { query() { throw new Error('oversized_reason_store_touched'); } } as unknown as Pool;
  const action = composePortalCapabilities(pool, async () => true)['operator.cancelFulfillment']!;
  assert.deepEqual(await action({ shipmentRef: 'abcdefab-cdef-4abc-8def-abcdefabcdef', reason: 'x'.repeat(241), confirmed: true }, context),
    { ok: false, code: 'starter_input_invalid' });
});

test('hold and release reject every caller-supplied identity before Commerce access', async () => {
  const pool = { query() { throw new Error('forged_identity_store_touched'); } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => true);
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  for (const operation of ['operator.hold', 'operator.release'] as const) {
    const target = operation === 'operator.hold' ? { orderRef: ref, reason: 'manual_support' } : { holdRef: ref };
    for (const field of ['actorUserId', 'principalRef', 'operatorRef', 'clientId', 'customerRef'])
      assert.deepEqual(await actions[operation]!({ ...target, [field]: ref }, context), { ok: false, code: 'starter_input_invalid' });
  }
});


test('order cancellation and manual refund recheck admission and reject forged identity before Commerce access', async () => {
  const pool = { query() { throw new Error('unadmitted_order_transition_store_touched'); } } as unknown as Pool;
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const input = { orderRef: ref, reason: 'Reviewed external outcome', confirmed: true };
  for (const operation of ['operator.cancelUnpaid', 'operator.externalRefund'] as const) {
    let checks = 0;
    const denied = composeE4Capabilities(pool, async () => { checks++; return false; })[operation]!;
    for (const commandKey of [context.commandKey, context.commandKey, 'another-command-123'])
      assert.deepEqual(await denied(input, { ...context, commandKey }), { ok: false, code: 'operator_required' });
    assert.equal(checks, 3);
    const action = composeE4Capabilities(pool, async () => true)[operation]!;
    for (const forged of [{ confirmed: false }, { actorUserId: ref }, { principalRef: ref }, { metadata: {} }, { idempotencyKey: 'forged' }, { reason: ' ' }, { reason: 'x'.repeat(2001) }])
      assert.deepEqual(await action({ ...input, ...forged }, context), { ok: false, code: 'starter_input_invalid' });
  }
});


test('return commands reject caller identities and validate native decisions before access', async () => {
  const pool = { query() { throw new Error('unvalidated_return_store_touched'); } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => true);
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const customer = { ...context, actor: { principalRef: ref, customerRef: ref, operatorRef: null } };
  const input = { orderRef: ref, reasonCode: context.config.returns.reasons[0]!.code, lines: [{ orderItemId: ref, quantity: 1 }] };
  for (const field of ['actorUserId','principalRef','requestedBy','customerRef','clientId','idempotencyKey']) {
    assert.deepEqual(await actions['return.request']!({ ...input, [field]: ref }, customer), { ok: false, code: 'starter_input_invalid' });
    for (const operation of ['operator.returnApprove','operator.returnReject'] as const)
      assert.deepEqual(await actions[operation]!({ returnRef: ref, [field]: ref }, context), { ok: false, code: 'starter_input_invalid' });
  }
  for (const invalid of [{ ...input, reasonCode: 'unconfigured' }, { ...input, lines: [...input.lines, ...input.lines] },
    { ...input, lines: [{ orderItemId: ref, quantity: 0 }] }, { ...input, lines: [{ ...input.lines[0], actorUserId: ref }] }])
    assert.deepEqual(await actions['return.request']!(invalid, customer), { ok: false, code: 'starter_input_invalid' });
  assert.deepEqual(await actions['operator.returnApprove']!({ returnRef: ref, refundMode: 'partial' }, context), { ok: false, code: 'starter_input_invalid' });
  assert.deepEqual(await actions['return.request']!(input, context), { ok: false, code: 'customer_session_required' });
  let checks = 0;
  const denied = composeE4Capabilities(pool, async () => { checks++; return false; });
  for (const operation of ['operator.returnApprove','operator.returnReject'] as const)
    for (let replay = 0; replay < 3; replay++) assert.deepEqual(await denied[operation]!({ returnRef: ref }, context), { ok: false, code: 'operator_required' });
  assert.equal(checks, 6);
});

for (const operation of ['operator.label','operator.handoff','operator.delivery'] as const) {
  test(`${operation} rechecks human admin, confirmation and strict identity before a connection`, async () => {
    let checks = 0;
    const pool = { connect() { throw new Error('unadmitted_shipment_connection'); } } as unknown as Pool;
    const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const input = { shipmentRef: ref, confirmed: true, ...(operation === 'operator.label' ? { providerKind: 'synthetic-carrier', providerTrackingId: 'parcel-evidence' }
      : operation === 'operator.delivery' ? { status: 'delivered', rawEvent: {} } : {}) };
    const denied = composeE4Capabilities(pool, async () => { checks++; return false; })[operation]!;
    for (const commandKey of [context.commandKey, context.commandKey, 'another-shipment-command'])
      assert.deepEqual(await denied(input, { ...context, commandKey }), { ok: false, code: 'operator_required' });
    assert.equal(checks, 3);
    const allowed = composeE4Capabilities(pool, async () => true)[operation]!;
    for (const field of ['actorUserId','principalRef','operatorRef','clientId','customerRef','idempotencyKey','fulfillmentOrderId'])
      assert.deepEqual(await allowed({ ...input, [field]: ref }, context), { ok: false, code: 'starter_input_invalid' });
    for (const invalid of [{ ...input, confirmed: false }, { ...input, shipmentRef: 'invalid' },
      { ...input, ...(operation === 'operator.label' ? { providerKind: '' } : operation === 'operator.delivery' ? { rawEvent: [] } : { metadata: [] }) }])
      assert.deepEqual(await allowed(invalid, context), { ok: false, code: 'starter_input_invalid' });
  });
}

test('shipment command transaction supplies the verified human, commits success and rolls back private diagnostics', async () => {
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  for (const failing of [false,true]) {
    const calls: string[] = []; let actor: unknown;
    const pool = { async connect() { return { async query(sql: string, values?: unknown[]) {
      calls.push(sql);
      if (sql.includes('fulfillment_operator_record_label')) {
        actor = values?.[3];
        if (failing) throw new Error('private-provider-diagnostic');
        return { rows: [{ response: { contractVersion: 'commerce.fulfillment.v0', fulfillmentOrderId: ref,
          orderId: ref, status: 'label_created', replayed: false } }] };
      }
      return { rows: [] };
    }, release() { calls.push('release'); } }; } } as unknown as Pool;
    const action = composeE4Capabilities(pool, async () => true)['operator.label']!;
    const result = await action({ shipmentRef: ref, confirmed: true, providerKind: 'synthetic-carrier', providerTrackingId: 'parcel-evidence' },
      { ...context, actor: { ...context.actor, operatorRef: ref } });
    assert.equal(actor, ref);
    assert.ok(calls.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED') < calls.findIndex(sql => sql.includes('fulfillment_operator_record_label')));
    assert.equal(calls.includes('COMMIT'), !failing);
    assert.equal(calls.at(-1), 'release');
    if (failing) { assert.deepEqual(result, { ok: false, code: 'starter_shipment_unavailable' }); assert.ok(calls.includes('ROLLBACK')); }
    else assert.equal(result.ok, true);
  }
});

for (const operation of ['account.addresses','account.paymentPreference','account.deliveryPreference','subscription.savedAddress'] as const) {
  test(`${operation} admits only the server customer pair and rejects supplied authority before storage`, async () => {
    const pool = { query() { throw new Error('unadmitted_customer_preferences_store'); } } as unknown as Pool;
    const action = composeE4Capabilities(pool, async () => false)[operation]!;
    const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const customer = { ...context, actor: { principalRef: ref, customerRef: ref, operatorRef: null } };
    const input = operation === 'subscription.savedAddress' ? { subscriptionRef: ref, savedAddressId: ref } : { action: 'read' };
    assert.deepEqual(await action(input, context), { ok: false, code: 'customer_session_required' });
    for (const field of ['actorUserId','actorId','principalRef','principalId','clientId','customerRef','userId','idempotencyKey'])
      assert.deepEqual(await action({ ...input, [field]: ref }, customer), { ok: false, code: 'starter_input_invalid' });
    assert.deepEqual(await action({ ...input, action: 'defaults' }, customer), { ok: false, code: 'starter_input_invalid' });
  });
}

test('preference schema refusal precedes storage, and saved selection replay retains the native parsing order', async () => {
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const customer = { ...context, actor: { principalRef: ref, customerRef: ref, operatorRef: null } };
  const pool = { query() { throw new Error('invalid_preference_store'); } } as unknown as Pool;
  const actions = composeE4Capabilities(pool, async () => false);
  for (const input of [{ action: 'save', scope: 'foreign', methodKind: 'demo-card' }, { action: 'save', scope: 'any', methodKind: 'provider-secret' }])
    assert.deepEqual(await actions['account.paymentPreference']!(input, customer), { ok: false, code: 'starter_input_invalid' });
  assert.deepEqual(await actions['account.deliveryPreference']!({ action: 'save', scope: 'any', deliveryKind: 'parcel-locker',
    providerKind: 'demo-simulator', carrierKind: 'demo-carrier', carrierCode: 'courier', serviceCode: 'standard', pickupPoint: null }, customer),
  { ok: false, code: 'starter_input_invalid' });
  let args: unknown[] = [];
  const replayPool = { async query(_sql: string, values: unknown[]) { args = values;
    return { rows: [{ result: { status: 'replayed', shippingAddressId: ref } }] }; } } as unknown as Pool;
  const result = await composeE4Capabilities(replayPool, async () => false)['subscription.savedAddress']!(
    { subscriptionRef: ref, savedAddressId: 'malformed-replay-input' }, customer);
  assert.equal(result.ok, true); assert.equal(result.ok && result.replayed, true);
  assert.deepEqual(args.slice(0, 4), [ref, ref, customer.commandKey, ref]);
  assert.equal(JSON.parse(String(args[4])).shippingAddressId, 'malformed-replay-input');
});

test('the selected scoped billing reader returns the real book and never hides a read error', async () => {
  const ref = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const customer = { ...context, actor: { principalRef: ref, customerRef: ref, operatorRef: null } };
  const pool = { async query(sql: string) { return { rows: [sql.includes('customer_billing_profiles_read') ? { value: [] } : { result: [] }] }; } } as unknown as Pool;
  assert.deepEqual(await composeE4Capabilities(pool, async () => false)['account.addresses']!({ action: 'read' }, customer),
    { ok: true, value: { contractVersion: 'customer.addresses.v1', ordererProfiles: [], addresses: [], billingProfilesAvailable: true } });
  const failed = { async query() { throw new Error('address-read-offline'); } } as unknown as Pool;
  assert.deepEqual(await composeE4Capabilities(failed, async () => false)['account.addresses']!({ action: 'read' }, customer),
    { ok: false, code: 'starter_account_data_unavailable' });
});


import { createStarterPersonalDataRegistry } from '../host/native-composition.ts';
test('the host requires billing privacy coverage and exposes incomplete privacy owners without a browser workflow', () => {
  const registry=createStarterPersonalDataRegistry();
  assert.ok(registry.contributors.some(c=>c.id==='customer-billing'));
  assert.deepEqual(registry.missingContributors,['identity','subscriptions']);
  assert.ok(registry.contributors.some(c=>c.id==='account-support'));
});
for(const operation of ['account.billing','account.defaults'] as const)test(`${operation} refuses caller-supplied identity before native storage`,async()=>{
  const ref='abcdefab-cdef-4abc-8def-abcdefabcdef';
  const pool={query(){throw Error('unexpected_billing_storage');}} as unknown as Pool;
  const actor={principalRef:ref,customerRef:ref,operatorRef:null};
  const action=composeE4Capabilities(pool,async()=>false)[operation]!;
  for(const key of ['actorUserId','principalRef','clientId','idempotencyKey'])assert.deepEqual(await action({action:'read',[key]:ref},{...context,actor}),{ok:false,code:'starter_input_invalid'});
});
