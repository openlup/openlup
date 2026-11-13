import { test, expect, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';

interface Fixture {
  email: string; identityMailbox: string; subscriptionId: string;
  nextCharge: { amountMinor: number; currency: string; chargeAt: string };
  order: { orderId: string; total: { amountMinor: number; currency: string } };
}
const field = (container: Locator, name: string) => container.locator(':scope > dt').filter({ hasText: new RegExp(`^${name}$`) }).locator('xpath=following-sibling::dd[1]');

test('customer reads the next charge and renewal order after the scheduled run', async ({ page }) => {
  const path = test.info().config.metadata.renewalFixture;
  if (typeof path !== 'string') throw new Error('starter_browser_renewal_fixture_required');
  const material: Fixture = JSON.parse(await readFile(path, 'utf8'));
  await page.goto(routes.auth.en);
  await page.getByLabel(copy.en.email, { exact: true }).fill(material.email);
  await page.getByRole('button', { name: copy.en.sendSignIn, exact: true }).click();
  await expect(page.locator('.action-result').first()).toContainText('accepted');
  const messages = (await readFile(material.identityMailbox, 'utf8')).trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
  const challenge = messages.filter(row => row.email === material.email).at(-1)?.token;
  if (typeof challenge !== 'string') throw new Error('starter_browser_renewal_challenge_missing');
  try {
    await page.getByLabel(copy.en.otp, { exact: true }).evaluate((element, value) => { (element as HTMLInputElement).value = value; }, challenge);
  } catch { throw new Error('starter_browser_renewal_challenge_control_failed'); }
  await page.getByRole('button', { name: copy.en.verifyOtp, exact: true }).click();
  await expect(page).toHaveURL(new URL(routes.account.en, page.url()).href);
  await page.goto(routes.account.en);
  const account = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: copy.en.account, exact: true }) });
  await account.getByRole('button', { name: copy.en.readStatus, exact: true }).click();
  const renewal = field(account.locator('[role=status] > dl'), 'renewal').locator(':scope > dl');
  const subscription = field(renewal, 'subscriptions').locator(':scope > ol > li > dl')
    .filter({ has: page.locator('dd', { hasText: material.subscriptionId }) });
  await expect(field(subscription, 'subscriptionId')).toHaveText(material.subscriptionId);
  const charge = field(subscription, 'nextCharge').locator(':scope > dl');
  await expect(field(charge, 'amountMinor')).toHaveText(String(material.nextCharge.amountMinor));
  await expect(field(charge, 'currency')).toHaveText(material.nextCharge.currency);
  await expect.soft(field(charge, 'chargeAt')).toHaveText(material.nextCharge.chargeAt);
  const orders = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: copy.en.orders, exact: true }) });
  await orders.getByRole('button', { name: copy.en.readStatus, exact: true }).click();
  const order = orders.locator('article[data-order]').filter({ has: page.getByRole('heading', { name: material.order.orderId, exact: true }) }).locator(':scope > dl');
  await expect.soft(order).toHaveCount(1);
  if (await order.count() !== 1) return;
  await expect(field(order, 'orderId')).toHaveText(material.order.orderId);
  const total = field(order, 'total').locator(':scope > dl');
  await expect(field(total, 'amountMinor')).toHaveText(String(material.order.total.amountMinor));
  await expect(field(total, 'currency')).toHaveText(material.order.total.currency);
});
