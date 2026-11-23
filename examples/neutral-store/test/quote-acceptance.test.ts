import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createQuoteAcceptance } from '../client/quote-acceptance.ts';
import type { PageContext } from '../client/context.ts';
import { configurations } from '../owned/store.config.ts';

const config = Object.values(configurations)[0]!;
const now = Date.parse('2026-01-01T10:00:00Z');
const quote = {
  mode: 'subscription', cadenceDays: 28, currency: config.market.currency,
  lines: [{ sku: config.offer.products[0]!.sku, quantity: 1, unitMinor: 100, lineMinor: 100, baseUnitMinor: 120 }],
  subtotalMinor: 100, discountMinor: 10, modeDiscountMinor: 20, shippingMinor: 0, totalMinor: 90,
  expectedTotal: { amountMinor: 90, currency: config.market.currency }, secondTotalMinor: 95,
  acquisitionTerms: { schemaVersion: 'subscription-acquisition.v1', revision: 'offer-v1',
    initialDiscountBps: 1000, delivery2DiscountBps: 500, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null },
  observedAt: new Date(now).toISOString(), validUntil: new Date(now + 1000).toISOString(), quoteAcceptance: 'reviewed-token',
};
const equal = { ...quote, observedAt: new Date(now + 100).toISOString(),
  validUntil: new Date(now + 2000).toISOString(), quoteAcceptance: 'new-token' };

async function fixture(t: TestContext) {
  class Element extends EventTarget {
    isConnected = true;
    append() {}
    appendChild() {}
    replaceChildren() {}
    querySelector() { return consent; }
  }
  const consent = { checked: false };
  const cart = { mode: 'subscription', cadenceDays: 28, lines: quote.lines };
  for (const [key, value] of Object.entries({
    Node: Element, FormData: class extends FormData { constructor(_form: unknown) { super(); } },
    document: { createElement: () => new Element(), createTextNode: () => new Element() },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const requests: ((value: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => requests.push(resolve)));
  const form = new Element();
  const context = { config, locale: config.market.defaultLocale, getCart: () => cart,
    fragments: { checkoutSummary: () => new Element() }, money: String } as unknown as PageContext;
  const controller = createQuoteAcceptance(context, new Element() as unknown as HTMLElement);
  const input = { ...controller.input(), termsAccepted: true };
  const reply = (index: number, value: unknown) => requests[index]!(Response.json({ ok: true, value }));
  controller.attach(form as unknown as HTMLElement);
  await setImmediate();
  reply(0, quote);
  await setImmediate();
  consent.checked = true;
  return { form, cart, controller, consent, input, reply, requests };
}

test('equal observations submit the reviewed token and payable until the original deadline', async t => {
  const { controller, consent, input, reply } = await fixture(t);
  const prepared = controller.prepare(input);
  reply(1, equal);
  assert.deepEqual(await prepared, { ...input, quoteAcceptance: quote.quoteAcceptance, expectedTotal: quote.expectedTotal });
  assert.equal(consent.checked, true);
  t.mock.timers.setTime(now + 1000);
  const expired = controller.prepare(input);
  assert.equal(consent.checked, false);
  reply(2, equal);
  assert.equal(await expired, null);
});

for (const [label, value] of [
  ['cadence', { ...equal, cadenceDays: 56 }],
  ['second total', { ...equal, secondTotalMinor: 94 }],
  ['operative policy', { ...equal, acquisitionTerms: { ...equal.acquisitionTerms, effectiveTo: '2026-02-01T00:00:00Z' } }],
  ['missing token', { ...equal, quoteAcceptance: undefined }],
  ['invalid payable', { ...equal, expectedTotal: { ...equal.expectedTotal, amountMinor: 89 } }],
] as const) test(`${label} clears consent before submit`, async t => {
  const { controller, consent, input, reply } = await fixture(t);
  const prepared = controller.prepare(input);
  reply(1, value);
  assert.equal(await prepared, null);
  assert.equal(consent.checked, false);
});

test('stale completion, disconnect and expiry during a refresh cannot revive consent', async t => {
  const { controller, consent, input, reply, form } = await fixture(t);
  const stale = controller.prepare(input);
  const latest = controller.prepare(input);
  reply(2, { ...equal, secondTotalMinor: 94 });
  assert.equal(await latest, null);
  reply(1, equal);
  assert.equal(await stale, null);
  assert.equal(consent.checked, false);

  consent.checked = true;
  const disconnected = controller.prepare(input);
  form.isConnected = false;
  reply(3, equal);
  assert.equal(await disconnected, null);
  assert.equal(consent.checked, false);

  form.isConnected = true;
  const fresh = controller.prepare(input);
  reply(4, equal);
  assert.equal(await fresh, null);
  consent.checked = true;
  const expiredInFlight = controller.prepare(input);
  t.mock.timers.tick(2000);
  reply(5, { ...equal, validUntil: new Date(now + 3000).toISOString() });
  assert.equal(await expiredInFlight, null);
  assert.equal(consent.checked, false);
});

test('one-time submit passes through without refreshing', async t => {
  const { controller, cart, input, requests } = await fixture(t);
  cart.mode = 'one_time';
  assert.equal(await controller.prepare(input), input);
  assert.equal(requests.length, 1);
});
