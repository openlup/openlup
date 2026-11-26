// Storefront anchors on the checkout form and the payment-status page, against installed PostgreSQL hosts.
// CI: titles start "storefront anchors:", so the file runs in the remainder browser group (shard 6).
// Quota: each case makes at most one metered create under a key of its own; beforeAll truncates the attempt ledger
// once per project, as the lost-response witness does.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { createPageHandle } from '@openlup/platform/storefront/testing';
import { copy } from '../owned/copy.ts';
import { market } from '../owned/market.config.ts';
import { configurations } from '../owned/store.config.ts';
import { routes } from '../shared/routes.ts';
import { checkoutContinuationCopy } from '../shared/limits.ts';

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

/**
 * B9: at most one element names a state; it is a status line with no form inside, outside the section that holds the
 * forms. The line has visible text, so the storefront page handle, which counts only anchors it can see, reports it.
 */
async function oneStateLine(page: Page, expected: string | null): Promise<void> {
  if (expected === null) { await expect(states(page)).toHaveCount(0); return; }
  await expect(states(page)).toHaveCount(1);
  const line = states(page).first();
  await expect(line).toHaveAttribute(attribute.state, expected);
  await expect(line).toHaveAttribute('role', 'status');
  await expect(line.locator('form')).toHaveCount(0);
  await expect(page.locator('section[aria-live]').filter({ has: page.locator(`[${attribute.state}]`) })).toHaveCount(0);
  expect((await createPageHandle(page).anchors()).filter(anchor => anchor.startsWith('state:'))).toEqual([`state:${expected}`]);
  await expect(line).not.toBeEmpty();
}

/** Exactly one visible element carries the action, inside a form, and it is that form's submit button. */
async function oneSubmit(page: Page, name: string): Promise<Locator> {
  await expect(action(page, name)).toHaveCount(1);
  const control = action(page, name).first();
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('type', 'submit');
  await expect(control.locator('xpath=ancestor::form')).toHaveCount(1);
  return control;
}

/** Clicks a control and waits until the page has replaced it, so the next step never acts on the previous view. */
async function advance(control: Locator): Promise<void> {
  const before = await control.elementHandle();
  if (before === null) throw new Error('storefront anchors: the control to click is not on the page');
  try {
    await control.click();
    await expect.poll(() => before.evaluate(element => element.isConnected), { message: 'the clicked view is replaced' }).toBe(false);
  } finally {
    await before.dispose();
  }
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

/** Fills the buyer details by their anchors and waits for the quote of exactly those details. */
async function fill(page: Page, email: string, line1?: string) {
  const quoted = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate') && row.request().postDataJSON().email === email
    && (line1 === undefined || row.request().postDataJSON().line1 === line1));
  if (line1 !== undefined) await page.locator(`[${attribute.field}="${storefrontAnchor.field.address_line1}"]`).fill(line1);
  const field = page.locator(`[${attribute.field}="${storefrontAnchor.field.email}"]`);
  await field.fill(email);
  await field.blur();
  await (await quoted).finished();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  await page.locator(`[${attribute.field}="${storefrontAnchor.field.terms_accepted}"]`).check();
}
const visibleAction = (page: Page, name: string) => page.locator(`[${attribute.action}="${name}"]:visible`);

test('storefront anchors: after a create the checkout page names awaiting_payment and one continue_payment', async ({ page }) => {
  await openCheckout(page);
  await fill(page, `anchors-created-${randomUUID()}@example.test`);
  await action(page, storefrontAnchor.action.place_order).click();
  await expect(page.locator('main').getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  await oneStateLine(page, storefrontAnchor.state.awaiting_payment);
  await expect(visibleAction(page, storefrontAnchor.action.continue_payment)).toHaveCount(1);
  await expect(visibleAction(page, storefrontAnchor.action.continue_payment)).toHaveAccessibleName(t.completion);
  await expect(action(page, storefrontAnchor.action.start_over)).toHaveCount(0);
});

test('storefront anchors: changed details name details_changed, continue_payment and start_over', async ({ page }) => {
  await openCheckout(page);
  const email = `anchors-changed-${randomUUID()}@example.test`;
  await fill(page, email);
  await action(page, storefrontAnchor.action.place_order).click();
  await expect(page.locator('main').getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  await fill(page, email, '7 Changed Lane');
  await action(page, storefrontAnchor.action.place_order).click();
  await expect(page.locator('form.action-form .action-result')).toContainText('starter_checkout_changed');
  await oneStateLine(page, storefrontAnchor.state.details_changed);
  await expect(visibleAction(page, storefrontAnchor.action.continue_payment)).toHaveCount(1);
  await expect(visibleAction(page, storefrontAnchor.action.start_over)).toHaveCount(1);
  // The payment link below the form still shows, so it, not the resume button, continues the payment.
  await expect(visibleAction(page, storefrontAnchor.action.continue_payment)).toHaveAccessibleName(t.completion);
  const resumed = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.continuation'));
  await page.getByRole('button', { name: checkoutContinuationCopy.resume[locale], exact: true }).click();
  expect((await (await resumed).json()).ok).toBe(true);
  await oneStateLine(page, storefrontAnchor.state.awaiting_payment);
  await expect(page.locator('[data-checkout-continuation]').getByRole('link', { name: t.completion, exact: true })).toBeVisible();
  await expect(visibleAction(page, storefrontAnchor.action.continue_payment)).toHaveCount(1);
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

  // A capture ends the payment. The page's next inspection shows the paid view, or, when it reads the attempt
  // before the host has marked the order paid (seen under load), the attempt as no longer payable. Each view
  // names its own state: `paid`, or none on the blocked view.
  await advance(page.getByRole('button', { name: t.simulatePaid, exact: true }));
  const paidView = page.locator('main p', { hasText: t.recoveryPaid });
  const blockedView = page.locator('main p', { hasText: t.recoveryUnavailable });
  await expect(paidView.or(blockedView)).toHaveCount(1);
  await oneStateLine(page, await paidView.count() ? storefrontAnchor.state.paid : null);
  await expect(anyAction(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('main')).toContainText(t.recoveryPaid);
  await oneStateLine(page, storefrontAnchor.state.paid);
});

test('storefront anchors: the blocked view after a capture names no state and offers no action', async ({ page }) => {
  // The blocked view appears when the page reads the order and its captured attempt before the host has marked the
  // order paid, which happens only under load. This case makes it certain: after the capture, the order read answers
  // with the host's own last answer from before it, and the attempt read with the host's own last answer for this
  // attempt, changed only to the captured, blocked state the host reports during that window.
  await openCheckout(page);
  const email = page.locator(`[${attribute.field}="${storefrontAnchor.field.email}"]`);
  const quoted = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate'));
  await email.fill(`anchors-blocked-${randomUUID()}@example.test`);
  await email.blur();
  await (await quoted).finished();
  await page.locator(`[${attribute.field}="${storefrontAnchor.field.terms_accepted}"]`).check();
  await action(page, storefrontAnchor.action.place_order).click();
  await page.locator('main').getByRole('link', { name: t.completion, exact: true }).click();
  // The host's latest order and attempt answers for this order, read as the page reads them.
  let live: Record<string, unknown> | undefined;
  let order: unknown;
  page.on('response', async response => {
    const inspect = response.request().postDataJSON()?.action === 'inspect';
    if (!inspect) return;
    const body = await response.json().catch(() => null) as { ok?: boolean; value?: Record<string, unknown> } | null;
    if (body?.ok !== true) return;
    if (response.url().endsWith('/api/actions/checkout.recovery')) order = body;
    if (response.url().endsWith('/api/actions/checkout.payment') && typeof body.value?.attemptRef === 'string') live = body.value;
  });
  await advance(page.getByRole('button', { name: t.recoveryPay, exact: true }));
  await oneStateLine(page, storefrontAnchor.state.awaiting_authority);
  await expect.poll(() => live?.state, { message: 'the host answered the dispatched attempt' }).toBe('dispatched');
  const dispatched = live, earlier = order;
  if (dispatched === undefined || earlier === undefined) throw new Error('storefront anchors: no order or attempt answer was recorded');
  await page.route('**/api/actions/checkout.recovery', route => route.fulfill({ json: earlier }), { times: 1 });
  await page.route('**/api/actions/checkout.payment', async route => {
    if (route.request().postDataJSON().action !== 'inspect') return route.fallback();
    await route.fulfill({ json: { ok: true, value: { ...dispatched, state: 'captured', paymentBlocked: true,
      canTokenPay: false, continuationAvailable: false } } });
  });
  await advance(page.getByRole('button', { name: t.simulatePaid, exact: true }));
  await expect(page.locator('main p', { hasText: t.recoveryUnavailable })).toHaveCount(1);
  await oneStateLine(page, null);
  await expect(anyAction(page)).toHaveCount(0);
});
