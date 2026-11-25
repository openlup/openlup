import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import type { Pool } from 'pg';
import { checkoutIncompleteAbandonMs, composePurchaseCapabilities } from '../host/purchase-composition.ts';
import { createApplication } from '../host/server.ts';
import type { ActionContext, VerifiedActor } from '../host/bindings.ts';
import type { AcquisitionPredecessors } from '../host/acquisition-predecessors.ts';
import { checkoutLateCreateMs } from '../shared/api.ts';
import { isRecord } from '../shared/offer.ts';
import { configurations } from '../owned/store.config.ts';

const original = Object.values(configurations)[0]!;
const config = { ...original, purchase: { ...original.purchase, responseFloorMs: 0 } };
const commandKey: string = randomUUID();
const guest: VerifiedActor = { customerRef: null, operatorRef: null, requesterKey: 'a'.repeat(64) };
const signedIn: VerifiedActor = { customerRef: '00000000-0000-4000-8000-000000000002', operatorRef: null,
  principalRef: '00000000-0000-4000-8000-000000000001', requesterKey: 'b'.repeat(64) };
const derived = (actor: VerifiedActor) => 'checkout:' + createHash('sha256').update(JSON.stringify([actor.principalRef, commandKey])).digest('hex');
const unavailable: AcquisitionPredecessors = {
  eligibility() { throw new Error('eligibility must not run'); }, checkout() { throw new Error('draft must not run'); },
};
const orderId = '00000000-0000-4000-8000-000000000003';
type Stored = { id: string; client_id: string; status: string; total_amount_minor: number; currency_code: string;
  owned: boolean; completed: boolean; submit: unknown; fingerprint: string };
const order = (changes: Partial<Stored> = {}): Stored => ({ id: orderId, client_id: signedIn.customerRef!, status: 'pending_payment',
  total_amount_minor: 1000, currency_code: config.market.currency, owned: true, completed: true,
  submit: { submitDigest: 'c'.repeat(64) }, fingerprint: 'd'.repeat(32), ...changes });
const presented = (stored: Stored) => ({ orderRef: stored.id, status: stored.status,
  total: { amountMinor: stored.total_amount_minor, currency: stored.currency_code } });

/** A fake held session in the style of the acquisition tests: every statement is named in `log`. */
function continuation(stored: Stored | undefined, options: { admitted?: boolean; integrity?: unknown; issue?: unknown;
  current?: { status: string; elapsed?: boolean }; safe?: boolean; cancel?: unknown; young?: boolean } = {}) {
  const log: string[] = [];
  const args: Record<string, unknown[]> = {};
  const query = async (sql: string, values: unknown[] = []) => {
    const step = [['pg_advisory_lock', 'lock'], ['pg_advisory_unlock', 'unlock'], ['commerce_order_draft_receipts', 'lookup'],
      ['catalog_admission_replay_order_draft', 'integrity'], ['abandonment_safe', 'predicate'], ['initial_checkout', 'initial'],
      ['commerce_cancel_abandoned_purchase_checkout', 'cancel'], ['AS young', 'age'], ['FROM public.commerce_orders WHERE id=$1', 'reread']]
      .find(([text]) => sql.includes(text!))?.[1];
    if (!step) throw new Error(`unexpected statement: ${sql}`);
    log.push(step);
    args[step] = values;
    if (step === 'lookup') return { rows: stored ? [stored] : [] };
    if (step === 'integrity' && options.integrity) throw options.integrity;
    if (step === 'initial') return { rows: [{ initial_checkout: true }] };
    if (step === 'predicate') return { rows: [{ safe: options.safe ?? true }] };
    if (step === 'cancel') {
      if (options.cancel instanceof Error) throw options.cancel;
      return { rows: [{ result: options.cancel ?? { cancelled: true } }] };
    }
    if (step === 'age') return { rows: [{ young: options.young ?? false }] };
    if (step === 'reread') return { rows: [options.current ?? stored] };
    return { rows: [] };
  };
  const db = { query, async connect() { log.push('connect'); return { query, release() { log.push('release'); } }; } } as unknown as Pool;
  const limiter = async () => { log.push('meter'); return { allowed: options.admitted ?? true }; };
  const recovery = { tokens: { async issue() {
    log.push('issue');
    if (options.issue) throw options.issue;
    return '00000000-0000-4000-8000-000000000009';
  } }, async deliver() { log.push('deliver'); } };
  const actions = composePurchaseCapabilities(db, {} as never, limiter, recovery as never, { predecessors: unavailable });
  const call = (action: unknown, actor = guest, key = commandKey, extra: Record<string, unknown> = {}) =>
    actions['checkout.continuation']!({ action, locale: config.market.defaultLocale, ...extra }, { config, actor, commandKey: key });
  return { log, args, call };
}

test('resume returns the order and a new token under the key lock', async () => {
  const stored = order();
  const host = continuation(stored);
  const result = await host.call('resume');
  assert.ok(result.ok && isRecord(result.value) && typeof result.value.token === 'string' && /^rcv_/.test(result.value.token));
  assert.deepEqual(result, { ok: true, value: { ...presented(stored), token: result.value.token }, replayed: true });
  assert.deepEqual(host.log, ['connect', 'lock', 'lookup', 'meter', 'integrity', 'initial', 'issue', 'unlock', 'release']);
  assert.deepEqual(host.args.lock, [derived(guest)]);
  assert.deepEqual(host.args.integrity, [derived(guest), stored.client_id, 'starter-checkout', 'c'.repeat(64)]);
  assert.ok(!host.log.includes('deliver'));
  // An unstamped historical draft is checked against its stored fingerprint.
  const legacy = continuation(order({ submit: null }));
  assert.equal((await legacy.call('resume')).ok, true);
  assert.deepEqual(legacy.args.integrity, [derived(guest), stored.client_id, 'starter-checkout', 'd'.repeat(32)]);
});

test('an incomplete order is in progress for resume', async () => {
  const host = continuation(order({ completed: false }));
  assert.deepEqual(await host.call('resume'), { ok: false, code: 'starter_checkout_in_progress' });
  assert.ok(!host.log.includes('issue') && !host.log.includes('cancel'));
});

test('resume re-checks receipt integrity', async () => {
  const conflict = continuation(order(), { integrity: Object.assign(new Error('receipt conflict'), { code: '23505' }) });
  assert.deepEqual(await conflict.call('resume'), { ok: false, code: 'starter_command_conflict' });
  assert.ok(!conflict.log.includes('issue'));
  assert.deepEqual(conflict.log.slice(-2), ['unlock', 'release']);
  const expired = continuation(order(), { integrity: Object.assign(new Error('commerce_order_draft_expired'), { code: '40001' }) });
  assert.deepEqual(await expired.call('resume'), { ok: false, code: 'commerce_order_draft_expired' });
  assert.ok(!expired.log.includes('issue'));
});

test('an unknown key is answered before metering', async () => {
  const host = continuation(undefined);
  assert.deepEqual(await host.call('resume'), { ok: false, code: 'starter_checkout_not_found' });
  assert.deepEqual(host.log, ['connect', 'lock', 'lookup', 'unlock', 'release']);
});

test('a limited resume returns the order without a token', async () => {
  const stored = order();
  const host = continuation(stored, { admitted: false });
  assert.deepEqual(await host.call('resume'), { ok: true, value: presented(stored), replayed: true });
  assert.ok(host.log.includes('meter') && !host.log.includes('issue'));
});

test('paid and closed orders resume without a token', async () => {
  const paid = order({ status: 'paid' });
  const host = continuation(paid);
  assert.deepEqual(await host.call('resume'), { ok: true, value: presented(paid), replayed: true });
  assert.ok(!host.log.includes('issue'));
  for (const status of ['cancelled', 'expired']) {
    const closed = continuation(order({ status }));
    assert.deepEqual(await closed.call('resume'), { ok: false, code: 'starter_checkout_not_payable' });
    assert.ok(!closed.log.includes('issue'));
  }
});

test('a signed-in caller cannot continue another client order under its key', async () => {
  const host = continuation(order({ owned: false }));
  assert.deepEqual(await host.call('resume', signedIn), { ok: false, code: 'starter_checkout_not_found' });
  assert.deepEqual(host.args.lock, [derived(signedIn)]);
  assert.ok(!host.log.includes('meter') && !host.log.includes('issue'));
  const owner = continuation(order());
  assert.equal((await owner.call('resume', signedIn)).ok, true);
});

test('continuation input names one action and a version 4 key', async () => {
  for (const [action, key, extra] of [['pay', commandKey, {}], [undefined, commandKey, {}], ['resume', commandKey, { email: 'buyer@example.test' }],
    ['resume', commandKey, { locale: 'xx' }], ['resume', commandKey.replace(/^(.{14})4/, '$11'), {}], ['resume', 'fictional-command-0001', {}]] as const) {
    const host = continuation(order());
    assert.deepEqual(await host.call(action, guest, key, extra), { ok: false, code: 'starter_input_invalid' });
    assert.deepEqual(host.log, []);
  }
});

test('a repeat whose token cannot be issued changes nothing', async () => {
  for (const [current, code] of [[{ status: 'pending_payment', elapsed: false }, 'starter_purchase_unavailable'],
    [{ status: 'pending_payment', elapsed: true }, 'starter_checkout_expired'],
    [{ status: 'cancelled', elapsed: false }, 'starter_checkout_not_payable']] as const) {
    const host = continuation(order(), { issue: new Error('checkout_recovery_order_not_recoverable'), current });
    assert.deepEqual(await host.call('resume'), { ok: false, code });
    assert.deepEqual(host.log.slice(-4), ['issue', 'reread', 'unlock', 'release']);
    assert.ok(!host.log.includes('cancel'));
  }
});

/** A guest create whose only permitted statements are the key lock and the lookup. */
function lateCreate(connect: () => void = () => {}) {
  const writes: string[] = [];
  const query = async (sql: string) => {
    if (sql.includes('pg_advisory') || sql.includes('commerce_order_draft_receipts')) return { rows: [] };
    if (sql.includes('SELECT email FROM public.clients')) return { rows: [{ email: 'buyer@example.test' }] };
    writes.push(sql);
    throw new Error('no write expected');
  };
  const db = { query, async connect() { connect(); return { query, release() {} }; } } as unknown as Pool;
  const contacts = { async ensureContactClient() { writes.push('contact'); return { ok: false }; } };
  const limiter = async () => { writes.push('ledger'); return { allowed: true }; };
  const actions = composePurchaseCapabilities(db, contacts as never, limiter, {} as never, { predecessors: unavailable });
  const input = { locale: config.market.defaultLocale, email: 'buyer@example.test', configuration: config.id, country: config.market.country,
    termsAccepted: true, termsRevision: config.legal.revision, firstName: 'Example', lastName: 'Buyer', phone: '00000',
    line1: '1 Example Lane', city: 'Example', postalCode: '00000',
    cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] } };
  return { writes, create: (context: Partial<ActionContext> = {}) => actions['checkout.create']!(input,
    { config, actor: guest, commandKey, ...context }), actions, input };
}

test('a fresh create that waited past the bound refuses before any write', async t => {
  let clock = 1_000;
  t.mock.method(performance, 'now', () => clock);
  const late = lateCreate(() => { clock += checkoutLateCreateMs + 1; });
  assert.deepEqual(await late.create(), { ok: false, code: 'starter_checkout_request_stale' });
  assert.deepEqual(late.writes, []);
});

test('the bound is measured from request receipt', async t => {
  let clock = 50_000;
  t.mock.method(performance, 'now', () => clock);
  const aged = lateCreate();
  assert.deepEqual(await aged.create({ receivedAt: clock - checkoutLateCreateMs - 1 }), { ok: false, code: 'starter_checkout_request_stale' });
  assert.deepEqual(aged.writes, []);
  // Authentication waits on the same pool before the handler starts; the HTTP host starts the clock earlier.
  const slow = lateCreate();
  const server = createApplication({ actions: { 'checkout.create': slow.actions['checkout.create']! },
    async authenticate() { clock += checkoutLateCreateMs + 1; return signedIn; }, async close() {} }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: address.port, path: '/api/actions/checkout.create', method: 'POST',
        headers: { Host: '127.0.0.1:4319', Origin: 'http://127.0.0.1:4319', 'X-Starter-Request': '1', 'Content-Type': 'application/json',
          'Idempotency-Key': commandKey } }, incoming => {
        let body = '';
        incoming.on('data', chunk => { body += String(chunk); });
        incoming.on('end', () => resolve({ status: incoming.statusCode!, value: JSON.parse(body) }));
      });
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify(slow.input));
    });
    assert.deepEqual(response, { status: 409, value: { ok: false, code: 'starter_checkout_request_stale' } });
    assert.deepEqual(slow.writes, []);
  } finally { server.close(); }
});

test('an incomplete order can be abandoned to start over', async () => {
  const host = continuation(order({ completed: false }));
  assert.deepEqual(await host.call('abandon'), { ok: true, value: { abandoned: true, orderRef: orderId } });
  assert.deepEqual(host.log, ['connect', 'lock', 'lookup', 'meter', 'integrity', 'initial', 'age', 'predicate', 'cancel', 'unlock', 'release']);
  assert.deepEqual(host.args.age, [orderId, checkoutIncompleteAbandonMs]);
  assert.deepEqual(host.args.cancel!.slice(0, 3), [`${derived(guest)}:start-over`, orderId, 'checkout_started_over']);
  assert.ok(!host.log.includes('issue'));
});

test('a dispatched attempt makes the order not abandonable', async () => {
  for (const [current, code] of [['pending_payment', 'starter_checkout_not_abandonable'], ['paid', 'starter_checkout_paid'],
    ['cancelled', 'starter_checkout_not_payable']] as const) {
    for (const cancel of [{ cancelled: false }, Object.assign(new Error('commerce_checkout_compensation_aggregate_changed'), { code: '55000' })]) {
      const host = continuation(order(), { cancel, current: { status: current } });
      assert.deepEqual(await host.call('abandon'), { ok: false, code });
      assert.deepEqual(host.log.slice(-4), ['cancel', 'reread', 'unlock', 'release']);
    }
  }
});

test('the safety predicate refuses before the compensation port', async () => {
  for (const [status, code] of [['pending_payment', 'starter_checkout_not_abandonable'], ['paid', 'starter_checkout_paid'],
    ['cancelled', 'starter_checkout_not_payable']] as const) {
    // A capture that lands before the predicate makes it false; the re-read names the order's state.
    const host = continuation(order(), { safe: false, current: { status } });
    assert.deepEqual(await host.call('abandon'), { ok: false, code });
    assert.deepEqual(host.log.slice(-4), ['predicate', 'reread', 'unlock', 'release']);
  }
});

test('abandon answers without a cancel for no, paid, closed or limited orders', async () => {
  const none = continuation(undefined);
  assert.deepEqual(await none.call('abandon'), { ok: true, value: { abandoned: false } });
  assert.ok(!none.log.includes('meter'));
  assert.deepEqual(await continuation(order({ status: 'paid' })).call('abandon'), { ok: false, code: 'starter_checkout_paid' });
  assert.deepEqual(await continuation(order({ status: 'cancelled' })).call('abandon'),
    { ok: true, value: { abandoned: false, orderRef: orderId, status: 'cancelled' } });
  const limited = continuation(order(), { admitted: false });
  assert.deepEqual(await limited.call('abandon'), { ok: false, code: 'starter_attempt_limited' });
  assert.ok(!limited.log.includes('integrity') && !limited.log.includes('cancel'));
});

test('an incomplete order younger than the stall bound is in progress for abandon', async () => {
  assert.equal(checkoutIncompleteAbandonMs, 60_000);
  const host = continuation(order({ completed: false }), { young: true });
  assert.deepEqual(await host.call('abandon'), { ok: false, code: 'starter_checkout_in_progress' });
  assert.ok(host.log.includes('age') && !host.log.includes('predicate') && !host.log.includes('cancel'));
  // A complete order never waits for the bound.
  const complete = continuation(order(), { young: true });
  assert.deepEqual(await complete.call('abandon'), { ok: true, value: { abandoned: true, orderRef: orderId } });
  assert.ok(!complete.log.includes('age'));
});
