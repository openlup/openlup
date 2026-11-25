import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createQuoteAcceptance } from '../client/quote-acceptance.ts';
import { actionForm } from '../client/forms.ts';
import type { PageContext } from '../client/context.ts';
import { configurations } from '../owned/store.config.ts';
import { dispatchAction, pendingBindings } from '../host/bindings.ts';

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

const unsigned = { ...quote, secondTotalMinor: undefined, acquisitionTerms: undefined, quoteAcceptance: null };
const oneTime = { ...unsigned, mode: 'one_time', cadenceDays: null };

async function fixture(t: TestContext, { initial = quote, render = true, integrated = false }: {
  initial?: typeof quote | typeof unsigned | typeof oneTime; render?: boolean; integrated?: boolean;
} = {}) {
  class Element extends EventTarget {
    isConnected = true;
    checked = false;
    name = '';
    value = '';
    hidden = false;
    parentElement: Element | null = null;
    attributes = new Map<string, string>();
    children: Element[] = [];
    append() {}
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); }
    replaceChildren() {}
    setAttribute(name: string, value: string) {
      if (name === 'name' || name === 'value') this[name] = value;
      this.attributes.set(name, value);
    }
    getAttribute(name: string) { return this.attributes.get(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    reportValidity() { return true; }
    control(name: string) { return this.children.flatMap(child => child.children).find(child => child.name === name); }
    querySelector(): Element | typeof fallbackConsent;
    querySelector(selector: string): Element | typeof fallbackConsent | undefined;
    querySelector(selector?: string) {
      if (selector === 'button[type="submit"]') return this.children.flatMap(child => child.children).find(child => child.getAttribute('type') === 'submit');
      return this.control('termsAccepted') ?? fallbackConsent;
    }
  }
  const fallbackConsent = { checked: false };
  let email = '';
  const cart = { mode: initial.mode, cadenceDays: initial.cadenceDays, lines: initial.lines };
  for (const [key, value] of Object.entries({
    Node: Element, FormData: class extends FormData {
      constructor(_form: unknown) { super(); if (email) this.set('email', email); }
    },
    document: { createElement: () => new Element(), createTextNode: () => new Element() },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const requests: { url: string; body: string; key: string; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, input: { body: string; headers: Record<string, string> }) =>
    new Promise<Response>((resolve, reject) => requests.push({ url, body: input.body, key: input.headers['Idempotency-Key']!, resolve, reject })));
  const summary = new Element();
  const displayed: unknown[] = [];
  const context = { config, locale: config.market.defaultLocale, getCart: () => cart,
    fragments: { checkoutSummary: (_context: PageContext, value: unknown) => { displayed.push(value); return new Element(); } },
    money: String, t: String } as unknown as PageContext;
  const controller = createQuoteAcceptance(context, summary as unknown as HTMLElement);
  if (integrated) email = 'buyer@example.test';
  const form = integrated ? actionForm(context, {
    operation: 'checkout.create', submit: 'placeOrder', input: controller.input, prepare: controller.prepare, onRefusal: controller.refused,
    fields: [{ name: 'email', label: 'email', value: email }, { name: 'termsAccepted', label: 'termsAccept', type: 'checkbox' }],
  }) as unknown as Element : new Element();
  const consent = form.querySelector();
  const input = { ...controller.input(), termsAccepted: true, ...(email ? { email } : {}) };
  const reply = (index: number, value: unknown) => requests[index]!.resolve(Response.json({ ok: true, value }));
  controller.attach(form as unknown as HTMLElement);
  await setImmediate();
  if (render) {
    reply(0, initial);
    await setImmediate();
    consent.checked = true;
  }
  return { form, controller, consent, input, reply, requests, displayed,
    editEmail(value: string) {
      email = value;
      const field = form.control('email');
      if (field) field.value = value;
      form.dispatchEvent(new Event('input'));
      form.dispatchEvent(new Event('change'));
    },
    async submit() { form.dispatchEvent(new Event('submit')); await setImmediate(); },
  };
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

test('one-time submit requires a matching rendered review and consent', async t => {
  const { controller, consent, input, reply, requests, editEmail } = await fixture(t, { initial: oneTime, render: false });
  consent.checked = true;
  assert.equal(await controller.prepare(input), null);
  reply(0, oneTime);
  await setImmediate();
  assert.equal(await controller.prepare(input), null);
  editEmail('  buyer@example.test  ');
  assert.deepEqual(JSON.parse(requests[1]!.body), { ...controller.input(), email: 'buyer@example.test' });
  consent.checked = true;
  const reviewedInput = { ...input, email: 'buyer@example.test', locale: 'en', quoteAcceptance: null };
  assert.equal(await controller.prepare(reviewedInput), null);
  reply(1, oneTime);
  await setImmediate();
  assert.equal(await controller.prepare(reviewedInput), null);
  consent.checked = true;
  assert.deepEqual(await controller.prepare(reviewedInput), { ...reviewedInput, expectedTotal: oneTime.expectedTotal });
  assert.equal(requests.length, 2);
});

test('term-less subscriptions submit the displayed payable and null signed acceptance', async t => {
  const { controller, input, reply } = await fixture(t, { initial: unsigned });
  const prepared = controller.prepare(input);
  reply(1, unsigned);
  assert.deepEqual(await prepared, { ...input, quoteAcceptance: null, expectedTotal: unsigned.expectedTotal });
});

test('the database-free checkout displays its estimate without submitting a purchase', async t => {
  const { form, consent, displayed, reply, requests, editEmail, submit } = await fixture(t, { initial: oneTime, render: false, integrated: true });
  const estimate = await dispatchAction(pendingBindings(), 'offer.validate', {
    cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] },
  }, { config, actor: { customerRef: null, operatorRef: null }, commandKey: 'preview-fixture' });
  assert.ok(estimate.ok);
  reply(0, estimate.value);
  await setImmediate();
  assert.deepEqual(displayed, [estimate.value]);
  assert.equal(consent.checked, false);
  assert.equal(form.control('termsAccepted')!.parentElement!.hidden, true);
  for (let click = 0; click < 3; click++) await submit();
  assert.equal(requests.length, 1);
  editEmail('other@example.test');
  reply(1, oneTime);
  await setImmediate();
  assert.equal(form.control('termsAccepted')!.parentElement!.hidden, false);
  assert.equal(consent.checked, false);
  await submit();
  assert.equal(requests.length, 2);
});

test('checkout limits document the kept key after a total refusal and exact uncertain retry', async () => {
  const limits = (await readFile(new URL('../docs/limits.md', import.meta.url), 'utf8')).replace(/\s+/gu, ' ');
  assert.match(limits, /Keep the command key after a definitive total refusal and reconfirm under it/u);
  assert.match(limits, /A page that retires the key accepts that an earlier create still in flight under the old key can place a second order/u);
  assert.match(limits, /uncertain retry keeps the exact payload and command key/u);
  assert.match(limits, /a refusal still counts toward the attempt limit/u);
});

test('one-time quote refresh refusal clears consent without retiring the command', async t => {
  const { controller, consent, reply, requests } = await fixture(t, { initial: oneTime });
  controller.refused('starter_quote_refresh_required', () => assert.fail('The command must keep its key'));
  assert.equal(consent.checked, false);
  assert.ok(requests[1]!.url.endsWith('offer.validate'));
  reply(1, oneTime);
  await setImmediate();
  assert.equal(consent.checked, false);
});

for (const code of ['starter_expected_total_required', 'starter_quote_price_changed']) {
  test(`a stale definitive ${code} retires the exact uncertain retry and refreshes review`, async t => {
    const { consent, editEmail, reply, requests, submit } = await fixture(t, { initial: oneTime, integrated: true });
    await submit();
    editEmail('another@example.test');
    editEmail('buyer@example.test');
    reply(3, oneTime);
    requests[1]!.reject(new Error('transport lost'));
    await setImmediate();
    consent.checked = true;
    await submit();
    assert.deepEqual([requests[4]!.url, requests[4]!.body, requests[4]!.key], [requests[1]!.url, requests[1]!.body, requests[1]!.key]);
    editEmail('another@example.test');
    editEmail('buyer@example.test');
    reply(6, oneTime);
    await setImmediate();
    consent.checked = true;
    requests[4]!.resolve(Response.json({ ok: false, code }, { status: 409 }));
    await setImmediate();
    assert.equal(consent.checked, false);
    assert.ok(requests[7]!.url.endsWith('offer.validate'));
    if (code === 'starter_expected_total_required') {
      requests[7]!.resolve(Response.json({ ok: false, code: 'base_price_not_found' }, { status: 409 }));
      await setImmediate();
      await submit();
      assert.ok(requests[8]?.url.endsWith('offer.validate'));
      assert.equal(requests[8]!.body, requests[7]!.body);
      reply(8, oneTime);
    } else {
      reply(7, oneTime);
    }
    await setImmediate();
    await submit();
    assert.equal(requests.filter(request => request.url.endsWith('checkout.create')).length, 2);
    consent.checked = true;
    await submit();
    const renewed = requests.at(-1)!;
    assert.ok(renewed.url.endsWith('checkout.create'));
    assert.equal(renewed.body, requests[1]!.body);
    assert.notEqual(renewed.key, requests[1]!.key);
    renewed.resolve(Response.json({ ok: true, value: null }));
  });
}
