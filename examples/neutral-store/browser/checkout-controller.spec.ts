// The checkout page on the purchase-continuation controller, against installed PostgreSQL hosts: its three declared
// behaviour changes, the choices on an order that can no longer be paid, the quote refusal hook, records written before
// the bindings, tab storage that fails, and the stale-view rule.
// CI: titles start "checkout controller:", so the file runs in the remainder browser group (shard 6). Every case is
// independent of the store configuration, so it runs in the first project only.
// Quota: each case makes at most 3 metered creates and 2 repeats under keys of its own; beforeAll truncates the attempt
// ledger once per project, as the lost-response witness does.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { copy } from '../owned/copy.ts';
import { market } from '../owned/market.config.ts';
import { configurations } from '../owned/store.config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { runCheckoutRecovery } from '../host/paid-mail.ts';
import { createPrivateCapture } from '../host/private-capture.ts';
import { routes } from '../shared/routes.ts';
import { checkoutContinuationCopy } from '../shared/limits.ts';

interface Material { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string }
let material: Material, owner: pg.Pool, runtime: pg.Pool;
const locale = market.defaultLocale, t = copy[locale];
const managed = (key: keyof typeof checkoutContinuationCopy) => checkoutContinuationCopy[key][locale];

test.beforeAll(async ({ baseURL }, info) => {
  const entries: Material[] = JSON.parse(await readFile('.context/care-browser/fixtures.json', 'utf8'));
  const found = entries.find(row => row.id === info.project.name);
  if (!found || found.baseURL !== baseURL) throw new Error('starter_care_browser_fixture_required');
  material = found;
  owner = new pg.Pool({ connectionString: found.ownerUrl });
  runtime = new pg.Pool({ connectionString: found.runtimeUrl });
  // No case depends on the quota that earlier specs left in this installation.
  await owner.query('TRUNCATE public.commerce_checkout_attempt_ledger');
});
test.afterAll(async () => { await owner?.end(); await runtime?.end(); });
test.beforeEach(({ browserName: _browser }, info) => {
  test.skip(info.project.name !== 'supplements', 'configuration-independent');
});

const buyer = (label: string) => `controller-${label}-${randomUUID()}@example.test`;
const recordKey = () => `neutral-store:checkout-continuation:v1:${material.id}`;
const record = (page: Page) => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), recordKey());
const purchase = (page: Page) => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), `neutral-store:purchase:v2:${material.id}`);
const panel = (page: Page) => page.getByRole('region', { name: managed('heading') });
const choice = (page: Page, key: 'resume' | 'abandon' | 'different') => page.getByRole('button', { name: managed(key), exact: true });
const placeOrder = (page: Page) => page.getByRole('button', { name: t.placeOrder, exact: true });
const output = (page: Page) => page.locator('form.action-form .action-result');
const keyOf = (request: Request) => request.headers()['idempotency-key']!;
const isCreate = (request: Request) => request.url().endsWith('/api/actions/checkout.create');

async function orders(email: string): Promise<Array<{ id: string; status: string }>> {
  return (await owner.query(`SELECT o.id,o.status FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
    WHERE lower(c.email)=lower($1) ORDER BY o.created_at,o.id`, [email])).rows;
}

async function openCheckout(page: Page, units = configurations[material.id]!.offer.minUnits) {
  await page.goto(routes.builder[locale]);
  await page.getByLabel(t.purchaseMode, { exact: true }).selectOption('one_time');
  await page.getByRole('spinbutton').first().fill(String(units));
  await page.getByRole('button', { name: t.addBox, exact: true }).click();
  await page.getByRole('button', { name: t.checkout, exact: true }).click();
  await expect(placeOrder(page)).toBeVisible();
}
/** Types the buyer details and waits for the quote of exactly those details to settle. */
async function details(page: Page, email: string, line1?: string) {
  const quoted = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate')
    && row.request().postDataJSON().email === email && (line1 === undefined || row.request().postDataJSON().line1 === line1));
  if (line1 !== undefined) await page.getByLabel(t.address, { exact: true }).fill(line1);
  const field = page.getByLabel(t.email, { exact: true });
  await field.fill(email);
  await field.blur();
  await (await quoted).finished();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  await page.getByLabel(t.termsAccept).check();
}
/** Records every create the page sends. */
function creates(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', request => { if (isCreate(request)) sent.push(request); });
  return sent;
}
/** Places the order and waits for the payment link below the form. */
async function placed(page: Page): Promise<string> {
  const answered = page.waitForResponse(row => isCreate(row.request()));
  await placeOrder(page).click();
  const body = await (await answered).json();
  expect(body).toMatchObject({ ok: true, value: { status: 'pending_payment', token: expect.any(String) } });
  await expect(page.locator('main').getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  return body.value.orderRef;
}
/** Submits changed details: the page answers by itself, and the view shows once the command has ended. */
async function refusedAsChanged(page: Page, sent: Request[]) {
  const before = sent.length;
  await placeOrder(page).click();
  await expect(output(page)).toContainText(managed('starter_checkout_changed'));
  await expect(output(page)).toContainText('starter_checkout_changed');
  expect(sent.slice(before), 'no create is sent under changed details').toEqual([]);
}
async function call(page: Page, operation: string, data: Record<string, unknown>) {
  const answer = await page.request.post(`${material.baseURL}/api/actions/${operation}`, { data,
    headers: { Origin: material.baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID() } });
  return answer.json();
}
/** The initial-checkout sweep expires an unpaid order whose payment was declined and whose hold has lapsed. */
async function sweepExpired(page: Page, orderRef: string) {
  const { token } = await purchase(page);
  expect((await call(page, 'payment.simulate', { orderRef, token, outcome: 'refused' })).ok).toBe(true);
  await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [orderRef]);
  await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE purchase_order_id=$1", [orderRef]);
  await runCheckoutRecovery({ executor: runtime, config: configurations[material.id]!, publicOrigin: material.baseURL,
    capture: createPrivateCapture(resolve(material.state, '.context/captured-messages')) });
  expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [orderRef])).rows[0].status).toBe('expired');
}

// C1: the three declared behaviour changes, each with its revert control:
// (a) changed details send nothing (control: declare `update_in_place`, and a create is sent);
// (b) a create lost in transport is repeated once (control: classify an uncertain answer as `other`, and nothing is repeated);
// (c) an expired order keeps the record (control: `completed` clears on expired, and the record is gone).
test('checkout controller: changed details after a create send nothing and show the changed-details refusal', async ({ page }) => {
  const email = buyer('changed');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const orderRef = await placed(page);
  await details(page, email, '9 Changed Lane');
  await refusedAsChanged(page, sent);
  await expect(panel(page)).toBeFocused();
  expect(sent.map(keyOf)).toEqual([(await record(page)).id]);
  expect(await orders(email)).toEqual([{ id: orderRef, status: 'pending_payment' }]);
});

test('checkout controller: a create lost in transport is repeated once by the page under the same key', async ({ page }) => {
  const email = buyer('repeat');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  let count = 0;
  await page.route('**/api/actions/checkout.create', async (route: Route) => {
    if (++count > 1) return route.continue();
    await route.fetch();
    await route.abort();
  });
  await placeOrder(page).click();
  await expect(panel(page).getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  const key = (await record(page)).id;
  expect(sent.map(keyOf)).toEqual([key, key]);
  const rows = await orders(email);
  expect(rows).toEqual([{ id: expect.any(String), status: 'pending_payment' }]);
  await expect(panel(page)).toContainText(rows[0]!.id);
});

test('checkout controller: the payment-status page shows an expired order and keeps the record', async ({ page }) => {
  const email = buyer('expired');
  await openCheckout(page);
  await details(page, email);
  const orderRef = await placed(page);
  const kept = await record(page);
  await sweepExpired(page, orderRef);
  // The recovery read would offer a replacement order; without it the page reads the order itself, which the host
  // answers as expired. That read is where the page cleared the record before.
  await page.route('**/api/actions/checkout.recovery', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'starter_recovery_unavailable' }) }), { times: 1 });
  const read = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.read'));
  await page.goto(routes.completion[locale]);
  expect(await (await read).json()).toEqual({ ok: true, value: { status: 'expired', orderRef } });
  await expect(page.locator('main')).toContainText(t.recoveryExpired);
  expect(await record(page)).toEqual(kept);
});

test('checkout controller: an order expired by the sweep offers a different purchase, which places one new order', async ({ page }) => {
  const email = buyer('swept');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  await sweepExpired(page, first);
  await openCheckout(page);
  await expect(panel(page)).toBeVisible();
  await choice(page, 'resume').click();
  await expect(panel(page)).toContainText(managed('starter_checkout_not_payable'));
  await expect(panel(page)).toContainText('starter_checkout_not_payable');
  await choice(page, 'different').click();
  await expect(panel(page)).toContainText(managed('differentStarted'));
  expect(await record(page)).toBeNull();
  await details(page, email);
  await placed(page);
  expect(new Set(sent.map(keyOf)).size).toBe(2);
  expect((await orders(email)).map(row => row.status)).toEqual(['expired', 'pending_payment']);
});

test('checkout controller: starting over on a fulfilled order shows it paid, clears the record, and places one new order', async ({ page }) => {
  const email = buyer('fulfilled');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  const { token } = await purchase(page);
  expect((await call(page, 'payment.simulate', { orderRef: first, token, outcome: 'captured' })).ok).toBe(true);
  // Model the external host's fulfilled-order fact, as the acquisition care fixture does.
  await owner.query("UPDATE public.commerce_orders SET status='fulfilled' WHERE id=$1", [first]);
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await choice(page, 'abandon').click();
  await expect(panel(page)).toContainText(t.recoveryPaid);
  expect(await record(page)).toBeNull();
  await details(page, email);
  await placed(page);
  expect(new Set(sent.map(keyOf)).size).toBe(2);
  expect((await orders(email)).map(row => row.status)).toEqual(['fulfilled', 'pending_payment']);
});

test('checkout controller: a cart refusal before any order lets corrected details continue under the same key', async ({ page }) => {
  const email = buyer('cart-refusal');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  await page.route('**/api/actions/checkout.create', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'minimum_units' }) }), { times: 1 });
  await placeOrder(page).click();
  await expect(output(page)).toContainText('minimum_units');
  await details(page, email, '4 Corrected Lane');
  await placed(page);
  expect(sent.map(keyOf)).toEqual([sent[0]!.headers()['idempotency-key'], sent[0]!.headers()['idempotency-key']]);
  expect(sent[1]!.postDataJSON().line1).toBe('4 Corrected Lane');
  await expect(page.locator('main')).not.toContainText(managed('starter_checkout_changed'));
  expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
});

test('checkout controller: a price change answered to the automatic repeat runs the quote refusal hook', async ({ page }) => {
  const config = configurations[material.id]!;
  const seed = buildDemoSeed(config);
  const sku = seed.skus.find(row => row.sku === config.offer.products[0]!.sku)!;
  const price = seed.prices.find(row => row.variant_id === sku.id && row.mode === 'one_time')!;
  const reprice = async (delta: number) => {
    expect((await owner.query('UPDATE public.price_entries SET unit_price_minor=unit_price_minor+$2 WHERE id=$1', [price.id, delta])).rowCount).toBe(1);
  };
  const email = buyer('price');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  let count = 0;
  // The first create is lost before the host; the page's automatic repeat reaches it after the price changed.
  await page.route('**/api/actions/checkout.create', route => ++count === 1 ? route.abort() : route.continue());
  await reprice(137);
  try {
    const requoted = page.waitForRequest(row => row.url().endsWith('/api/actions/offer.validate') && row.postDataJSON().email === email);
    const repeated = page.waitForResponse(row => isCreate(row.request()) && count === 2);
    await placeOrder(page).click();
    expect(await (await repeated).json()).toEqual({ ok: false, code: 'starter_quote_price_changed' });
    await requoted;
    await expect(page.getByLabel(t.termsAccept)).not.toBeChecked();
    await expect(output(page)).toContainText('starter_quote_price_changed');
    expect(sent.map(keyOf)).toEqual([keyOf(sent[0]!), keyOf(sent[0]!)]);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    await page.getByLabel(t.termsAccept).check();
    await placed(page);
    expect(new Set(sent.map(keyOf)).size).toBe(1);
    expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
  } finally { await reprice(-137); }
});

for (const shape of ['without a dispatch time', 'with a dispatch time'] as const) {
  test(`checkout controller: a record from before the bindings (${shape}) keeps its key on the first submit`, async ({ page }) => {
    const email = buyer('earlier-record');
    const id = randomUUID();
    await page.goto(routes.builder[locale]);
    await page.evaluate(([key, value]) => { sessionStorage.setItem(key!, value!); },
      [recordKey(), JSON.stringify(shape === 'with a dispatch time' ? { v: 1, id, sentAt: Date.now() - 60_000 } : { v: 1, id })]);
    await openCheckout(page);
    if (shape === 'with a dispatch time') await expect(panel(page)).toBeVisible();
    await details(page, email);
    const sent = creates(page);
    await placed(page);
    expect(sent.map(keyOf)).toEqual([id]);
    expect(await record(page)).toMatchObject({ v: 1, id, fingerprint: expect.any(String), ordered: true });
    expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
  });
}

test('checkout controller: tab storage that fails after load moves the purchase to page memory under the same key', async ({ page }) => {
  const email = buyer('storage-later');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  await placed(page);
  const key = (await record(page)).id;
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  });
  await placeOrder(page).click();
  await expect(output(page)).toContainText(managed('starter_checkout_storage_unavailable'));
  await expect(output(page)).toContainText('starter_checkout_storage_unavailable');
  await expect(page.locator('[data-storage-notice]')).toContainText(managed('starter_storage_unavailable'));
  expect(sent.map(keyOf), 'nothing was sent').toEqual([key]);
  const replayed = page.waitForResponse(row => isCreate(row.request()));
  await placeOrder(page).click();
  expect(await (await replayed).json()).toMatchObject({ ok: true, replayed: true });
  expect(sent.map(keyOf)).toEqual([key, key]);
  await page.getByRole('button', { name: t.newAction, exact: true }).click();
  await placed(page);
  expect(sent).toHaveLength(3);
  expect(keyOf(sent[2]!)).not.toBe(key);
});

test('checkout controller: with tab storage blocked, changed details send nothing and offer to continue or start over', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  });
  const email = buyer('storage-blocked');
  await openCheckout(page);
  await expect(page.locator('[data-storage-notice]')).toBeVisible();
  await details(page, email);
  const sent = creates(page);
  await placed(page);
  await details(page, email, '5 Changed Lane');
  await refusedAsChanged(page, sent);
  await expect(choice(page, 'resume')).toBeVisible();
  await expect(choice(page, 'abandon')).toBeVisible();
  expect(sent).toHaveLength(1);
  expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
});

test('checkout controller: a late answer to a replaced view renders nothing and keeps the newer purchase', async ({ page }) => {
  const email = buyer('stale');
  await openCheckout(page);
  await details(page, email);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let first: string | undefined;
  let delivered!: () => void;
  const late = new Promise<void>(done => { delivered = done; });
  // The first create reaches the host; its answer is held until the buyer has moved on.
  await page.route('**/api/actions/checkout.create', async route => {
    if (first) return route.continue();
    const response = await route.fetch();
    first = (await response.json()).value.orderRef;
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  await placeOrder(page).click();
  await expect.poll(() => first).toEqual(expect.any(String));
  // The view is replaced in the same document: to the cart and back.
  await page.locator('header').getByRole('link', { name: t.cart, exact: true }).click();
  await page.getByRole('button', { name: t.checkout, exact: true }).click();
  await expect(panel(page)).toBeVisible();
  // The earlier order is answered as not payable, so the buyer starts a different purchase.
  await page.route('**/api/actions/checkout.continuation', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'starter_checkout_not_payable' }) }), { times: 1 });
  await choice(page, 'resume').click();
  await choice(page, 'different').click();
  await expect(panel(page)).toContainText(managed('differentStarted'));
  await details(page, email);
  const newer = await placed(page);
  const key = (await record(page)).id;
  release();
  await late;
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  expect((await purchase(page)).orderRef).toBe(newer);
  expect((await record(page)).id).toBe(key);
  await expect(page.locator('main')).not.toContainText(first!);
});
