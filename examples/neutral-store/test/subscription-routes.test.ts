import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Pool } from 'pg';
import { composeSubscriptionEditors } from '../host/subscription-editors.ts';
import { composeSubscriptionCommands } from '../host/native-composition.ts';
import { dispatchAction, type VerifiedActor } from '../host/bindings.ts';
import { createApplication } from '../host/server.ts';
import { configurations } from '../owned/store.config.ts';
import type { Operation } from '../shared/api.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(owned = true) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let releases = 0;
  const db = { async query(sql: string,values?: unknown[]) {
    calls.push({ sql,values });
    if (sql.includes('SELECT s.configured_offer_version')) return { rows: owned ? [{ configured_offer_version: 'classic' }] : [] };
    throw new Error('unexpected_editor_database_read');
  },release() { releases++; } };
  const pool = { async connect() { return db; } } as unknown as Pool;
  const actions = composeSubscriptionEditors(pool);
  return { calls,actions,releases: () => releases };
}
const actor: VerifiedActor = { customerRef: id(2),principalRef: id(3),operatorRef: null };
test('all three editor operations refuse a missing customer session before database access',async () => {
  const f = fixture();
  for (const operation of ['subscription.preview','subscription.command','subscription.catalog'] as const) {
    const result = await dispatchAction({ actions: f.actions,authenticate: async () => actor,close: async () => {} },operation,{},
      { actor: { customerRef: null,operatorRef: null },config: configurations.supplements!,commandKey: 'editor-test-123456' });
    assert.deepEqual(result,{ ok: false,code: 'customer_session_required' });
  }
  assert.equal(f.calls.length,0);
});
test('editor ownership uses only the session principal/client and releases a refused connection',async () => {
  const f = fixture(false),result = await f.actions['subscription.preview']!({ request: { subscriptionId: id(1),action: 'update_plan_length',planDays: 14 } },
    { actor,config: configurations.supplements!,commandKey: 'editor-test-123456' });
  assert.deepEqual(result,{ ok: false,code: 'subscription_command_forbidden',status: 403 });
  assert.deepEqual(f.calls[0]!.values,[id(1),id(2),id(3)]); assert.equal(f.releases(),1);
});
test('unconfigured plan/portion refusals remain named after ownership, with no quote or mutation',async () => {
  const f = fixture();
  for (const operation of ['subscription.preview','subscription.command'] as const) {
    for (const input of [{ action: 'update_plan_length',planDays: 14 },{ action: 'update_portion',portionMode: 'reduced' }]) {
      const result = await f.actions[operation]!({ request: { subscriptionId: id(1),...input } },{ actor,config: configurations.supplements!,commandKey: 'editor-test-123456' });
      assert.deepEqual(result,{ ok: false,code: 'starter_subscription_resize_unconfigured',status: 409 });
    }
  }
  assert.equal(f.calls.length,4); assert.ok(f.calls.every(call => call.sql.includes('SELECT s.configured_offer_version'))); assert.equal(f.releases(),4);
});
test('browser-supplied identity or quoted evidence is rejected by the route/package schema',async () => {
  const f = fixture(),context = { actor,config: configurations.supplements!,commandKey: 'editor-test-123456' };
  assert.deepEqual(await f.actions['subscription.preview']!({ actorId: id(9),request: { subscriptionId: id(1) } },context),{ ok: false,code: 'starter_input_invalid',status: 400 });
  const result = await f.actions['subscription.preview']!({ request: { subscriptionId: id(1),planDays: 28,base: [{ variantId: id(4),qty: 6 }],currentTotal: { amountMinor: 1,currency: 'XTS' } } },context);
  assert.deepEqual(result,{ ok: false,code: 'subscription_reprice_invalid_request',status: 400 });
  assert.equal(f.calls.length,2); assert.ok(f.calls.every(call => call.sql.includes('SELECT s.configured_offer_version')));
});

test('a classic dispatch racing opt-in rechecks the offer under the same transaction lock before pricing',async () => {
  const calls: string[] = [];
  const db = { release() {},async query(sql: string) {
    calls.push(sql);
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('SELECT s.configured_offer_version')) return { rows: [{ configured_offer_version: sql.includes('FOR UPDATE OF s') ? 'sized.v1' : 'classic' }] };
    throw new Error('must_not_quote_a_changed_offer');
  } };
  const actions = composeSubscriptionEditors({ async connect() { return db; } } as unknown as Pool);
  const result = await actions['subscription.preview']!({ request: { subscriptionId: id(1),planDays: 28,base: [{ variantId: id(4),qty: 6 }] } },
    { actor,config: configurations.supplements!,commandKey: 'editor-race-123456' });
  assert.deepEqual(result,{ ok: false,code: 'subscription_reprice_configured_offer_action_mismatch',status: 400 });
  assert.equal(calls.at(-1),'ROLLBACK'); assert.ok(calls.some(sql => sql.includes('FOR UPDATE OF s')));
});
test('the mounted HTTP action preserves the named resize status and requires a session',async () => {
  const f = fixture(),server = createApplication({ actions: f.actions,close: async () => {},
    authenticate: async incoming => incoming.headers.cookie === 'fixture-session=customer' ? actor : { customerRef: null,operatorRef: null } });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_listener_required');
  const call = (operation: Operation,session: boolean) => new Promise<{ status: number; body: { code: string } }>((resolve,reject) => {
    const input = JSON.stringify({ request: { subscriptionId: id(1),action: 'update_plan_length',planDays: 14 } });
    const outgoing = request({ hostname: '127.0.0.1',port: address.port,path: `/api/actions/${operation}`,method: 'POST',
      headers: { Host: '127.0.0.1:4319',Origin: 'http://127.0.0.1:4319','Content-Type': 'application/json','X-Starter-Request': '1',
        'Idempotency-Key': 'editor-http-123456',...(session ? { Cookie: 'fixture-session=customer' } : {}) } },response => {
      let result = ''; response.on('data',chunk => { result += chunk; }); response.on('end',() => resolve({ status: response.statusCode!,body: JSON.parse(result) }));
    });
    outgoing.on('error',reject); outgoing.end(input);
  });
  try {
    assert.equal((await call('subscription.preview',false)).body.code,'customer_session_required');
    for (const operation of ['subscription.preview','subscription.command'] as const) {
      const result = await call(operation,true); assert.equal(result.status,409); assert.equal(result.body.code,'starter_subscription_resize_unconfigured');
    }
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});


test('the composed command retains editor and care ownership checks without falling through',async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let released = 0;
  const query = async (sql: string,values: unknown[]) => { calls.push({ sql,values }); return { rows: [] }; };
  const command = composeSubscriptionCommands({ query,async connect() { return { query,release() { released++; } }; } } as unknown as Pool);
  const context = { actor,config: configurations.supplements!,commandKey: 'composed-command-123456' };
  assert.deepEqual(await command({ request: { subscriptionId: id(1),action: 'update_plan_length',planDays: 14 } },context),
    { ok: false,code: 'subscription_command_forbidden',status: 403 });
  assert.deepEqual(await command({ subscriptionRef: id(1),action: 'pause',pausePreset: '2_weeks' },context),
    { ok: false,code: 'starter_subscription_not_found' });
  assert.equal(calls.length,2); assert.equal(released,1);
  assert.ok(calls[0]!.sql.includes('SELECT s.configured_offer_version'));
  assert.ok(calls[1]!.sql.includes('SELECT s.id'));
  for (const call of calls) assert.deepEqual(call.values,[id(1),id(2),id(3)]);
  for (const input of [{ request: {} },{ action: 'pause',subscriptionRef: id(1) }]) {
    assert.equal((await command(input,{ ...context,actor: { customerRef: null,operatorRef: null } })).ok,false);
  }
  assert.equal(calls.length,2);
});
