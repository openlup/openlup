import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from '../client/api.ts';
import { market } from '../owned/market.config.ts';
import type { ActionResult } from '../shared/api.ts';

type Purchase = typeof import('../client/purchase.ts');
type Controller = ReturnType<Purchase['checkoutContinuation']>;
type Outcome = Awaited<ReturnType<Controller['continue']>>;

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const storageKey = (configuration: string) => `neutral-store:checkout-continuation:v1:${configuration}`;
const orderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const total = { amountMinor: 4200, currency: 'XTS' };
let documents = 0, configurations = 0;

/** Each import is a fresh document: its module memory and document start are its own. */
async function freshDocument(): Promise<Purchase> {
  return import(new URL(`../client/purchase.ts?continuation-document-${++documents}`, import.meta.url).href) as Promise<Purchase>;
}

function storage(data = new Map<string, string>()) {
  const faults = { access: false, get: false, set: false, remove: false };
  const store = {
    getItem(key: string) { if (faults.get) throw new Error('blocked'); return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (faults.set) throw new Error('full'); data.set(key, value); },
    removeItem(key: string) { if (faults.remove) throw new Error('blocked'); data.delete(key); },
  };
  return { data, faults, accessor: () => { if (faults.access) throw new Error('denied'); return store; } };
}

function setup(purchase: Purchase, data?: Map<string, string>, start = 1_764_000_000_000) {
  const configuration = `continuation-${++configurations}`;
  const tab = storage(data), time = { now: start };
  const controller = purchase.checkoutContinuation(configuration, { storage: tab.accessor, now: () => time.now });
  const stored = () => { const raw = tab.data.get(storageKey(configuration)); return raw === undefined ? null : JSON.parse(raw); };
  return { configuration, tab, time, controller, stored };
}

/** Stubs HTTP only, so `act` and its classification run unchanged. */
async function withFetch<T>(reply: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => reply(String(url), init ?? {})) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusedWith = (code: string, status = 409) => json({ ok: false, code }, status);
const succeeded = (value: unknown) => json({ ok: true, value, replayed: true });
const lost = (): Response => { throw new TypeError('network'); };

async function create(controller: Controller, reply: () => Response) {
  const { key } = controller.dispatch();
  const result = await withFetch(reply, () => act('checkout.create', {}, key));
  controller.settled(key, result);
  return { key, result, outcome: controller.answer(key, result) };
}
async function proceed(controller: Controller, action: 'resume' | 'abandon', reply: () => Response) {
  const sent: Array<{ url: string; key: string | null; body: unknown }> = [];
  const outcome = await withFetch(async (url, init) => {
    sent.push({ url, key: new Headers(init.headers).get('Idempotency-Key'), body: JSON.parse(String(init.body)) });
    return reply();
  }, () => controller.continue(action, 'en'));
  return { outcome, sent };
}

test('every host checkout code has a class', async () => {
  const purchase = await freshDocument();
  const source = await readFile(new URL('../host/purchase-composition.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function continuationToken'), end = source.indexOf("actions['checkout.read']");
  const failure = source.indexOf('\nfunction failure'), failureEnd = source.indexOf('\n}\n', failure);
  assert.ok(start > 0 && end > start && failure > end && failureEnd > failure, 'starter_host_checkout_scan_anchor_missing');
  const codes = new Set([...(source.slice(start, end) + source.slice(failure, failureEnd)).matchAll(/'(starter_[a-z_]+)'/g)].map(match => match[1]!));
  assert.ok(codes.size >= 16, `scanned ${codes.size} host codes`);
  for (const code of codes) assert.ok(Object.hasOwn(purchase.checkoutAnswerCodes, code), `${code} has no checkout answer class`);
  for (const code of ['starter_transport_unavailable', 'starter_response_invalid', 'starter_dependency_unavailable']) {
    assert.equal(purchase.checkoutAnswerCodes[code], 'noAnswer');
  }
  const counts: Record<string, number> = {};
  for (const kind of Object.values(purchase.checkoutAnswerCodes)) counts[kind] = (counts[kind] ?? 0) + 1;
  assert.deepEqual(counts, { noAnswer: 3, open: 4, closed: 2, none: 1, other: 10 });
});

interface Row {
  name: string;
  operation: 'create' | 'resume' | 'abandon';
  reply: () => Response;
  kind: Outcome['kind'];
  record: 'unchanged' | 'ordered' | 'cleared';
  orderRef?: string;
  panel: Outcome['panel'];
  choices?: boolean;
  different?: boolean;
  link: Outcome['link'];
  code?: string;
  text?: string;
  copy?: string;
  /** A definite refusal of the only create clears its dispatch time; the key stays. */
  cleared?: true;
}

const pending = (token?: string) => ({ orderRef: orderA, status: 'pending_payment', total, ...(token ? { token } : {}) });
const rows: Row[] = [
  { name: 'create success with token', operation: 'create', reply: succeeded(pending('rcv_first')), kind: 'open', record: 'ordered', orderRef: orderA, panel: 'close', link: 'show' },
  { name: 'create success without token', operation: 'create', reply: succeeded(pending()), kind: 'open', record: 'ordered', orderRef: orderA, panel: 'open', link: 'remove', text: 'limited' },
  { name: 'create success paid', operation: 'create', reply: succeeded({ orderRef: orderA, status: 'paid', total }), kind: 'closed', record: 'cleared', panel: 'close', link: 'remove', copy: 'recoveryPaid' },
  { name: 'create changed', operation: 'create', reply: refusedWith('starter_checkout_changed'), kind: 'open', record: 'ordered', panel: 'open', link: 'keep', code: 'starter_checkout_changed', text: 'starter_checkout_changed' },
  { name: 'create expired', operation: 'create', reply: refusedWith('starter_checkout_expired'), kind: 'open', record: 'ordered', panel: 'open', different: true, link: 'keep', code: 'starter_checkout_expired', text: 'starter_checkout_expired' },
  { name: 'create paid', operation: 'create', reply: refusedWith('starter_checkout_paid'), kind: 'closed', record: 'cleared', panel: 'close', link: 'remove', code: 'starter_checkout_paid', text: 'starter_checkout_paid' },
  { name: 'create not payable', operation: 'create', reply: refusedWith('starter_checkout_not_payable'), kind: 'closed', record: 'cleared', panel: 'close', link: 'remove', code: 'starter_checkout_not_payable', text: 'starter_checkout_not_payable' },
  { name: 'create stale', cleared: true, operation: 'create', reply: refusedWith('starter_checkout_request_stale'), kind: 'other', record: 'unchanged', panel: 'keep', link: 'keep', code: 'starter_checkout_request_stale', text: 'starter_checkout_request_stale' },
  { name: 'create limited', cleared: true, operation: 'create', reply: refusedWith('starter_attempt_limited'), kind: 'other', record: 'unchanged', panel: 'keep', link: 'keep', code: 'starter_attempt_limited', text: 'starter_attempt_limited' },
  { name: 'create conflict', cleared: true, operation: 'create', reply: refusedWith('starter_command_conflict'), kind: 'other', record: 'unchanged', panel: 'keep', link: 'keep', code: 'starter_command_conflict', text: 'starter_command_conflict' },
  ...['starter_input_invalid', 'starter_email_invalid', 'starter_terms_required', 'starter_purchase_unavailable', 'starter_quote_refresh_required', 'starter_quote_price_changed', 'starter_expected_total_required', 'starter_cart_invalid'].map(code =>
    ({ name: `create ${code}`, cleared: true as const, operation: 'create' as const, reply: refusedWith(code), kind: 'other' as const, record: 'unchanged' as const, panel: 'keep' as const, link: 'keep' as const, code })),
  { name: 'create dependency unavailable', operation: 'create', reply: refusedWith('starter_dependency_unavailable', 503), kind: 'noAnswer', record: 'unchanged', panel: 'open', link: 'keep', code: 'starter_dependency_unavailable' },
  { name: 'create lost', operation: 'create', reply: lost, kind: 'noAnswer', record: 'unchanged', panel: 'open', link: 'keep', code: 'starter_transport_unavailable' },
  { name: 'create unreadable', operation: 'create', reply: json({ ok: 'maybe' }), kind: 'noAnswer', record: 'unchanged', panel: 'open', link: 'keep', code: 'starter_response_invalid' },
  { name: 'create other success shape', operation: 'create', reply: succeeded({ accepted: true }), kind: 'other', record: 'unchanged', panel: 'keep', link: 'keep' },
  { name: 'resume with token', operation: 'resume', reply: succeeded(pending('rcv_resumed')), kind: 'open', record: 'ordered', orderRef: orderA, panel: 'open', choices: true, link: 'show' },
  { name: 'resume without token', operation: 'resume', reply: succeeded(pending()), kind: 'open', record: 'ordered', orderRef: orderA, panel: 'open', choices: true, link: 'remove', text: 'limited' },
  { name: 'resume paid', operation: 'resume', reply: succeeded({ orderRef: orderA, status: 'paid', total }), kind: 'closed', record: 'cleared', panel: 'open', choices: false, link: 'remove', copy: 'recoveryPaid' },
  { name: 'resume in progress', operation: 'resume', reply: refusedWith('starter_checkout_in_progress'), kind: 'open', record: 'ordered', panel: 'open', choices: true, link: 'keep', code: 'starter_checkout_in_progress', text: 'starter_checkout_in_progress' },
  { name: 'resume expired', operation: 'resume', reply: refusedWith('starter_checkout_expired'), kind: 'open', record: 'ordered', panel: 'open', choices: true, different: true, link: 'keep', code: 'starter_checkout_expired', text: 'starter_checkout_expired' },
  { name: 'resume not payable', operation: 'resume', reply: refusedWith('starter_checkout_not_payable'), kind: 'closed', record: 'cleared', panel: 'open', choices: false, link: 'remove', code: 'starter_checkout_not_payable', text: 'starter_checkout_not_payable' },
  { name: 'resume not found', operation: 'resume', reply: refusedWith('starter_checkout_not_found'), kind: 'none', record: 'cleared', panel: 'open', choices: false, link: 'keep', code: 'starter_checkout_not_found', text: 'starter_checkout_not_found' },
  { name: 'resume lost', operation: 'resume', reply: lost, kind: 'noAnswer', record: 'unchanged', panel: 'open', choices: true, link: 'keep', code: 'starter_transport_unavailable' },
  { name: 'abandon cancelled it', operation: 'abandon', reply: succeeded({ abandoned: true, orderRef: orderA }), kind: 'closed', record: 'cleared', panel: 'open', choices: false, link: 'remove', text: 'abandoned' },
  ...(['paid', 'fulfillment_pending', 'fulfilled'] as const).map(status => ({ name: `abandon found ${status}`, operation: 'abandon' as const,
    reply: succeeded({ abandoned: false, orderRef: orderA, status }), kind: 'closed' as const, record: 'cleared' as const, panel: 'open' as const, choices: false, link: 'remove' as const, copy: 'recoveryPaid' })),
  { name: 'abandon found cancelled', operation: 'abandon', reply: succeeded({ abandoned: false, orderRef: orderA, status: 'cancelled' }), kind: 'closed', record: 'cleared', panel: 'open', choices: false, link: 'remove', copy: 'recoveryCancelled' },
  ...(['refunded', 'expired'] as const).map(status => ({ name: `abandon found ${status}`, operation: 'abandon' as const,
    reply: succeeded({ abandoned: false, orderRef: orderA, status }), kind: 'closed' as const, record: 'cleared' as const, panel: 'open' as const, choices: false, link: 'remove' as const, text: 'starter_checkout_not_payable' })),
  { name: 'abandon found a later unpaid order', operation: 'abandon', reply: succeeded({ abandoned: false, orderRef: orderA, status: 'pending_payment' }), kind: 'other', record: 'unchanged', panel: 'open', choices: true, link: 'keep' },
  { name: 'abandon found none', operation: 'abandon', reply: succeeded({ abandoned: false }), kind: 'none', record: 'cleared', panel: 'open', choices: false, link: 'keep', code: 'starter_checkout_not_found', text: 'starter_checkout_not_found' },
  { name: 'abandon not abandonable', operation: 'abandon', reply: refusedWith('starter_checkout_not_abandonable'), kind: 'open', record: 'ordered', panel: 'open', choices: true, different: true, link: 'keep', code: 'starter_checkout_not_abandonable', text: 'starter_checkout_not_abandonable' },
  { name: 'abandon in progress', operation: 'abandon', reply: refusedWith('starter_checkout_in_progress'), kind: 'open', record: 'ordered', panel: 'open', choices: true, link: 'keep', code: 'starter_checkout_in_progress', text: 'starter_checkout_in_progress' },
  { name: 'abandon paid', operation: 'abandon', reply: refusedWith('starter_checkout_paid'), kind: 'closed', record: 'cleared', panel: 'open', choices: false, link: 'remove', code: 'starter_checkout_paid', copy: 'recoveryPaid' },
  { name: 'abandon limited', operation: 'abandon', reply: refusedWith('starter_attempt_limited'), kind: 'other', record: 'unchanged', panel: 'open', choices: true, link: 'keep', code: 'starter_attempt_limited', text: 'starter_attempt_limited' },
  { name: 'abandon busy', operation: 'abandon', reply: refusedWith('starter_purchase_unavailable'), kind: 'other', record: 'unchanged', panel: 'open', choices: true, link: 'keep', code: 'starter_purchase_unavailable' },
  { name: 'abandon unavailable', operation: 'abandon', reply: refusedWith('starter_dependency_unavailable', 503), kind: 'noAnswer', record: 'unchanged', panel: 'open', choices: true, link: 'keep', code: 'starter_dependency_unavailable' },
];

test('each answer class updates the record as the table says', async () => {
  const purchase = await freshDocument();
  for (const row of rows) {
    const { controller, time, stored, configuration } = setup(purchase);
    let key: string, outcome: Outcome;
    if (row.operation === 'create') ({ key, outcome } = await create(controller, row.reply));
    else {
      // A create lost in transport, then a continuation once "none" could be final: its request timeout plus the bound.
      ({ key } = await create(controller, lost));
      if (row.name === 'abandon cancelled it') purchase.rememberPurchase(configuration, { orderRef: orderA, token: 'rcv_remembered' });
      time.now += 35_000;
      const sent = await proceed(controller, row.operation, row.reply);
      outcome = sent.outcome;
      assert.deepEqual(sent.sent, [{ url: '/api/actions/checkout.continuation', key, body: { action: row.operation, locale: 'en' } }], row.name);
      if (row.name === 'abandon cancelled it') assert.equal(purchase.currentPurchase(configuration), null, 'the remembered purchase of the cancelled order is forgotten');
    }
    assert.match(key, v4, row.name);
    assert.equal(outcome.kind, row.kind, row.name);
    assert.equal(outcome.panel, row.panel, row.name);
    assert.equal(outcome.link, row.link, row.name);
    assert.equal(outcome.different, row.different ?? false, row.name);
    if (row.choices !== undefined) assert.equal(outcome.choices, row.choices, row.name);
    assert.equal(outcome.code, row.code, row.name);
    assert.equal(outcome.text, row.text, row.name);
    assert.equal(outcome.copy, row.copy, row.name);
    assert.equal(outcome.stored, true, row.name);
    const record = stored();
    if (row.record === 'cleared') {
      assert.equal(record, null, row.name);
      assert.equal(controller.current(), null, row.name);
      assert.notEqual(controller.dispatch().key, key, `${row.name}: a closed or final answer lets the next submit use a new key`);
    } else {
      assert.equal(record.id, key, row.name);
      assert.equal(typeof record.sentAt, row.cleared ? 'undefined' : 'number', row.name);
      assert.equal(controller.pending(), row.record === 'ordered' || !row.cleared, `${row.name}: the panel on load`);
      assert.equal(record.ordered, row.record === 'ordered' ? true : undefined, row.name);
      assert.equal(record.orderRef, row.orderRef, row.name);
      assert.deepEqual(controller.current(), record, row.name);
      assert.equal(controller.dispatch().key, key, `${row.name}: the next submit reuses the key`);
    }
  }
  const { controller, configuration } = setup(purchase);
  const { key } = controller.dispatch();
  purchase.rememberPurchase(configuration, { orderRef: orderA, token: 'rcv_known' });
  assert.equal(controller.answer(key, { ok: true, value: pending() }).link, 'show', 'a token already known for that order keeps the link');
  for (const locale of market.locales) {
    for (const text of ['limited', 'starter_attempt_limited'] as const) {
      assert.match(purchase.continuationMessage(text, locale, 180_000), /\b3 min\b/, `${text} (${locale})`);
      // The wait is a point in time, not a deadline.
      assert.match(purchase.continuationMessage(text, locale, 180_000), /(?:\bin|\bza) 3 min\./u, `${text} (${locale})`);
      assert.doesNotMatch(purchase.continuationMessage(text, locale, 180_000), /\{minutes\}/);
    }
    assert.match(purchase.continuationMessage('starter_attempt_limited', locale, 60_001), /\b2 min\b/);
  }
});

test('none is final only after the browser gave up plus the bound', async () => {
  const { noneIsFinal } = await freshDocument();
  const S = 2_000_000, T = 1_000_000;
  assert.equal(noneIsFinal({ documentStartedAt: 0, continuationAt: 0 }), true, 'nothing was ever sent');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 1 }, documentStartedAt: T, continuationAt: T + 10_000_000 }), false, 'in flight');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 1, settledAt: S }, documentStartedAt: T, continuationAt: S + 10_000_000 }), false, 'a later create is in flight');
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 0, settledAt: S }, documentStartedAt: T, continuationAt: S + 14_999 }), false);
  assert.equal(noneIsFinal({ sentAt: T, create: { inFlight: 0, settledAt: S }, documentStartedAt: T, continuationAt: S + 15_000 }), true);
  for (const D of [T + 10_000, T + 30_000]) {
    const bound = Math.max(D + 15_000, T + 35_000);
    assert.equal(noneIsFinal({ sentAt: T, documentStartedAt: D, continuationAt: bound - 1 }), false, `inherited at ${D - T}`);
    assert.equal(noneIsFinal({ sentAt: T, documentStartedAt: D, continuationAt: bound }), true, `inherited at ${D - T}`);
  }

  const purchase = await freshDocument();
  const { controller, time, stored } = setup(purchase);
  const { key } = controller.dispatch();
  time.now += 1_000_000;
  const inFlight = await proceed(controller, 'resume', refusedWith('starter_checkout_not_found'));
  assert.equal(inFlight.outcome.kind, 'none');
  assert.equal(inFlight.outcome.code, 'starter_checkout_in_progress', 'never final while the create is in flight');
  assert.equal(inFlight.outcome.text, 'starter_checkout_in_progress');
  controller.settled(key);
  const settledAt = time.now;
  // Each answer arrives 30 s after dispatch; the decision uses the continuation's dispatch time.
  for (const [action, reply] of [['resume', refusedWith('starter_checkout_not_found')], ['abandon', succeeded({ abandoned: false })]] as const) {
    time.now = settledAt + 14_999;
    const slow = await proceed(controller, action, () => { time.now += 30_000; return reply(); });
    assert.equal(slow.outcome.code, 'starter_checkout_in_progress', action);
    assert.equal(stored().id, key, action);
  }
  time.now = settledAt + 15_000;
  const final = await proceed(controller, 'resume', refusedWith('starter_checkout_not_found'));
  assert.equal(final.outcome.code, 'starter_checkout_not_found');
  assert.equal(stored(), null);

  const T2 = 5_000_000;
  for (const [D, bound] of [[T2 + 10_000, T2 + 35_000], [T2 + 30_000, T2 + 45_000]] as const) {
    const data = new Map<string, string>();
    const page = setup(await freshDocument(), data, D);
    data.set(storageKey(page.configuration), JSON.stringify({ v: 1, id: key, sentAt: T2 }));
    assert.equal(page.controller.pending(), true, 'the inherited record opens the panel on load');
    page.time.now = bound - 1;
    assert.equal((await proceed(page.controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_in_progress');
    page.time.now = bound;
    assert.equal((await proceed(page.controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_not_found');
    assert.equal(page.stored(), null);
  }
});

test('contradictions keep the record', async () => {
  const purchase = await freshDocument();
  for (const [action, reply] of [['resume', refusedWith('starter_checkout_not_found')], ['abandon', succeeded({ abandoned: false })]] as const) {
    const { controller, time, stored } = setup(purchase);
    await create(controller, refusedWith('starter_checkout_changed'));
    const before = stored();
    assert.equal(before.ordered, true);
    time.now += 1_000_000;
    const { outcome } = await proceed(controller, action, reply);
    assert.equal(outcome.kind, 'contradiction', action);
    assert.equal(outcome.code, 'starter_checkout_session_changed', action);
    assert.equal(outcome.text, 'starter_checkout_session_changed', action);
    assert.equal(outcome.choices, true, action);
    assert.deepEqual(stored(), before, action);
  }
  for (const operation of ['create', 'resume', 'abandon'] as const) {
    const { controller, stored, configuration } = setup(purchase);
    await create(controller, succeeded(pending('rcv_first')));
    const before = stored();
    assert.equal(before.orderRef, orderA);
    const other = operation === 'abandon' ? succeeded({ abandoned: true, orderRef: orderB })
      : succeeded({ orderRef: orderB, status: 'pending_payment', total, token: 'rcv_other' });
    const outcome = operation === 'create' ? (await create(controller, other)).outcome : (await proceed(controller, operation, other)).outcome;
    assert.equal(outcome.kind, 'contradiction', operation);
    assert.equal(outcome.code, 'starter_checkout_session_changed', operation);
    assert.equal(outcome.text, 'starter_checkout_session_changed', operation);
    // The host answered with another order: it is shown, and the record keeps the earlier one.
    assert.equal(outcome.value?.orderRef, orderB, operation);
    if (operation === 'abandon') {
      assert.equal(outcome.copy, 'recoveryCancelled', 'the shown order was cancelled');
      assert.equal(outcome.link, 'keep');
    } else {
      assert.equal(outcome.link, 'show', operation);
      assert.deepEqual(purchase.currentPurchase(configuration), { orderRef: orderB, token: 'rcv_other' }, operation);
    }
    assert.deepEqual({ ...stored(), sentAt: before.sentAt }, before, operation);
  }
});

test('storage faults fall back and never mask the answer', async () => {
  const purchase = await freshDocument();
  const denied = setup(purchase);
  denied.tab.faults.access = true;
  assert.equal(denied.controller.available(), false);
  assert.equal(denied.controller.current(), null);
  const full = setup(purchase);
  full.tab.faults.set = true;
  assert.equal(full.controller.available(), false, 'a probe write that fails selects the fallback');
  const dispatched = full.controller.dispatch();
  assert.match(dispatched.key, v4);
  assert.equal(dispatched.stored, false);
  assert.equal(full.controller.current()?.id, dispatched.key, 'the in-memory record still serves this document');
  assert.equal(full.controller.dispatch().key, dispatched.key);

  const answer = setup(purchase);
  const { key } = answer.controller.dispatch();
  answer.tab.faults.set = true;
  const changed = answer.controller.answer(key, { ok: false, code: 'starter_checkout_changed' });
  assert.equal(changed.kind, 'open');
  assert.equal(changed.code, 'starter_checkout_changed');
  assert.equal(changed.stored, false);
  assert.equal(answer.controller.current()?.ordered, true);
  answer.tab.faults.remove = true;
  const closed = answer.controller.answer(key, { ok: false, code: 'starter_checkout_paid' });
  assert.equal(closed.kind, 'closed');
  assert.equal(closed.code, 'starter_checkout_paid');
  assert.equal(closed.stored, false);
  assert.equal(answer.controller.current(), null);

  const ok = setup(purchase);
  assert.equal(ok.controller.available(), true);
  assert.equal(ok.tab.data.size, 0, 'the probe leaves nothing behind');

  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const [value, expected] of [
    [JSON.stringify({ v: 2, id, sentAt: 1 }), { v: 1, id }],
    [JSON.stringify({ v: 1, id, sentAt: 'later', ordered: true }), { v: 1, id }],
    [JSON.stringify({ v: 1, id, orderRef: orderA }), { v: 1, id }],
    [JSON.stringify({ v: 1, id, ordered: 'yes' }), { v: 1, id }],
    [JSON.stringify({ v: 1, id, sentAt: 7, ordered: true, orderRef: orderA }), { v: 1, id, sentAt: 7, ordered: true, orderRef: orderA }],
    [JSON.stringify({ v: 1, id: '0f8fad5b-d9cb-169f-a165-70867728950e', sentAt: 1 }), null],
    [JSON.stringify({ v: 1, id: id.toUpperCase() }), null],
    [JSON.stringify(['not', 'a', 'record']), null],
    ['{', null],
  ] as const) {
    const data = new Map<string, string>();
    const malformed = setup(purchase, data);
    data.set(storageKey(malformed.configuration), value);
    assert.deepEqual(malformed.controller.current(), expected, value);
    const next = malformed.controller.dispatch().key;
    if (expected) assert.equal(next, id, value);
    else assert.notEqual(next.toLowerCase(), id, value);
    assert.match(next, v4);
    assert.equal(malformed.stored().id, next, `${value} is replaced on the next dispatch`);
  }
});

test('start a different purchase follows only not abandonable or expired', async () => {
  const purchase = await freshDocument();
  for (const code of Object.keys(purchase.checkoutAnswerCodes)) {
    const { controller } = setup(purchase);
    const { key } = controller.dispatch();
    const result: ActionResult = { ok: false, code, ...(code === 'starter_dependency_unavailable' ? { status: 503 as const } : {}) };
    assert.equal(controller.answer(key, result).different, ['starter_checkout_not_abandonable', 'starter_checkout_expired'].includes(code), code);
  }
  const { controller, stored } = setup(purchase);
  const { key } = await create(controller, succeeded(pending('rcv_first')));
  assert.equal(controller.pending(), true);
  assert.equal(controller.startDifferent(), true);
  assert.equal(stored(), null);
  assert.equal(controller.pending(), false);
  const next = controller.dispatch().key;
  assert.match(next, v4);
  assert.notEqual(next, key);
});

test('completion clears only the order under the key', async () => {
  const purchase = await freshDocument();
  for (const [value, cleared] of [
    [{ orderRef: orderA, status: 'paid' }, true],
    [{ originalOrderRef: orderA, latestOrderRef: orderB, terminalStatus: 'paid' }, true],
    [{ originalOrderRef: orderB, latestOrderRef: orderA, terminalStatus: 'paid' }, false],
    [{ orderRef: orderB, status: 'cancelled' }, false],
    [{ status: 'paid' }, false],
    [null, false],
  ] as const) {
    const { controller, stored } = setup(purchase);
    await create(controller, succeeded(pending('rcv_first')));
    assert.equal(controller.completed(value), cleared, JSON.stringify(value));
    assert.equal(stored() === null, cleared, JSON.stringify(value));
  }
  const { controller, stored } = setup(purchase);
  await create(controller, refusedWith('starter_checkout_changed'));
  assert.equal(controller.completed({ orderRef: orderA, status: 'paid' }), false, 'an order of unknown reference is kept');
  assert.equal(stored().ordered, true);
});

test('a create lost in transport is final only after its request timeout plus the bound', async () => {
  const { noneIsFinal } = await freshDocument();
  const T = 1_000_000, S = T + 100;
  const early = { inFlight: 0, settledAt: S, lostUntil: T + 20_000 };
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: S + 15_000 }), false, 'an early transport error');
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: T + 34_999 }), false);
  assert.equal(noneIsFinal({ sentAt: T, create: early, documentStartedAt: T, continuationAt: T + 35_000 }), true);

  const purchase = await freshDocument();
  const { controller, time, stored } = setup(purchase);
  const start = time.now;
  const { key } = await create(controller, () => { time.now += 100; return lost(); });
  time.now = start + 100 + 15_000;
  assert.equal((await proceed(controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_in_progress');
  time.now = start + 34_999;
  assert.equal((await proceed(controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_in_progress');
  assert.equal(stored().id, key);
  time.now = start + 35_000;
  assert.equal((await proceed(controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_not_found');
  assert.equal(stored(), null);
});

test('a definite refusal of every create clears the dispatch time but keeps the key', async () => {
  const purchase = await freshDocument();
  const only = setup(purchase);
  const { key } = await create(only.controller, refusedWith('starter_terms_required'));
  assert.deepEqual(only.stored(), { v: 1, id: key });
  assert.equal(only.controller.pending(), false, 'no panel on load after an ordinary refusal');
  assert.equal(only.controller.dispatch().key, key);

  const afterLoss = setup(purchase);
  const first = await create(afterLoss.controller, lost);
  await create(afterLoss.controller, refusedWith('starter_command_conflict'));
  assert.equal(typeof afterLoss.stored().sentAt, 'number', 'an earlier lost create may still arrive');
  assert.equal(afterLoss.stored().id, first.key);

  const data = new Map<string, string>();
  const inherited = setup(await freshDocument(), data);
  data.set(storageKey(inherited.configuration), JSON.stringify({ v: 1, id: key, sentAt: 1 }));
  await create(inherited.controller, refusedWith('starter_terms_required'));
  assert.equal(typeof inherited.stored().sentAt, 'number', 'a create of an earlier document may still arrive');
});

test('an inherited create keeps its bound through a create of this document', async () => {
  const T = 5_000_000;
  for (const reply of [refusedWith('starter_terms_required'), refusedWith('starter_dependency_unavailable', 503)]) {
    const data = new Map<string, string>();
    const page = setup(await freshDocument(), data, T + 5_000);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    data.set(storageKey(page.configuration), JSON.stringify({ v: 1, id, sentAt: T }));
    const { key } = await create(page.controller, () => { page.time.now += 100; return reply(); });
    assert.equal(key, id);
    // The earlier document's create may reach the host until T + 20 s, then 15 s more.
    page.time.now = T + 5_100 + 15_000;
    assert.equal((await proceed(page.controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_in_progress');
    page.time.now = T + 34_999;
    assert.equal((await proceed(page.controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_in_progress');
    page.time.now = T + 35_000;
    assert.equal((await proceed(page.controller, 'resume', refusedWith('starter_checkout_not_found'))).outcome.code, 'starter_checkout_not_found');
  }
});

test('a stale view settles the record without replacing the shown purchase', async () => {
  const purchase = await freshDocument();
  const { controller, stored, configuration } = setup(purchase);
  purchase.rememberPurchase(configuration, { orderRef: orderB, token: 'rcv_shown' });
  const { key } = controller.dispatch();
  controller.settled(key, { ok: true, value: pending('rcv_late') });
  const outcome = controller.answer(key, { ok: true, value: pending('rcv_late') }, false);
  assert.equal(outcome.kind, 'open');
  assert.deepEqual(stored(), { v: 1, id: key, sentAt: stored().sentAt, ordered: true, orderRef: orderA });
  assert.deepEqual(purchase.currentPurchase(configuration), { orderRef: orderB, token: 'rcv_shown' });
});

test('in flight covers the creates and choices of this purchase', async () => {
  const purchase = await freshDocument();
  const { controller } = setup(purchase);
  assert.equal(controller.inFlight(), false);
  const { key } = controller.dispatch();
  assert.equal(controller.inFlight(), true);
  controller.settled(key, { ok: false, code: 'starter_transport_unavailable' });
  assert.equal(controller.inFlight(), false);
  let release!: (response: Response) => void;
  const held = withFetch(() => new Promise<Response>(done => { release = done; }), () => controller.continue('resume', 'en'));
  assert.equal(controller.inFlight(), true);
  release(refusedWith('starter_checkout_in_progress')());
  await held;
  assert.equal(controller.inFlight(), false);
});
