import { createPostgresCommerceOmsPort } from '@openlup/platform/commerce/server/postgres';
import { createPostgresInvoiceStore, runNativeInvoiceIssueJob } from '@openlup/platform/invoicing';
import { createCapturedPostgresInvoiceProvider } from '@openlup/platform/invoicing/postgres';
import { runCheckoutRecovery } from '../host/paid-mail.ts';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import * as subscriptions from '@openlup/platform/subscriptions';
import { createPostgresFulfillmentShipmentSpinePort } from '@openlup/platform/fulfillment';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import { createDirectOperatorInvitationStore, createDirectOperatorIdentityDirectory, createPostgresAccountLinkStore, createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
import { createPostgresNotificationRecipientsPort } from '@openlup/platform/communications';
import { configurations } from '../owned/store.config.ts';
import type { Locale } from '../shared/config.ts';
import { createPrivateCapture } from '../host/private-capture.ts';
import { runScheduledCare } from '../host/scheduled-renewal.ts';
import { test, expect, type Page, type Locator } from '@playwright/test';
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

test.describe('database subscription care', () => {
interface Material { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string }
interface Purchase { orderRef: string; email: string; subscriptionId: string; clientId: string; nextCycleAt: string; cadenceDays: number }
let material: Material, owner: pg.Pool, runtime: pg.Pool;
test.beforeAll(async ({ baseURL }, info) => {
  const entries: Material[] = JSON.parse(await readFile('.context/care-browser/fixtures.json', 'utf8'));
  const found = entries.find(row => row.id === info.project.name);
  if (!found || found.baseURL !== baseURL) throw new Error('starter_care_browser_fixture_required');
  material = found; owner = new pg.Pool({ connectionString: found.ownerUrl }); runtime = new pg.Pool({ connectionString: found.runtimeUrl });
});
test.afterAll(async () => { await owner?.end(); await runtime?.end(); });
async function call(page: Page, operation: string, data: Record<string, unknown>, key: string = randomUUID()) {
  const response = await page.request.post(`${material.baseURL}/api/actions/${operation}`, { data,
    headers: { Origin: material.baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key } });
  return response.json();
}
async function purchase(page: Page): Promise<Purchase> {
  const config = configurations[material.id]!;
  const email = `care-${randomUUID()}@example.test`;
  const accounts = createPostgresAccountLinkStore({ connectionString: material.runtimeUrl });
  try { await accounts.createAccount({ email, principalId: randomUUID(), acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' }); } finally { await accounts.close(); }
  const data = { email, locale: 'en', configuration: config.id, acquisitionCapability: 'subscription-acquisition.v1', country: config.market.country,
    termsAccepted: true, termsRevision: config.legal.revision, firstName: 'Example', lastName: 'Buyer', phone: '000000000',
    line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
    cart: { schemaVersion: 1, configuration: config.id, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] } };
  const quote = await call(page, 'offer.validate', data); expect(quote.ok).toBe(true);
  const created = await call(page, 'checkout.create', { ...data, quoteAcceptance: quote.value?.quoteAcceptance, expectedTotal: quote.value?.expectedTotal });
  expect(created.ok).toBe(true);
  const paid = await call(page, 'payment.simulate', { orderRef: created.value?.orderRef, token: created.value?.token, outcome: 'captured' });
  expect(paid.ok).toBe(true);
  const row = (await runtime.query(`SELECT s.id,s.client_id,s.next_cycle_at,s.cadence_days FROM public.subscriptions s
    JOIN public.subscription_activations a ON a.subscription_id=s.id WHERE a.order_id=$1::uuid`, [created.value.orderRef])).rows[0];
  if (!row) throw new Error('starter_care_browser_activation_required');
  return { orderRef: created.value.orderRef, email, subscriptionId: String(row.id), clientId: String(row.client_id), nextCycleAt: row.next_cycle_at.toISOString(), cadenceDays: Number(row.cadence_days) };
}
async function signIn(page: Page, email: string, locale: Locale, landing?: string, operator = false) {
  const path = resolve(material.state, '.context/captured-messages/identity.jsonl');
  const prior = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.email === email).at(-1)?.token;
  await page.goto(landing ?? routes.auth[locale]);
  if (landing) await page.locator('main').getByRole('link', { name: copy[locale].signIn, exact: true }).click();
  if (operator) {
    expect((await call(page, 'auth.operator', { email })).ok).toBe(true);
  } else {
    await page.getByLabel(copy[locale].email, { exact: true }).fill(email);
    await page.getByRole('button', { name: copy[locale].sendSignIn, exact: true }).click();
    await expect(page.locator('.action-result').first()).toContainText('accepted');
  }
  let token: string | undefined;
  await expect.poll(async () => {
    const messages = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    token = messages.filter(row => row.email === email && row.token !== prior).at(-1)?.token; return !!token;
  }).toBe(true);
  if (!token) throw new Error('starter_care_browser_challenge_required');
  if (operator) { expect((await call(page, 'auth.operator', { token })).ok).toBe(true); return; }
  // Keep private bearer values out of Playwright fill arguments and diagnostics.
  await page.getByLabel(copy[locale].otp, { exact: true }).evaluate((control, value) => { (control as HTMLInputElement).value = value; }, token);
  await page.getByRole('button', { name: copy[locale].verifyOtp, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(routes.account[locale]));
}
const cardFor = (page: Page, f: Purchase) => page.locator(`[data-subscription="${f.subscriptionId}"]`);
async function state(f: Purchase) { return (await runtime.query('SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1::uuid', [f.subscriptionId])).rows[0]; }
async function open(page: Page, f: Purchase, locale: Locale, label: string) {
  const card = cardFor(page, f); await expect(card).toBeVisible();
  await card.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(label);
  const controls = dialog.locator('input:visible, select:visible, textarea:visible');
  for (const control of await controls.all()) await expect(control).toHaveAccessibleName(/.+/);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  return dialog;
}
async function confirm(dialog: Locator, label: string) { await dialog.getByRole('button', { name: label, exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function pause(page: Page, f: Purchase, locale: Locale, preset?: string) {
  const dialog = await open(page, f, locale, copy[locale].carePause);
  await expect(dialog.getByLabel(copy[locale].careDuration)).toHaveValue('2_weeks');
  if (preset) await dialog.getByLabel(copy[locale].careDuration).selectOption(preset);
  await confirm(dialog, copy[locale].carePause);
  await expect(cardFor(page, f).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'paused');
}
async function cancel(page: Page, f: Purchase, locale: Locale, reason: string, accepted: boolean) {
  const dialog = await open(page, f, locale, copy[locale].cancelSubscription);
  await dialog.getByLabel(copy[locale].cancelReason).selectOption(reason);
  await dialog.getByLabel(copy[locale].note).fill('Example feedback');
  if (reason !== 'too_much_product' && reason !== 'delivery_issue') await expect(dialog.getByLabel(copy[locale].careDuration)).toHaveValue('1_month');
  await confirm(dialog, accepted ? copy[locale].careAccept : copy[locale].confirmCancel);
}
async function runCare(locale: Locale, at?: string) {
  const config = structuredClone(configurations[material.id]!);
  config.renewal.subscriptionCare.batchLimit = 100;
  config.renewal.notices.locale = locale;
  config.renewal.notices.countryLocales = { ZZ: locale };
  const capture = createPrivateCapture(resolve(material.state, '.context/captured-messages'));
  return runScheduledCare(material.runtimeUrl, config, { publicOrigin: material.baseURL, capture, ...(at ? { now: () => at } : {}) });
}
async function messages() {
  const path = resolve(material.state, '.context/captured-messages');
  const result: Record<string, unknown>[] = [];
  for (const name of await readdir(path)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    const envelope = JSON.parse(await readFile(resolve(path, name), 'utf8')); result.push(envelope.record);
  }
  return result;
}
async function notice(f: Purchase, kind: string) {
  const row = (await messages()).find(message => message.subscriptionId === f.subscriptionId && message.kind === kind);
  if (!row) throw new Error('starter_care_browser_message_missing');
  return row;
}
async function failedRenewal(f: Purchase) {
  const now = f.nextCycleAt;
  const withTransaction = async <T>(work: (db: pg.PoolClient) => Promise<T>) => {
    const db = await runtime.connect(); try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  };
  const codec = subscriptions.createNativeRenewalCodec(), store = subscriptions.createPostgresRenewalStore(runtime, codec, withTransaction);
  const due = (await store.listDue(500, now)).find(row => row.subscriptionId === f.subscriptionId);
  if (!due) throw new Error('starter_care_browser_due_required');
  const method = await subscriptions.createPostgresPurchaseRenewalWriter(runtime).readMethod(f.subscriptionId);
  const lifecycle = subscriptions.createPostgresRetryLifecycleBinding({ executor: runtime, withTransaction,
    settlement: db => subscriptions.createPostgresRenewalSettlementPort(db, codec, withTransaction), correlate: wire => codec.decode(wire).cycle,
    failureTemplate: 'failed', recoveryPath: '/account/payment/recover', retryCadence: { backoffHours: configurations[material.id]!.renewal.retryBackoffHours } });
  const rail = subscriptions.createPostgresSandboxRenewalRail(runtime, { scenario: 'declined', now: () => now });
  const result = await subscriptions.runOneAutomaticSubscriptionRenewal({ store, settlement: lifecycle.settlement,
    failureHandoff: lifecycle.failureHandoff, inventory: createPostgresRenewalReservationPort(runtime), paymentRails: { resolve: () => rail },
    workerId: 'starter-care-browser', policy: subscriptions.createSandboxRenewalPolicy(String(method!.methodRef)) }, due, now);
  expect(result.status).toBe('refused');
  const row = await subscriptions.createPostgresRetryStore(runtime).read(result.operationId);
  if (!row?.caseId) throw new Error('starter_care_browser_case_required');
  return row;
}
async function ageCancellation(f: Purchase) {
  // Clock fixture only: preserve the actual native cancellation's event/state relation.
  await owner.query(`WITH clock AS (SELECT now()-interval '20 days' AS at), changed AS (
    UPDATE public.subscriptions SET started_at=started_at-interval '20 days',ended_at=clock.at FROM clock WHERE id=$1::uuid RETURNING ended_at)
    UPDATE public.subscription_events SET occurred_at=changed.ended_at FROM changed
    WHERE subscription_id=$1::uuid AND event_type='subscription.customer_self_service.cancel'`, [f.subscriptionId]);
}

for (const locale of ['en', 'pl'] as const) {
  for (const preset of [undefined, '1_month', 'indefinite']) test(`${locale}: pause ${preset ?? 'default two weeks'} and manual resume`, async ({ page }) => {
    const f = await purchase(page); await signIn(page, f.email, locale); await pause(page, f, locale, preset);
    const window = (await runtime.query('SELECT pause_preset,ends_at,starts_at FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL', [f.subscriptionId])).rows[0];
    expect(window.pause_preset).toBe(preset ?? '2_weeks');
    if (!preset) expect(window.ends_at.getTime() - window.starts_at.getTime()).toBe(14 * 86400000);
    if (preset === 'indefinite') expect(window.ends_at).toBeNull();
    await confirm(await open(page, f, locale, copy[locale].careResume), copy[locale].careResume);
    await expect(cardFor(page, f).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'active');
    expect((await state(f)).next_cycle_at.getTime()).toBeGreaterThanOrEqual(Date.parse(f.nextCycleAt));
  });
  test(`${locale}: skip advances one cadence and preserves command replay`, async ({ page }) => {
    const f = await purchase(page);
    expect((await call(page, 'subscription.command', { action: 'skip', subscriptionRef: f.subscriptionId, customerRef: f.clientId })).code).toBe('customer_session_required');
    await signIn(page, f.email, locale);
    const foreign = (await runtime.query('SELECT id,status,next_cycle_at FROM public.subscriptions WHERE client_id<>$1::uuid LIMIT 1', [f.clientId])).rows[0];
    if (!foreign) throw new Error('starter_care_foreign_purchase_fixture_required');
    expect((await call(page, 'subscription.command', { action: 'pause', pausePreset: '2_weeks', subscriptionRef: foreign.id })).code).toBe('starter_subscription_not_found');
    expect((await runtime.query('SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1', [foreign.id])).rows[0]).toEqual({ status: foreign.status, next_cycle_at: foreign.next_cycle_at });
    expect((await call(page, 'subscription.command', { action: 'pause', pausePreset: '2_weeks', subscriptionRef: f.subscriptionId, lifecycleTerms: { pauseDays: 1 } })).code).toBe('starter_input_invalid');
    for (const action of ['edit_future_terms', 'update_package_template', 'update_bundle', 'resize_bundle', 'update_plan_length']) {
      expect((await call(page, 'subscription.command', { action, subscriptionRef: f.subscriptionId })).code).toBe('starter_input_invalid');
    }
    const command = page.waitForRequest(request => request.url().endsWith('/api/actions/subscription.command'));
    await confirm(await open(page, f, locale, copy[locale].careSkip), copy[locale].careSkip);
    const request = await command;
    expect((await state(f)).next_cycle_at.getTime()).toBe(Date.parse(f.nextCycleAt) + f.cadenceDays * 86400000);
    const replay = await call(page, 'subscription.command', request.postDataJSON(), request.headers()['idempotency-key']!);
    expect(replay.replayed).toBe(true);
  });
  test(`${locale}: reschedule submits the chosen date`, async ({ page }) => {
    const f = await purchase(page); await signIn(page, f.email, locale);
    const dialog = await open(page, f, locale, copy[locale].reschedule);
    const target = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await dialog.getByLabel(copy[locale].nextDelivery).fill(target);
    await confirm(dialog, copy[locale].reschedule);
    expect((await state(f)).next_cycle_at.toISOString().slice(0, 10)).toBe(target);
  });
  for (const reason of ['too_much_product', 'delivery_issue', 'too_expensive']) {
    test(`${locale}: cancellation ${reason} offer accepted then declined`, async ({ page }) => {
      const f = await purchase(page); await signIn(page, f.email, locale);
      await cancel(page, f, locale, reason, true);
      let row = await state(f);
      expect(row.status).toBe(reason === 'too_expensive' ? 'paused' : 'active');
      if (reason === 'delivery_issue') expect(row.next_cycle_at.getTime()).toBeGreaterThan(Date.parse(f.nextCycleAt));
      if (reason === 'too_expensive') {
        const outcome = (await owner.query('SELECT * FROM public.subscription_retention_outcomes WHERE subscription_id=$1', [f.subscriptionId])).rows[0];
        expect(outcome.cancel_reason_code).toBe(reason); expect(outcome.save_offer_accepted).toBe(true);
        await confirm(await open(page, f, locale, copy[locale].careResume), copy[locale].careResume);
        await expect(cardFor(page, f).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'active');
      }
      await cancel(page, f, locale, reason, false); row = await state(f); expect(row.status).toBe('cancelled');
      const declined = (await owner.query('SELECT * FROM public.subscription_retention_outcomes WHERE subscription_id=$1 ORDER BY occurred_at DESC,event_id DESC', [f.subscriptionId])).rows[0];
      expect(declined.cancel_reason_code).toBe(reason); expect(declined.save_offer_accepted).toBe(false);
    });
  }
  for (const action of ['careOrderNow', 'careReactivate'] as const) test(`${locale}: ${action} requires explicit charge-timing confirmation`, async ({ page }) => {
    const f = await purchase(page); await signIn(page, f.email, locale);
    if (action === 'careReactivate') await cancel(page, f, locale, 'other', false);
    const before = await state(f), command = action === 'careOrderNow' ? 'order_now' : 'reactivate';
    expect((await call(page, 'subscription.command', { action: command, subscriptionRef: f.subscriptionId })).code).toBe('subscription_command_charge_timing_not_confirmed');
    const dialog = await open(page, f, locale, copy[locale][action]);
    const check = dialog.getByLabel(copy[locale].careConfirmed); await expect(check).not.toBeChecked();
    await dialog.getByRole('button', { name: copy[locale][action], exact: true }).click(); await expect(dialog).toBeVisible();
    expect((await state(f)).next_cycle_at.getTime()).toBe(before.next_cycle_at.getTime());
    await check.check(); await confirm(dialog, copy[locale][action]);
    expect((await state(f)).status).toBe('active');
    const date = (await state(f)).next_cycle_at.getTime();
    expect(date).toBeGreaterThan(Date.now() + (action === 'careOrderNow' ? 4 * 60000 : 1.9 * 86400000));
  });
}

test('pause remains available during an open payment case and closes that case', async ({ page }) => {
  const f = await purchase(page); const obligation = await failedRenewal(f); await signIn(page, f.email, 'en');
  const card = cardFor(page, f); await expect(card.getByRole('button', { name: copy.en.careSkip, exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: copy.en.reschedule, exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: copy.en.carePause, exact: true })).toBeEnabled();
  await pause(page, f, 'en');
  expect((await runtime.query('SELECT status FROM public.subscription_dunning_cases WHERE id=$1', [obligation.caseId])).rows[0].status).toBe('paused');
});
test('clock-driven finite auto-resume captures the resumed confirmation once', async ({ page }) => {
  const f = await purchase(page); await signIn(page, f.email, 'en'); await pause(page, f, 'en');
  // The disposable fixture supplies carrier facts; no operator delivery action is mounted.
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('care-parcels','simulator',true) ON CONFLICT DO NOTHING");
  const parcels = createPostgresFulfillmentShipmentSpinePort(runtime, { portKey: 'care-parcels' });
  const parcel = await parcels.createShipment({ idempotencyKey: `parcel:${f.orderRef}`, orderId: f.orderRef });
  const shipment = { shipmentId: parcel.shipmentId, requestedAt: new Date().toISOString() };
  await parcels.recordLabel({ ...shipment, idempotencyKey: `label:${f.orderRef}` });
  await parcels.handOff({ ...shipment, idempotencyKey: `handoff:${f.orderRef}` });
  expect(await parcels.recordTracking({ ...shipment, idempotencyKey: `delivered:${f.orderRef}`, status: 'delivered' })).toMatchObject({ status: 'delivered' });
  // Model the external host's fulfilled-order fact, as in the native history fixture.
  await owner.query("UPDATE public.commerce_orders SET status='fulfilled' WHERE id=$1", [f.orderRef]);
  const history = async () => (await runtime.query(`SELECT o.status AS order_status,c.status AS cycle_status,p.status AS parcel_status
    FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    JOIN public.fulfillment_shipments p ON p.order_id=o.id WHERE o.id=$1`, [f.orderRef])).rows[0];
  const delivered = { order_status: 'fulfilled', cycle_status: 'paid', parcel_status: 'delivered' };
  expect(await history()).toEqual(delivered);
  const window = (await runtime.query('SELECT starts_at,ends_at,pause_preset FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL', [f.subscriptionId])).rows[0];
  expect(window.pause_preset).toBe('2_weeks');
  expect(window.ends_at.getTime() - window.starts_at.getTime()).toBe(14 * 86400000);
  const cadenceMs = f.cadenceDays * 86400000;
  const previousNext = Date.parse(f.nextCycleAt);
  const clock = Math.max(window.ends_at.getTime(), previousNext + cadenceMs) + 1000;
  const at = new Date(clock).toISOString();
  const expectedNext = new Date(Math.max(previousNext + (window.ends_at.getTime() - window.starts_at.getTime()), clock));
  expect(expectedNext.getTime()).toBeGreaterThanOrEqual(clock);
  await runCare('en', at);
  expect(await state(f)).toEqual({ status: 'active', next_cycle_at: expectedNext });
  expect((await runtime.query('SELECT resumed_at FROM public.subscription_pause_windows WHERE subscription_id=$1', [f.subscriptionId])).rows[0].resumed_at).toEqual(new Date(at));
  const message = await notice(f, 'subscription.resumed'); expect(message.subject).toBe(copy.en.careResumed);
  await page.getByRole('button', { name: copy.en.careRead, exact: true }).click();
  await expect(cardFor(page, f).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'active');
  const nextDate = await cardFor(page, f).locator('p').filter({ hasText: `${copy.en.careNext}:` }).innerText();
  expect(Date.parse(nextDate.slice(copy.en.careNext.length + 2))).toBe(expectedNext.getTime());
  await runCare('en', at);
  expect(await state(f)).toEqual({ status: 'active', next_cycle_at: expectedNext });
  expect(await history()).toEqual(delivered);
  expect((await messages()).filter(row => row.subscriptionId === f.subscriptionId && row.kind === 'subscription.resumed')).toHaveLength(1);
});
for (const locale of ['en', 'pl'] as const) for (const kind of ['subscription.renewal_upcoming', 'subscription.pause_reminder_due', 'subscription.renewal_at_risk']) {
  test(`${locale}: captured ${kind} targets the owned subscription through sign-in`, async ({ page }) => {
    const f = await purchase(page);
    if (kind === 'subscription.pause_reminder_due') {
      // Trusted native command, followed by a clock-only fixture adjustment of the finite window.
      const principal = (await owner.query('SELECT principal_id FROM public.clients WHERE id=$1', [f.clientId])).rows[0].principal_id;
      const command = subscriptions.createPostgresSubscriptionCommandStore({ async withTransaction(work) {
        const db = await runtime.connect(); try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
      } });
      expect((await command.apply({ actorId: principal, clientId: f.clientId, subscriptionId: f.subscriptionId,
        idempotencyKey: randomUUID(), now: new Date().toISOString(), action: 'pause', payload: { pausePreset: '2_weeks', reason: null, actorKind: 'customer' } })).status).toBe('applied');
      await owner.query("UPDATE public.subscription_pause_windows SET ends_at=now()+interval '2 days' WHERE subscription_id=$1 AND resumed_at IS NULL", [f.subscriptionId]);
    } else {
      await owner.query('UPDATE public.subscriptions SET next_cycle_at=$2::timestamptz,updated_at=$3::timestamptz WHERE id=$1',
        [f.subscriptionId, new Date(Date.now() + 4 * 86400000).toISOString(), new Date(Date.now() - 6 * 86400000).toISOString()]);
      if (kind === 'subscription.renewal_at_risk') {
        const writer = subscriptions.createPostgresPurchaseRenewalWriter(runtime), method = await writer.readMethod(f.subscriptionId);
        await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: randomUUID(), expectedState: 'healthy', healthState: 'method_missing', methodRef: String(method!.methodRef), evidenceRef: 'synthetic-method-missing' });
      }
    }
    await runCare(locale);
    const captured = await notice(f, kind), link = String(captured.body).match(/https?:\/\/[^\s]+/)?.[0];
    if (!link) throw new Error('starter_care_browser_account_link_required');
    const url = new URL(link); expect(url.pathname).toBe(routes.account[locale]); expect(url.searchParams.get('sub')).toBe(f.subscriptionId);
    if (kind === 'subscription.renewal_at_risk') expect(url.searchParams.get('sekcja')).toBe('payments');
    await signIn(page, f.email, locale, link); await expect(cardFor(page, f)).toBeFocused();
    if (kind === 'subscription.renewal_at_risk') await expect(cardFor(page, f).getByRole('heading', { name: copy[locale].carePayment })).toBeVisible();
  });
}
for (const locale of ['en', 'pl'] as const) test(`${locale}: default-ON winback records refusal and a host-authorized outcome, with confirmed reactivation`, async ({ page, context }) => {
  // The owner enables the existing delivery control in this disposable fixture; the host never seeds controls.
  await owner.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES('subscriber-retention',true) ON CONFLICT(control_key) DO UPDATE SET enabled=true");
  const denied = await purchase(page); await signIn(page, denied.email, locale); await cancel(page, denied, locale, 'other', false); await ageCancellation(denied);
  await runCare(locale); await page.getByRole('button', { name: copy[locale].careRead, exact: true }).click();
  await expect(cardFor(page, denied).locator('[data-winback=refused]')).toContainText('consent_missing');
  await expect(cardFor(page, denied)).toContainText(copy[locale].careConsent);
  await expect(cardFor(page, denied).locator('[name=retention_marketing]')).toHaveCount(0);
  await context.clearCookies();
  const admitted = await purchase(page); await signIn(page, admitted.email, locale); await cancel(page, admitted, locale, 'other', false); await ageCancellation(admitted);
  const fingerprint = createHash('sha256').update(admitted.email).digest('hex');
  await owner.query("SELECT public.communications_record_recipient_consent($1,'retention_marketing','granted',now())", [fingerprint]);
  await runCare(locale);
  expect((await owner.query("SELECT count(*)::int AS count FROM public.commerce_settings WHERE key='subscriber_winback_policy'")).rows[0].count).toBe(0);
  const captured = await notice(admitted, 'winback'); expect(captured.locale).toBe(locale);
  await page.goto(String(captured.accountUrl));
  await expect(cardFor(page, admitted)).toBeFocused();
  await expect(cardFor(page, admitted).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'cancelled');
  await expect(cardFor(page, admitted).locator('[data-winback=accepted]')).toBeVisible();
  const dialog = await open(page, admitted, locale, copy[locale].careReactivate);
  await dialog.getByRole('button', { name: copy[locale].careReactivate, exact: true }).click();
  await expect(dialog).toBeVisible(); expect((await state(admitted)).status).toBe('cancelled');
  await dialog.getByLabel(copy[locale].careConfirmed).check(); await confirm(dialog, copy[locale].careReactivate);
  expect((await state(admitted)).status).toBe('active');

});
test('operator escalation uses configured recipients and narrow captured fields', async ({ page }) => {
  const email = `operator-${randomUUID()}@example.test`;
  const identity = createPostgresOperatorIdentityStore({ connectionString: material.ownerUrl });
  let operator: string;
  try { operator = (await identity.bootstrapFirstAdministrator({ email })).principalId; } finally { await identity.close(); }
  await signIn(page, email, 'en', undefined, true);
  await owner.query('INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)', [operator]);
  const recipients = createPostgresNotificationRecipientsPort({ connectionString: material.runtimeUrl }, { operatorId: operator });
  try {
    for (const address of [email, `second-${email}`]) await recipients.createNotificationRecipient({ email: address, name: null, notification_type: 'commerce_payment_critical', active: true });
    const f = await purchase(page), obligation = await failedRenewal(f); await runCare('en');
    const captured = (await messages()).filter(row => row.kind === 'operator_escalation' && row.caseId === obligation.caseId);
    expect(captured.length).toBe(2);
    for (const message of captured) { expect(message.token).toBeUndefined(); expect(message.recoveryUrl).toBeUndefined(); expect(message.body).toContain(String(obligation.caseId)); }
    await page.goto(routes.admin.en);
    const customer = page.locator('form').filter({ has: page.locator('[name=customerRef]') }).filter({ hasNot: page.locator('[name=caseRef]') }).last();
    await customer.locator('[name=customerRef]').fill(f.clientId); await customer.getByRole('button', { name: copy.en.read, exact: true }).click();
    await expect(customer.locator('.action-result')).toContainText(String(obligation.caseId));
    const list = await recipients.listNotificationRecipients({ notification_type: 'commerce_payment_critical' });
    await recipients.updateNotificationRecipient({ recipientId: list.recipients[0]!.id, active: false });
    const second = await purchase(page), next = await failedRenewal(second); await runCare('en');
    expect((await messages()).filter(row => row.kind === 'operator_escalation' && row.caseId === obligation.caseId)).toHaveLength(2);
    expect((await messages()).filter(row => row.kind === 'operator_escalation' && row.caseId === next.caseId)).toHaveLength(1);
  } finally { await recipients.close(); }
});



async function pendingCheckout(page: Page, locale: Locale, mode: 'one_time' | 'subscription' = 'one_time') {
  const config = configurations[material.id]!, email = `portal-${randomUUID()}@example.test`;
  const accounts = createPostgresAccountLinkStore({ connectionString: material.runtimeUrl });
  try { await accounts.createAccount({ email, principalId: randomUUID(), acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' }); } finally { await accounts.close(); }
  const input = { locale, configuration: config.id, email, country: config.market.country,
    firstName: 'Example', lastName: 'Buyer', phone: '000000000', line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
    termsAccepted: true, termsRevision: config.legal.revision, ...(mode === 'subscription' ? { acquisitionCapability: 'subscription-acquisition.v1' } : {}),
    cart: { schemaVersion: 1, configuration: config.id, mode, cadenceDays: mode === 'subscription' ? config.offer.defaultCadenceDays : null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] } };
  const quote = await call(page, 'offer.validate', input); expect(quote.ok).toBe(true);
  const created = await call(page, 'checkout.create', { ...input, quoteAcceptance: quote.value?.quoteAcceptance, expectedTotal: quote.value?.expectedTotal });
  expect(created.ok).toBe(true);
  return { email, orderRef: created.value.orderRef as string, token: created.value.token as string };
}
async function portalOperator(page: Page, locale: Locale, role: 'admin' | 'distributor' = 'admin') {
  let root = (await owner.query(`SELECT p.principal_id,p.email FROM public.platform_human_principals p
    JOIN public.platform_human_memberships m USING(principal_id) WHERE m.role='admin' AND m.membership_state='active' LIMIT 1`)).rows[0];
  if (!root) {
    const identity = createPostgresOperatorIdentityStore({ connectionString: material.ownerUrl });
    const email = `portal-root-${randomUUID()}@example.test`;
    try { const result = await identity.bootstrapFirstAdministrator({ email }); root = { principal_id: result.principalId, email }; } finally { await identity.close(); }
    await signIn(page, root.email, locale, undefined, true);
  }
  // Each test uses a new native invitation; challenge quotas stay enabled and unchanged.
  const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
  const directory = createDirectOperatorIdentityDirectory({ connectionString: material.ownerUrl });
  const email = `portal-admin-${randomUUID()}@example.test`;
  let principal: string;
  try {
    principal = (await directory.ensurePrincipal({ email, redirectTo: material.baseURL + routes.admin[locale] })).principalId;
    const result = await invitations.issue({ actorPrincipalId: root.principal_id, targetPrincipalId: principal, email, role, ttlSeconds: 600 });
    expect(result.code).toBe('INVITATION_CREATED');
  } finally { await invitations.close(); await directory.close(); }
  // The database owner provisions these durable rows. No host or installer writer exists.
  await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Demonstration administrator') ON CONFLICT DO NOTHING", [principal]);
  await owner.query('INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true) ON CONFLICT(principal_id) DO UPDATE SET active=true', [principal]);
  await signIn(page, email, locale, undefined, true); await page.goto(routes.admin[locale]);
  return principal;
}
async function operatorDetail(page: Page, orderId: string, locale: Locale) {
  const reader = page.locator('#orders form').filter({ has: page.locator('[name=orderRef]') }).first();
  await reader.locator('[name=orderRef]').fill(orderId.toUpperCase());
  await reader.getByRole('button', { name: copy[locale].read, exact: true }).click();
  const controls = page.locator('[data-order-controls]'); await expect(controls).toContainText(orderId);
  return controls;
}
async function accessible(section: Locator) {
  for (const control of await section.locator('input:visible,textarea:visible,select:visible,button:visible').all()) await expect(control).toHaveAccessibleName(/.+/);
}
async function checkoutMail(locale: Locale) {
  const config = structuredClone(configurations[material.id]!);
  config.renewal.notices.locale = locale; config.renewal.notices.countryLocales = { ZZ: locale };
  return runCheckoutRecovery({ executor: runtime, config, publicOrigin: material.baseURL,
    capture: createPrivateCapture(resolve(material.state, '.context/captured-messages')) });
}
async function parcel(orderRef: string) {
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('portal-parcels','simulator',true) ON CONFLICT DO NOTHING");
  const result = await createPostgresFulfillmentShipmentSpinePort(runtime, { portKey: 'portal-parcels' })
    .createShipment({ idempotencyKey: `portal-parcel:${orderRef}`, orderId: orderRef });
  // The external dispatch host freezes carrier contact. The starter mounts no dispatch or arrival writer.
  await runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [result.shipmentId,
    { schemaVersion: 1, source: 'contact', revision: 1, recipientName: 'Example Buyer', contactEmail: 'parcel@example.test',
      contactPhone: '+999123456789', line1: '1 Example Lane', line2: null, city: 'Example City', postalCode: '00000', country: 'ZZ',
      deliveryInstructions: null, courierInstructions: null, selectedDelivery: { providerKind: configurations[material.id]!.purchase.stock.providerRef,
        carrierKind: 'synthetic-carrier', service: 'synthetic-service', deliveryKind: 'courier' } }]);
  return result;
}
async function issuedInvoice(orderId: string) {
  const config = configurations[material.id]!, providerRef = config.documents.sandbox.providerRef;
  const order = (await runtime.query('SELECT total_amount_minor,currency_code FROM public.commerce_orders WHERE id=$1', [orderId])).rows[0];
  const intent = (await runtime.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1', [orderId])).rows[0].id;
  const total = Number(order.total_amount_minor), currency = String(order.currency_code);
  const proof = { evidenceRef: 'synthetic-money', fingerprint: 'a'.repeat(64), observedAt: '2026-11-01T12:00:00Z' };
  const store = createPostgresInvoiceStore(runtime, { seller: { read: async () => ({ kind: 'found',
    seller: { name: 'Synthetic seller', address: { line1: '1 Example Street', postalCode: '00000', city: 'Example' },
      taxIdentifier: { scheme: 'synthetic', value: 'seller' }, bankAccount: null, routingRef: null }, revisionRef: 'seller-v1' }) } });
  const duty = await store.captureDuty({ requestKey: `invoice:${orderId}`, sourceKind: 'paid', sourceId: randomUUID(), orderId,
    occurredAt: proof.observedAt, evidence: { settlementIntentId: intent, amountMinor: total, currency } });
  if ('kind' in duty) throw new Error('portal_invoice_duty_required');
  await store.installFacts({ dutyId: duty.dutyId, facts: { factRevision: `facts:${orderId}`, policyVersion: 'sandbox-v1',
    refs: { orderId, orderRef: orderId, invoiceRef: `INVOICE/${orderId}` },
    dates: { issueDate: '2026-11-01', sellDate: '2026-11-01', handedOverAt: null, paymentCompletedAt: proof.observedAt },
    documentKind: 'sandbox-document', clearanceRequired: false, currency,
    buyer: { name: 'Example Customer', email: null, taxIdentifier: null, companyName: null, address: null },
    payment: { intentRef: intent, providerRef: 'sandbox-money', providerPaymentRef: null, amountMinor: total, currency, localSettlementState: 'matched' },
    orderMoney: null, lines: [{ description: 'Synthetic item', quantity: 1, unitNetMinor: total, unitGrossMinor: total,
      totalNetMinor: total, totalTaxMinor: 0, totalGrossMinor: total, taxRateBps: 0, positionKind: 'item',
      catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null }],
    totalNetMinor: total, totalTaxMinor: 0, totalGrossMinor: total, chargedTotalGrossMinor: total } });
  const sweep = await store.sweep(100); if ('kind' in sweep) throw new Error('portal_invoice_sweep_required');
  const lease = sweep.claims.find(row => row.dutyId === duty.dutyId)!;
  const prepared = await store.prepareFacts(lease); if ('kind' in prepared || prepared.status !== 'ready') throw new Error('portal_invoice_facts_required');
  await store.finishFacts({ ...lease, result: { ...prepared, status: 'ready' } });
  const money = { read: async () => ({ kind: 'observed' as const, status: 'succeeded' as const, amountMinor: total, currency, proof }) };
  expect(await runNativeInvoiceIssueJob({ store, provider: createCapturedPostgresInvoiceProvider(runtime, config.documents.sandbox).provider,
    money, readLocalPayment: () => money.read(), providerRef, orderId })).toMatchObject({ failures: 0 });
  return (await runtime.query('SELECT id FROM public.accounting_documents WHERE order_id=$1', [orderId])).rows[0].id as string;
}

for (const locale of ['en', 'pl'] as const) {
  test(`${locale}: portal recovery waves retain both links and land on the exact order`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale);
    // Time-only fixture: the order and intent remain the ones created by checkout.
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '21 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.commerce_settlement_intents SET created_at=now()-interval '21 hours',updated_at=now()-interval '21 hours' WHERE order_id=$1", [f.orderRef]);
    await checkoutMail(locale); await checkoutMail(locale);
    const captured = (await messages()).filter(row => row.kind === 'checkout_recovery' && row.orderId === f.orderRef);
    expect(captured).toHaveLength(2);
    for (const message of captured) {
      expect(message.locale).toBe(locale); expect(message.recoveryUrl).toBeTruthy();
      await page.goto(String(message.recoveryUrl));
      await expect(page.locator('main')).toContainText(f.orderRef);
      await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.has('token')).toBe(false); await accessible(page.locator('main'));
    }
    await page.getByRole('button', { name: copy[locale].simulatePaid, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    await context.clearCookies();
    for (const message of captured) {
      await page.goto(String(message.recoveryUrl)); await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
      await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
    }
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1 AND e.outcome='captured'", [f.orderRef])).rows[0].n).toBe(1);
  });


  test(`${locale}: portal expired-checkout notice retains the source order and offers no payment`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE purchase_order_id=$1", [f.orderRef]);
    await checkoutMail(locale);
    const message = (await messages()).find(row => row.kind === 'checkout_expired' && row.orderId === `order_${f.orderRef}`)!;
    expect(message).toBeTruthy(); expect(message.locale).toBe(locale);
    await page.goto(String(message.recoveryUrl));
    await expect(page.locator('main')).toContainText(copy[locale].recoveryExpired);
    await expect(page.locator('main')).toContainText(f.orderRef);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
  });


  test(`${locale}: portal abandoned initial checkout notice cannot activate or pay a subscription`, async ({ page }) => {
    const f = await pendingCheckout(page, locale, 'subscription');
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '3 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.subscription_activations SET declared_at=now()-interval '3 hours' WHERE order_id=$1", [f.orderRef]);
    await checkoutMail(locale);
    const message = (await messages()).find(row => row.kind === 'checkout_expired' && row.orderId === `order_${f.orderRef}`)!;
    expect(message).toBeTruthy(); await page.goto(String(message.recoveryUrl));
    await expect(page.locator('main')).toContainText(copy[locale].recoveryCancelled);
    await expect(page.locator('main')).toContainText(f.orderRef);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
    expect((await runtime.query('SELECT state,subscription_id FROM public.subscription_activations WHERE order_id=$1', [f.orderRef])).rows[0]).toEqual({ state: 'compensated', subscription_id: null });
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.cancelled'", [f.orderRef])).rows[0].n).toBe(0);
  });

  test(`${locale}: portal signed-in recovery selects owned pending checkout and sends no mail`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale);
    const second = await pendingCheckout(page, locale, 'subscription');
    expect((await call(page, 'checkout.recoveryStart', { orderRef: f.orderRef })).code).toBe('customer_session_required');
    await signIn(page, f.email, locale);
    const before = (await runtime.query('SELECT count(*)::int AS n FROM public.outbox_events')).rows[0].n;
    const result = await call(page, 'checkout.recoveryStart', { orderRef: f.orderRef }); expect(result.ok).toBe(true);
    expect(result.value.recoverable).toBe(true);
    expect((await runtime.query('SELECT count(*)::int AS n FROM public.outbox_events')).rows[0].n).toBe(before);
    const again = await call(page, 'checkout.recoveryStart', { orderRef: f.orderRef }); expect(again.value.token === result.value.token).toBe(false);
    expect((await call(page, 'checkout.read', { token: result.value.token })).ok).toBe(true);
    const foreign = await call(page, 'checkout.recoveryStart', { orderRef: second.orderRef }); expect(foreign.value.recoverable).toBe(false);
    const card = page.locator(`[data-order="${f.orderRef}"]`); await expect(card).toBeVisible(); await accessible(card);
    await card.getByRole('button', { name: copy[locale].completeOrderPayment, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(routes.completion[locale])); await expect(page.locator('main')).toContainText(f.orderRef);
    await context.clearCookies(); await signIn(page, second.email, locale);
    const initial = (await runtime.query('SELECT id FROM public.subscription_activations WHERE order_id=$1', [second.orderRef])).rows[0].id;
    expect((await call(page, 'checkout.recoveryStart', { subscriptionRef: initial })).value.recoverable).toBe(true);
  });

  test(`${locale}: portal profile edit normalizes, preserves failed drafts and replays current state`, async ({ page }) => {
    const f = await pendingCheckout(page, locale); await signIn(page, f.email, locale);
    const section = page.locator('[data-profile-editor]'); await expect(section.locator('form')).toBeVisible(); await accessible(section);
    await expect(section).toContainText(f.email); await expect(section.locator('[name=email]')).toHaveCount(0);
    await section.locator('[name=firstName]').fill('  Example   Name '); await section.locator('[name=lastName]').fill('');
    await section.locator('[name=phone]').fill('123 456 789');
    await section.getByRole('button', { name: copy[locale].save, exact: true }).click();
    await expect(section.locator('[name=firstName]')).toHaveValue('Example Name');
    await expect(section.locator('[name=phone]')).toHaveValue('+999123456789');
    await section.locator('[name=firstName]').fill('x'); await section.getByRole('button', { name: copy[locale].save, exact: true }).click();
    await expect(section.locator('.action-result')).toContainText('starter_input_invalid');
    await expect(section.locator('[name=firstName]')).toHaveValue('x');
    expect((await call(page, 'account.profile', { email: 'different@example.test' })).code).toBe('starter_input_invalid');
    const key = randomUUID(); expect((await call(page, 'account.profile', { firstName: 'Recorded' }, key)).ok).toBe(true);
    expect((await call(page, 'account.profile', { firstName: 'Current', phone: null })).ok).toBe(true);
    expect((await call(page, 'account.profile', { firstName: 'Recorded' }, key)).value.profile.firstName).toBe('Current');
    await page.reload(); await expect(section.locator('[name=firstName]')).toHaveValue('Current');
    await expect(section.locator('[name=phone]')).toHaveValue('');
  });

  test(`${locale}: portal invoice correction records a request without changing the document`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
    const invoiceId = await issuedInvoice(f.orderRef); await signIn(page, f.email, locale); await page.goto(routes.invoices[locale]);
    const before = (await runtime.query('SELECT to_jsonb(d) AS value FROM public.accounting_documents d WHERE id=$1', [invoiceId])).rows[0].value;
    const reader = page.locator('form').filter({ has: page.locator('[name=orderRef]') }).filter({ hasNot: page.locator('[name=documentRef]') }).first();
    await reader.locator('[name=orderRef]').fill(f.orderRef); await reader.getByRole('button', { name: copy[locale].read, exact: true }).click();
    const form = page.locator('[data-invoice-corrections] form'); await expect(form).toBeVisible(); await accessible(form);
    await form.locator('[name=reason]').fill('x'); await form.getByRole('button', { name: copy[locale].save, exact: true }).click();
    await expect(form.locator('.action-result')).toContainText('starter_input_invalid'); await expect(form.locator('[name=reason]')).toHaveValue('x');
    await form.locator('[name=reason]').fill('Correct the fictional recipient'); await form.locator('[name=requestedFields]').fill('name, address');
    await form.getByRole('button', { name: copy[locale].save, exact: true }).click(); await expect(form).toContainText(copy[locale].correctionRecorded);
    const key = randomUUID(), input = { invoiceId, reason: 'Correct the fictional recipient', requestedFields: ['name'] };
    const first = await call(page, 'account.invoiceCorrection', input, key), second = await call(page, 'account.invoiceCorrection', input, key);
    expect(first.ok && second.ok).toBe(true); expect(first.value.eventId === second.value.eventId).toBe(false);
    expect((await call(page, 'account.read', {})).value.accountEvents.filter((row: { eventType: string }) => row.eventType === 'customer.invoice_correction_requested')).toHaveLength(3);
    expect((await runtime.query('SELECT to_jsonb(d) AS value FROM public.accounting_documents d WHERE id=$1', [invoiceId])).rows[0].value).toEqual(before);
    await context.clearCookies(); const other = await pendingCheckout(page, locale); await signIn(page, other.email, locale);
    expect((await call(page, 'account.invoiceCorrection', input)).code).toBe('starter_invoice_not_found');
  });

  test(`${locale}: portal operator copies and emails a checkout link with native revocation`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale); await portalOperator(page, locale);
    const panel = await operatorDetail(page, f.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=delivery]') }); await expect(form).toBeVisible(); await accessible(form);
    await form.getByRole('button', { name: copy[locale].paymentLink, exact: true }).click();
    await expect(panel.locator('input[readonly]')).toBeVisible();
    expect((await call(page, 'checkout.read', { token: f.token })).ok).toBe(false);
    const before = (await runtime.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'", [f.orderRef])).rows[0].n; expect(before).toBe(0);
    await form.locator('[name=delivery]').selectOption('email'); await form.getByRole('button', { name: copy[locale].paymentLink, exact: true }).click();
    await expect(form.locator('.action-result')).toContainText('true');
    await owner.query("UPDATE public.commerce_settlement_intents SET updated_at=now()-interval '2 hours' WHERE order_id=$1", [f.orderRef]);
    await checkoutMail(locale);
    const message = (await messages()).find(row => row.kind === 'checkout_recovery' && row.orderId === f.orderRef)!; expect(message).toBeTruthy();
    await context.clearCookies(); await page.goto(String(message.recoveryUrl)); await expect(page.locator('main')).toContainText(f.orderRef);
    await page.getByRole('button', { name: copy[locale].simulatePaid, exact: true }).click(); await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    await portalOperator(page, locale); expect((await call(page, 'operator.paymentLink', { orderRef: f.orderRef, delivery: 'copy' })).ok).toBe(false);
  });


  test(`${locale}: portal operator completion navigation replaces a different pending purchase`, async ({ page }) => {
    const other = await pendingCheckout(page, locale), issued = await pendingCheckout(page, locale);
    const previous = new URL(routes.completion[locale], material.baseURL); previous.searchParams.set('token', other.token);
    await page.goto(previous.href);
    await expect(page.locator('main')).toContainText(other.orderRef);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
    await portalOperator(page, locale);
    const panel = await operatorDetail(page, issued.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=delivery]') }); await accessible(form);
    await form.getByRole('button', { name: copy[locale].paymentLink, exact: true }).click();
    const completion = panel.getByRole('link', { name: copy[locale].completion, exact: true });
    await expect(completion).toHaveAccessibleName(copy[locale].completion);
    await completion.click();
    await expect(page.locator('main')).toContainText(issued.orderRef);
    await expect(page.locator('main')).not.toContainText(other.orderRef);
    expect(new URL(page.url()).searchParams.has('token')).toBe(false);
    const payment = page.getByRole('button', { name: copy[locale].simulatePaid, exact: true });
    await expect(payment).toHaveAccessibleName(copy[locale].simulatePaid); await payment.click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    await expect(page.locator('main')).toContainText(issued.orderRef);
    expect((await runtime.query('SELECT id,status FROM public.commerce_orders WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[issued.orderRef, other.orderRef]])).rows).toEqual([
      { id: issued.orderRef, status: 'paid' }, { id: other.orderRef, status: 'pending_payment' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });

  test(`${locale}: portal distributor cannot read OMS or mutate and replay catalog drafts and payment links`, async ({ page }) => {
    const f = await pendingCheckout(page, locale); await portalOperator(page, locale);
    expect((await call(page, 'operator.orders', {})).ok).toBe(true);
    expect((await call(page, 'operator.order', { orderRef: f.orderRef })).ok).toBe(true);
    const draftForm = page.locator('#catalogue-drafts form').filter({ has: page.locator('[name=payload]') }); await accessible(draftForm);
    const sent = page.waitForRequest(row => row.url().endsWith('/api/actions/operator.catalogDrafts'));
    const response = page.waitForResponse(row => row.url().endsWith('/api/actions/operator.catalogDrafts'));
    await draftForm.getByRole('button', { name: copy[locale].save, exact: true }).click();
    const created = await (await response).json(); expect(created.ok, created.code).toBe(true);
    const draftRequest = await sent, draftInput = draftRequest.postDataJSON(), draftKey = draftRequest.headers()['idempotency-key']!;
    expect((await call(page, 'operator.catalogDrafts', draftInput, draftKey)).replayed).toBe(true);
    const linkInput = { orderRef: f.orderRef, delivery: 'copy' }, linkKey = randomUUID();
    expect((await call(page, 'operator.paymentLink', linkInput, linkKey)).ok).toBe(true);
    const before = (await call(page, 'operator.catalogDrafts', { action: 'get', draftId: created.value.record.draftId })).value;
    await portalOperator(page, locale, 'distributor');
    for (const [operation, input, key] of [
      ['operator.orders', {}, randomUUID()], ['operator.order', { orderRef: f.orderRef }, randomUUID()],
      ['operator.catalogDrafts', { ...draftInput, draftId: randomUUID() }, randomUUID()],
      ['operator.catalogDrafts', draftInput, draftKey],
      ['operator.paymentLink', linkInput, randomUUID()], ['operator.paymentLink', linkInput, linkKey],
    ] as const) {
      const result = await call(page, operation, input, key);
      expect(result.code, operation).toBe('operator_required'); expect(result.value, operation).toBeUndefined();
    }
    await portalOperator(page, locale);
    expect((await call(page, 'operator.catalogDrafts', { action: 'get', draftId: created.value.record.draftId })).value).toEqual(before);
  });

  test(`${locale}: portal operator expired links revalidate frozen commercial facts`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE purchase_order_id=$1", [f.orderRef]);
    await checkoutMail(locale); await portalOperator(page, locale);
    const result = await call(page, 'operator.paymentLink', { orderRef: f.orderRef, delivery: 'copy' });
    expect(result.ok, result.code).toBe(true);
    const url = new URL(routes.completion[locale], material.baseURL); url.searchParams.set('token', result.value.token);
    await page.goto(url.href); await expect(page.locator('main')).toContainText(copy[locale].recoveryExpired);
    await expect(page.locator('main')).toContainText(f.orderRef);
    // Corrupt only this synthetic frozen money snapshot: the current quote must no longer match it.
    await owner.query("UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,totalGross,amountMinor}',to_jsonb(total_amount_minor+1)) WHERE id=$1", [f.orderRef]);
    expect((await call(page, 'operator.paymentLink', { orderRef: f.orderRef, delivery: 'copy' })).code).toBe('starter_checkout_order_changed');
  });

  test(`${locale}: portal operator replacement requires confirmation and retains in-flight alignment`, async ({ page }) => {
    const f = await purchase(page), original = await parcel(f.orderRef), before = await state(f);
    const actor = await portalOperator(page, locale);
    const hold = await createPostgresCommerceOmsPort(runtime).createHold({ idempotencyKey: randomUUID(), orderId: f.orderRef,
      actorUserId: actor, reason: 'fulfillment_exception' });
    const panel = await operatorDetail(page, f.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=confirmed]') }).first();
    await expect(form).toBeVisible(); await accessible(form); await expect(panel).toContainText('1 Example Lane');
    await form.locator('[name=reason]').selectOption('lost');
    expect((await call(page, 'operator.replacement', { orderRef: f.orderRef, reason: 'lost' })).code).toBe('starter_input_invalid');
    await form.locator('[name=confirmed]').check();
    const sentRequest = page.waitForRequest(row => row.url().endsWith('/api/actions/operator.replacement'));
    const response = page.waitForResponse(row => row.url().endsWith('/api/actions/operator.replacement'));
    await form.getByRole('button', { name: copy[locale].requestReplacement, exact: true }).click();
    const result = await (await response).json(); expect(result.ok, result.code).toBe(true);
    await expect(page.locator('[data-parcel-result]')).toContainText(original.shipmentId);
    expect(result.value.releasedHoldIds).toEqual([hold.hold.id]);
    const replayKey = (await sentRequest).headers()['idempotency-key']!;
    expect((await call(page, 'operator.replacement', { orderRef: f.orderRef, reason: 'lost', confirmed: true }, replayKey)).replayed).toBe(true);
    expect((await call(page, 'operator.replacement', { orderRef: f.orderRef, reason: 'damaged', confirmed: true }, replayKey)).ok).toBe(false);
    const replacement = result.value.replacement.fulfillmentOrderId;
    expect((await runtime.query('SELECT status,replaces_shipment_id FROM public.fulfillment_shipments WHERE id=$1', [replacement])).rows[0]).toEqual({ status: 'created', replaces_shipment_id: original.shipmentId });
    await expect(page.locator('[data-order-controls]')).toContainText(replacement);
    expect((await state(f)).next_cycle_at).toEqual(before.next_cycle_at);
    const key = randomUUID(), request = { orderRef: f.orderRef, reason: 'lost', confirmed: true };
    expect((await call(page, 'operator.replacement', request, key)).ok).toBe(false);
    await expect(page.getByRole('button', { name: /confirm.*deliver|potwierdź.*doręczenie/i })).toHaveCount(0);
  });

  test(`${locale}: portal complete fulfillment cancellation releases only recorded reservations and replays`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
    const shipment = await parcel(f.orderRef); await portalOperator(page, locale);
    const panel = await operatorDetail(page, f.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=confirmed]') }).last(); await expect(form).toBeVisible(); await accessible(form);
    await form.locator('[name=reason]').fill('Cancel this fictional parcel'); await form.locator('[name=confirmed]').check();
    const request = page.waitForRequest(row => row.url().endsWith('/api/actions/operator.cancelFulfillment'));
    await form.getByRole('button', { name: copy[locale].cancelFulfillment, exact: true }).click();
    const sent = await request, key = sent.headers()['idempotency-key']!;
    await expect(page.locator('[data-parcel-result]')).toContainText('cancelled');
    const replay = await call(page, 'operator.cancelFulfillment', { shipmentRef: shipment.shipmentId, reason: 'Cancel this fictional parcel', confirmed: true }, key);
    expect(replay.ok).toBe(true); expect(replay.replayed).toBe(true);
    expect((await call(page, 'operator.cancelFulfillment', { shipmentRef: shipment.shipmentId, reason: 'Changed reason', confirmed: true }, key)).ok).toBe(false);
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [f.orderRef])).rows[0].status).toBe('paid');
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 AND status IN ('held','committed')", [f.orderRef])).rows[0].n).toBe(0);
  });

  test(`${locale}: portal provider cancellation keeps payment and invoice facts and rejects revoked replay`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
    const original = await parcel(f.orderRef), document = await issuedInvoice(f.orderRef), actor = await portalOperator(page, locale);
    const request = { shipmentRef: original.shipmentId, reason: 'Provider confirmed cancellation', confirmed: true };
    // External provider fixture, matching native dispatch ownership and normalized cancellation evidence.
    await owner.query('INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref,withheld) VALUES($1,$2,$3,false)',
      [original.shipmentId, { schemaVersion: 1, source: 'contact', revision: 1 }, configurations[material.id]!.purchase.stock.providerRef]);
    await owner.query("INSERT INTO public.fulfillment_dispatch_refs(request_key,shipment_id,order_id,mode,evidence) VALUES($1,$2,$3,'live','{}')", [randomUUID(), original.shipmentId, f.orderRef]);
    const stock = async () => (await runtime.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 ORDER BY id', [f.orderRef])).rows;
    const beforeStock = await stock();
    expect((await call(page, 'operator.cancelFulfillment', request)).code).toBe('starter_fulfillment_provider_dispatch_active');
    expect(await stock()).toEqual(beforeStock);
    await owner.query("UPDATE public.fulfillment_dispatch_refs SET status='cancelled' WHERE shipment_id=$1", [original.shipmentId]);
    await owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [original.shipmentId]);
    const event = randomUUID();
    await runtime.query('SELECT public.fulfillment_record_observation($1,$2,$3,$4)', [event, original.shipmentId,
      { providerStatus: { primary: 'CANCELLED' }, fact: { occurredAt: '2026-11-03T00:00:00Z' }, correlation: { fulfillmentRef: original.shipmentId } }, '2026-11-10T12:00:00Z']);
    await runtime.query('SELECT public.fulfillment_record_operator_status_evidence($1,$2)', [event, original.shipmentId]);
    const externalOms = createPostgresCommerceOmsPort(runtime);
    const hold = await externalOms.createHold({ idempotencyKey: randomUUID(), orderId: f.orderRef, reason: 'fulfillment_exception', actorUserId: actor });
    expect((await call(page, 'operator.cancelFulfillment', request)).code).toBe('starter_fulfillment_active_hold');
    await externalOms.releaseHold({ idempotencyKey: randomUUID(), holdId: hold.hold.id, actorUserId: actor });
    const facts = async () => ({ money: (await runtime.query('SELECT to_jsonb(i) AS value FROM public.commerce_settlement_intents i WHERE order_id=$1', [f.orderRef])).rows,
      invoice: (await runtime.query('SELECT to_jsonb(d) AS value FROM public.accounting_documents d WHERE id=$1', [document])).rows });
    const before = await facts(), panel = await operatorDetail(page, f.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=confirmed]') }).last();
    await form.locator('[name=reason]').fill(request.reason); await form.locator('[name=confirmed]').check();
    await form.getByRole('button', { name: copy[locale].cancelFulfillment, exact: true }).click();
    await expect(page.locator('[data-parcel-result]')).toContainText('cancelled');
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [f.orderRef])).rows[0].status).toBe('cancelled');
    expect(await facts()).toEqual(before);
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.cancelled'", [f.orderRef])).rows[0].n).toBe(0);
    const key = randomUUID(); expect((await call(page, 'operator.cancelFulfillment', request, key)).replayed).toBe(true);
    const root = (await owner.query("SELECT principal_id FROM public.platform_human_memberships WHERE membership_state='active' AND role='admin' AND principal_id<>$1 LIMIT 1", [actor])).rows[0].principal_id;
    const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
    try { await invitations.remove({ actorPrincipalId: root, targetPrincipalId: actor }); } finally { await invitations.close(); }
    expect((await call(page, 'operator.cancelFulfillment', request, key)).code).toBe('operator_required');
    await portalOperator(page, locale, 'distributor');
    expect((await call(page, 'operator.cancelFulfillment', request)).code).toBe('operator_required');
    expect((await call(page, 'operator.cancelFulfillment', request, key)).code).toBe('operator_required');
    expect((await call(page, 'operator.replacement', { orderRef: f.orderRef, reason: 'lost', confirmed: true })).code).toBe('operator_required');
  });

}
});
