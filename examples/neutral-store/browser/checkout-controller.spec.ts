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
// The specs after this one in the same installation share the requester's checkout quota (36 metered attempts per
// 180 s from one address); this spec spends about 40, so it leaves none of them behind.
test.afterAll(async () => {
  try {
    const { rows: [left] } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM public.commerce_checkout_attempt_ledger');
    expect(left!.n, 'metered checkout attempts this spec leaves for later specs').toBe(0);
  } finally { await owner?.end(); await runtime?.end(); }
});
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

/**
 * Counts each create answer the page has read and finished applying: the count moves in a task queued once the answer
 * is read, after the page's own continuation of that read, which runs in microtasks, has run.
 */
async function countCreatesRead(page: Page) {
  await page.addInitScript(() => {
    const json = Response.prototype.json;
    Response.prototype.json = function (this: Response) {
      const read = json.call(this);
      if (this.url.endsWith('/api/actions/checkout.create')) {
        void read.then(() => setTimeout(() => {
          const counter = window as unknown as { createsRead?: number };
          counter.createsRead = (counter.createsRead ?? 0) + 1;
        }, 0), () => {});
      }
      return read;
    };
  });
}
const createsRead = (page: Page, count: number) =>
  page.waitForFunction(expected => (window as unknown as { createsRead?: number }).createsRead === expected, count);

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

test('checkout controller: changed details after an expired order was refused as not payable keep that answer', async ({ page }) => {
  const email = buyer('expired-changed');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  await sweepExpired(page, first);
  await openCheckout(page);
  await details(page, email);
  const refused = page.waitForResponse(row => isCreate(row.request()));
  await placeOrder(page).click();
  expect(await (await refused).json()).toEqual({ ok: false, code: 'starter_checkout_not_payable' });
  await expect(output(page)).toContainText(managed('starter_checkout_not_payable'));
  await details(page, email, '2 Fixed Lane');
  await placeOrder(page).click();
  await expect(output(page)).toContainText(managed('starter_checkout_not_payable'));
  await expect(output(page)).toContainText('starter_checkout_not_payable');
  await expect(page.locator('main')).not.toContainText(managed('starter_checkout_changed'));
  await expect(choice(page, 'different')).toBeVisible();
  expect(sent).toHaveLength(2);
});

test('checkout controller: changed details after the payment-status page showed the order expired name it closed', async ({ page }) => {
  const email = buyer('status-expired');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  await sweepExpired(page, first);
  // The payment-status page reads the expired order (it offers to pay a replacement) and keeps the record.
  await page.goto(routes.completion[locale]);
  await expect(page.getByRole('button', { name: t.recoveryPay, exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText(first);
  await openCheckout(page);
  await details(page, email, '5 Returned Lane');
  await placeOrder(page).click();
  await expect(output(page)).toContainText(managed('starter_checkout_not_payable'));
  await expect(page.locator('main')).not.toContainText(managed('starter_checkout_changed'));
  await expect(choice(page, 'different')).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('checkout controller: the payment-status page reading an earlier order sets no state for a newer purchase', async ({ page }) => {
  const email = buyer('other-order');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  // The earlier order is paid on the payment-status page, which ends its purchase; its reload convenience stays.
  await page.locator('main').getByRole('link', { name: t.completion, exact: true }).click();
  await page.getByRole('button', { name: t.simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  await expect.poll(() => record(page)).toBeNull();
  // A newer purchase whose create is lost before the host: its record names no order.
  await openCheckout(page);
  await details(page, email);
  let newer: string | undefined;
  await page.route('**/api/actions/checkout.create', async route => {
    newer ??= keyOf(route.request());
    if (keyOf(route.request()) === newer) return route.abort();
    return route.continue();
  });
  await placeOrder(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(placeOrder(page)).toBeEnabled();
  expect(await record(page)).not.toHaveProperty('orderRef');
  // The payment-status page reads the earlier, paid order through the reload convenience.
  await page.goto(routes.completion[locale]);
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  await expect(page.locator('main')).toContainText(first);
  await openCheckout(page);
  await details(page, email, '7 Newer Lane');
  await placeOrder(page).click();
  await expect(output(page)).toContainText(managed('changedUnconfirmed'));
  await expect(page.locator('main')).not.toContainText(managed('starter_checkout_paid'));
  await expect(choice(page, 'abandon')).toBeVisible();
  await expect(choice(page, 'different')).toBeVisible();
  expect((await record(page)).id).toBe(newer);
  expect(sent.filter(request => keyOf(request) !== newer)).toHaveLength(1);
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

// A refusal the host answers only before writing any order (a cart issue, or a fresh create that arrived too late) lets
// corrected details be sent under the same key.
for (const code of ['minimum_units', 'starter_checkout_request_stale']) {
  test(`checkout controller: a refusal that wrote no order (${code}) lets corrected details continue under the same key`, async ({ page }) => {
    const email = buyer('no-order');
    await openCheckout(page);
    await details(page, email);
    const sent = creates(page);
    await page.route('**/api/actions/checkout.create', route => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, code }) }), { times: 1 });
    await placeOrder(page).click();
    await expect(output(page)).toContainText(code);
    await details(page, email, '4 Corrected Lane');
    await placed(page);
    expect(sent.map(keyOf)).toEqual([keyOf(sent[0]!), keyOf(sent[0]!)]);
    expect(sent[1]!.postDataJSON().line1).toBe('4 Corrected Lane');
    await expect(page.locator('main')).not.toContainText(managed('starter_checkout_changed'));
    await expect(page.locator('main')).not.toContainText(managed('changedUnconfirmed'));
    expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
  });
}

// A refusal the host can also answer while an order exists under the key keeps the key: corrected details send nothing,
// and the page says an order may exist, never that an unpaid one does, and names every way out.
for (const code of ['starter_purchase_unavailable', 'starter_attempt_limited', 'starter_command_conflict', 'starter_quote_unavailable']) {
  test(`checkout controller: after ${code}, corrected details send nothing and say an order may exist`, async ({ page }) => {
    const email = buyer('may-exist');
    await openCheckout(page);
    await details(page, email);
    const sent = creates(page);
    await page.route('**/api/actions/checkout.create', route => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, code }) }), { times: 1 });
    await placeOrder(page).click();
    await expect(output(page)).toContainText(code);
    await details(page, email, '6 Corrected Lane');
    await placeOrder(page).click();
    await expect(output(page)).toContainText(managed('changedUnconfirmed'));
    await expect(output(page)).toContainText('starter_checkout_changed');
    await expect(page.locator('main')).not.toContainText(managed('starter_checkout_changed'));
    expect(sent).toHaveLength(1);
    for (const key of ['resume', 'abandon', 'different'] as const) await expect(choice(page, key)).toBeVisible();
    await choice(page, 'different').click();
    await expect(panel(page)).toContainText(managed('differentStarted'));
    await placed(page);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[1]!)).not.toBe(keyOf(sent[0]!));
    expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
  });
}

test('checkout controller: resume finding no order leaves a way to start a different purchase', async ({ page }) => {
  const email = buyer('none-found');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  let first: string | undefined;
  // Every create under the first key is lost before the host, so no order exists under it.
  await page.route('**/api/actions/checkout.create', async route => {
    first ??= keyOf(route.request());
    if (keyOf(route.request()) === first) return route.abort();
    return route.continue();
  });
  await placeOrder(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(placeOrder(page)).toBeEnabled();
  await choice(page, 'resume').click();
  await expect(panel(page)).toContainText(managed('resumeNotFound'));
  await expect(panel(page)).toContainText('starter_checkout_not_found');
  for (const key of ['resume', 'abandon', 'different'] as const) await expect(choice(page, key)).toBeVisible();
  await details(page, email, '8 Other Lane');
  await choice(page, 'different').click();
  await expect(panel(page)).toContainText(managed('differentStarted'));
  await placed(page);
  expect(keyOf(sent.at(-1)!)).not.toBe(first);
  expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
});

test('checkout controller: after a resume finds the order paid, placing an order says so and offers a different purchase', async ({ page }) => {
  const email = buyer('paid-resume');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  const { token } = await purchase(page);
  expect((await call(page, 'payment.simulate', { orderRef: first, token, outcome: 'captured' })).ok).toBe(true);
  await page.reload();
  await choice(page, 'resume').click();
  await expect(panel(page)).toContainText(t.recoveryPaid);
  await details(page, email);
  await placeOrder(page).click();
  await expect(output(page)).toContainText('starter_checkout_paid');
  await expect(output(page)).toContainText(managed('starter_checkout_paid'));
  expect(sent).toHaveLength(1);
  await choice(page, 'different').click();
  await placed(page);
  expect(sent).toHaveLength(2);
  expect((await orders(email)).map(row => row.status)).toEqual(['paid', 'pending_payment']);
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
  await countCreatesRead(page);
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
  // The newer create's answer was read first; the late one is applied once the count reaches two.
  await createsRead(page, 2);
  expect((await purchase(page)).orderRef).toBe(newer);
  expect((await record(page)).id).toBe(key);
  await expect(page.locator('main')).not.toContainText(first!);
});

test('checkout controller: a late answer to a view replaced in the same purchase leaves the newer payment link', async ({ page }) => {
  const email = buyer('stale-same');
  await countCreatesRead(page);
  await openCheckout(page);
  await details(page, email);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let first: { orderRef: string; token: string } | undefined;
  let delivered!: () => void;
  const late = new Promise<void>(done => { delivered = done; });
  await page.route('**/api/actions/checkout.create', async route => {
    const response = await route.fetch();
    first = (await response.json()).value;
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  await placeOrder(page).click();
  await expect.poll(() => first).toEqual(expect.objectContaining({ orderRef: expect.any(String) }));
  const key = (await record(page)).id;
  await page.locator('header').getByRole('link', { name: t.cart, exact: true }).click();
  await page.getByRole('button', { name: t.checkout, exact: true }).click();
  await expect(panel(page)).toBeVisible();
  // The replacing view continues the same order and receives a newer token for it.
  const resumed = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'resume').click();
  const newer = (await (await resumed).json()).value;
  expect(newer).toMatchObject({ orderRef: first!.orderRef, token: expect.any(String) });
  expect(newer.token).not.toBe(first!.token);
  await expect(panel(page).getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  release();
  await late;
  await createsRead(page, 1);
  expect(await purchase(page)).toEqual({ orderRef: first!.orderRef, token: newer.token });
  expect((await record(page)).id).toBe(key);
  await expect(page.locator('form.action-form .action-result')).toBeEmpty();
});

test('checkout controller: tab storage that stops reading after load keeps the key', async ({ page }) => {
  const email = buyer('storage-read');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  await placed(page);
  const key = (await record(page)).id;
  await page.evaluate(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (this: Storage, name: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'SecurityError');
      return getItem.call(this, name);
    };
  });
  const replayed = page.waitForResponse(row => isCreate(row.request()));
  await placeOrder(page).click();
  expect(await (await replayed).json()).toMatchObject({ ok: true, replayed: true });
  expect(sent.map(keyOf)).toEqual([key, key]);
  expect((await orders(email)).map(row => row.status)).toEqual(['pending_payment']);
});

test('checkout controller: a start-over answer is shown when tab storage refuses to clear the record', async ({ page }) => {
  const email = buyer('storage-clear');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  await details(page, email, '3 Edited Lane');
  await refusedAsChanged(page, sent);
  await page.evaluate(() => {
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (this: Storage, name: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'SecurityError');
      return removeItem.call(this, name);
    };
  });
  await choice(page, 'abandon').click();
  await expect(panel(page)).toContainText(managed('abandoned'));
  await expect(page.locator('[data-storage-notice]')).toBeVisible();
  // The cancelled order's key is not reused: the next submit places a new order under a new key.
  await placed(page);
  expect(sent).toHaveLength(2);
  expect(keyOf(sent[1]!)).not.toBe(keyOf(sent[0]!));
  expect((await orders(email)).map(row => row.id === first ? 'first ' + row.status : row.status)).toEqual(['first cancelled', 'pending_payment']);
});

test('checkout controller: a paid resume whose record cannot be cleared shows it paid and offers only a different purchase', async ({ page }) => {
  const email = buyer('paid-clear');
  await openCheckout(page);
  await details(page, email);
  const sent = creates(page);
  const first = await placed(page);
  const { token } = await purchase(page);
  expect((await call(page, 'payment.simulate', { orderRef: first, token, outcome: 'captured' })).ok).toBe(true);
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await page.evaluate(() => {
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (this: Storage, name: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'SecurityError');
      return removeItem.call(this, name);
    };
  });
  await choice(page, 'resume').click();
  await expect(panel(page)).toContainText(t.recoveryPaid);
  await expect(page.locator('[data-storage-notice]')).toBeVisible();
  await expect(choice(page, 'resume')).toHaveCount(0);
  await expect(choice(page, 'abandon')).toHaveCount(0);
  await expect(choice(page, 'different')).toBeVisible();
  // The paid order's record did not move to page memory: the next submit is a new purchase under a new key.
  await details(page, email);
  await placed(page);
  expect(sent).toHaveLength(2);
  expect(keyOf(sent[1]!)).not.toBe(keyOf(sent[0]!));
  expect((await orders(email)).map(row => row.status)).toEqual(['paid', 'pending_payment']);
});
