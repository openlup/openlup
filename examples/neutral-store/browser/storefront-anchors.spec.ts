// Storefront anchors on the checkout form and the payment-status page, against installed PostgreSQL hosts.
// CI: titles start "storefront anchors:", so the file runs in the remainder browser group (shard 6).
// Quota: each case makes at most one metered create under a key of its own; beforeAll truncates the attempt ledger
// once per project, as the lost-response witness does.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { copy } from '../owned/copy.ts';
import { market } from '../owned/market.config.ts';
import { configurations } from '../owned/store.config.ts';
import { routes } from '../shared/routes.ts';

interface Material { id: string; baseURL: string; ownerUrl: string }
let material: Material, owner: pg.Pool;
const locale = market.defaultLocale, t = copy[locale];
const { attribute } = storefrontAnchor;
const action = (page: Page, name: string) => page.locator(`[${attribute.action}="${name}"]`);
const anyAction = (page: Page) => page.locator(`[${attribute.action}]`);
const states = (page: Page) => page.locator(`[${attribute.state}]`);

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

async function openCheckout(page: Page) {
  await page.goto(routes.builder[locale]);
  await page.getByLabel(t.purchaseMode, { exact: true }).selectOption('one_time');
  await page.getByRole('spinbutton').first().fill(String(configurations[material.id]!.offer.minUnits));
  await page.getByRole('button', { name: t.addBox, exact: true }).click();
  await page.getByRole('button', { name: t.checkout, exact: true }).click();
  await expect(page.getByRole('button', { name: t.placeOrder, exact: true })).toBeVisible();
}

/** B9: at most one element names a state; it is a status line with no form inside, outside the section that holds the forms. */
async function oneStateLine(page: Page, expected: string | null): Promise<void> {
  if (expected === null) { await expect(states(page)).toHaveCount(0); return; }
  await expect(states(page)).toHaveCount(1);
  const line = states(page).first();
  await expect(line).toHaveAttribute(attribute.state, expected);
  await expect(line).toHaveAttribute('role', 'status');
  await expect(line.locator('form')).toHaveCount(0);
  await expect(page.locator('section[aria-live]').filter({ has: page.locator(`[${attribute.state}]`) })).toHaveCount(0);
}

/** Exactly one visible element carries the action, inside a form, and it is that form's submit button. */
async function oneSubmit(page: Page, name: string): Promise<Locator> {
  await expect(action(page, name)).toHaveCount(1);
  const control = action(page, name).first();
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('type', 'submit');
  return control;
}

/** Clicks a control and waits until the page has replaced it, so the next step never acts on the previous view. */
async function advance(control: Locator): Promise<void> {
  const before = await control.elementHandle();
  await control.click();
  await expect.poll(() => before!.evaluate(element => element.isConnected)).toBe(false);
}

test('storefront anchors: the checkout form names its nine fields and place_order', async ({ page }) => {
  await openCheckout(page);
  for (const name of Object.values(storefrontAnchor.field)) {
    const control = page.locator(`[${attribute.field}="${name}"]`);
    await expect(control, name).toHaveCount(1);
    await expect(control, name).toBeVisible();
    expect(await control.evaluate(element => ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)), name).toBe(true);
  }
  await expect(page.locator(`[${attribute.field}]`)).toHaveCount(Object.keys(storefrontAnchor.field).length);
  const place = await oneSubmit(page, storefrontAnchor.action.place_order);
  await expect(place).toHaveAccessibleName(t.placeOrder);
  // No other action and no state on the checkout page yet.
  await expect(anyAction(page)).toHaveCount(1);
  await oneStateLine(page, null);
});

test('storefront anchors: the payment-status page names its state and offers retry_payment only after a decline', async ({ page, context }) => {
  await openCheckout(page);
  const email = page.locator(`[${attribute.field}="${storefrontAnchor.field.email}"]`);
  const quoted = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate'));
  await email.fill(`anchors-${randomUUID()}@example.test`);
  await email.blur();
  await (await quoted).finished();
  await page.locator(`[${attribute.field}="${storefrontAnchor.field.terms_accepted}"]`).check();
  const created = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.create'));
  await action(page, storefrontAnchor.action.place_order).click();
  expect((await (await created).json()).ok).toBe(true);
  await page.locator('main').getByRole('link', { name: t.completion, exact: true }).click();

  // The payable view: the first payment is not a retry.
  const firstPay = page.getByRole('button', { name: t.recoveryPay, exact: true });
  await expect(firstPay).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.awaiting_payment);
  await expect(firstPay).not.toHaveAttribute(attribute.action);
  await expect(anyAction(page)).toHaveCount(0);

  // A started attempt waits for the payment authority.
  await advance(firstPay);
  await expect(page.getByRole('button', { name: t.simulateDeclined, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.awaiting_authority);
  await expect(anyAction(page)).toHaveCount(0);

  // A decline offers the inline retry, the only action on the page.
  await advance(page.getByRole('button', { name: t.simulateDeclined, exact: true }));
  await expect(page.getByRole('button', { name: t.inlineRetry, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.declined);
  const inline = await oneSubmit(page, storefrontAnchor.action.retry_payment);
  await expect(inline).toHaveAccessibleName(t.inlineRetry);
  await expect(anyAction(page)).toHaveCount(1);

  // Without the continuation cookie the same declined attempt offers "pay again", which is the retry.
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('button', { name: t.recoveryPay, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.declined);
  const again = await oneSubmit(page, storefrontAnchor.action.retry_payment);
  await expect(again).toHaveAccessibleName(t.recoveryPay);
  await expect(page.getByRole('button', { name: t.inlineRetry, exact: true })).toHaveCount(0);
  await expect(anyAction(page)).toHaveCount(1);

  // An indeterminate outcome still waits for the authority.
  await advance(again);
  await expect(page.getByRole('button', { name: t.simulateIndeterminate, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.awaiting_authority);
  await advance(page.getByRole('button', { name: t.simulateIndeterminate, exact: true }));
  await expect(page.getByRole('button', { name: t.simulatePaid, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.awaiting_authority);
  await expect(anyAction(page)).toHaveCount(0);

  // A capture ends the payment; the page names no state while it shows the attempt as no longer payable.
  await advance(page.getByRole('button', { name: t.simulatePaid, exact: true }));
  await expect(page.getByRole('button', { name: t.simulatePaid, exact: true })).toHaveCount(0);
  await expect(anyAction(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  await oneStateLine(page, storefrontAnchor.state.paid);
});
