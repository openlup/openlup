import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import pg from 'pg';
import { dispatchAction, pendingBindings } from '../host/bindings.ts';
import { copy } from '../owned/copy.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { market } from '../owned/market.config.ts';
import { quoteCopy } from '../owned/quote-copy.ts';
import { configurations } from '../owned/store.config.ts';
import type { OfferQuote } from '../shared/offer.ts';
import { routes } from '../shared/routes.ts';

type Money = { amountMinor: number; currency: string };
const locale = market.defaultLocale;
const labels = copy[locale];
const createPath = '**/api/actions/checkout.create';
const reviewPath = '**/api/actions/offer.validate';
const priceChanged = { ok: false, code: 'starter_quote_price_changed' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function isCheckoutReview(response: Response) {
  return response.url().endsWith('/api/actions/offer.validate') && response.request().postDataJSON().firstName;
}

async function checkout(page: Page, quantity: number) {
  await page.goto(routes.builder[locale]);
  await page.getByRole('spinbutton').first().fill(String(quantity));
  await page.getByLabel(labels.purchaseMode, { exact: true }).selectOption('one_time');
  await page.getByRole('button', { name: labels.addBox, exact: true }).click();
  const checked = page.waitForResponse(isCheckoutReview);
  await page.getByRole('button', { name: labels.checkout, exact: true }).click();
  const review = await (await checked).json();
  expect(review.ok).toBe(true);
  return review.value as OfferQuote & { expectedTotal?: Money };
}

function renderedTotal(page: Page, { amountMinor, currency }: Money) {
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100);
  return expect(page.locator('.summary dl > div').filter({ has: page.getByText(labels.total, { exact: true }) }))
    .toHaveText(labels.total + money);
}

test('one-time checkout preview displays its estimate and gates repeated submits', async ({ page }, info) => {
  const config = configurations[info.project.name]!;
  let reviews = 0;
  let creates = 0;
  await page.route(reviewPath, async route => {
    const input = route.request().postDataJSON();
    if (!input.firstName) return route.continue();
    reviews++;
    const estimate = await dispatchAction(pendingBindings(), 'offer.validate', input,
      { config, actor: { customerRef: null, operatorRef: null }, commandKey: 'preview-fixture' });
    await route.fulfill({ json: estimate });
  });
  await page.route(createPath, route => { creates++; return route.abort(); });

  const estimate = await checkout(page, config.offer.minUnits);
  const message = page.getByText('Checkout requires the installed store host.', { exact: true });
  const consent = page.getByText(labels.termsAccept, { exact: true });
  const submit = page.getByRole('button', { name: labels.placeOrder, exact: true });
  await renderedTotal(page, { amountMinor: estimate.totalMinor, currency: estimate.currency });
  await expect(message).toBeVisible();
  await expect(consent).toBeHidden();
  await expect(submit).toBeDisabled();
  for (let click = 0; click < 3; click++) await submit.evaluate((button: HTMLButtonElement) => button.click());
  await expect(message).toHaveCount(1);
  await expect(consent).toBeHidden();
  await expect(page.getByText(quoteCopy[locale].refresh)).toHaveCount(0);
  expect(reviews).toBe(1);
  expect(creates).toBe(0);
});

for (const outcome of ['changed total', 'same total', 'stale refusal', 'uncertain retry', 'failed refresh'] as const) {
  test(`one-time checkout reconfirms after ${outcome}`, async ({ page, baseURL }, info) => {
    const fixtures: { id: string; baseURL: string; ownerUrl: string }[] =
      JSON.parse(await readFile('.context/care-browser/fixtures.json', 'utf8'));
    const fixture = fixtures.find(row => row.id === info.project.name && row.baseURL === baseURL);
    if (!fixture) throw new Error('starter_checkout_browser_fixture_required');
    const config = configurations[fixture.id]!;
    const seed = buildDemoSeed(config);
    const sku = seed.skus.find(row => row.sku === config.offer.products[0]!.sku)!;
    const price = seed.prices.find(row => row.variant_id === sku.id && row.mode === 'one_time')!;
    const owner = new pg.Pool({ connectionString: fixture.ownerUrl });
    const reprice = async (amount: number) => {
      const result = await owner.query('UPDATE public.price_entries SET unit_price_minor=$2 WHERE id=$1', [price.id, amount]);
      expect(result.rowCount).toBe(1);
    };
    const effects = async () => (await owner.query(`SELECT
      (SELECT count(*) FROM public.clients) AS clients,
      (SELECT count(*) FROM public.commerce_checkout_attempt_ledger) AS attempts,
      (SELECT count(*) FROM public.commerce_orders) AS orders,
      (SELECT count(*) FROM public.commerce_order_items) AS items,
      (SELECT count(*) FROM public.commerce_order_draft_receipts) AS receipts,
      (SELECT count(*) FROM public.commerce_settlement_intents) AS intents,
      (SELECT count(*) FROM public.commerce_destination_bindings) AS destinations,
      (SELECT count(*) FROM public.fulfillment_inventory_reservations) AS reservations,
      (SELECT count(*) FROM public.commerce_promotion_claims) AS claims,
      (SELECT count(*) FROM public.outbox_events) AS events`)).rows[0];

    const release = deferred<void>();
    try {
      const before = await effects();
      const original = (await checkout(page, config.offer.minUnits)).expectedTotal!;
      await renderedTotal(page, original);
      const consent = page.getByLabel(labels.termsAccept);
      const submit = page.getByRole('button', { name: labels.placeOrder, exact: true });
      const form = page.locator('form').filter({ has: submit });
      const city = page.getByLabel(labels.city, { exact: true });
      const originalCity = await city.inputValue();
      const response = deferred<unknown>();
      const sent: { body: string; key: string }[] = [];
      const refusedAttempt = outcome === 'uncertain retry' ? 2 : 1;
      await page.route(createPath, async route => {
        const body = route.request().postData()!;
        const key = route.request().headers()['idempotency-key']!;
        sent.push({ body, key });
        if (outcome === 'uncertain retry' && sent.length === 1) {
          await route.abort();
        } else if (sent.length === refusedAttempt) {
          const upstream = await route.fetch();
          const body = await upstream.json();
          response.resolve({ status: upstream.status(), body: body.ok ? { ok: true } : body });
          await release.promise;
          await route.fulfill({ response: upstream });
        } else {
          await route.continue();
        }
      });

      await reprice(price.unit_price_minor + 137);
      await consent.check();
      await submit.click();
      if (outcome === 'uncertain retry') {
        await expect(form.getByText('starter_transport_unavailable')).toBeVisible();
        await submit.click();
      }
      expect(await response.promise).toEqual({ status: 409, body: priceChanged });
      expect(JSON.parse(sent[0]!.body).expectedTotal).toEqual(original);
      expect(await effects()).toEqual(before);
      if (outcome === 'uncertain retry') expect(sent[1]).toEqual(sent[0]);

      // Even a programmatic repeat while the response is held cannot create again.
      await form.dispatchEvent('submit');
      expect(sent).toHaveLength(refusedAttempt);

      if (outcome === 'changed total') {
        const { expectedTotal: _expectedTotal, ...input } = JSON.parse(sent[0]!.body);
        const headers = { Origin: baseURL!, 'X-Starter-Request': '1' };
        const latest = await page.request.post('/api/actions/offer.validate', {
          data: input, headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        });
        const reviewed = await latest.json();
        expect(reviewed.ok).toBe(true);
        const wrongCurrency = { ...reviewed.value.expectedTotal, currency: original.currency === 'USD' ? 'EUR' : 'USD' };
        for (const [data, code] of [
          [input, 'starter_expected_total_required'],
          [{ ...input, expectedTotal: wrongCurrency }, 'starter_quote_price_changed'],
        ] as const) {
          const invalid = await page.request.post('/api/actions/checkout.create', {
            data, headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
          });
          expect(invalid.status()).toBe(409);
          expect(await invalid.json()).toEqual({ ok: false, code });
          expect(await effects()).toEqual(before);
        }
      }

      if (outcome === 'same total') await reprice(price.unit_price_minor);
      if (outcome === 'stale refusal' || outcome === 'uncertain retry') {
        for (const value of [originalCity + ' Edited', originalCity]) {
          const edited = page.waitForResponse(row => isCheckoutReview(row) && row.request().postDataJSON().city === value);
          await city.fill(value);
          await city.blur();
          const reviewed = await (await edited).json();
          expect(reviewed.ok).toBe(true);
          await renderedTotal(page, reviewed.value.expectedTotal);
        }
        await consent.check();
      }

      if (outcome === 'failed refresh') {
        await page.route(reviewPath, route => route.fulfill({ status: 409, json: { ok: false, code: 'base_price_not_found' } }));
      }
      const refresh = page.waitForResponse(isCheckoutReview);
      release.resolve();
      const automatic = await refresh;
      let refreshed = await automatic.json();
      await expect(consent).not.toBeChecked();
      await expect(submit).toBeEnabled();
      if (outcome === 'failed refresh') {
        expect(refreshed).toEqual({ ok: false, code: 'base_price_not_found' });
        await expect(page.getByText(quoteCopy[locale].unavailable)).toBeVisible();
        await expect(page.locator('.summary')).toHaveCount(0);
        await page.unroute(reviewPath);
        const retry = page.waitForResponse(isCheckoutReview);
        await submit.click();
        const retried = await retry;
        expect(retried.request().postDataJSON()).toEqual(automatic.request().postDataJSON());
        refreshed = await retried.json();
        await expect(city).toHaveValue(originalCity);
        await expect(consent).not.toBeChecked();
        expect(sent).toHaveLength(refusedAttempt);
        expect(await effects()).toEqual(before);
      }

      expect(refreshed.ok).toBe(true);
      const current: Money = refreshed.value.expectedTotal;
      if (outcome === 'same total') expect(current).toEqual(original);
      else expect(current.amountMinor).not.toBe(original.amountMinor);
      await renderedTotal(page, current);
      await form.dispatchEvent('submit');
      expect(sent).toHaveLength(refusedAttempt);
      expect(await effects()).toEqual(before);

      await consent.check();
      const created = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.create'));
      await submit.click();
      expect(await (await created).json()).toMatchObject({ ok: true, value: { total: current } });
      expect(sent).toHaveLength(refusedAttempt + 1);
      const fresh = sent.at(-1)!;
      expect(fresh.key).not.toBe(sent[0]!.key);
      expect(JSON.parse(fresh.body).expectedTotal).toEqual(current);
      if (outcome === 'same total') expect(fresh.body).toBe(sent[0]!.body);
      expect(Number((await effects()).orders)).toBe(Number(before.orders) + 1);
    } finally {
      release.resolve();
      try { await reprice(price.unit_price_minor); }
      finally { await owner.end(); }
    }
  });
}
