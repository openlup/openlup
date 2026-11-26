// Witness of one checkout key per purchase in a tab, against installed PostgreSQL hosts.
// CI: titles start "lost response:", so the file runs in the remainder browser group (shard 6). Locally it adds
// about 20 s of Playwright time for its 16 tests in both projects; the case-independent cases run in one project.
// Quota: each case makes at most 3 metered creates and 5 repeats under keys of its own, well inside the 36 creates and
// 36 repeats per requester per 180 s (12 repeats per key); beforeAll truncates the attempt ledger once per project.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { createPostgresAccountLinkStore } from '@openlup/platform/identity';
import { copy } from '../owned/copy.ts';
import { market } from '../owned/market.config.ts';
import { configurations } from '../owned/store.config.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { routes } from '../shared/routes.ts';
import * as limits from '../shared/limits.ts';

interface Material { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string }
type Mode = 'one_time' | 'subscription';
let material: Material, owner: pg.Pool;
const locale = market.defaultLocale, t = copy[locale];

/** Managed buyer texts, read lazily so this witness also loads against a client without them. */
function managed(key: string): string {
  const texts = (limits as unknown as { checkoutContinuationCopy?: Record<string, Record<string, string>> }).checkoutContinuationCopy;
  return texts?.[key]?.[locale] ?? `missing managed text: ${key}`;
}
const recordKey = () => `neutral-store:checkout-continuation:v1:${material.id}`;
const record = (page: Page) => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), recordKey());
const panel = (page: Page) => page.getByRole('region', { name: managed('heading') });
const choice = (page: Page, key: 'resume' | 'abandon' | 'different') => page.getByRole('button', { name: managed(key), exact: true });
const placeOrder = (page: Page) => page.getByRole('button', { name: t.placeOrder, exact: true });
const completionLink = (page: Page) => page.locator('main').getByRole('link', { name: t.completion, exact: true });
const output = (page: Page) => page.locator('form.action-form .action-result');
const keyOf = (request: Request) => request.headers()['idempotency-key']!;
const never = new Promise<never>(() => {});

test.beforeAll(async ({ baseURL }, info) => {
  const entries: Material[] = JSON.parse(await readFile('.context/care-browser/fixtures.json', 'utf8'));
  const found = entries.find(row => row.id === info.project.name);
  if (!found || found.baseURL !== baseURL) throw new Error('starter_care_browser_fixture_required');
  material = found;
  owner = new pg.Pool({ connectionString: found.ownerUrl });
  // No case depends on the quota that earlier specs left in this installation.
  await owner.query('TRUNCATE public.commerce_checkout_attempt_ledger');
});
test.afterAll(async () => { await owner?.end(); });

const onlySupplements = () => test.skip(test.info().project.name !== 'supplements', 'configuration-independent');
const buyer = (label: string) => `lost-${label}-${randomUUID()}@example.test`;

async function orders(email: string): Promise<Array<{ id: string; status: string }>> {
  return (await owner.query(`SELECT o.id,o.status FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
    WHERE lower(c.email)=lower($1) ORDER BY o.created_at,o.id`, [email])).rows;
}
async function heldOrders(email: string): Promise<string[]> {
  return (await owner.query(`SELECT DISTINCT r.purchase_order_id::text AS id FROM public.fulfillment_inventory_reservations r
    JOIN public.commerce_orders o ON o.id=r.purchase_order_id JOIN public.clients c ON c.id=o.client_id
    WHERE lower(c.email)=lower($1) AND r.status='held' ORDER BY 1`, [email])).rows.map(row => row.id);
}
async function held(orderId: string): Promise<number> {
  return (await owner.query("SELECT count(*)::int AS n FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 AND status='held'", [orderId])).rows[0].n;
}
async function startedOver(orderId: string): Promise<Array<string | null>> {
  return (await owner.query('SELECT failure_reason FROM public.commerce_settlement_intents WHERE order_id=$1', [orderId])).rows.map(row => row.failure_reason);
}
async function oneOrderAndOneHold(email: string): Promise<string> {
  const rows = await orders(email);
  expect(rows, `orders of ${email}`).toEqual([{ id: expect.any(String), status: 'pending_payment' }]);
  expect(await heldOrders(email)).toEqual([rows[0]!.id]);
  expect(await held(rows[0]!.id)).toBeGreaterThan(0);
  return rows[0]!.id;
}

async function openCheckout(page: Page, mode: Mode, units = configurations[material.id]!.offer.minUnits) {
  await page.goto(routes.builder[locale]);
  await page.getByLabel(t.purchaseMode, { exact: true }).selectOption(mode);
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
/** Submits and returns the create request and its parsed answer, or `lost` when the browser saw no answer. */
async function submit(page: Page): Promise<{ request: Request; answer: Record<string, unknown> | 'lost' }> {
  const sent = page.waitForRequest(row => row.url().endsWith('/api/actions/checkout.create'));
  // Only one of the two events happens; the other wait is left pending and never rejects the test.
  const failed = page.waitForEvent('requestfailed', row => row.url().endsWith('/api/actions/checkout.create')).then(() => 'lost' as const, () => never);
  const answered = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.create'))
    .then(row => row.json() as Promise<Record<string, unknown>>, () => never);
  await placeOrder(page).click();
  const request = await sent;
  const answer = await Promise.race([failed, answered]);
  await expect(placeOrder(page)).toBeEnabled();
  return { request, answer };
}
/** Changed details: the page sends no create and shows the host's changed-details code and managed text itself. */
async function changedDetails(page: Page) {
  const creates: Request[] = [];
  const count = (request: Request) => { if (request.url().endsWith('/api/actions/checkout.create')) creates.push(request); };
  page.on('request', count);
  try {
    await placeOrder(page).click();
    // The answer view is written once the command has ended, so no create of this submit can follow it.
    await expect(output(page)).toContainText(managed('starter_checkout_changed'));
    await expect(output(page)).toContainText('starter_checkout_changed');
    expect(creates, 'no create is sent under changed details').toEqual([]);
  } finally { page.off('request', count); }
}
/** The first create reaches the host and completes; its response is lost. Later creates pass. */
async function loseFirstResponse(page: Page, before?: (route: Route) => Promise<void>) {
  let count = 0;
  await page.route('**/api/actions/checkout.create', async route => {
    if (++count > 1) return route.continue();
    await before?.(route);
    await route.fetch();
    await route.abort();
  });
}

for (const mode of ['one_time', 'subscription'] as const) {
  test(`lost response: a reload and the same details keep one order and one hold (${mode === 'one_time' ? 'one-time' : mode})`, async ({ page }) => {
    const email = buyer(`reload-${mode}`);
    await openCheckout(page, mode);
    await details(page, email);
    let before: { id?: unknown; sentAt?: unknown } | null = null;
    let firstKey = '';
    await loseFirstResponse(page, async route => { firstKey = keyOf(route.request()); before = await record(page); });
    expect((await submit(page)).answer).toBe('lost');
    // The key is stored before the request leaves the browser.
    expect.soft(before, 'stored record before the response').toMatchObject({ id: firstKey, sentAt: expect.any(Number) });
    await expect.soft(panel(page)).toBeVisible();
    await page.reload();
    await expect.soft(panel(page), 'the panel shows on load').toBeVisible();
    await details(page, email);
    const second = await submit(page);
    expect.soft(keyOf(second.request), 'the reload reused the key').toBe(firstKey);
    // A subscription repeat carries a refreshed acceptance; the host treats the same stored terms as the same purchase.
    expect.soft(second.answer).toMatchObject({ ok: true, replayed: true, value: { status: 'pending_payment', token: expect.any(String) } });
    await expect(completionLink(page)).toBeVisible();
    // A second create under a new key would show here as a second order and a second hold.
    const orderRef = await oneOrderAndOneHold(email);
    expect((second.answer as { value: { orderRef: string } }).value.orderRef).toBe(orderRef);
  });
}

test('lost response: a create captured before the host and replayed after a reload keeps one order', async ({ page }) => {
  onlySupplements();
  const email = buyer('captured');
  await openCheckout(page, 'one_time');
  await details(page, email);
  let captured: { key: string; body: unknown } | undefined;
  // The page repeats a lost create once: every create under the first key is lost before the host.
  const capture = async (route: Route) => {
    captured ??= { key: keyOf(route.request()), body: route.request().postDataJSON() };
    if (keyOf(route.request()) !== captured.key) return route.continue();
    await route.abort();
  };
  await page.route('**/api/actions/checkout.create', capture);
  expect((await submit(page)).answer).toBe('lost');
  expect(await orders(email)).toEqual([]);
  await page.unroute('**/api/actions/checkout.create', capture);
  await page.reload();
  // The network delivers the captured request late, after the reload.
  const replay = await page.request.post(`${material.baseURL}/api/actions/checkout.create`, { data: captured!.body,
    headers: { Origin: material.baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': captured!.key } });
  expect(await replay.json()).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
  await details(page, email);
  const second = await submit(page);
  expect.soft(keyOf(second.request)).toBe(captured!.key);
  expect(second.answer).toMatchObject({ ok: true, replayed: true });
  await oneOrderAndOneHold(email);
});

test('lost response: a create lost before the host waits for finality, then starts over', async ({ page }) => {
  onlySupplements();
  await page.clock.install();
  const email = buyer('finality');
  await openCheckout(page, 'one_time');
  await details(page, email);
  let firstKey = '';
  // The page repeats a lost create once: every create under the first key is lost before the host.
  await page.route('**/api/actions/checkout.create', async route => {
    firstKey ||= keyOf(route.request());
    if (keyOf(route.request()) !== firstKey) return route.continue();
    await route.abort();
  });
  expect((await submit(page)).answer).toBe('lost');
  await expect(panel(page)).toBeVisible();
  const abandon = async (expected: unknown) => {
    const answered = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
    await choice(page, 'abandon').click();
    expect(await (await answered).json()).toEqual(expected);
  };
  await abandon({ ok: true, value: { abandoned: false } });
  await expect(panel(page)).toContainText('starter_checkout_in_progress');
  await expect(panel(page)).toContainText(managed('starter_checkout_in_progress'));
  expect((await record(page))?.id).toBe(firstKey);
  // A create lost in transport may still reach the host until the browser's request timeout, then 15 s more.
  await page.clock.fastForward(35_000);
  await abandon({ ok: true, value: { abandoned: false } });
  await expect(panel(page)).toContainText(managed('starter_checkout_not_found'));
  expect(await record(page)).toBeNull();
  const next = await submit(page);
  expect(keyOf(next.request)).not.toBe(firstKey);
  expect(next.answer).toMatchObject({ ok: true });
  await oneOrderAndOneHold(email);
});

test('lost response: corrected details are refused and completing payment pays the first order', async ({ page }) => {
  onlySupplements();
  const email = buyer('corrected');
  await openCheckout(page, 'one_time');
  await details(page, email);
  await loseFirstResponse(page);
  expect((await submit(page)).answer).toBe('lost');
  await details(page, email, '2 Corrected Lane');
  await changedDetails(page);
  await expect(page.locator('main')).not.toContainText(t.notSubmitted);
  await expect(panel(page)).toBeFocused();
  const [orderRef] = (await orders(email)).map(row => row.id);
  expect(await orders(email)).toEqual([{ id: orderRef, status: 'pending_payment' }]);
  const resumed = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'resume').click();
  expect(await (await resumed).json()).toMatchObject({ ok: true, value: { orderRef, status: 'pending_payment', token: expect.any(String) } });
  await expect(panel(page)).toBeFocused();
  const status = panel(page).getByRole('status');
  await expect(status).toContainText(orderRef!);
  const total = status.locator('[data-order-total]');
  await expect(total).not.toBeEmpty();
  const link = panel(page).getByRole('link', { name: t.completion, exact: true });
  // The order's own total precedes the way to pay it.
  expect(await total.evaluate((node, after) => Boolean(node.compareDocumentPosition(after!) & Node.DOCUMENT_POSITION_FOLLOWING), await link.elementHandle())).toBe(true);
  await link.click();
  await page.getByRole('button', { name: t.simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  await expect.poll(() => record(page)).toBeNull();
  await page.goto(routes.checkout[locale]);
  await expect(placeOrder(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  expect(await orders(email)).toEqual([{ id: orderRef, status: 'paid' }]);
});

test('lost response: a guest who corrects only the e-mail can continue or start over', async ({ page, browser }) => {
  onlySupplements();
  // Variant A: continue the first order.
  const first = buyer('email-first'), corrected = buyer('email-corrected');
  await openCheckout(page, 'one_time');
  await details(page, first);
  await loseFirstResponse(page);
  expect((await submit(page)).answer).toBe('lost');
  await details(page, corrected);
  await changedDetails(page);
  const resumed = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'resume').click();
  const firstOrder = await oneOrderAndOneHold(first);
  expect(await (await resumed).json()).toMatchObject({ ok: true, value: { orderRef: firstOrder, status: 'pending_payment' } });
  expect(await orders(corrected)).toEqual([]);

  // Variant B, in a new tab: start over under the corrected e-mail.
  const context = await browser.newContext({ baseURL: material.baseURL });
  try {
    const tab = await context.newPage();
    const earlier = buyer('email-earlier'), later = buyer('email-later');
    await openCheckout(tab, 'one_time');
    await details(tab, earlier);
    await loseFirstResponse(tab);
    expect((await submit(tab)).answer).toBe('lost');
    await details(tab, later);
    await changedDetails(tab);
    const refusedKey: string = (await record(tab)).id;
    const [cancelled] = (await orders(earlier)).map(row => row.id);
    const abandoned = tab.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
    await choice(tab, 'abandon').click();
    expect(await (await abandoned).json()).toEqual({ ok: true, value: { abandoned: true, orderRef: cancelled } });
    await expect(panel(tab)).toContainText(managed('abandoned'));
    expect(await startedOver(cancelled!)).toEqual(['checkout_started_over']);
    expect(await held(cancelled!)).toBe(0);
    expect(await orders(earlier)).toEqual([{ id: cancelled, status: 'cancelled' }]);
    const next = await submit(tab);
    expect(keyOf(next.request)).not.toBe(refusedKey);
    expect(next.answer).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
    await oneOrderAndOneHold(later);
  } finally { await context.close(); }
});

test('lost response: an edited cart is refused and starting over leaves one order and one hold', async ({ page }) => {
  onlySupplements();
  const email = buyer('cart');
  const units = configurations[material.id]!.offer.minUnits;
  await openCheckout(page, 'one_time', units);
  await details(page, email);
  const first = await submit(page);
  expect(first.answer).toMatchObject({ ok: true, value: { status: 'pending_payment', token: expect.any(String) } });
  await expect(completionLink(page)).toBeVisible();
  const firstOrder = await oneOrderAndOneHold(email);
  // The payment link stays while the order is open and goes when it is cancelled.
  await details(page, email, '3 Edited Lane');
  await changedDetails(page);
  await expect(completionLink(page)).toBeVisible();
  const abandoned = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'abandon').click();
  expect(await (await abandoned).json()).toEqual({ ok: true, value: { abandoned: true, orderRef: firstOrder } });
  await expect(panel(page)).toContainText(managed('abandoned'));
  await expect(panel(page)).toBeFocused();
  await expect(completionLink(page)).toHaveCount(0);
  expect(await record(page)).toBeNull();
  expect(await orders(email)).toEqual([{ id: firstOrder, status: 'cancelled' }]);
  expect(await held(firstOrder)).toBe(0);
  expect(await startedOver(firstOrder)).toEqual(['checkout_started_over']);
  // The next purchase has a new key; editing its cart afterwards is refused under that key.
  await openCheckout(page, 'one_time', units + 1);
  await details(page, email);
  const second = await submit(page);
  expect(keyOf(second.request)).not.toBe(keyOf(first.request));
  expect(second.answer).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
  await openCheckout(page, 'one_time', units);
  await details(page, email);
  await changedDetails(page);
  expect((await record(page)).id).toBe(keyOf(second.request));
  await expect(panel(page)).toBeVisible();
  const rows = await orders(email);
  expect(rows).toEqual([{ id: firstOrder, status: 'cancelled' }, { id: expect.any(String), status: 'pending_payment' }]);
  expect(await heldOrders(email)).toEqual([rows[1]!.id]);
  expect(await held(rows[1]!.id)).toBeGreaterThan(0);
});

test('lost response: a guest can pay after a retry without a reload', async ({ page }) => {
  onlySupplements();
  const email = buyer('retry');
  await openCheckout(page, 'one_time');
  await details(page, email);
  await loseFirstResponse(page);
  const sent: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/actions/checkout.create')) sent.push(keyOf(request)); });
  const first = await submit(page);
  expect(first.answer).toBe('lost');
  // The page repeats the lost create once by itself, under the same key, before the buyer's retry.
  await expect(panel(page).getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  expect(sent).toEqual([keyOf(first.request), keyOf(first.request)]);
  const retry = await submit(page);
  expect(keyOf(retry.request)).toBe(keyOf(first.request));
  expect(sent).toEqual([keyOf(first.request), keyOf(first.request), keyOf(first.request)]);
  expect(retry.answer).toMatchObject({ ok: true, replayed: true, value: { status: 'pending_payment', token: expect.any(String) } });
  await completionLink(page).click();
  await page.getByRole('button', { name: t.simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  expect((await orders(email)).map(row => row.status)).toEqual(['paid']);
});

test('lost response: blocked tab storage falls back to one in-memory key with a notice', async ({ page }) => {
  onlySupplements();
  // The cart uses local storage; only tab storage is blocked.
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  const email = buyer('storage');
  await openCheckout(page, 'subscription');
  await details(page, email);
  await expect(page.locator('main')).toContainText('starter_storage_unavailable');
  await expect(page.locator('main')).toContainText(managed('starter_storage_unavailable'));
  await expect(page.getByRole('button', { name: t.newAction, exact: true })).toBeVisible();
  await loseFirstResponse(page);
  const first = await submit(page);
  expect(first.answer).toBe('lost');
  const retry = await submit(page);
  expect(keyOf(retry.request)).toBe(keyOf(first.request));
  expect(retry.answer).toMatchObject({ ok: true, replayed: true });
  await oneOrderAndOneHold(email);
});

test('lost response: blocked tab storage keeps the key after a refused total', async ({ page }) => {
  onlySupplements();
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException('blocked', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  const config = configurations[material.id]!;
  const seed = buildDemoSeed(config);
  const sku = seed.skus.find(row => row.sku === config.offer.products[0]!.sku)!;
  const price = seed.prices.find(row => row.variant_id === sku.id && row.mode === 'one_time')!;
  const reprice = async (delta: number) => {
    const result = await owner.query('UPDATE public.price_entries SET unit_price_minor=unit_price_minor+$2 WHERE id=$1', [price.id, delta]);
    expect(result.rowCount).toBe(1);
  };
  const email = buyer('storage-total');
  await openCheckout(page, 'one_time');
  await details(page, email);
  await expect(page.locator('main')).toContainText('starter_storage_unavailable');
  await reprice(137);
  try {
    const reviewed = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate') && row.request().postDataJSON().email === email);
    const refused = await submit(page);
    expect(refused.answer).toEqual({ ok: false, code: 'starter_quote_price_changed' });
    const review = await (await reviewed).json();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    await expect(page.getByLabel(t.termsAccept)).not.toBeChecked();
    await page.getByLabel(t.termsAccept).check();
    const reconfirmed = await submit(page);
    // The refusal wrote nothing, so the in-memory key stays although the reviewed total changed.
    expect(keyOf(reconfirmed.request)).toBe(keyOf(refused.request));
    expect(reconfirmed.request.postDataJSON().expectedTotal).toEqual(review.value.expectedTotal);
    expect(reconfirmed.answer).toMatchObject({ ok: true, value: { total: review.value.expectedTotal } });
    await oneOrderAndOneHold(email);
  } finally { await reprice(-137); }
});

test('lost response: the panel is labelled, described and sends one request per choice', async ({ page }) => {
  onlySupplements();
  const email = buyer('panel');
  await openCheckout(page, 'one_time');
  await details(page, email);
  expect((await submit(page)).answer).toMatchObject({ ok: true });
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).not.toBeFocused();
  await expect(page.getByRole('button', { name: t.newAction, exact: true })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(t.idempotency);
  await expect(choice(page, 'abandon')).toHaveAccessibleDescription(managed('abandonDetail'));
  await expect(choice(page, 'different')).toHaveCount(0);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const requests: string[] = [];
  await page.route('**/api/actions/checkout.continuation', async route => {
    requests.push(route.request().postDataJSON().action);
    await gate;
    await route.continue();
  });
  const answered = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'resume').dblclick();
  await expect.poll(() => requests.length).toBe(1);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
  for (const key of ['resume', 'abandon'] as const) await expect(choice(page, key)).toBeDisabled();
  await expect(placeOrder(page)).toBeDisabled();
  release();
  expect(await (await answered).json()).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
  await expect(panel(page).getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  await expect(panel(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(choice(page, 'resume')).toBeEnabled();
  await expect(placeOrder(page)).toBeEnabled();
  expect(requests).toEqual(['resume']);
  await oneOrderAndOneHold(email);
});

test('lost response: a declined payment cannot be cancelled, and a different purchase creates one new order', async ({ page }) => {
  onlySupplements();
  const email = buyer('declined');
  const units = configurations[material.id]!.offer.minUnits;
  await openCheckout(page, 'one_time', units);
  await details(page, email);
  const first = await submit(page);
  expect(first.answer).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
  const firstOrder = (first.answer as { value: { orderRef: string } }).value.orderRef;
  await completionLink(page).click();
  const declined = page.waitForResponse(row => row.url().endsWith('/api/actions/payment.simulate'));
  await page.getByRole('button', { name: t.simulateDeclined, exact: true }).click();
  expect((await (await declined).json()).ok).toBe(true);
  await openCheckout(page, 'one_time', units + 1);
  await details(page, email);
  await changedDetails(page);
  const refused = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await choice(page, 'abandon').click();
  expect(await (await refused).json()).toEqual({ ok: false, code: 'starter_checkout_not_abandonable' });
  await expect(panel(page)).toContainText(managed('starter_checkout_not_abandonable'));
  await expect(choice(page, 'different')).toBeVisible();
  await expect(choice(page, 'different')).toHaveAccessibleDescription(managed('differentDetail'));
  await choice(page, 'different').click();
  await expect(panel(page)).toContainText(managed('differentStarted'));
  await expect(panel(page)).toBeFocused();
  expect(await record(page)).toBeNull();
  const next = await submit(page);
  expect(keyOf(next.request)).not.toBe(keyOf(first.request));
  expect(next.answer).toMatchObject({ ok: true, value: { status: 'pending_payment' } });
  const second = (next.answer as { value: { orderRef: string } }).value.orderRef;
  const rows = await orders(email);
  expect(rows).toEqual([{ id: firstOrder, status: 'pending_payment' }, { id: second, status: 'pending_payment' }]);
  expect(await startedOver(firstOrder)).not.toContain('checkout_started_over');
  expect(await held(second)).toBeGreaterThan(0);
});

/** The guest path of the acquisition spec's sign-in helper. */
async function signIn(page: Page, email: string) {
  const path = resolve(material.state, '.context/captured-messages/identity.jsonl');
  const prior = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.email === email).at(-1)?.token;
  await page.goto(new URL(routes.auth[locale], material.baseURL).href);
  await page.getByLabel(t.email, { exact: true }).fill(email);
  await page.getByRole('button', { name: t.sendSignIn, exact: true }).click();
  await expect(page.locator('.action-result').first()).toContainText('accepted');
  let token: string | undefined;
  await expect.poll(async () => {
    const messages = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    token = messages.filter(row => row.email === email && row.token !== prior).at(-1)?.token; return !!token;
  }).toBe(true);
  if (!token) throw new Error('starter_care_browser_challenge_required');
  // Keep private bearer values out of Playwright fill arguments and diagnostics.
  await page.getByLabel(t.otp, { exact: true }).evaluate((control, value) => { (control as HTMLInputElement).value = value; }, token);
  await page.getByRole('button', { name: t.verifyOtp, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(routes.account[locale]));
}

test('lost response: a signed-in buyer keeps one order across a reload', async ({ page }) => {
  onlySupplements();
  const email = buyer('signed-in');
  const accounts = createPostgresAccountLinkStore({ connectionString: material.runtimeUrl });
  try { await accounts.createAccount({ email, principalId: randomUUID(), acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' }); }
  finally { await accounts.close(); }
  await signIn(page, email);
  await openCheckout(page, 'one_time');
  await details(page, email);
  let firstKey = '';
  await loseFirstResponse(page, async route => { firstKey = keyOf(route.request()); });
  expect((await submit(page)).answer).toBe('lost');
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await details(page, email);
  const second = await submit(page);
  expect(keyOf(second.request)).toBe(firstKey);
  expect(second.answer).toMatchObject({ ok: true, replayed: true, value: { token: expect.any(String) } });
  await oneOrderAndOneHold(email);
});

test('lost response: an ordinary refusal keeps the key and opens no panel', async ({ page }) => {
  onlySupplements();
  const email = buyer('refusal');
  await openCheckout(page, 'one_time');
  await details(page, email);
  let refusedOnce = false;
  await page.route('**/api/actions/checkout.create', async route => {
    if (refusedOnce) return route.continue();
    refusedOnce = true;
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'starter_command_conflict' }) });
  });
  const first = await submit(page);
  expect(first.answer).toEqual({ ok: false, code: 'starter_command_conflict' });
  await expect(output(page)).toContainText(managed('starter_command_conflict'));
  await expect(panel(page)).toHaveCount(0);
  // The refusal wrote nothing: the key stays, but nothing asks for the panel on load.
  const kept = await record(page);
  expect(kept).toMatchObject({ v: 1, id: keyOf(first.request) });
  expect(kept).not.toHaveProperty('sentAt');
  await page.reload();
  await expect(placeOrder(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await details(page, email);
  const next = await submit(page);
  expect(keyOf(next.request)).toBe(keyOf(first.request));
  expect(next.answer).toMatchObject({ ok: true });
  await oneOrderAndOneHold(email);
});
