import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { routes } from '../shared/routes.ts';
import { copy } from '../owned/copy.ts';
import { demoRecoveryConfiguration } from '../shared/recovery-config.ts';

interface Fixture { token: string; email: string; identityMailbox: string }
// The proof wrapper supplies a private fixture path, never credentials in metadata.
async function fixture(): Promise<Fixture> {
  const path = test.info().config.metadata.recoveryFixture;
  if (typeof path !== 'string') throw new Error('starter_browser_recovery_fixture_required');
  return JSON.parse(await readFile(path, 'utf8')) as Fixture;
}

test('recurring link is captured before application requests, signs in and authorizes only retry', async ({ page }) => {
  const material = await fixture();
  let leaked = false, inspected = false;
  await page.route('**/api/config', async route => {
    leaked ||= await page.evaluate(() => new URLSearchParams(location.search).has('token'));
    inspected = true;
    await route.continue();
  });
  // A still-active recurring capability cannot open guest checkout controls.
  try { await page.goto(`${routes.completion.en}?token=${encodeURIComponent(material.token)}`); }
  catch { throw new Error('starter_browser_completion_navigation_failed'); }
  await expect(page.locator('main')).toContainText(copy.en.recoveryUnavailable);
  await expect(page.getByRole('button', { name: copy.en.simulatePaid, exact: true })).toHaveCount(0);
  expect(page.url().includes(material.token)).toBe(false);
  // Sanitize navigation errors so a failed launch cannot print the bearer URL.
  try { await page.goto(`${routes.repair.en}?token=${encodeURIComponent(material.token)}`); }
  catch { throw new Error('starter_browser_recovery_navigation_failed'); }
  await expect(page.locator('main')).toContainText(demoRecoveryConfiguration.states.login_required.en);
  expect(inspected).toBe(true); expect(leaked).toBe(false);
  expect(page.url().includes(material.token)).toBe(false);
  // Re-enter through the actual application message link without a document reload.
  await page.goto(routes.destinations.en);
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'T07-03', exact: true }) });
  const entry = row.getByRole('link').first();
  try { await entry.evaluate((element, value) => element.setAttribute('href', value),
    `${routes.repair.en}?token=${encodeURIComponent(material.token)}`); }
  catch { throw new Error('starter_browser_recovery_entry_control_failed'); }
  try { await entry.click(); }
  catch { throw new Error('starter_browser_recovery_entry_click_failed'); }
  await expect(page.locator('main')).toContainText(demoRecoveryConfiguration.states.login_required.en);
  expect(page.url().includes(material.token)).toBe(false);
  await page.locator('main').getByRole('link', { name: copy.en.signIn, exact: true }).click();
  await page.getByLabel(copy.en.email, { exact: true }).fill(material.email);
  await page.getByRole('button', { name: copy.en.sendSignIn, exact: true }).click();
  await expect(page.locator('.action-result').first()).toContainText('accepted');
  const messages = (await readFile(material.identityMailbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const challenge = messages.filter(row => row.email === material.email).at(-1)?.token;
  if (typeof challenge !== 'string') throw new Error('starter_browser_recovery_challenge_missing');
  try {
    await page.getByLabel(copy.en.otp, { exact: true }).evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
    }, challenge);
  } catch { throw new Error('starter_browser_recovery_challenge_control_failed'); }
  await page.getByRole('button', { name: copy.en.verifyOtp, exact: true }).click();
  await expect(page.locator('main')).toContainText(demoRecoveryConfiguration.states.awaiting_confirmation.en);
  expect(page.url().includes(material.token)).toBe(false);
  // The same owner still cannot use that active token for initial checkout.
  try { await page.goto(`${routes.completion.en}?token=${encodeURIComponent(material.token)}`); }
  catch { throw new Error('starter_browser_completion_navigation_failed'); }
  await expect(page.locator('main')).toContainText(copy.en.recoveryUnavailable);
  await expect(page.getByRole('button', { name: copy.en.simulatePaid, exact: true })).toHaveCount(0);
  await page.goto(routes.repair.en);
  await expect(page.locator('main')).toContainText(demoRecoveryConfiguration.states.awaiting_confirmation.en);
  await page.getByRole('button', { name: copy.en.repairAction, exact: true }).click();
  await expect(page.locator('main')).toContainText(demoRecoveryConfiguration.states.authorized_retry.en);
  expect(page.url().includes(material.token)).toBe(false);
});
