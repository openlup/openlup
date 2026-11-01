import { test, expect } from '@playwright/test';
import { messageDestinations, routes } from '../shared/routes.ts';
import { copy } from '../owned/copy.ts';

for (const locale of ['en', 'pl'] as const) {
  for (const destination of messageDestinations) {
    test(`${locale}: follows ${destination.id}`, async ({ page }) => {
      await page.goto(routes.destinations[locale]);
      const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: destination.id, exact: true }) });
      await row.getByRole('link').nth(locale === 'en' ? 0 : 1).click();
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('main')).not.toContainText(copy[locale].notFound);
    });
  }

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

  test(`${locale}: every unavailable account preference and private view refuses visibly`, async ({ page }) => {
    for (const path of [routes.account[locale], routes.limits[locale]]) {
      await page.goto(path);
      for (const key of ['savedAddresses', 'billing', 'deliveryPreference', 'paymentPreference', 'privateProfile', 'profileViews'] as const) {
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
  await page.goto(routes.builder.en);
  await page.getByRole('spinbutton').first().fill('1');
  await page.getByRole('button', { name: copy.en.addBox, exact: true }).click();
  await page.getByRole('button', { name: copy.en.checkout, exact: true }).click();
  await page.getByLabel(copy.en.termsAccept).check();
  await page.getByRole('button', { name: copy.en.placeOrder, exact: true }).click();
  await page.locator('main').getByRole('link', { name: copy.en.completion, exact: true }).click();
  await page.getByRole('button', { name: copy.en.simulatePaid, exact: true }).click();
  await expect(page.locator('main')).toContainText('paid');
});
