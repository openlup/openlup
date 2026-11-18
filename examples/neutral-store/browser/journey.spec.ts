import { market } from '../owned/market.config.ts';
import { test, expect } from '@playwright/test';
import { messageDestinations, routes } from '../shared/routes.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { copy } from '../owned/copy.ts';
import { quoteCopy, quoteRefusalCopy } from '../owned/quote-copy.ts';
import { configurations } from '../owned/store.config.ts';
import { deriveSubscriptionUnitPrice } from '@openlup/platform/pricing';

test('mixed-store installed quotes retain both purchase modes', async ({ request, baseURL }) => {
  const { config } = await (await request.get('/api/config')).json();
  const owned = configurations[config.id]!;
  const product = owned.offer.products[0]!;
  for (const mode of ['one_time', 'subscription'] as const) {
    const response = await request.post('/api/actions/offer.validate', {
      headers: { 'X-Starter-Request': '1', 'Idempotency-Key': crypto.randomUUID(), Origin: baseURL! },
      data: { acquisitionCapability: 'subscription-acquisition.v1', cart: { schemaVersion: 1,configuration: owned.id,
        mode,cadenceDays: mode === 'subscription' ? owned.offer.defaultCadenceDays : null,
        lines: [{ sku: product.sku,quantity: owned.offer.minUnits }] } },
    });
    const result = await response.json();
    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe(mode);
    const unitMinor = mode === 'one_time' ? product.unitPrice.amountMinor : deriveSubscriptionUnitPrice(product.unitPrice.amountMinor, {
      discountBps: owned.offer.subscriptionDiscountBps,roundingQuantumMinor: owned.offer.subscriptionRoundingQuantumMinor,roundingRule: 'FLOOR_TO_QUANTUM' });
    expect(result.value.lines[0].unitMinor).toBe(unitMinor);
    expect(result.value.totalMinor).toBeGreaterThan(0);
  }
});

for (const locale of market.locales) {
  test(`${locale}: quote refusals explain safe repairs and hide unknown payloads`, async ({ page }) => {
    let code = 'host_binding_required';
    await page.route('**/api/actions/offer.validate', route => route.fulfill({
      status: 422,json: { ok: false,code,details: { sql: 'private SQL' },message: 'private message' },
    }));
    for (const reason of ['host_binding_required', 'base_price_not_found', 'purchase_mode_unavailable', 'cadence_unavailable', 'unknown: private payload'] as const) {
      code = reason;
      await page.goto(routes.builder[locale]);
      await page.getByRole('spinbutton').first().fill('1');
      const result = page.locator('form.builder > [aria-live="polite"]');
      await expect(result).toHaveText(reason === 'unknown: private payload' ? quoteCopy[locale].unavailable : quoteRefusalCopy[locale][reason]);
      await expect(result).not.toContainText('private');
    }
  });

  test(`${locale}: failed quote refresh removes money and late success cannot restore it`, async ({ page }) => {
    const late: import('@playwright/test').Route[] = [];
    const { config } = await (await page.request.get('/api/config')).json();
    const currency = config.market.currency;
    await page.route('**/api/actions/offer.validate', async route => {
      const { cart } = route.request().postDataJSON();
      const quantity = cart.lines[0].quantity;
      if (quantity === 2) { late.push(route); return; }
      if (quantity === 3) { await route.fulfill({ json: { ok: false,code: 'base_price_not_found' } }); return; }
      await route.fulfill({ json: { ok: true,value: { ...cart,currency,
        lines: cart.lines.map((line: { sku: string; quantity: number }) => ({ ...line,baseUnitMinor: 1234,unitMinor: 1234,lineMinor: 1234 * line.quantity })),
        subtotalMinor: 1234 * quantity,discountMinor: 0,modeDiscountMinor: 0,shippingMinor: 0,totalMinor: 1234 * quantity } } });
    });
    await page.goto(routes.builder[locale]);
    const quantity = page.getByRole('spinbutton').first(), result = page.locator('form.builder > [aria-live="polite"]');
    await quantity.fill('1');
    await expect(result.locator('.summary')).toBeVisible();
    await quantity.fill('2');
    await expect(result).toHaveText(quoteCopy[locale].loading);
    await expect(page.locator('.builder-row').first().locator('p')).toHaveText('');
    await expect.poll(() => late.length).toBeGreaterThan(0);
    await quantity.fill('3');
    await expect(result).toHaveText(quoteRefusalCopy[locale].base_price_not_found);
    const responses = late.map(route => route.request().response());
    await Promise.all(late.map(route => route.fulfill({ json: { ok: true,value: {
      mode: 'one_time',currency,lines: [{ sku: route.request().postDataJSON().cart.lines[0].sku,quantity: 2,baseUnitMinor: 1234,unitMinor: 1234,lineMinor: 2468 }],
      subtotalMinor: 2468,discountMinor: 0,modeDiscountMinor: 0,shippingMinor: 0,totalMinor: 2468,
    } } })));
    await Promise.all(responses.map(async response => (await response)?.finished()));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(result).toHaveText(quoteRefusalCopy[locale].base_price_not_found);
    await expect(result.locator('.summary')).toHaveCount(0);
    await expect(page.locator('.builder-row').first().locator('p')).toHaveText('');
  });

  for (const destination of messageDestinations) {
    test(`${locale}: follows ${destination.id}`, async ({ page }) => {
      await page.goto(routes.destinations[locale]);
      const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: destination.id, exact: true }) });
      await row.getByRole('link').nth(market.locales.indexOf(locale)).click();
      await expect(page.locator('main h1')).toBeVisible();
      if (destination.hash) {
        await expect(page).toHaveURL(new RegExp(`#${destination.hash}$`));
        await expect(page.locator(`#${destination.hash}`)).toBeVisible();
      }
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('main')).not.toContainText(copy[locale].notFound);
    });
  }

  test(`${locale}: operator sign-in has separate localized email and private token forms`, async ({ page }) => {
    await page.goto(routes.admin[locale]);
    const forms = page.locator('#operator-sign-in form');
    await expect(forms).toHaveCount(2);
    await expect(forms.first().getByLabel(copy[locale].email, { exact: true })).toHaveAttribute('type', 'email');
    await expect(forms.first().getByRole('button', { name: copy[locale].operatorRequestSignIn, exact: true })).toBeVisible();
    const token = forms.nth(1).getByLabel(copy[locale].operatorToken, { exact: true });
    await expect(token).toHaveAttribute('type', 'password');
    await expect(token).toHaveAttribute('required', '');
    await expect(token).toHaveAttribute('maxlength', '43');
    await expect(token).toHaveAttribute('pattern', '(?:[A-Za-z0-9_]|-){43}');
    for (const value of ['x'.repeat(42), 'x'.repeat(44), '!'.repeat(43)]) {
      expect(await token.evaluate((input, candidate) => {
        (input as HTMLInputElement).value = candidate;
        return (input as HTMLInputElement).checkValidity();
      }, value)).toBe(false);
    }
    for (const value of ['x', '_', '-']) {
      await token.fill(value.repeat(43));
      expect(await token.evaluate(input => (input as HTMLInputElement).checkValidity())).toBe(true);
    }
    await expect(forms.nth(1).getByRole('button', { name: copy[locale].operatorRedeemToken, exact: true })).toBeVisible();
  });

  test(`${locale}: operator choices translate labels and preserve submitted wire values`, async ({ page }) => {
    await page.goto(routes.admin[locale]);
    const cases = [
      { section: '#reviews', field: 'action', operation: 'operator.reviewModerate', reference: 'reviewRef',
        choices: [
          ['publish', 'Publish', 'Opublikuj'], ['hide', 'Hide', 'Ukryj'],
        ] },
      { section: '#partners', field: 'status', operation: 'operator.partnerTransition', reference: 'id',
        choices: [
          ['contacted', 'Contacted', 'Nawiązano kontakt'], ['qualified', 'Qualified', 'Zakwalifikowano'],
          ['disqualified', 'Disqualified', 'Odrzucono'], ['closed_won', 'Closed — won', 'Zamknięto — pozyskano'],
          ['closed_lost', 'Closed — lost', 'Zamknięto — nie pozyskano'],
        ] },
    ];
    for (const item of cases) {
      // Observe the real form payload; a refusal response never fabricates an authorized action.
      await page.route(`**/api/actions/${item.operation}`, route => route.fulfill({
        status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'host_binding_required' }),
      }));
      const form = page.locator(`${item.section} form.action-form`);
      const select = form.locator(`select[name="${item.field}"]`);
      await expect(select.locator('option')).toHaveText(item.choices.map(choice => choice[{ en: 1, pl: 2 }[locale]]!));
      await form.locator(`input[name="${item.reference}"]`).fill('fictional-reference');
      for (const choice of item.choices) {
        await select.selectOption(choice[0]!);
        await expect(select).toHaveValue(choice[0]!);
        const request = page.waitForRequest(request => request.url().endsWith(`/api/actions/${item.operation}`));
        await form.getByRole('button', { name: copy[locale].save, exact: true }).click();
        expect((await request).postDataJSON()[item.field]).toBe(choice[0]);
        await expect(form.locator('.action-result')).toContainText('host_binding_required');
        await expect(form.getByRole('button', { name: copy[locale].save, exact: true })).toBeEnabled();
      }
    }
  });

  test(`${locale}: auxiliary copy, demo fields and product contents follow the active language`, async ({ page }) => {
    const text = copy[locale];
    await page.goto(routes.destinations[locale]);
    await expect(page.getByRole('columnheader').nth(1)).toHaveText(text.languageEnglish);
    await expect(page.getByRole('columnheader').nth(2)).toHaveText(text.languagePolish);
    await page.goto(routes.acquisition[locale]);
    await expect(page.getByLabel(text.acquisitionAddress, { exact: true })).toHaveValue(acquisitionAddresses[0]!.id);
    await expect(page.locator('main')).toContainText(acquisitionAddresses[0]!.label[locale]);
    await expect(page.locator('main [name=firstName], main [name=lastName]')).toHaveCount(0);
    await page.goto(routes.partners[locale]);
    await expect(page.getByLabel(text.company, { exact: true })).toHaveValue(text.demoCompany);
    await expect(page.getByLabel(text.lastName, { exact: true })).toHaveValue(text.demoPartner);
    await page.goto(routes.catalog[locale]);
    await page.getByRole('link', { name: text.details, exact: true }).first().click();
    await expect(page.locator('main')).toContainText(text.packContents);
    await expect(page.locator('main')).not.toContainText(' units');
    await page.goto(routes.builder[locale]);
    await page.getByRole('spinbutton').first().fill('2');
    await page.getByRole('button', { name: text.addBox, exact: true }).click();
    await page.getByRole('button', { name: text.checkout, exact: true }).click();
    await expect(page.getByLabel(text.lastName, { exact: true })).toHaveValue(text.demoCustomer);
    await expect(page.getByLabel(text.address, { exact: true })).toHaveValue(text.demoStreet);
    await expect(page.getByLabel(text.city, { exact: true })).toHaveValue(text.demoCity);
  });

  test(`${locale}: static support shows only text contact and the account link`, async ({ page }) => {
    for (const contact of [undefined, 'help@example.test']) {
      await page.route('**/api/config', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (contact === undefined) delete body.config.supportEmail;
        else body.config.supportEmail = contact;
        await route.fulfill({ response, json: body });
      });
      await page.goto(routes.support[locale]);
      await expect(page.locator('[data-support-contact]')).toHaveText(contact ?? copy[locale].supportContactAbsent);
      await expect(page.locator('main form')).toHaveCount(0);
      await expect(page.locator('[data-support-contact] a')).toHaveCount(0);
      await expect(page.locator('main').getByRole('link', { name: copy[locale].account, exact: true }))
        .toHaveAttribute('href', routes.account[locale]);
      await page.unroute('**/api/config');
    }
  });

  test(`${locale}: configuration failure uses only the active language`, async ({ page }) => {
    await page.route('**/api/config', route => route.fulfill({ status: 503, body: '{}' }));
    await page.goto(routes.admin[locale]);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('main h1')).toHaveText(copy[locale].applicationUnavailable);
    await expect(page).toHaveTitle(copy[locale].applicationUnavailable);
    await expect(page.locator('main code')).toHaveText('starter_configuration_unavailable');
  });

  test(`${locale}: browser cart survives navigation and reload`, async ({ page }) => {
    const text = copy[locale];
    await page.goto(routes.builder[locale]);
    const quantities = page.getByRole('spinbutton');
    await quantities.nth(0).fill('2');
    await page.getByLabel(text.purchaseMode, { exact: true }).selectOption('subscription');
    await page.getByRole('button', { name: text.addBox, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(routes.cart[locale]));
    await page.reload();
    await expect(page.getByRole('spinbutton').first()).toHaveValue('2');
    await expect(page.getByLabel(text.purchaseMode, { exact: true })).toHaveValue('subscription');
    await page.getByRole('button', { name: text.checkout, exact: true }).click();
    await expect(page.locator('main h1')).toHaveText(text.checkout);
  });

  test(`${locale}: limit action gives its named refusal without hiding the action`, async ({ page }) => {
    await page.goto(routes.auth[locale]);
    await page.getByRole('button', { name: copy[locale].google, exact: true }).click();
    await expect(page.locator('main')).toContainText('oauth_not_supported');
    await expect(page.getByRole('button', { name: copy[locale].google, exact: true })).toBeVisible();
  });

  test(`${locale}: method setup and saved account draft actions show their named refusals`, async ({ page }) => {
    for (const path of [routes.account[locale], routes.limits[locale]]) {
      await page.goto(path);
      for (const [name, code] of [
        [copy[locale].setupPaymentMethod, 'native_prepared_attempt_store_unsupported'],
        [copy[locale].resumeAccountDraft, 'starter_rich_oms_unavailable'],
      ] as const) {
        const action = page.locator('.refused-action').filter({ has: page.getByRole('button', { name, exact: true }) });
        await action.getByRole('button', { name, exact: true }).click();
        await expect(action).toContainText(code);
        await expect(action.getByRole('button', { name, exact: true })).toBeVisible();
      }
    }
  });

  test(`${locale}: remaining private and combined profile views refuse visibly`, async ({ page }) => {
    for (const path of [routes.account[locale], routes.limits[locale]]) {
      await page.goto(path);
      for (const key of ['privateProfile', 'profileViews'] as const) {
        const name = copy[locale][key];
        const action = page.locator('.refused-action').filter({ has: page.getByRole('button', { name, exact: true }) });
        await action.getByRole('button', { name, exact: true }).click();
        await expect(action).toContainText('starter_account_preferences_unavailable');
        await expect(action.getByRole('button', { name, exact: true })).toBeVisible();
      }
    }
    await expect(page.locator('main')).toContainText(copy[locale].lotTraceability);
  });
}

// This is deliberately a required, failing witness until the native path is actually bound.
// It must never be rewritten to accept a missing binding as a completed sandbox purchase.
test('completes sandbox purchase through the installed engine', async ({ page }) => {
  await page.goto(routes.builder[market.defaultLocale]);
  await page.getByRole('spinbutton').first().fill('1');
  await page.getByRole('button', { name: copy[market.defaultLocale].addBox, exact: true }).click();
  await page.getByRole('button', { name: copy[market.defaultLocale].checkout, exact: true }).click();
  await page.getByLabel(copy[market.defaultLocale].termsAccept).check();
  await page.getByRole('button', { name: copy[market.defaultLocale].placeOrder, exact: true }).click();
  await page.locator('main').getByRole('link', { name: copy[market.defaultLocale].completion, exact: true }).click();
  await page.getByRole('button', { name: copy[market.defaultLocale].simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText('paid');
});
