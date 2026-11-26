import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPurchaseContinuation, toAttemptNumber, toCommandKey, toContinuationId } from '@openlup/platform/storefront';
import { actionRequestTimeoutMs, type ActionResult } from '../shared/api.ts';
import { act } from '../shared/transport.ts';

type Bindings = typeof import('../shared/storefront-bindings.ts');
type Call = { operation: string; key: string | null; body: Record<string, unknown> };

const idA = '0f8fad5b-d9cb-469f-a165-70867728950e', idB = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const orderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const total = { amountMinor: 4200, currency: 'XTS' };
const originalFetch = globalThis.fetch;
let documents = 0, configurations = 0;

afterEach(() => { globalThis.fetch = originalFetch; });

/** Each import is a fresh document: its create bookkeeping and document start are its own. */
async function freshDocument(): Promise<Bindings> {
  return import(new URL(`../shared/storefront-bindings.ts?document-${++documents}`, import.meta.url).href) as Promise<Bindings>;
}

/** Stubs HTTP only, so the shared `act` runs unchanged. */
function wire(reply: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { operation: String(url).replace('/api/actions/', ''), key: new Headers(init?.headers).get('Idempotency-Key'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const succeeded = (value: unknown) => json({ ok: true, value, replayed: true });
const refusedWith = (code: string, status = 409) => json({ ok: false, code }, status);
const lost = (): Response => { throw new TypeError('network'); };
const pending = (orderRef: string, token?: string) => ({ orderRef, status: 'pending_payment', total, ...(token ? { token } : {}) });

function setup(module: Bindings, options: { data?: Map<string, string>; start?: number; token?: () => string | null } = {}) {
  const configuration = `bindings-${++configurations}`;
  const data = options.data ?? new Map<string, string>();
  const faults = { get: false, set: false, remove: false, drop: false };
  const storage = {
    getItem(key: string) { if (faults.get) throw new Error('blocked'); return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (faults.set) throw new Error('full'); if (!faults.drop) data.set(key, value); },
    removeItem(key: string) { if (faults.remove) throw new Error('blocked'); data.delete(key); },
  };
  const time = { now: options.start ?? 1_000_000 };
  const answers: Array<{ answer: ActionResult; reading: unknown }> = [];
  const checkout = module.createCheckoutBindings({ configuration, storage, act, now: () => time.now, nextId: () => randomUUID(),
    token: options.token ?? (() => null), locale: () => 'en', onContinuationAnswer: (answer, reading) => { answers.push({ answer, reading }); } });
  const name = module.checkoutRecordKey(configuration);
  const raw = () => data.get(name);
  const stored = () => { const text = raw(); return text === undefined ? null : JSON.parse(text); };
  const seed = (record: unknown) => { data.set(name, JSON.stringify(record)); };
  const controller = () => createPurchaseContinuation(checkout.bindings);
  const purchase = (id = idA, attempt = 0, result: ActionResult | null = null) =>
    ({ continuationId: toContinuationId(id), attempt: toAttemptNumber(attempt), result, pending: null });
  return { configuration, data, faults, storage, time, answers, checkout, name, raw, stored, seed, controller, purchase };
}
const payload = (details = 'first') => ({ reviewed: JSON.stringify({ details }), body: { details } });
const createOf = (id = idA) => ({ key: toCommandKey(id), body: { details: 'first' } });

/** Spies the request deadline every `act` passes to `AbortSignal.timeout`. */
async function deadlines<T>(run: () => Promise<T>): Promise<{ result: T; deadlines: number[] }> {
  const original = AbortSignal.timeout, seen: number[] = [];
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return original.call(AbortSignal, ms); };
  try { return { result: await run(), deadlines: seen }; } finally { AbortSignal.timeout = original; }
}

test('U1 records written before the bindings read as their identity and adopt the reviewed details', async () => {
  const module = await freshDocument();
  for (const earlier of [{ v: 1, id: idA }, { v: 1, id: idA, sentAt: 7, ordered: true, orderRef: orderA }]) {
    const page = setup(module);
    page.seed(earlier);
    assert.deepEqual(page.checkout.bindings.storage.read(), { continuationId: idA, fingerprint: '' });
    const calls = wire(() => succeeded(pending(orderA, 'rcv_first')));
    // Without adoption the reviewed details differ from the empty fingerprint, so nothing is sent.
    assert.equal((await page.controller().submit({ payload: payload() })).snapshot.status, 'details_changed');
    assert.equal(calls.length, 0);
    page.checkout.adoptFingerprint(payload().reviewed);
    assert.deepEqual(page.stored(), { ...earlier, fingerprint: payload().reviewed });
    const { snapshot } = await page.controller().submit({ payload: payload() });
    assert.equal(snapshot.status, 'awaiting_payment', JSON.stringify(earlier));
    assert.deepEqual(calls.map(call => [call.operation, call.key]), [['checkout.create', idA]]);
  }
  const adopted = setup(module);
  adopted.seed({ v: 1, id: idA, fingerprint: 'earlier' });
  adopted.checkout.adoptFingerprint('later');
  assert.equal(adopted.stored().fingerprint, 'earlier', 'a stored fingerprint is never rewritten');
  for (const text of [JSON.stringify({ v: 1, id: 'not-a-uuid' }), JSON.stringify({ v: 1, id: idA.toUpperCase() }), 'null', '{']) {
    const page = setup(module);
    page.data.set(page.name, text);
    assert.equal(page.checkout.bindings.storage.read(), null, text);
  }
  const blocked = setup(module);
  blocked.seed({ v: 1, id: idA });
  blocked.faults.get = true;
  assert.equal(blocked.checkout.bindings.storage.read(), null);
});

test('U2 a write keeps the host fields of the same identity only', async () => {
  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f', attempts: { a1: 0 }, sentAt: 5, ordered: true, orderRef: orderA });
  page.checkout.bindings.storage.write({ continuationId: toContinuationId(idA), fingerprint: 'g', attempt: toAttemptNumber(1) });
  assert.deepEqual(page.stored(), { v: 1, id: idA, fingerprint: 'g', attempt: 1, attempts: { a1: 0 }, sentAt: 5, ordered: true, orderRef: orderA });
  assert.deepEqual(page.checkout.bindings.storage.read(), { continuationId: idA, fingerprint: 'g', attempt: 1 });
  page.checkout.bindings.storage.write({ continuationId: toContinuationId(idB), fingerprint: 'h' });
  assert.deepEqual(page.stored(), { v: 1, id: idB, fingerprint: 'h' }, 'another identity drops the host fields');
});

test('U3 every read reads storage', async () => {
  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  page.faults.drop = true;
  page.checkout.bindings.storage.write({ continuationId: toContinuationId(idB), fingerprint: 'g' });
  assert.deepEqual(page.checkout.bindings.storage.read(), { continuationId: idA, fingerprint: 'f' }, 'a dropped write is visible');
  page.faults.drop = false;
  page.faults.set = true;
  assert.throws(() => page.checkout.bindings.storage.write({ continuationId: toContinuationId(idB), fingerprint: 'g' }), /full/);
  page.faults.remove = true;
  assert.throws(() => page.checkout.bindings.storage.clear(), /blocked/);
  assert.equal(module.storageAvailable(page.storage), false, 'a probe write that fails reports storage as unavailable');
  page.faults.set = false;
  assert.equal(module.storageAvailable({ ...page.storage, removeItem: (key: string) => { page.data.delete(key); } }), true);
  assert.deepEqual([...page.data.keys()], [page.name], 'the probe leaves nothing behind');
});

test('U4 the create carries the stored identity as its key, also from a second controller', async () => {
  const module = await freshDocument();
  const page = setup(module);
  const calls = wire(() => lost());
  assert.equal((await page.controller().submit({ payload: payload() })).snapshot.status, 'unknown');
  const id = page.stored().id;
  assert.deepEqual(calls.map(call => [call.operation, call.key]), [['checkout.create', id], ['checkout.create', id]]);
  const later = wire(() => succeeded(pending(orderA, 'rcv_first')));
  assert.equal((await page.controller().submit({ payload: payload() })).snapshot.status, 'awaiting_payment');
  assert.deepEqual(later.map(call => [call.operation, call.key]), [['checkout.create', id]]);
});

test('U5 an uncertain answer rejects and is replayed once with the replay deadline', async () => {
  for (const uncertain of [lost, () => json({ ok: 'maybe' }), () => refusedWith('starter_dependency_unavailable', 503)]) {
    const module = await freshDocument();
    const page = setup(module);
    let first = true;
    const calls = wire(() => { if (first) { first = false; return uncertain(); } return succeeded(pending(orderA, 'rcv_first')); });
    const { result, deadlines: seen } = await deadlines(() => page.controller().submit({ payload: payload() }));
    assert.deepEqual({ status: result.snapshot.status, source: result.snapshot.source }, { status: 'awaiting_payment', source: 'replay' });
    assert.deepEqual(seen, [actionRequestTimeoutMs, 10_000]);
    assert.equal(calls[0]!.key, calls[1]!.key);
    wire(() => uncertain());
    await assert.rejects(page.checkout.bindings.transport.submit(createOf(page.stored().id)), (error: unknown) => {
      assert.ok(error instanceof module.CheckoutAnswerUncertain);
      assert.equal(error.answer.ok, false);
      assert.equal(page.checkout.bindings.classifySubmitFailure(error), 'transport_uncertain');
      return true;
    });
    assert.equal(page.checkout.bindings.classifySubmitFailure(new TypeError('network')), 'other');
  }
  const module = await freshDocument();
  const page = setup(module);
  const calls = wire(() => refusedWith('starter_terms_required'));
  assert.equal((await page.controller().submit({ payload: payload() })).snapshot.status, 'refused', 'a definite refusal resolves');
  assert.equal(calls.length, 1);
});

test('U6 the attempt map is durable beside the record', async () => {
  const data = new Map<string, string>();
  const page = setup(await freshDocument(), { data });
  page.seed({ v: 1, id: idA, fingerprint: 'f', ordered: true, orderRef: orderA });
  const calls = wire(call => call.operation === 'checkout.payment' ? succeeded({ attemptRef: 'a1', state: 'refused' })
    : succeeded(pending(orderA, 'rcv_read')));
  const answer = await page.checkout.bindings.transport.read(page.purchase());
  assert.deepEqual(calls.map(call => call.operation), ['checkout.continuation', 'checkout.payment']);
  assert.deepEqual(calls[1]!.body, { action: 'inspect', orderRef: orderA, token: 'rcv_read' });
  assert.equal(page.checkout.bindings.classifyOutcome(answer), 'declined');
  assert.match(page.raw()!, /"attempts":\{"a1":0\}/);
  const fresh = setup(await freshDocument(), { data });
  fresh.seed(page.stored());
  const declined = { ok: true as const, value: { attemptRef: 'a1' } };
  assert.equal(fresh.checkout.bindings.declinedAttempt(declined), 0);
  assert.equal(fresh.checkout.bindings.declinedAttempt({ ok: true, value: { attemptRef: 'constructor' } }), null);
  fresh.checkout.bindings.storage.clear();
  assert.equal(fresh.checkout.bindings.declinedAttempt(declined), null);
  // A second read of the same attempt keeps the attempt it was first read under.
  page.seed({ v: 1, id: idA, fingerprint: 'f', attempt: 1, attempts: { a1: 0 }, ordered: true, orderRef: orderA });
  wire(call => call.operation === 'checkout.payment' ? succeeded({ attemptRef: 'a1', state: 'refused' }) : succeeded(pending(orderA, 'rcv_read')));
  await page.checkout.bindings.transport.read(page.purchase(idA, 1));
  assert.deepEqual(page.stored().attempts, { a1: 0 });
});

const ok = (value: unknown) => ({ ok: true, value });
const no = (code: string, status?: 503) => ({ ok: false, code, ...(status ? { status } : {}) });
const additions = ['starter_terms_required', 'starter_expected_total_required', 'starter_quote_price_changed', 'starter_quote_refresh_required',
  'acquisition_terms_capability_required', 'acquisition_terms_changed', 'catalog_admission_quote_authority_required',
  'cart_invalid', 'cart_configuration_changed', 'cart_empty', 'unknown_sku', 'quantity_invalid', 'duplicate_sku',
  'purchase_mode_unavailable', 'cadence_unavailable', 'minimum_units', 'maximum_units', 'amount_overflow',
  'starter_checkout_request_stale'];
const classRows: Array<[unknown, string]> = [
  [ok({ status: 'paid' }), 'settled'], [ok({ status: 'fulfillment_pending' }), 'settled'], [ok({ status: 'fulfilled' }), 'settled'],
  [ok({ status: 'pending_payment' }), 'needs_client_action'], [ok({ status: 'pending_payment', attemptState: null }), 'needs_client_action'],
  [ok({ status: 'pending_payment', attemptState: 'refused' }), 'declined'],
  [ok({ status: 'pending_payment', attemptState: 'dispatched' }), 'awaiting_authority'],
  [ok({ status: 'pending_payment', attemptState: 'indeterminate' }), 'awaiting_authority'],
  [ok({ status: 'pending_payment', attemptState: 'captured' }), 'unknown'],
  [ok({ status: 'cancelled' }), 'closed'], [ok({ status: 'expired' }), 'unknown'], [ok({ status: 'refunded' }), 'unknown'],
  [ok({ abandoned: true }), 'unknown'], [ok(null), 'unknown'], [null, 'unknown'], [{ ok: 'maybe' }, 'unknown'],
  [no('starter_input_invalid'), 'refused'], [no('starter_email_invalid'), 'refused'],
  ...additions.map((code): [unknown, string] => [no(code), 'refused']),
  ...['starter_checkout_expired', 'starter_checkout_not_payable', 'starter_checkout_changed', 'starter_checkout_paid',
    'starter_command_conflict', 'starter_attempt_limited', 'starter_purchase_unavailable', 'starter_checkout_not_found',
    'starter_checkout_session_changed', 'starter_transport_unavailable', 'starter_response_invalid', 'starter_quote_unavailable',
    'starter_unlisted_code'].map((code): [unknown, string] => [no(code), 'unknown']),
  [no('starter_dependency_unavailable', 503), 'unknown'], [no('starter_input_invalid', 503), 'unknown'],
];

test('U7 the classifier gives every answer its class', async () => {
  const module = await freshDocument();
  for (const [answer, expected] of classRows) assert.equal(module.classifyCheckoutAnswer(answer), expected, JSON.stringify(answer));
  for (const code of additions) assert.equal(module.classifyCheckoutAnswer(no(code)), 'refused', `addition ${code}`);
  const source = await readFile(new URL('../host/purchase-composition.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function continuationToken'), end = source.indexOf("actions['payment.simulate']");
  const failure = source.indexOf('\nfunction failure'), failureEnd = source.indexOf('\n}\n', failure);
  assert.ok(start > 0 && end > start && failure > end && failureEnd > failure, 'starter_host_checkout_scan_anchor_missing');
  const codes = new Set([...(source.slice(start, end) + source.slice(failure, failureEnd)).matchAll(/'(starter_[a-z_]+)'/g)].map(match => match[1]!));
  assert.ok(codes.size >= 19, `scanned ${codes.size} host codes`);
  for (const code of codes) assert.ok(Object.hasOwn(module.checkoutRefusalClasses, code), `${code} has no listed class`);
});

// The create action's refusals that write no order are `refused`, so corrected details are sent; a refusal the host can
// also answer when an order exists under the key, or after one was written, stays `unknown`.
test('U7b each create refusal is classed by whether an order can exist under the key when the host answers it', async () => {
  const module = await freshDocument();
  const source = await readFile(new URL('../host/purchase-composition.ts', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes("actions['checkout.create'] = async"));
  const end = lines.findIndex(line => line.includes("actions['checkout.continuation'] = async"));
  const write = lines.findIndex(line => line.includes('drafts.createOrderDraft('));
  assert.ok(start > 0 && write > start && end > write, 'starter_host_checkout_scan_anchor_missing');
  const create = lines.slice(start, end).map((text, index) => ({ text, at: start + index }));
  const answering = (code: string) => create.filter(line => line.text.includes(`'${code}'`));
  // Answered only while no draft exists under the key, read under the key's lock, and before any write.
  const stale = answering('starter_checkout_request_stale');
  assert.equal(stale.length, 1);
  assert.ok(stale.every(line => line.text.includes('!priorOrder') && line.at < write), 'request_stale writes no order');
  assert.equal(module.classifyCheckoutAnswer(no('starter_checkout_request_stale')), 'refused');
  // Each of these is also answered with an order under the key (an earlier draft) or after this create wrote one.
  const failureAfterWrite = create.some(line => line.at > write && /return failure\(error\)/.test(line.text));
  const quoteFailureAfterWrite = create.some(line => line.at > write && /refused\(quoteFailure\(error\)\)/.test(line.text));
  const failureCodes = source.slice(source.indexOf('\nfunction failure'));
  const mayExist: Record<string, boolean> = {
    starter_attempt_limited: answering('starter_attempt_limited').some(line => /priorOrder|order\.status/.test(line.text) || /changed = async/.test(lines[line.at - 1] ?? '')),
    starter_command_conflict: answering('starter_command_conflict').some(line => line.at > write) || (failureAfterWrite && failureCodes.includes("'starter_command_conflict'")),
    starter_purchase_unavailable: answering('starter_purchase_unavailable').some(line => line.at > write) || (failureAfterWrite && failureCodes.includes("'starter_purchase_unavailable'")),
    starter_quote_unavailable: quoteFailureAfterWrite,
  };
  for (const [code, exists] of Object.entries(mayExist)) {
    assert.ok(exists, `${code} can be answered while an order exists under the key`);
    assert.equal(module.classifyCheckoutAnswer(no(code)), 'unknown', code);
  }
});

test('U8 the abandon answer resolves its reading', async () => {
  const module = await freshDocument();
  const rows: Array<[string, () => Response, string, Record<string, unknown>?]> = [
    ['abandoned', () => succeeded({ abandoned: true, orderRef: orderA }), 'terminal'],
    ['none, nothing sent', () => succeeded({ abandoned: false }), 'terminal'],
    ['none, an order is recorded', () => succeeded({ abandoned: false }), 'checking', { ordered: true, orderRef: orderA }],
    ...['cancelled', 'refunded', 'paid', 'fulfillment_pending', 'fulfilled'].map((status): [string, () => Response, string] =>
      [`found ${status}`, () => succeeded({ abandoned: false, orderRef: orderA, status }), 'terminal']),
    ...['expired', 'pending_payment', 'other'].map((status): [string, () => Response, string] =>
      [`found ${status}`, () => succeeded({ abandoned: false, orderRef: orderA, status }), 'active']),
    ['paid refusal', () => refusedWith('starter_checkout_paid'), 'terminal'],
    ['not abandonable', () => refusedWith('starter_checkout_not_abandonable'), 'active'],
    ...['starter_checkout_in_progress', 'starter_attempt_limited', 'starter_purchase_unavailable', 'starter_input_invalid']
      .map((code): [string, () => Response, string] => [code, () => refusedWith(code), 'checking']),
    ['other shape', () => succeeded({ accepted: true }), 'checking'],
  ];
  for (const [name, reply, expected, fields] of rows) {
    const page = setup(module);
    page.seed({ v: 1, id: idA, fingerprint: 'f', ...fields });
    const calls = wire(reply);
    const reading = await page.checkout.bindings.transport.abandon(page.purchase());
    assert.deepEqual(reading, { kind: expected }, name);
    assert.deepEqual(calls.map(call => [call.operation, call.key, call.body]), [['checkout.continuation', idA, { action: 'abandon', locale: 'en' }]], name);
    assert.deepEqual(page.answers.map(entry => entry.reading), [reading], name);
  }
  for (const uncertain of [lost, () => refusedWith('starter_dependency_unavailable', 503)]) {
    const page = setup(module);
    wire(uncertain);
    await assert.rejects(page.checkout.bindings.transport.abandon(page.purchase()), module.CheckoutAnswerUncertain);
  }
  // A create lost in transport: final strictly after its request timeout plus the late-create bound.
  const after = setup(await freshDocument());
  after.seed({ v: 1, id: idA, fingerprint: 'f' });
  const start = after.time.now;
  wire(lost);
  await assert.rejects(after.checkout.bindings.transport.submit(createOf()), Error);
  for (const [at, expected] of [[35_000, 'checking'], [35_001, 'terminal']] as const) {
    after.time.now = start + at;
    wire(() => succeeded({ abandoned: false }));
    assert.equal((await after.checkout.bindings.transport.abandon(after.purchase())).kind, expected, `lost at ${at}`);
  }
  // A create that settled without a definite answer: final strictly after the late-create bound.
  const settled = setup(await freshDocument());
  settled.seed({ v: 1, id: idA, fingerprint: 'f' });
  wire(() => json({ ok: 'maybe' }));
  await assert.rejects(settled.checkout.bindings.transport.submit(createOf()), Error);
  const settledAt = settled.time.now;
  for (const [at, expected] of [[15_000, 'checking'], [15_001, 'terminal']] as const) {
    settled.time.now = settledAt + at;
    wire(() => succeeded({ abandoned: false }));
    assert.equal((await settled.checkout.bindings.transport.abandon(settled.purchase())).kind, expected, `settled at ${at}`);
  }
});

test('U9 an answer about another session leaves the record as it was', async () => {
  const module = await freshDocument();
  const recorded = { v: 1, id: idA, fingerprint: 'f', ordered: true, orderRef: orderA };
  const created = setup(module);
  created.seed(recorded);
  wire(() => succeeded(pending(orderB, 'rcv_other')));
  assert.deepEqual(await created.checkout.bindings.transport.submit(createOf()), { ok: false, code: 'starter_checkout_session_changed' });
  // The dispatch time is written before the create leaves; nothing else changes.
  const { sentAt, ...rest } = created.stored();
  assert.equal(typeof sentAt, 'number');
  assert.deepEqual(rest, recorded);
  for (const [name, reply] of [
    ['read of another order', (call: Call) => call.operation === 'checkout.payment' ? succeeded({ attemptRef: 'a9', state: null })
      : succeeded(pending(orderB, 'rcv_other'))],
    ['no order under an ordered key', () => refusedWith('starter_checkout_not_found')],
  ] as const) {
    const page = setup(module);
    page.seed(recorded);
    const before = page.raw();
    wire(reply);
    assert.deepEqual(await page.checkout.bindings.transport.read(page.purchase()), { ok: false, code: 'starter_checkout_session_changed' }, name);
    assert.equal(page.raw(), before, name);
  }
  const unordered = setup(module);
  unordered.seed({ v: 1, id: idA, fingerprint: 'f' });
  wire(() => refusedWith('starter_checkout_not_found'));
  assert.deepEqual(await unordered.checkout.bindings.transport.read(unordered.purchase()), { ok: false, code: 'starter_checkout_not_found' });
});

test('U10 the fallback read is pinned to the recorded order', async () => {
  const module = await freshDocument();
  const recorded = { v: 1, id: idA, fingerprint: 'f', ordered: true, orderRef: orderA };
  const reply = (read: Response) => (call: Call) => call.operation === 'checkout.read' ? read : refusedWith('starter_checkout_not_payable');
  const other = setup(module, { token: () => 'rcv_other_order' });
  other.seed(recorded);
  const before = other.raw();
  let calls = wire(reply(succeeded({ status: 'cancelled', orderRef: orderB })));
  assert.deepEqual(await other.checkout.bindings.transport.read(other.purchase()), { ok: false, code: 'starter_checkout_not_payable' });
  assert.deepEqual(calls[1]!.body, { orderRef: orderA, token: 'rcv_other_order' });
  assert.equal(other.raw(), before);
  calls = wire(reply(succeeded({ status: 'cancelled', orderRef: orderA })));
  const last: ActionResult = { ok: true, value: pending(orderA, 'rcv_last') };
  assert.deepEqual(await other.checkout.bindings.transport.read(other.purchase(idA, 0, last)), { ok: true, value: { status: 'cancelled', orderRef: orderA }, replayed: true });
  assert.deepEqual(calls[1]!.body, { orderRef: orderA, token: 'rcv_last' }, 'the last answer\'s token comes first');
  for (const [name, page] of [['no recorded order', setup(module, { token: () => 'rcv_known' })], ['no token', setup(module)]] as const) {
    page.seed(name === 'no token' ? recorded : { v: 1, id: idA, fingerprint: 'f' });
    calls = wire(reply(succeeded({ status: 'cancelled', orderRef: orderA })));
    assert.deepEqual(await page.checkout.bindings.transport.read(page.purchase()), { ok: false, code: 'starter_checkout_not_payable' }, name);
    assert.deepEqual(calls.map(call => call.operation), ['checkout.continuation'], name);
  }
});

test('U11 none is final only after the browser gave up plus the bound', async () => {
  const { noneIsFinal } = await freshDocument();
  const S = 2_000_000, T = 1_000_000;
  assert.equal(noneIsFinal({ documentStartedAt: 0, continuationAt: 0 }), true, 'nothing was ever sent');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 1 }, documentStartedAt: T, continuationAt: T + 10_000_000 }), false, 'in flight');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 1, settledAt: S }, documentStartedAt: T, continuationAt: S + 10_000_000 }), false, 'a later create is in flight');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 0, settledAt: S }, documentStartedAt: T, continuationAt: S + 15_000 }), false);
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 0, settledAt: S }, documentStartedAt: T, continuationAt: S + 15_001 }), true);
  for (const D of [T + 10_000, T + 30_000]) {
    const bound = Math.max(D + 15_000, T + 35_000);
    assert.equal(noneIsFinal({ sentAt: T, documentStartedAt: D, continuationAt: bound }), false, `inherited at ${D - T}`);
    assert.equal(noneIsFinal({ sentAt: T, documentStartedAt: D, continuationAt: bound + 1 }), true, `inherited at ${D - T}`);
  }

  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  let release!: (response: Response) => void;
  wire(() => new Promise<Response>(done => { release = done; }));
  const held = page.checkout.bindings.transport.submit(createOf());
  assert.equal(module.checkoutCreates.state(idA)?.inFlight, 1);
  page.time.now += 1_000_000;
  wire(() => succeeded({ abandoned: false }));
  assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, 'checking', 'never final while the create is in flight');
  release(json({ ok: 'maybe' }));
  await assert.rejects(held, module.CheckoutAnswerUncertain);
  assert.equal(module.checkoutCreates.state(idA)?.inFlight, 0);
  const settledAt = page.time.now;
  // The answer arrives 30 s after dispatch; the decision uses the abandon's dispatch time.
  page.time.now = settledAt + 15_000;
  wire(() => { page.time.now += 30_000; return succeeded({ abandoned: false }); });
  assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, 'checking');
  page.time.now = settledAt + 15_001;
  wire(() => succeeded({ abandoned: false }));
  assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, 'terminal');

  const T2 = 5_000_000;
  for (const [D, bound] of [[T2 + 10_000, T2 + 35_000], [T2 + 30_000, T2 + 45_000]] as const) {
    const earlier = setup(await freshDocument(), { start: D });
    earlier.seed({ v: 1, id: idA, fingerprint: 'f', sentAt: T2 });
    assert.equal(earlier.checkout.pending(), true, 'the inherited record opens the panel on load');
    for (const [at, expected] of [[bound, 'checking'], [bound + 1, 'terminal']] as const) {
      earlier.time.now = at;
      wire(() => succeeded({ abandoned: false }));
      assert.equal((await earlier.checkout.bindings.transport.abandon(earlier.purchase())).kind, expected, `inherited from ${D - T2}`);
    }
  }
});

test('U11 a create lost in transport is final only after its request timeout plus the bound', async () => {
  const { noneIsFinal } = await freshDocument();
  const T = 1_000_000, S = T + 100;
  const early = { inFlight: 0, settledAt: S, lostUntil: T + 20_000 };
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: S + 15_000 }), false, 'an early transport error');
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: T + 35_000 }), false);
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: T + 35_001 }), true);

  const page = setup(await freshDocument());
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  const start = page.time.now;
  wire(() => { page.time.now += 100; return lost(); });
  await assert.rejects(page.checkout.bindings.transport.submit(createOf()), Error);
  for (const [at, expected] of [[100 + 15_000, 'checking'], [35_000, 'checking'], [35_001, 'terminal']] as const) {
    page.time.now = start + at;
    wire(() => succeeded({ abandoned: false }));
    assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, expected, `at ${at}`);
  }
});

test('U11 a definite refusal of every create clears the dispatch time but keeps the key', async () => {
  const module = await freshDocument();
  const only = setup(module);
  wire(() => refusedWith('starter_terms_required'));
  const first = await only.controller().submit({ payload: payload() });
  assert.equal(first.snapshot.status, 'refused');
  const id = only.stored().id;
  assert.deepEqual(only.stored(), { v: 1, id, fingerprint: payload().reviewed });
  assert.equal(only.checkout.pending(), false, 'no panel on load after an ordinary refusal');
  const again = wire(() => refusedWith('starter_terms_required'));
  await only.controller().submit({ payload: payload() });
  assert.equal(again[0]!.key, id);

  const afterLoss = setup(module);
  afterLoss.seed({ v: 1, id: idB, fingerprint: 'f' });
  wire(lost);
  await assert.rejects(afterLoss.checkout.bindings.transport.submit(createOf(idB)), module.CheckoutAnswerUncertain);
  wire(() => refusedWith('starter_command_conflict'));
  await afterLoss.checkout.bindings.transport.submit(createOf(idB));
  assert.equal(typeof afterLoss.stored().sentAt, 'number', 'an earlier lost create may still arrive');
  assert.equal(afterLoss.stored().id, idB);

  const inherited = setup(await freshDocument());
  inherited.seed({ v: 1, id: idA, fingerprint: 'f', sentAt: 1 });
  wire(() => refusedWith('starter_terms_required'));
  await inherited.checkout.bindings.transport.submit(createOf());
  assert.equal(typeof inherited.stored().sentAt, 'number', 'a create of an earlier document may still arrive');

  const exists = setup(module);
  exists.seed({ v: 1, id: idA, fingerprint: 'f' });
  wire(() => refusedWith('starter_checkout_changed'));
  await exists.checkout.bindings.transport.submit(createOf());
  assert.equal(exists.stored().ordered, true, 'a refusal that names an existing order records it');
  assert.equal(typeof exists.stored().sentAt, 'number');
});

test('U11 an inherited create keeps its bound through a create of this document', async () => {
  const T = 5_000_000;
  for (const reply of [() => refusedWith('starter_terms_required'), () => refusedWith('starter_dependency_unavailable', 503)]) {
    const page = setup(await freshDocument(), { start: T + 5_000 });
    page.seed({ v: 1, id: idA, fingerprint: 'f', sentAt: T });
    wire(() => { page.time.now += 100; return reply(); });
    await page.checkout.bindings.transport.submit(createOf()).catch(() => undefined);
    // The earlier document's create may reach the host until T + 20 s, then 15 s more.
    for (const [at, expected] of [[T + 5_100 + 15_000, 'checking'], [T + 35_000, 'checking'], [T + 35_001, 'terminal']] as const) {
      page.time.now = at;
      wire(() => succeeded({ abandoned: false }));
      assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, expected, `at ${at - T}`);
    }
  }
});

test('U11 in flight counts the creates of this purchase', async () => {
  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  assert.equal(module.checkoutCreates.state(idA), undefined);
  let release!: (response: Response) => void;
  wire(() => new Promise<Response>(done => { release = done; }));
  const held = page.checkout.bindings.transport.submit(createOf());
  assert.equal(module.checkoutCreates.state(idA)?.inFlight, 1);
  release(refusedWith('starter_terms_required'));
  await held;
  assert.equal(module.checkoutCreates.state(idA)?.inFlight, 0);
  // The bookkeeping is one per document: a remounted page of the same document counts into the same state.
  const state = module.checkoutCreates.state(idA);
  wire(() => refusedWith('starter_terms_required'));
  await createRemount(module, page.data, page.configuration).bindings.transport.submit(createOf());
  assert.equal(module.checkoutCreates.state(idA), state);
  assert.deepEqual({ inFlight: state?.inFlight, sentAt: state?.sentAt, settledAt: state?.settledAt }, { inFlight: 0, sentAt: 2_000_000, settledAt: 2_000_000 });
});

/** A second set of bindings over the same storage and configuration, as a remounted page builds. */
function createRemount(module: Bindings, data: Map<string, string>, configuration: string) {
  return module.createCheckoutBindings({ configuration, act, now: () => 2_000_000, nextId: () => randomUUID(), token: () => null,
    locale: () => 'en', storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } } });
}

test('U12 act uses the request timeout unless a deadline is given', async () => {
  wire(() => succeeded({}));
  assert.deepEqual((await deadlines(() => act('checkout.read', {}, 'key'))).deadlines, [actionRequestTimeoutMs]);
  assert.deepEqual((await deadlines(() => act('checkout.read', {}, 'key', 10_000))).deadlines, [10_000]);
});

test('U13 completed clears only a paid or cancelled order under the key', async () => {
  const module = await freshDocument();
  for (const [value, cleared] of [
    [{ orderRef: orderA, status: 'paid' }, true],
    [{ orderRef: orderA, status: 'cancelled' }, true],
    [{ originalOrderRef: orderA, latestOrderRef: orderB, terminalStatus: 'paid' }, true],
    [{ originalOrderRef: orderA, terminalStatus: 'cancelled' }, true],
    [{ orderRef: orderA, status: 'expired' }, false],
    [{ orderRef: orderA, status: 'pending_payment' }, false],
    [{ orderRef: orderB, status: 'paid' }, false],
    [{ originalOrderRef: orderB, latestOrderRef: orderA, terminalStatus: 'paid' }, false],
    [{ status: 'paid' }, false],
    [null, false],
  ] as const) {
    const page = setup(module);
    page.seed({ v: 1, id: idA, fingerprint: 'f', ordered: true, orderRef: orderA });
    assert.equal(page.checkout.completed(value), cleared, JSON.stringify(value));
    assert.equal(page.stored() === null, cleared, JSON.stringify(value));
  }
  const none = setup(module);
  assert.equal(none.checkout.completed({ orderRef: orderA, status: 'paid' }), false, 'no record');
  const unknown = setup(module);
  unknown.seed({ v: 1, id: idA, fingerprint: 'f', ordered: true });
  assert.equal(unknown.checkout.completed({ orderRef: orderA, status: 'paid' }), false, 'an order of unknown reference is kept');
  assert.equal(unknown.checkout.pending(), true);
  unknown.checkout.clearLocally();
  assert.equal(unknown.stored(), null);
  assert.equal(unknown.checkout.pending(), false);
});

test('a newer dispatch time stored by another document keeps "no order" open until its own bound', async () => {
  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  wire(() => json({ ok: 'maybe' }));
  await assert.rejects(page.checkout.bindings.transport.submit(createOf()), module.CheckoutAnswerUncertain);
  const settledAt = page.time.now;
  // Storage shared with another document: it dispatched a create of the same key 5 s later.
  page.seed({ ...page.stored(), sentAt: settledAt + 5_000 });
  for (const [at, expected] of [[15_001, 'checking'], [5_000 + 35_000, 'checking'], [5_000 + 35_001, 'terminal']] as const) {
    page.time.now = settledAt + at;
    wire(() => succeeded({ abandoned: false }));
    assert.equal((await page.checkout.bindings.transport.abandon(page.purchase())).kind, expected, `at ${at}`);
  }
});

test('a create is not sent when its dispatch time cannot be stored', async () => {
  const module = await freshDocument();
  const page = setup(module);
  page.seed({ v: 1, id: idA, fingerprint: 'f' });
  page.faults.set = true;
  const calls = wire(() => succeeded(pending(orderA, 'rcv_first')));
  await assert.rejects(page.checkout.bindings.transport.submit(createOf()), (error: unknown) => {
    assert.ok(error instanceof module.CheckoutStorageUnavailable);
    assert.equal(page.checkout.bindings.classifySubmitFailure(error), 'other', 'never replayed');
    return true;
  });
  assert.equal(calls.length, 0);
  page.faults.set = false;
  page.faults.drop = true;
  await assert.rejects(page.checkout.bindings.transport.submit(createOf()), module.CheckoutStorageUnavailable);
  assert.equal(calls.length, 0, 'a dropped dispatch-time write sends nothing either');
  page.faults.drop = false;
  // Through the controller: its own record write succeeds, the dispatch-time write fails, and nothing is sent.
  const other = setup(module);
  const storage = other.storage;
  other.checkout.bindings.storage.write({ continuationId: toContinuationId(idB), fingerprint: payload().reviewed });
  const setItem = storage.setItem;
  storage.setItem = (key: string, value: string) => { if (value.includes('"sentAt"')) throw new Error('full'); setItem(key, value); };
  const sent = wire(() => succeeded(pending(orderA, 'rcv_first')));
  const { snapshot } = await other.controller().submit({ payload: payload() });
  assert.equal(snapshot.status, 'unknown');
  assert.ok(snapshot.error instanceof module.CheckoutStorageUnavailable);
  assert.equal(sent.length, 0);
  assert.equal(other.stored().id, idB, 'the key is kept for the next attempt');
});
