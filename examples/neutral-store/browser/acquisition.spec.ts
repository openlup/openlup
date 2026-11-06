import { test, expect } from '@playwright/test';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';

test('a discounted first-subscription purchase settled through the sandbox', async ({ page }) => {
  await page.goto(routes.builder.en);
  await page.getByRole('spinbutton').first().fill('1');
  await page.getByLabel(copy.en.purchaseMode, { exact: true }).selectOption('subscription');
  await page.getByRole('button', { name: copy.en.addBox, exact: true }).click();
  await page.getByRole('button', { name: copy.en.checkout, exact: true }).click();
  await page.getByLabel(copy.en.email, { exact: true }).fill(`acquisition-${crypto.randomUUID()}@example.test`);
  await page.getByLabel(copy.en.email, { exact: true }).blur();
  await expect(page.locator('main')).toContainText('Second delivery:');
  await expect(page.locator('.summary')).toBeVisible();
  await page.getByLabel(copy.en.termsAccept).check();
  const created = page.waitForResponse(response => response.url().endsWith('/api/actions/checkout.create'));
  await page.getByRole('button', { name: copy.en.placeOrder, exact: true }).click();
  const result = await (await created).json();
  expect(result.ok).toBe(true);
  await page.locator('main').getByRole('link', { name: copy.en.completion, exact: true }).click();
  await page.getByRole('button', { name: copy.en.simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText('paid');
});

test('quote and checkout refuse callers without acquisition capability by name', async ({ page }) => {
  await page.goto(routes.builder.en);
  const { config } = await (await page.request.get('/api/config')).json();
  const payload = { locale: 'en',configuration: config.id,country: config.market.country,
    termsAccepted: true,termsRevision: config.legal.revision,email: 'capability@example.test',
    firstName: 'Example',lastName: 'Buyer',phone: '00000',line1: '1 Example Lane',city: 'Example',postalCode: '00000',
    cart: { schemaVersion: 1,configuration: config.id,mode: 'subscription',cadenceDays: config.offer.defaultCadenceDays,
      lines: [{ sku: config.offer.products[0].sku,quantity: config.offer.minUnits }] } };
  for (const operation of ['offer.validate','checkout.create']) {
    const response = await page.request.post(`/api/actions/${operation}`, { data: payload,headers: {
      Origin: new URL(page.url()).origin,'X-Starter-Request': '1','Idempotency-Key': crypto.randomUUID(),
    } });
    expect(await response.json()).toEqual({ ok: false,code: 'acquisition_terms_capability_required' });
  }
});
