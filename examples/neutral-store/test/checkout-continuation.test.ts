// The checkout page's earlier-order answers and their managed texts. The record, the key and the create bookkeeping
// belong to `shared/storefront-bindings.ts` and are witnessed in `test/storefront-bindings.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StatusReading } from '@openlup/platform/storefront';
import { changedDetailsView, continuationView, orderStateFor, orderStateOf, type ContinuationView } from '../client/pages/checkout.ts';
import { continuationMessage } from '../client/purchase.ts';
import { market } from '../owned/market.config.ts';
import type { ActionResult } from '../shared/api.ts';
import { checkoutContinuationCopy } from '../shared/limits.ts';

const orderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const total = { amountMinor: 4200, currency: 'XTS' };
const refused = (code: string, status?: 503): ActionResult => ({ ok: false, code, ...(status ? { status } : {}) });
const value = (body: Record<string, unknown>): ActionResult => ({ ok: true, value: body });
const terminal: StatusReading = { kind: 'terminal' }, checking: StatusReading = { kind: 'checking' }, active: StatusReading = { kind: 'active' };

interface Row {
  name: string;
  operation: 'create' | 'resume' | 'abandon';
  answer: ActionResult;
  reading?: StatusReading;
  ordered?: boolean;
  view: Partial<ContinuationView> & Pick<ContinuationView, 'choices' | 'different' | 'link'>;
}

type Text = NonNullable<ContinuationView['text']>;
const coded = (code: Text) => ({ code, text: code });
const both = { choices: 'both', different: false, link: 'keep' } as const;
const gone = { choices: 'none', different: false, link: 'remove' } as const;
const notPayable: Row['view'] = { choices: 'resume', different: true, link: 'keep', ...coded('starter_checkout_not_payable') };

// The answer table of the earlier-order panel, row by row.
const rows: Row[] = [
  { name: 'abandon cancelled it', operation: 'abandon', answer: value({ abandoned: true, orderRef: orderA }), reading: terminal, view: { ...gone, text: 'abandoned' } },
  { name: 'abandon found none, not yet final', operation: 'abandon', answer: value({ abandoned: false }), reading: checking, view: { ...both, ...coded('starter_checkout_in_progress') } },
  { name: 'abandon found none under a recorded order', operation: 'abandon', answer: value({ abandoned: false }), reading: checking, ordered: true,
    view: { ...both, ...coded('starter_checkout_session_changed') } },
  { name: 'abandon found none, final', operation: 'abandon', answer: value({ abandoned: false }), reading: terminal, view: { ...gone, ...coded('starter_checkout_not_found') } },
  ...['paid', 'fulfillment_pending', 'fulfilled'].map(status => ({ name: `abandon found ${status}`, operation: 'abandon' as const,
    answer: value({ abandoned: false, orderRef: orderA, status }), reading: terminal, view: { ...gone, copy: 'recoveryPaid' as const } })),
  { name: 'abandon refused as paid', operation: 'abandon', answer: refused('starter_checkout_paid'), reading: terminal, view: { ...gone, copy: 'recoveryPaid' } },
  ...['cancelled', 'refunded'].map(status => ({ name: `abandon found ${status}`, operation: 'abandon' as const,
    answer: value({ abandoned: false, orderRef: orderA, status }), reading: terminal, view: { ...gone, copy: 'recoveryCancelled' as const } })),
  ...['expired', 'failed'].map(status => ({ name: `abandon found ${status}`, operation: 'abandon' as const,
    answer: value({ abandoned: false, orderRef: orderA, status }), reading: active, view: notPayable })),
  { name: 'abandon found a later unpaid order', operation: 'abandon', answer: value({ abandoned: false, orderRef: orderA, status: 'pending_payment' }), reading: active,
    view: { ...both, value: { abandoned: false, orderRef: orderA, status: 'pending_payment' } } },
  { name: 'abandon not abandonable', operation: 'abandon', answer: refused('starter_checkout_not_abandonable'), reading: active,
    view: { choices: 'resume', different: true, link: 'keep', ...coded('starter_checkout_not_abandonable') } },
  ...(['create', 'resume', 'abandon'] as const).map(operation => ({ name: `${operation} expired`, operation, answer: refused('starter_checkout_expired'),
    reading: checking, view: { ...both, different: true, ...coded('starter_checkout_expired') } })),
  ...(['create', 'resume'] as const).map(operation => ({ name: `${operation} not payable`, operation, answer: refused('starter_checkout_not_payable'), view: notPayable })),
  { name: 'create paid', operation: 'create', answer: refused('starter_checkout_paid'),
    view: { choices: 'resume', different: true, link: 'keep', ...coded('starter_checkout_paid') } },
  { name: 'resume read the order expired', operation: 'resume', answer: value({ orderRef: orderA, status: 'expired' }), view: notPayable },
  ...(['create', 'resume', 'abandon'] as const).map(operation => ({ name: `${operation} session changed`, operation,
    answer: refused('starter_checkout_session_changed'), reading: checking, view: { ...both, ...coded('starter_checkout_session_changed') } })),
  // The record stays: the buyer can submit the same details, cancel, or start a different purchase for other details.
  ...['paid', 'fulfillment_pending', 'fulfilled'].map(status => ({ name: `resume read ${status}`, operation: 'resume' as const,
    answer: value({ orderRef: orderA, status }), view: { ...gone, different: true, copy: 'recoveryPaid' as const } })),
  ...['cancelled', 'refunded'].map(status => ({ name: `resume read ${status}`, operation: 'resume' as const,
    answer: value({ orderRef: orderA, status }), view: { ...gone, different: true, copy: 'recoveryCancelled' as const } })),
  { name: 'resume found none', operation: 'resume', answer: refused('starter_checkout_not_found'),
    view: { choices: 'both', different: true, link: 'remove', code: 'starter_checkout_not_found', text: 'resumeNotFound' } },
  { name: 'resume limited', operation: 'resume', answer: refused('starter_attempt_limited'), view: { ...both, ...coded('starter_attempt_limited') } },
  { name: 'abandon limited', operation: 'abandon', answer: refused('starter_attempt_limited'), reading: checking, view: { ...both, ...coded('starter_attempt_limited') } },
  { name: 'resume without a token', operation: 'resume', answer: value({ orderRef: orderA, status: 'pending_payment', total }),
    view: { ...both, text: 'limited', value: { orderRef: orderA, status: 'pending_payment', total } } },
  { name: 'resume in progress', operation: 'resume', answer: refused('starter_checkout_in_progress'), view: { ...both, ...coded('starter_checkout_in_progress') } },
  { name: 'resume of a code without a managed text', operation: 'resume', answer: refused('starter_purchase_unavailable'), view: { ...both, code: 'starter_purchase_unavailable' } },
  { name: 'resume lost', operation: 'resume', answer: refused('starter_transport_unavailable'), view: { ...both, code: 'starter_transport_unavailable', uncertain: true } },
  { name: 'abandon unavailable', operation: 'abandon', answer: refused('starter_dependency_unavailable', 503), view: { ...both, code: 'starter_dependency_unavailable', uncertain: true } },
];

test('each earlier-order answer shows its code, texts, choices and link as the table says', () => {
  for (const row of rows) {
    assert.deepEqual(continuationView(row.answer, row.reading ?? null, row.operation, row.ordered ?? false), row.view, row.name);
  }
});

// Every answer that names the order's state updates what the page knows about it; an answer that names none leaves it.
test('each answer naming the order sets the known order state', () => {
  const rows: Array<[string, ActionResult | Record<string, unknown>, string | null]> = [
    ['create or resume, payable', value({ orderRef: orderA, status: 'pending_payment' }), 'payable'],
    ['host changed details', refused('starter_checkout_changed'), 'payable'],
    ['in progress', refused('starter_checkout_in_progress'), 'payable'],
    ...(['starter_checkout_not_payable', 'starter_checkout_paid', 'starter_checkout_expired', 'starter_checkout_not_abandonable'] as const)
      .map((code): [string, ActionResult, string] => [code, refused(code), code]),
    ...['expired', 'cancelled', 'refunded', 'failed'].map((status): [string, ActionResult, string] =>
      [`read ${status}`, value({ orderRef: orderA, status }), 'starter_checkout_not_payable']),
    ...['paid', 'fulfillment_pending', 'fulfilled'].map((status): [string, ActionResult, string] =>
      [`read ${status}`, value({ orderRef: orderA, status }), 'starter_checkout_paid']),
    // The payment-status page's own answers.
    ['payment status: replacement for an expired order', { originalOrderRef: orderA, latestOrderRef: orderA, recoverable: true, recoveryKind: 'recreate_expired' }, 'starter_checkout_not_payable'],
    ['payment status: paid', { originalOrderRef: orderA, terminalStatus: 'paid' }, 'starter_checkout_paid'],
    ['payment status: cancelled', { originalOrderRef: orderA, terminalStatus: 'cancelled' }, 'starter_checkout_not_payable'],
    ['payment status: read expired', { orderRef: orderA, status: 'expired' }, 'starter_checkout_not_payable'],
    ['payment status: payable', { orderRef: orderA, status: 'pending_payment' }, 'payable'],
    ['no order named', value({ abandoned: true }), null],
    ['transport', refused('starter_transport_unavailable'), null],
    ['other refusal', refused('starter_attempt_limited'), null],
  ];
  for (const [name, answer, state] of rows) {
    const result = 'ok' in answer ? answer as ActionResult : { ok: true as const, value: answer };
    assert.equal(orderStateOf(result)?.state ?? null, state, name);
    // A refusal names the state of the order under the key; a value names its order too.
    if (state !== null) assert.equal(orderStateOf(result)?.orderRef, result.ok ? orderA : undefined, name);
  }
});

// An answer that names an order sets the state only for a record that names the same order; an answer that names no
// order (a refusal of the record's own command) sets it for the record.
test('the known order state is set only for the order the record names', () => {
  const orderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const paidA = value({ originalOrderRef: orderA, terminalStatus: 'paid' });
  const expiredA = value({ orderRef: orderA, status: 'expired' });
  const rows: Array<[string, { orderRef?: string }, ActionResult, string | null]> = [
    ['same order', { orderRef: orderA }, paidA, 'starter_checkout_paid'],
    ['same order, read', { orderRef: orderA }, expiredA, 'starter_checkout_not_payable'],
    ['another order', { orderRef: orderB }, paidA, null],
    ['record without an order', {}, paidA, null],
    ['record without an order, read', {}, expiredA, null],
    ['refusal of the record\'s own command, record without an order', {}, refused('starter_checkout_not_payable'), 'starter_checkout_not_payable'],
    ['refusal, record with an order', { orderRef: orderB }, refused('starter_checkout_changed'), 'payable'],
  ];
  for (const [name, record, answer, state] of rows) assert.equal(orderStateFor(record, answer), state, name);
});

// Changed details name what is known about the recorded order: unpaid only when it is known payable.
test('changed details show the view of what is known about the recorded order', () => {
  const changed = { choices: 'both', different: false, link: 'keep', ...coded('starter_checkout_changed') };
  assert.deepEqual(changedDetailsView('payable'), changed);
  for (const code of ['starter_checkout_not_payable', 'starter_checkout_paid', 'starter_checkout_not_abandonable'] as const) {
    assert.deepEqual(changedDetailsView(code), { choices: 'resume', different: true, link: 'keep', ...coded(code) }, code);
  }
  assert.deepEqual(changedDetailsView('starter_checkout_expired'), { ...both, different: true, ...coded('starter_checkout_expired') });
  assert.deepEqual(changedDetailsView(null), { ...both, different: true, code: 'starter_checkout_changed', text: 'changedUnconfirmed' });
});

test('"Start a different purchase" is offered on every answer that names the earlier order not payable', () => {
  const offered = rows.filter(row => row.view.different).map(row => row.view.code ?? row.view.text ?? row.view.copy);
  assert.deepEqual([...new Set(offered)].sort(), ['recoveryCancelled', 'recoveryPaid', 'starter_checkout_expired', 'starter_checkout_not_abandonable',
    'starter_checkout_not_found', 'starter_checkout_not_payable', 'starter_checkout_paid']);
  for (const locale of market.locales) {
    const label = checkoutContinuationCopy.different[locale];
    for (const code of ['starter_checkout_not_payable', 'starter_checkout_paid', 'starter_checkout_expired'] as const) {
      const text = checkoutContinuationCopy[code][locale];
      assert.ok(text.includes(label), `${code} (${locale}) names "${label}"`);
      assert.doesNotMatch(text, /submit again|wyślij ponownie/iu, `${code} (${locale}) no longer says to submit again`);
    }
  }
});

test('the texts for an earlier order that may not exist claim no unpaid order and name every way out', () => {
  for (const locale of market.locales) {
    const label = checkoutContinuationCopy.different[locale];
    const unconfirmed = checkoutContinuationCopy.changedUnconfirmed[locale];
    const none = checkoutContinuationCopy.resumeNotFound[locale];
    for (const text of [unconfirmed, none]) assert.ok(text.includes(label), `${text} names "${label}"`);
    assert.doesNotMatch(unconfirmed, /is unpaid|jest nieopłacone/u, locale);
    const phrases: Readonly<Record<string, RegExp>> = { en: /may have created/u, pl: /mogło utworzyć/u };
    assert.match(unconfirmed, phrases[String(locale)] ?? /./u, locale);
    assert.doesNotMatch(none, /^No earlier order[^.]*\. Submit the form to place your order\.$/u, locale);
  }
});

test('the storage texts say what the page keeps and promise no send', () => {
  for (const locale of market.locales) {
    const notice = checkoutContinuationCopy.starter_storage_unavailable[locale];
    const refusedWrite = checkoutContinuationCopy.starter_checkout_storage_unavailable[locale];
    // Any market's locale list: only the locales that ship texts are checked by phrase.
    const phrases: Readonly<Record<string, readonly [RegExp, RegExp]>> = { en: [/until a reload/u, /nothing was sent/u], pl: [/do przeładowania/u, /niczego nie wysłano/u] };
    const [kept, nothingSent] = phrases[String(locale)] ?? [/./u, /./u];
    assert.match(notice, kept, locale);
    assert.match(refusedWrite, nothingSent, locale);
  }
});

test('managed texts fill in the request-limit wait', () => {
  for (const locale of market.locales) {
    for (const text of ['limited', 'starter_attempt_limited'] as const) {
      assert.match(continuationMessage(text, locale, 180_000), /\b3 min\b/, `${text} (${locale})`);
      // The wait is a point in time, not a deadline.
      assert.match(continuationMessage(text, locale, 180_000), /(?:\bin|\bza) 3 min\./u, `${text} (${locale})`);
      assert.doesNotMatch(continuationMessage(text, locale, 180_000), /\{minutes\}/);
    }
    assert.match(continuationMessage('starter_attempt_limited', locale, 60_001), /\b2 min\b/);
  }
});
