import { once } from 'node:events';
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
  // This care fixture supplies its own external carrier facts.
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
  // The external dispatch fixture freezes carrier contact before operator evidence.
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
    const priorDecline = await page.getByRole('button', { name: copy[locale].simulateDeclined, exact: true }).elementHandle();
    await page.getByRole('button', { name: copy[locale].simulateDeclined, exact: true }).click();
    await expect.poll(() => priorDecline!.evaluate(element => element.isConnected)).toBe(false);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy[locale].simulatePaid, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    await context.clearCookies();
    for (const message of captured) {
      await page.goto(String(message.recoveryUrl)); await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
      await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
    }
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1 AND e.outcome='captured'", [f.orderRef])).rows[0].n).toBe(1);
  });


  test(`${locale}: portal expired-checkout notice retains the source order before replacement payment`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE purchase_order_id=$1", [f.orderRef]);
    await checkoutMail(locale);
    const message = (await messages()).find(row => row.kind === 'checkout_expired' && row.orderId === `order_${f.orderRef}`)!;
    expect(message).toBeTruthy(); expect(message.locale).toBe(locale);
    await page.goto(String(message.recoveryUrl));
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText(f.orderRef);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy[locale].recoveryPay, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryUnavailable);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
    expect((await owner.query('SELECT id FROM public.commerce_orders WHERE recreated_from_order_id=$1', [f.orderRef])).rows).toHaveLength(0);
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1', [f.orderRef])).rows).toHaveLength(0);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
  });


  test(`${locale}: portal abandoned initial checkout notice cannot activate or pay a subscription`, async ({ page }) => {
    const f = await pendingCheckout(page, locale, 'subscription');
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '3 hours' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.subscription_activations SET declared_at=now()-interval '3 hours' WHERE order_id=$1", [f.orderRef]);
    await checkoutMail(locale);
    const message = (await messages()).find(row => row.kind === 'checkout_expired' && row.orderId === `order_${f.orderRef}`)!;
    expect(message).toBeTruthy(); await page.goto(String(message.recoveryUrl));
    await expect(page.locator('main')).toContainText(f.orderRef);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy[locale].recoveryPay, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryUnavailable);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
    expect((await owner.query('SELECT id FROM public.commerce_orders WHERE recreated_from_order_id=$1', [f.orderRef])).rows).toHaveLength(0);
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1', [f.orderRef])).rows).toHaveLength(0);
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

  test(`${locale}: portal delayed checkout response cannot replace the displayed issued purchase`, async ({ page }) => {
    const issued = await pendingCheckout(page, locale); await portalOperator(page, locale);
    await page.goto(routes.builder[locale]);
    await page.getByLabel(copy[locale].purchaseMode, { exact: true }).selectOption('one_time');
    await page.getByRole('spinbutton').first().fill(String(configurations[material.id]!.offer.minUnits));
    await page.getByRole('button', { name: copy[locale].addBox, exact: true }).click();
    await page.getByRole('button', { name: copy[locale].checkout, exact: true }).click();
    const buyerEmail = `delayed-${randomUUID()}@example.test`;
    await page.getByLabel(copy[locale].email, { exact: true }).fill(buyerEmail);
    const quoted = page.waitForResponse(row => row.url().endsWith('/api/actions/offer.validate')
      && row.request().postDataJSON().email === buyerEmail);
    await page.getByLabel(copy[locale].email, { exact: true }).blur();
    await (await quoted).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    await page.getByLabel(copy[locale].termsAccept).check();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let createdStatus = 'not_submitted';
    let received!: (order: string) => void;
    const pending = new Promise<string>(done => { received = done; });
    let finished!: () => void;
    const delivered = new Promise<void>(done => { finished = done; });
    await page.route('**/api/actions/checkout.create', async route => {
      const response = await route.fetch(), body = await response.json();
      createdStatus = body.ok ? 'created' : body.code;
      expect(body.ok, body.code).toBe(true); received(body.value.orderRef);
      await gate; await route.fulfill({ response }); finished();
    });
    await test.step('submit the pending checkout', async () => {
      await page.getByRole('button', { name: copy[locale].placeOrder, exact: true }).click();
      await expect.poll(() => createdStatus).toBe('created');
    });
    const other = await pending;
    await page.locator('footer').getByRole('link', { name: copy[locale].admin, exact: true }).click();
    const panel = await operatorDetail(page, issued.orderRef, locale);
    const form = panel.locator('form').filter({ has: page.locator('[name=delivery]') }); await accessible(form);
    await form.getByRole('button', { name: copy[locale].paymentLink, exact: true }).click();
    await panel.getByRole('link', { name: copy[locale].completion, exact: true }).click();
    await expect(page.locator('main')).toContainText(issued.orderRef);
    const lateResponse = page.waitForResponse(row => row.url().endsWith('/api/actions/checkout.create'));
    await test.step('deliver the late checkout response', async () => {
      release(); await delivered; await (await lateResponse).finished();
    });
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    // The completed response must not replace the active page's reload convenience.
    await expect.poll(() => page.evaluate(configuration => {
      const value = JSON.parse(sessionStorage.getItem(`neutral-store:purchase:v2:${configuration}`) ?? 'null');
      return value?.orderRef;
    }, material.id)).toBe(issued.orderRef);
    const paymentRequest = page.waitForRequest(row => row.url().endsWith('/api/actions/payment.simulate'));
    const payment = page.getByRole('button', { name: copy[locale].simulatePaid, exact: true });
    await expect(payment).toHaveAccessibleName(copy[locale].simulatePaid); await payment.click();
    expect((await paymentRequest).postDataJSON().orderRef).toBe(issued.orderRef);
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [issued.orderRef])).rows[0].status).toBe('paid');
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [other])).rows[0].status).toBe('pending_payment');
    await page.reload(); await expect(page.locator('main')).toContainText(issued.orderRef);
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
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
    await page.goto(url.href); await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
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
    const form = panel.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].requestReplacement, exact: true }) });
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
async function expiredCheckout(page: Page, locale: Locale, mode: 'one_time' | 'subscription' = 'one_time') {
  const f = await pendingCheckout(page, locale, mode);
  expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'refused' })).ok).toBe(true);
  await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [f.orderRef]);
  await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE purchase_order_id=$1", [f.orderRef]);
  if (mode === 'subscription') {
    // Canonical compensated initial-source fixture, matching the package recreation witness.
    // An automatic no-provider abandonment is separately covered by the existing portal case.
    await runtime.query('SELECT public.commerce_cancel_abandoned_purchase_checkout($1,$2,$3,$4)', [randomUUID(), f.orderRef, 'provisional_payment_window_elapsed', new Date().toISOString()]);
    await owner.query("UPDATE public.commerce_orders SET metadata=metadata||'{\"subscriptionActivation\":\"abandoned\",\"source\":\"initial_checkout_sweep\",\"paymentStatus\":\"cancelled\"}'::jsonb WHERE id=$1", [f.orderRef]);
  }
  await checkoutMail(locale);
  expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [f.orderRef])).rows[0].status).toBe(mode === 'subscription' ? 'cancelled' : 'expired');
  return f;
}
for (const locale of ['en','pl'] as const) {
  test(`${locale}: recovery extension human holds replay, conflict, target and role admission`, async ({ page }) => {
    const f = await pendingCheckout(page, locale), actor = await portalOperator(page, locale);
    const key = randomUUID(), payload = { orderRef: f.orderRef.toUpperCase(), reason: 'manual_support', note: 'Example hold' };
    for (const field of ['actorUserId','principalRef','operatorRef','clientId','customerRef']) {
      expect((await call(page, 'operator.hold', { ...payload, [field]: actor })).code).toBe('starter_input_invalid');
      expect((await call(page, 'operator.release', { holdRef: randomUUID(), [field]: actor })).code).toBe('starter_input_invalid');
    }
    const held = await call(page, 'operator.hold', payload, key); expect(held.ok).toBe(true);
    expect((await call(page, 'operator.hold', payload, key)).replayed).toBe(true);
    expect((await call(page, 'operator.hold', { ...payload, reason: 'risk_review' }, key)).code).toBe('starter_order_hold_conflict');
    expect((await call(page, 'operator.release', { holdRef: randomUUID() })).ok).toBe(false);
    const panel = page.locator('#orders'); const release = panel.locator('form').filter({ has: page.locator('[name=holdRef]') });
    await release.locator('[name=holdRef]').fill(held.value.hold.id.toUpperCase());
    await release.getByRole('button', { name: copy[locale].releaseHold, exact: true }).click();
    await expect(release).toContainText('released'); await accessible(release);
    expect((await call(page, 'operator.release', { holdRef: held.value.hold.id })).ok).toBe(false);
    // Membership withdrawal preserves the Commerce row and denies durable replay.
    const root = (await owner.query("SELECT principal_id FROM public.platform_human_memberships WHERE membership_state='active' AND role='admin' AND principal_id<>$1 LIMIT 1", [actor])).rows[0].principal_id;
    const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
    try { await invitations.remove({ actorPrincipalId: root, targetPrincipalId: actor }); } finally { await invitations.close(); }
    expect((await call(page, 'operator.hold', payload, key)).code).toBe('operator_required');
    const missing = await portalOperator(page, locale);
    // This principal has created no holds; remove its fixture row to test absent provisioning.
    await owner.query('DELETE FROM public.commerce_operators WHERE id=$1', [missing]);
    expect((await call(page, 'operator.hold', payload)).code).toBe('operator_required');
    await portalOperator(page, locale, 'distributor');
    expect((await call(page, 'operator.hold', payload, key)).code).toBe('operator_required');
    expect((await call(page, 'operator.release', { holdRef: held.value.hold.id })).code).toBe('operator_required');
  });
  test(`${locale}: recovery extension hold replay survives host restart`, async ({ page }) => {
    const { spawn } = await import('node:child_process');
    const { createServer } = await import('node:net');
    const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port; await new Promise<void>(done => probe.close(() => done()));
    const priorURL = material.baseURL, address = `http://127.0.0.1:${port}`;
    const connection = new URL(material.runtimeUrl), password = decodeURIComponent(connection.password); connection.password = '';
    const start = async () => {
      const child = spawn(process.execPath, ['--experimental-strip-types', resolve('host/server.ts'), '--configuration', material.id,
        '--port', String(port), '--database-url', connection.href], { cwd: material.state, env: { PGPASSWORD: password }, stdio: ['ignore','pipe','pipe'] });
      let diagnostic = '';
      child.stdout?.on('data', value => { diagnostic += String(value); }); child.stderr?.on('data', value => { diagnostic += String(value); });
      try { await expect.poll(async () => fetch(address + '/api/config').then(r => r.ok).catch(() => false)).toBe(true); }
      catch { await createPrivateCapture(resolve(material.state, '.context/captured-messages')).writeOnce('restart-host:' + randomUUID(), { diagnostic }); child.kill('SIGTERM'); throw new Error('starter_restart_host_unavailable'); }
      return child;
    };
    let host = await start(); material.baseURL = address;
    try {
      const f = await pendingCheckout(page, locale); await portalOperator(page, locale);
      const key = randomUUID(), input = { orderRef: f.orderRef, reason: 'manual_support' };
      const held = await call(page, 'operator.hold', input, key); expect(held.ok).toBe(true);
      const stopped = once(host, 'exit'); host.kill('SIGTERM'); await stopped; host = await start();
      // New native administrator session after restart; the original receipt and actor attribution stay durable.
      await portalOperator(page, locale);
      expect((await call(page, 'operator.hold', input, key)).replayed).toBe(true);
      const releaseKey = randomUUID(), target = { holdRef: held.value.hold.id.toUpperCase() };
      expect((await call(page, 'operator.release', target, releaseKey)).ok).toBe(true);
      expect((await call(page, 'operator.release', target, releaseKey)).replayed).toBe(true);
    } finally { material.baseURL = priorURL; const stopped = once(host, 'exit'); host.kill('SIGTERM'); await stopped; }
  });
  test(`${locale}: recovery extension locked upcoming cycle refuses address change visibly`, async ({ page }) => {
    const f = await purchase(page); await signIn(page, f.email, locale);
    await owner.query('UPDATE public.subscription_cycles SET scheduled_at=$2 WHERE subscription_id=$1 AND status=\'paid\'', [f.subscriptionId,f.nextCycleAt]);
    const form = page.locator('form').filter({ has: page.locator('[name=subscriptionRef]') }).filter({ has: page.locator('[name=line1]') });
    for (const [name,value] of Object.entries({ subscriptionRef: f.subscriptionId,recipientName: 'Example Customer',line1: 'Example Street 2',postalCode: '00-001',city: 'Example City',phone: '+999123456789' })) await form.locator(`[name=${name}]`).fill(value);
    await form.getByRole('button', { name: copy[locale].save, exact: true }).click();
    await expect(form).toContainText('payment_blocked'); await accessible(form);
  });
  for (const mode of ['one_time','subscription'] as const) test(`${locale}: recovery extension ${mode} expired-policy Pay creates one replacement and one attempt, then pays it`, async ({ page }) => {
    const f = await expiredCheckout(page, locale, mode);
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 days' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.commerce_checkout_recovery_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE order_id=$1", [f.orderRef]);
    const source = await call(page, 'checkout.recovery', { token: f.token, action: 'inspect' });
    expect(source.value.recoveryKind).toBe('recreate_expired');
    expect((await call(page, 'checkout.read', { token: f.token })).code).toBe('starter_recovery_expired');
    await page.goto(routes.completion[locale] + '?' + new URLSearchParams({ token: f.token }));
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
    await accessible(page.locator('main'));
    await page.getByRole('button', { name: copy[locale].recoveryPay, exact: true }).click();
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
    const replay = await call(page, 'checkout.recovery', { token: f.token, action: 'pay' }); expect(replay.ok).toBe(true);
    const rows = (await runtime.query('SELECT id FROM public.commerce_orders WHERE recreated_from_order_id=$1', [f.orderRef])).rows;
    expect(rows).toHaveLength(1); expect(replay.value.latestOrderRef).toBe(rows[0].id);
    expect(replay.replayed).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
    const execution = await call(page, 'checkout.recovery', { token: f.token, action: 'inspect' });
    expect(execution.value.recoverable).toBe(false);
    expect(execution.value.recreatedExecution.attemptRef).toBe(replay.value.attemptRef);
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1', [rows[0].id])).rows).toHaveLength(1);
    await page.getByRole('button', { name: copy[locale].simulatePaid, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [f.orderRef])).rows[0].status).toBe(mode === 'subscription' ? 'cancelled' : 'expired');
    await page.reload(); await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid);
    const settled = await call(page, 'checkout.recovery', { token: f.token, action: 'inspect' });
    expect(settled.value.terminalStatus).toBe('paid'); expect(settled.value.recreatedExecution).toBeUndefined();
    expect((await call(page, 'checkout.recovery', { token: f.token, action: 'simulate', orderRef: rows[0].id, attemptRef: replay.value.attemptRef, outcome: 'refused' })).code).toBe('starter_recovery_unavailable');
    expect((await owner.query('SELECT id FROM public.payment_simulator_attempts WHERE settlement_intent_id=(SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1)', [rows[0].id])).rows.map(row => row.id)).toEqual([replay.value.attemptRef]);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
  });
  test(`${locale}: recovery extension recreated order cannot retry through ordinary payment even for its owner`, async ({ page }) => {
    const f = await expiredCheckout(page, locale);
    const started = await call(page, 'checkout.recovery', { token: f.token, action: 'pay' }); expect(started.ok).toBe(true);
    const target = { token: f.token, orderRef: started.value.latestOrderRef, attemptRef: started.value.attemptRef };
    expect((await call(page, 'checkout.recovery', { ...target, action: 'simulate', outcome: 'refused' })).ok).toBe(true);
    await signIn(page, f.email, locale);
    expect((await call(page, 'payment.simulate', { orderRef: target.orderRef, outcome: 'captured' })).code).toBe('starter_recovery_unavailable');
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1', [target.orderRef])).rows).toHaveLength(1);
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [target.orderRef])).rows[0].status).toBe('pending_payment');
    // Source continuation can expire without invalidating the exact dispatched replacement execution.
    await owner.query("UPDATE public.commerce_checkout_recovery_tokens SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE order_id=$1", [f.orderRef]);
    const inspected = await call(page, 'checkout.recovery', { token: f.token, action: 'inspect' });
    expect(inspected.value.recoverable).toBe(false); expect(inspected.value.recreatedExecution.attemptRef).toBe(target.attemptRef);
    const replay = await call(page, 'checkout.recovery', { token: f.token, action: 'pay' });
    expect(replay.replayed).toBe(true); expect(replay.value.attemptRef).toBe(target.attemptRef);
    expect((await call(page, 'checkout.recovery', { ...target, attemptRef: randomUUID(), action: 'simulate', outcome: 'captured' })).ok).toBe(false);
    expect((await call(page, 'checkout.recovery', { ...target, orderRef: randomUUID(), action: 'simulate', outcome: 'captured' })).ok).toBe(false);
    expect((await call(page, 'checkout.recovery', { ...target, action: 'simulate', outcome: 'captured' })).ok).toBe(true);
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=$1', [target.orderRef])).rows).toHaveLength(1);
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1 AND e.outcome='captured'", [target.orderRef])).rows[0].n).toBe(1);
  });
  test(`${locale}: recovery extension terminal and captured execution suppress stale attempt controls`, async ({ page }) => {
    const token = 'rcv_' + 'a'.repeat(64), attempt = { latestOrderRef: randomUUID(), attemptRef: randomUUID() };
    for (const terminalStatus of ['paid', undefined]) {
      await page.route('**/api/actions/checkout.recovery', route => route.fulfill({ json: { ok: true, value: {
        recoverable: false, terminalStatus, recreatedExecution: { ...attempt, state: terminalStatus ? 'dispatched' : 'captured' },
      } } }));
      await page.goto(routes.completion[locale] + '?' + new URLSearchParams({ token }));
      await expect(page.locator('main')).toContainText(copy[locale][terminalStatus ? 'recoveryPaid' : 'recoveryUnavailable']);
      await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
      await accessible(page.locator('main')); await page.unroute('**/api/actions/checkout.recovery');
    }
  });
  test(`${locale}: recovery extension simulator refuses terminal observations and technically expired replacements`, async ({ page }) => {
    const f = await expiredCheckout(page, locale);
    const started = await call(page, 'checkout.recovery', { token: f.token, action: 'pay' }); expect(started.ok).toBe(true);
    const input = { token: f.token, action: 'simulate', orderRef: started.value.latestOrderRef, attemptRef: started.value.attemptRef };
    expect((await call(page, 'checkout.recovery', { ...input, outcome: 'refused' })).ok).toBe(true);
    expect((await call(page, 'checkout.recovery', { ...input, outcome: 'expired' })).code).toBe('starter_recovery_unavailable');
    await owner.query("UPDATE public.commerce_orders SET metadata=metadata||'{\"paymentStatus\":\"expired\"}'::jsonb WHERE id=$1", [input.orderRef]);
    expect((await call(page, 'checkout.recovery', { ...input, outcome: 'captured' })).code).toBe('starter_recovery_unavailable');
    expect((await owner.query('SELECT count(*)::int AS n FROM public.payment_simulator_observations WHERE attempt_id=$1', [input.attemptRef])).rows[0].n).toBe(1);
  });
  test(`${locale}: recovery extension source outside the 30-day window refuses recreation`, async ({ page }) => {
    const f = await expiredCheckout(page, locale);
    await owner.query("UPDATE public.commerce_orders SET created_at=now()-interval '31 days' WHERE id=$1", [f.orderRef]);
    await owner.query("UPDATE public.commerce_checkout_recovery_tokens SET created_at=now()-interval '31 days',expires_at=now()-interval '30 days' WHERE order_id=$1", [f.orderRef]);
    const inspected = await call(page, 'checkout.recovery', { token: f.token, action: 'inspect' });
    expect(inspected.value.recoverable).toBe(false); expect(inspected.value.recreatedExecution).toBeUndefined();
    await page.goto(routes.completion[locale] + '?' + new URLSearchParams({ token: f.token }));
    await expect(page.locator('main')).toContainText(copy[locale].recoveryExpired);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
    expect((await call(page, 'checkout.recovery', { token: f.token, action: 'pay' })).ok).toBe(false);
    expect((await runtime.query('SELECT id FROM public.commerce_orders WHERE recreated_from_order_id=$1', [f.orderRef])).rows).toHaveLength(0);
    expect((await runtime.query('SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1', [`checkout-recovery-recreate:${f.orderRef}`])).rows).toHaveLength(0);
    await accessible(page.locator('main'));
  });
  test(`${locale}: recovery extension paid and cancelled orders never offer Pay`, async ({ page }) => {
    for (const paid of [true,false]) {
      const f = await pendingCheckout(page, locale);
      if (paid) expect((await call(page, 'payment.simulate', { token: f.token, orderRef: f.orderRef, outcome: 'captured' })).ok).toBe(true);
      else await runtime.query('SELECT public.commerce_cancel_abandoned_purchase_checkout($1,$2,$3,$4)', [randomUUID(), f.orderRef, 'manual_cancel', new Date().toISOString()]);
      await page.goto(routes.completion[locale] + '?' + new URLSearchParams({ token: f.token }));
      await expect(page.locator('main')).toContainText(copy[locale][paid ? 'recoveryPaid' : 'recoveryCancelled']);
      await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toHaveCount(0);
    }
  });
  for (const refusal of ['drift','content','stock'] as const) test(`${locale}: recovery extension ${refusal} refusal starts no payment`, async ({ page }) => {
    const f = await expiredCheckout(page, locale);
    if (refusal === 'content') await owner.query(`UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context}',(metadata#>'{quoteSnapshot,quote,context}')||'{"offerVersion":"sized.v1","starterPack":{}}'::jsonb) WHERE id=$1`, [f.orderRef]);
    if (refusal === 'drift') await owner.query(`UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,totalGross,amountMinor}','1'::jsonb) WHERE id=$1`, [f.orderRef]);
    await page.goto(routes.completion[locale] + '?' + new URLSearchParams({ token: f.token }));
    if (refusal === 'stock') {
      await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toBeVisible();
      const saved = (await owner.query('SELECT sku,for_sale_quantity FROM public.fulfillment_stock_current WHERE source_key=$1', [`starter-demo:${material.id}`])).rows;
      try {
        await owner.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1', [`starter-demo:${material.id}`]);
        await page.getByRole('button', { name: copy[locale].recoveryPay, exact: true }).click();
        await expect(page.locator('main')).toContainText(copy[locale].recoveryChanged);
      } finally { for (const row of saved) await owner.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=$3 WHERE source_key=$1 AND sku=$2', [`starter-demo:${material.id}`,row.sku,row.for_sale_quantity]); }
    } else await expect(page.locator('main')).toContainText(copy[locale].recoveryChanged);
    await expect(page.getByRole('button', { name: copy[locale].recoveryPay, exact: true })).toHaveCount(0);
    expect((await owner.query('SELECT a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id JOIN public.commerce_orders o ON o.id=i.order_id WHERE o.recreated_from_order_id=$1', [f.orderRef])).rows).toHaveLength(0);
    if (refusal !== 'stock') { const attempted = await call(page, 'checkout.recovery', { token: f.token, action: 'pay' }); expect(attempted.ok).toBe(false); }
    await accessible(page.locator('main'));
  });
}

for (const locale of ['en','pl'] as const) {
  test(`${locale}: operator operations cancel unpaid order with confirmation, exact replay and human authority`, async ({ page }) => {
    const f = await pendingCheckout(page, locale), actor = await portalOperator(page, locale);
    const input = { orderRef: f.orderRef.toUpperCase(), reason: 'Reviewed unpaid cancellation', confirmed: true };
    expect((await call(page, 'operator.cancelUnpaid', { ...input, confirmed: false })).code).toBe('starter_input_invalid');
    const detail = page.locator('[data-order-controls]');
    const lookup = page.locator('#orders form').filter({ has: page.locator('[name=orderRef]') }).filter({ has: page.getByRole('button', { name: copy[locale].read, exact: true }) });
    await lookup.locator('[name=orderRef]').fill(f.orderRef); await lookup.getByRole('button', { name: copy[locale].read, exact: true }).click();
    const form = detail.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].cancelUnpaid, exact: true }) });
    await form.locator('[name=reason]').fill(input.reason); await form.locator('[name=confirmed]').check();
    await accessible(form);
    const request = page.waitForRequest(request => request.url().endsWith('/api/actions/operator.cancelUnpaid'));
    await form.getByRole('button', { name: copy[locale].cancelUnpaid, exact: true }).click();
    const key = (await request).headers()['idempotency-key']!;
    await expect(page.locator('[data-parcel-result]')).toContainText('cancelled');
    await expect(detail.getByRole('button', { name: copy[locale].cancelUnpaid, exact: true })).toHaveCount(0);
    const before = (await runtime.query('SELECT count(*)::int AS n FROM public.commerce_order_operations WHERE order_id=$1', [f.orderRef])).rows[0].n;
    expect((await call(page, 'operator.cancelUnpaid', input, key)).replayed).toBe(true);
    expect((await call(page, 'operator.cancelUnpaid', { ...input, reason: 'Changed reason' }, key)).code).toBe('starter_order_transition_conflict');
    expect((await runtime.query('SELECT count(*)::int AS n FROM public.commerce_order_operations WHERE order_id=$1', [f.orderRef])).rows[0].n).toBe(before);
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 AND status='held'", [f.orderRef])).rows[0].n).toBe(0);
    for (const operation of ['operator.cancelUnpaid','operator.externalRefund']) for (const field of ['actorUserId','principalRef','operatorRef'])
      expect((await call(page, operation, { ...input, [field]: actor })).code).toBe('starter_input_invalid');
    const root = (await owner.query("SELECT principal_id FROM public.platform_human_memberships WHERE membership_state='active' AND role='admin' AND principal_id<>$1 LIMIT 1", [actor])).rows[0].principal_id;
    const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
    try { await invitations.remove({ actorPrincipalId: root, targetPrincipalId: actor }); } finally { await invitations.close(); }
    expect((await call(page, 'operator.cancelUnpaid', input, key)).code).toBe('operator_required');
    const missing = await portalOperator(page, locale); await owner.query('DELETE FROM public.commerce_operators WHERE id=$1', [missing]);
    for (const operation of ['operator.cancelUnpaid','operator.externalRefund']) expect((await call(page, operation, input)).code).toBe('operator_required');
    await portalOperator(page, locale, 'distributor');
    for (const operation of ['operator.cancelUnpaid','operator.externalRefund']) expect((await call(page, operation, input, key)).code).toBe('operator_required');
  });
  test(`${locale}: operator operations refuse dispatched, indeterminate and paid cancellation without effects`, async ({ page }) => {
    const { createPostgresSandboxPaymentSimulator } = await import('@openlup/platform/payments');
    for (const outcome of ['dispatched','indeterminate','captured'] as const) {
      const f = await pendingCheckout(page, locale);
      if (outcome === 'dispatched') {
        const intent = (await runtime.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1', [f.orderRef])).rows[0].id;
        await createPostgresSandboxPaymentSimulator(runtime, configurations[material.id]!.purchase.sandbox).beginAttempt({ settlementIntentId: intent, idempotencyKey: randomUUID(), requestFingerprint: createHash('sha256').update(f.orderRef).digest('hex'), at: new Date().toISOString() });
      } else expect((await call(page, 'payment.simulate', { token: f.token, orderRef: f.orderRef, outcome })).ok).toBe(true);
      await portalOperator(page, locale);
      const before = (await owner.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$1', [f.orderRef])).rows[0].rows;
      const operations = (await runtime.query('SELECT count(*)::int AS n FROM public.commerce_order_operations WHERE order_id=$1', [f.orderRef])).rows[0].n;
      const input = { orderRef: f.orderRef, reason: 'Cannot override payment evidence', confirmed: true };
      expect((await call(page, 'operator.cancelUnpaid', input)).code).toBe('starter_order_transition_conflict');
      if (outcome !== 'captured') expect((await call(page, 'operator.externalRefund', input)).code).toBe('starter_order_transition_conflict');
      expect((await owner.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$1', [f.orderRef])).rows[0].rows).toEqual(before);
      expect((await runtime.query('SELECT count(*)::int AS n FROM public.commerce_order_operations WHERE order_id=$1', [f.orderRef])).rows[0].n).toBe(operations);
    }
  });
  test(`${locale}: operator operations manual refund marking records no money, mail or subscription change`, async ({ page }) => {
    const f = await purchase(page); await portalOperator(page, locale);
    const subscription = (await runtime.query('SELECT to_jsonb(s) AS value FROM public.subscriptions s WHERE id=$1', [f.subscriptionId])).rows[0].value;
    const events = (await runtime.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.refunded'", [f.orderRef])).rows[0].n;
    const truth = (await owner.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) AS value FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1', [f.orderRef])).rows[0].value;
    const detail = page.locator('[data-order-controls]');
    const lookup = page.locator('#orders form').filter({ has: page.locator('[name=orderRef]') }).filter({ has: page.getByRole('button', { name: copy[locale].read, exact: true }) });
    await lookup.locator('[name=orderRef]').fill(f.orderRef); await lookup.getByRole('button', { name: copy[locale].read, exact: true }).click();
    const form = detail.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].externalRefund, exact: true }) });
    await expect(form).toContainText(copy[locale].externalRefund); await form.locator('[name=reason]').fill('External refund completed');
    await form.locator('[name=confirmed]').check(); await accessible(form);
    const request = page.waitForRequest(request => request.url().endsWith('/api/actions/operator.externalRefund'));
    await form.getByRole('button', { name: copy[locale].externalRefund, exact: true }).click();
    const key = (await request).headers()['idempotency-key']!;
    await expect(page.locator('[data-parcel-result]')).toContainText('refunded');
    const input = { orderRef: f.orderRef.toUpperCase(), reason: 'External refund completed', confirmed: true };
    expect((await call(page, 'operator.externalRefund', input, key)).replayed).toBe(true);
    expect((await call(page, 'operator.externalRefund', { ...input, reason: 'Different reason' }, key)).code).toBe('starter_order_transition_conflict');
    expect((await call(page, 'operator.externalRefund', input)).ok).toBe(true);
    expect((await runtime.query('SELECT to_jsonb(s) AS value FROM public.subscriptions s WHERE id=$1', [f.subscriptionId])).rows[0].value).toEqual(subscription);
    expect((await runtime.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.refunded'", [f.orderRef])).rows[0].n).toBe(events);
    expect((await owner.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) AS value FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=$1', [f.orderRef])).rows[0].value).toEqual(truth);
  });
}

for (const locale of ['en','pl'] as const) {
  test(`${locale}: returns portal owned paid request, canonical replay and customer refusals`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
    await signIn(page, f.email, locale);
    const item = (await runtime.query('SELECT id,quantity FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal LIMIT 1', [f.orderRef])).rows[0];
    const input = { orderRef: f.orderRef, reasonCode: configurations[material.id]!.returns.reasons[0]!.code, lines: [{ orderItemId: item.id, quantity: 1 }] };
    await page.goto(routes.returns[locale]);
    const form = page.locator('main form'); await accessible(form);
    await form.locator('[name=orderRef]').fill(f.orderRef.toUpperCase());
    await form.locator('[name=orderItemId]').fill(item.id.toUpperCase()); await form.locator('[name=quantity]').fill('1');
    const response = page.waitForResponse(r => r.url().endsWith('/api/actions/return.request'));
    await form.getByRole('button', { name: copy[locale].requestReturn, exact: true }).click();
    const created = await (await response).json(); expect(created.ok).toBe(true);
    await expect(form.locator('.action-result')).toContainText(created.value.returnRequestId);
    const key = randomUUID(), first = await call(page, 'return.request', input, key); expect(first.ok).toBe(true);
    const replay = await call(page, 'return.request', { ...input, orderRef: f.orderRef.toUpperCase(), customerNote: '' }, key);
    expect(replay.ok).toBe(true); expect(replay.replayed).toBe(true); expect(replay.value.returnRequestId).toBe(first.value.returnRequestId);
    const count = async () => (await runtime.query('SELECT count(*)::int AS n FROM public.commerce_return_requests WHERE order_id=$1', [f.orderRef])).rows[0].n;
    const before = await count();
    for (const forged of ['requestedBy','actorUserId','principalRef','customerRef','idempotencyKey'])
      expect((await call(page, 'return.request', { ...input, [forged]: randomUUID() })).code).toBe('starter_input_invalid');
    for (const invalid of [{ ...input, lines: [...input.lines, ...input.lines] }, { ...input, reasonCode: 'unconfigured' }])
      expect((await call(page, 'return.request', invalid)).code).toBe('starter_input_invalid');
    for (const invalid of [{ ...input, lines: [{ orderItemId: randomUUID(), quantity: 1 }] },
      { ...input, lines: [{ orderItemId: item.id, quantity: Number(item.quantity) + 1 }] },
      { ...input, customerNote: 'Changed replay' }])
      expect((await call(page, 'return.request', invalid, key)).ok).toBe(false);
    expect(await count()).toBe(before);
    await context.clearCookies();
    expect((await call(page, 'return.request', input)).code).toBe('customer_session_required');
    const foreign = await pendingCheckout(page, locale); await signIn(page, foreign.email, locale);
    expect((await call(page, 'return.request', input, key)).code).toBe('starter_return_refused');
    expect((await call(page, 'return.request', input)).code).toBe('starter_return_refused'); expect(await count()).toBe(before);
  });

  test(`${locale}: returns portal admin decisions use exact reference and record intent without execution`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
    await signIn(page, f.email, locale);
    const item = (await runtime.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal LIMIT 1', [f.orderRef])).rows[0];
    const refs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await call(page, 'return.request', { orderRef: f.orderRef, reasonCode: configurations[material.id]!.returns.reasons[0]!.code,
        customerNote: `Request ${i}`, lines: [{ orderItemId: item.id, quantity: 1 }] });
      expect(result.ok).toBe(true); refs.push(result.value.returnRequestId);
    }
    const effects = async () => (await owner.query(`SELECT jsonb_build_object('order',(SELECT to_jsonb(o) FROM public.commerce_orders o WHERE id=$1),
      'truth',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payment_truth_events t JOIN public.commerce_settlement_intents i ON i.id=t.settlement_intent_id WHERE i.order_id=$1),
      'stock',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$1),
      'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.subscriptions s JOIN public.subscription_activations a ON a.subscription_id=s.id WHERE a.order_id=$1)) AS value`, [f.orderRef])).rows[0].value;
    const before = await effects(); await context.clearCookies(); await portalOperator(page, locale);
    const forms = page.locator('#returns form'); await accessible(page.locator('#returns'));
    await forms.first().locator('[name=returnRef]').fill(refs[0]!.toUpperCase());
    await forms.first().getByRole('button', { name: copy[locale].approveReturn, exact: true }).click();
    await expect(forms.first().locator('.action-result')).toContainText('approved');
    await forms.nth(1).locator('[name=returnRef]').fill(refs[1]!);
    await forms.nth(1).getByRole('button', { name: copy[locale].rejectReturn, exact: true }).click();
    await expect(forms.nth(1).locator('.action-result')).toContainText('rejected');
    for (const [index, refundMode] of [[2,'partial'],[3,'none']] as const) {
      const key = randomUUID(), input = { returnRef: refs[index]!.toUpperCase(), refundMode, refundAmountCents: 0, adminNote: 'Original decision' };
      expect((await call(page, 'operator.returnApprove', input, key)).ok).toBe(true);
      const replay = await call(page, 'operator.returnApprove', { ...input, adminNote: 'Later note' }, key);
      expect(replay.ok).toBe(true); expect(replay.replayed).toBe(true);
      expect((await call(page, 'operator.returnReject', { returnRef: refs[index] })).code).toBe('starter_return_refused');
    }
    const rows = (await runtime.query('SELECT refund_mode,refund_amount_minor,admin_note FROM public.commerce_return_requests WHERE id=ANY($1::uuid[]) ORDER BY refund_mode', [refs.slice(2)])).rows;
    expect(rows).toEqual([{ refund_mode: 'none', refund_amount_minor: null, admin_note: 'Original decision' }, { refund_mode: 'partial', refund_amount_minor: '0', admin_note: 'Original decision' }]);
    expect((await call(page, 'operator.returnApprove', { returnRef: f.orderRef })).code).toBe('starter_return_refused');
    expect((await call(page, 'operator.returnApprove', { returnRef: refs[0], refundMode: 'partial' })).code).toBe('starter_input_invalid');
    expect(await effects()).toEqual(before);
    expect((await runtime.query("SELECT event_type,count(*)::int AS n FROM public.outbox_events WHERE aggregate_id=ANY($1::uuid[]) AND event_type LIKE 'commerce.return.%' GROUP BY event_type ORDER BY event_type", [refs])).rows)
      .toEqual([{ event_type: 'commerce.return.approved', n: 3 }, { event_type: 'commerce.return.rejected', n: 1 }]);
    const removed = await page.request.post(`${material.baseURL}/api/actions/operator.returns`, { data: {}, headers: { Origin: material.baseURL, 'X-Starter-Request': '1' } }); expect(removed.status()).toBe(404);
  });

  test(`${locale}: returns portal refuses unpaid targets, distributor, revoked and missing Commerce identities`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale); await signIn(page, f.email, locale);
    const item = (await runtime.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal LIMIT 1', [f.orderRef])).rows[0];
    expect((await call(page, 'return.request', { orderRef: f.orderRef, reasonCode: configurations[material.id]!.returns.reasons[0]!.code,
      lines: [{ orderItemId: item.id, quantity: 1 }] })).code).toBe('starter_return_refused');
    const decisions = ['operator.returnApprove','operator.returnReject'];
    await context.clearCookies(); await portalOperator(page, locale, 'distributor');
    for (const operation of decisions) expect((await call(page, operation, { returnRef: randomUUID() })).code).toBe('operator_required');
    await context.clearCookies(); const principal = await portalOperator(page, locale);
    for (const operation of decisions) for (const field of ['actorUserId','principalRef','operatorRef','requestedBy','idempotencyKey'])
      expect((await call(page, operation, { returnRef: randomUUID(), [field]: principal })).code).toBe('starter_input_invalid');
    await owner.query('DELETE FROM public.commerce_operators WHERE id=$1', [principal]);
    for (const operation of decisions) expect((await call(page, operation, { returnRef: randomUUID() })).code).toBe('operator_required');
    await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Demonstration administrator')", [principal]);
    const root = (await owner.query("SELECT principal_id FROM public.platform_human_memberships WHERE membership_state='active' AND role='admin' AND principal_id<>$1 LIMIT 1", [principal])).rows[0].principal_id;
    const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
    try { await invitations.remove({ actorPrincipalId: root, targetPrincipalId: principal }); } finally { await invitations.close(); }
    for (const operation of decisions) expect((await call(page, operation, { returnRef: randomUUID() })).code).toBe('operator_required');
    expect((await runtime.query('SELECT count(*)::int AS n FROM public.commerce_return_requests WHERE order_id=$1', [f.orderRef])).rows[0].n).toBe(0);
  });

  test(`${locale}: payment guidance exact declined bearer is safe, read-only, localized and suppressed after capture`, async ({ page }) => {
    const f = await pendingCheckout(page, locale);
    const input = { orderRef: f.orderRef, token: f.token };
    expect((await call(page, 'payment.simulate', { ...input, outcome: 'refused' })).ok).toBe(true);
    const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM public.payment_truth_events)::int AS truth,
      (SELECT count(*) FROM public.payment_simulator_attempts)::int AS attempts`)).rows[0];
    const before = await counts();
    const result = await call(page, 'checkout.read', input); expect(result.ok).toBe(true);
    expect(result.value.recoveryGuidance).toMatchObject({ version: 1, purchaseContext: 'one_time', cause: 'generic_decline',
      methodKind: null, methodKey: null, operation: null, restriction: null, consecutiveRefusals: null, emphasis: 'normal', actions: ['change_instrument','change_method'] });
    expect(result.value.snapshot).toBeUndefined(); expect(result.value.attempts).toBeUndefined();
    await page.goto(routes.completion[locale] + '?token=' + encodeURIComponent(f.token));
    await expect(page.locator('[data-payment-guidance]')).toContainText(copy[locale].guidanceBody); await accessible(page.locator('main'));
    await page.reload(); await expect(page.locator('[data-payment-guidance]')).toBeVisible(); expect(await counts()).toEqual(before);
    await page.getByRole('button', { name: copy[locale].simulatePaid, exact: true }).click();
    await expect(page.locator('main')).toContainText(copy[locale].recoveryPaid); await expect(page.locator('[data-payment-guidance]')).toHaveCount(0);
    expect((await call(page, 'checkout.read', input)).value.recoveryGuidance).toBeUndefined();
  });

  test(`${locale}: payment guidance never borrows foreign, revoked or expired authority`, async ({ page, context }) => {
    const f = await pendingCheckout(page, locale), other = await pendingCheckout(page, locale);
    expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'refused' })).ok).toBe(true);
    const data = { orderRef: f.orderRef, token: f.token };
    for (const forged of ['clientId','paymentIntentId','principalRef','claims'])
      expect((await call(page, 'checkout.read', { ...data, [forged]: randomUUID() })).code).toBe('starter_input_invalid');
    expect((await call(page, 'checkout.read', { ...data, token: other.token })).ok).toBe(false);
    await signIn(page, other.email, locale); expect((await call(page, 'checkout.read', data)).ok).toBe(false); await context.clearCookies();
    await owner.query('UPDATE public.commerce_checkout_recovery_tokens SET created_at=$2,expires_at=$3 WHERE order_id=$1', [f.orderRef, new Date(Date.now() - 3 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString()]);
    expect((await call(page, 'checkout.read', data)).code).toBe('starter_recovery_expired');
    await owner.query('UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=now() WHERE order_id=$1', [other.orderRef]);
    expect((await call(page, 'checkout.read', { orderRef: other.orderRef, token: other.token })).code).toBe('starter_recovery_unavailable');
  });

  test(`${locale}: payment guidance absent evidence and indeterminate attempts retain the legacy display`, async ({ page }) => {
    const f = await pendingCheckout(page, locale, 'subscription');
    const input = { orderRef: f.orderRef, token: f.token };
    expect((await call(page, 'checkout.read', input)).value.recoveryGuidance).toBeUndefined();
    expect((await call(page, 'payment.simulate', { ...input, outcome: 'indeterminate' })).ok).toBe(true);
    expect((await call(page, 'checkout.read', input)).value.recoveryGuidance).toBeUndefined();
    await page.goto(routes.completion[locale] + '?token=' + encodeURIComponent(f.token));
    await expect(page.getByRole('button', { name: copy[locale].simulatePaid, exact: true })).toBeVisible();
    await expect(page.locator('[data-payment-guidance]')).toHaveCount(0);
    const declined = await pendingCheckout(page, locale, 'subscription');
    const credential = { orderRef: declined.orderRef, token: declined.token };
    expect((await call(page, 'payment.simulate', { ...credential, outcome: 'refused' })).ok).toBe(true);
    expect((await call(page, 'checkout.read', credential)).value.recoveryGuidance.purchaseContext).toBe('subscription_initial');
    const { createPostgresSandboxPaymentSimulator } = await import('@openlup/platform/payments');
    const simulator = createPostgresSandboxPaymentSimulator(runtime, configurations[material.id]!.purchase.sandbox);
    const intent = (await runtime.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1', [declined.orderRef])).rows[0].id;
    const attempt = await simulator.readAttempt({ settlementIntentId: intent }); expect(!!attempt).toBe(true);
    await simulator.recordObservation({ attemptId: attempt!.id, idempotencyKey: randomUUID(), outcome: 'captured', occurredAt: new Date().toISOString() });
    const observed = await call(page, 'checkout.read', credential);
    expect(observed.ok).toBe(true); expect(observed.value.status).toBe('pending_payment'); expect(observed.value.recoveryGuidance).toBeUndefined();
  });
}

async function shipmentSubject(page: Page, locale: Locale) {
  const f = await pendingCheckout(page, locale);
  expect((await call(page, 'payment.simulate', { orderRef: f.orderRef, token: f.token, outcome: 'captured' })).ok).toBe(true);
  const result = await parcel(f.orderRef);
  return { ...f, shipmentRef: result.shipmentId };
}
async function shipmentPanel(page: Page, shipmentRef: string, locale: Locale) {
  const form = page.locator('#shipments form').filter({ has: page.getByRole('button', { name: copy[locale].read, exact: true }) });
  await form.locator('[name=shipmentRef]').fill(shipmentRef.toUpperCase()); await form.getByRole('button', { name: copy[locale].read, exact: true }).click();
  const panel = page.locator('[data-shipment-controls]'); await expect(panel).toContainText(shipmentRef); return panel;
}
for (const locale of ['en','pl'] as const) {
  test(`${locale}: shipment operations confirmed label and handoff retain private evidence and consume exact stock once`, async ({ page, context }) => {
    const f = await shipmentSubject(page, locale), other = await shipmentSubject(page, locale);
    const reservations = async (id: string) => (await owner.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 ORDER BY id', [id])).rows;
    const unrelated = await reservations(other.orderRef);
    const actor = await portalOperator(page, locale); const panel = await shipmentPanel(page, f.shipmentRef, locale);
    await accessible(panel);
    const labelUrl = `https://labels.example.invalid/private/${randomUUID()}`, raw = { captured: `operator-evidence-${randomUUID()}` }, tracking = `TRACK-${randomUUID()}`;
    const form = panel.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].label, exact: true }) });
    await form.locator('[name=providerKind]').fill('synthetic-carrier'); await form.locator('[name=providerTrackingId]').fill(tracking);
    await form.locator('[name=labelUrl]').fill(labelUrl); await form.locator('[name=rawProviderPayload]').fill(JSON.stringify(raw));
    const input = { shipmentRef: f.shipmentRef, providerKind: 'synthetic-carrier', providerTrackingId: tracking, labelUrl, rawProviderPayload: raw, confirmed: true };
    expect((await call(page, 'operator.label', { ...input, confirmed: false })).code).toBe('starter_input_invalid');
    await form.locator('[name=confirmed]').check();
    const request = page.waitForRequest(r => r.url().endsWith('/api/actions/operator.label'));
    await form.getByRole('button', { name: copy[locale].label, exact: true }).click(); const key = (await request).headers()['idempotency-key']!;
    await expect(panel.getByRole('button', { name: copy[locale].handoff, exact: true })).toBeVisible();
    expect((await call(page, 'operator.label', { ...input, shipmentRef: other.shipmentRef, providerKind: 'changed-provider' }, key)).value.fulfillmentOrderId).toBe(f.shipmentRef);
    const detail = await call(page, 'operator.shipment', { shipmentRef: f.shipmentRef.toUpperCase() });
    expect(detail.ok).toBe(true); expect(JSON.stringify(detail.value).includes(labelUrl)).toBe(true);
    expect(detail.value.order.latestOperation.actorUserId).toBe(actor);
    const receipt = (await owner.query("SELECT command FROM public.fulfillment_operator_receipts WHERE kind='label' AND idempotency_key=$1", [key])).rows[0].command;
    expect(receipt.request.rawProviderPayload).toEqual(raw); expect(receipt.request.labelUrl === labelUrl).toBe(true);
    const handoff = panel.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].handoff, exact: true }) });
    await handoff.locator('[name=confirmed]').check();
    const handoffRequest = page.waitForRequest(r => r.url().endsWith('/api/actions/operator.handoff'));
    await handoff.getByRole('button', { name: copy[locale].handoff, exact: true }).click(); const handoffKey = (await handoffRequest).headers()['idempotency-key']!;
    await expect(page.locator('[data-shipment-result]')).toContainText('handed_over');
    const heldIds = (await owner.query(`SELECT DISTINCT reservation_id AS id FROM public.fulfillment_parcel_line_reservations r
      JOIN public.fulfillment_parcel_lines l ON l.id=r.line_id WHERE l.shipment_id=$1 ORDER BY reservation_id`, [f.shipmentRef])).rows.map(r => r.id);
    expect(heldIds.length).toBeGreaterThan(0);
    expect((await reservations(f.orderRef)).filter(r => heldIds.includes(r.id)).every(r => r.status === 'consumed')).toBe(true);
    expect(await reservations(other.orderRef)).toEqual(unrelated);
    const before = (await owner.query("SELECT to_jsonb(r) AS value FROM public.fulfillment_operator_receipts r WHERE kind='handoff' AND command->>'idempotencyKey'=$1", [handoffKey])).rows;
    expect((await call(page, 'operator.handoff', { shipmentRef: f.shipmentRef, confirmed: true }, handoffKey)).replayed).toBe(true);
    expect((await call(page, 'operator.handoff', { shipmentRef: f.shipmentRef, confirmed: true })).replayed).toBe(true);
    expect((await owner.query("SELECT to_jsonb(r) AS value FROM public.fulfillment_operator_receipts r WHERE kind='handoff' AND command->>'idempotencyKey'=$1", [handoffKey])).rows).toEqual(before);
    expect((await call(page, 'operator.delivery', { shipmentRef: f.shipmentRef, status: 'in_transit', providerTrackingId: tracking, confirmed: true })).ok).toBe(true);
    const oldHandoff = await call(page, 'operator.handoff', { shipmentRef: f.shipmentRef, confirmed: true }, handoffKey);
    expect(oldHandoff.replayed).toBe(true); expect(oldHandoff.value.status).toBe('in_transit');
    expect((await owner.query("SELECT to_jsonb(r) AS value FROM public.fulfillment_operator_receipts r WHERE kind='handoff' AND command->>'idempotencyKey'=$1", [handoffKey])).rows).toEqual(before);
    const naiveTime = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, -1);
    expect((await call(page, 'operator.delivery', { shipmentRef: f.shipmentRef, status: 'delivered', providerTrackingId: tracking, rawEvent: { occurredAt: naiveTime }, confirmed: true })).ok).toBe(true);
    expect((await owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipmentRef])).rows[0].delivered_at.getTime()).toBeGreaterThan(Date.now() - 86400000);
    await context.clearCookies(); await signIn(page, f.email, locale);
    for (const operation of ['operator.shipments','operator.shipment','operator.label','operator.handoff','operator.delivery'])
      expect((await call(page, operation, { ...input, actorUserId: actor })).code).toBe('operator_required');
    const customer = await call(page, 'account.orders', { orderRef: f.orderRef }); expect(customer.ok).toBe(true);
    for (const response of [customer, await call(page, 'checkout.read', { token: f.token }), await call(page, 'tracking.read', { shipmentRef: f.shipmentRef })]) {
      expect(JSON.stringify(response).includes(labelUrl)).toBe(false); expect(JSON.stringify(response).includes(raw.captured)).toBe(false);
    }
    await page.goto(routes.account[locale]); expect((await page.locator('main').textContent())?.includes(labelUrl)).toBe(false);
    expect((await owner.query("SELECT command FROM public.fulfillment_operator_receipts WHERE kind='label' AND idempotency_key=$1", [key])).rows[0].command).toEqual(receipt);
  });

  test(`${locale}: shipment operations provider correlation and historical handoff refuse unsafe ownership`, async ({ page }) => {
    const a = await shipmentSubject(page, locale), b = await shipmentSubject(page, locale); await portalOperator(page, locale);
    const number = `PARCEL-${randomUUID()}`, historical = `HISTORY-${randomUUID()}`;
    const input = { shipmentRef: b.shipmentRef, providerKind: 'carrier-a', providerTrackingId: number, confirmed: true };
    await owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id) VALUES($1,'tracking',$2)", [a.shipmentRef, historical]);
    const before = (await owner.query('SELECT to_jsonb(s) AS value FROM public.fulfillment_shipments s WHERE id=$1', [b.shipmentRef])).rows;
    expect((await call(page, 'operator.label', { ...input, providerTrackingId: historical })).code).toBe('starter_shipment_tracking_reference_unattributed');
    expect((await owner.query('SELECT to_jsonb(s) AS value FROM public.fulfillment_shipments s WHERE id=$1', [b.shipmentRef])).rows).toEqual(before);
    expect((await call(page, 'operator.label', input)).ok).toBe(true);
    expect((await call(page, 'operator.label', { ...input, shipmentRef: a.shipmentRef })).code).toBe('starter_shipment_tracking_ref_conflict');
    expect((await call(page, 'operator.label', { ...input, shipmentRef: a.shipmentRef, providerKind: 'carrier-b' })).ok).toBe(true);
    const sibling = randomUUID();
    // Historical parcel fixture deliberately has no frozen reservation set; it must never capture today's stock.
    await owner.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key,sequence_no,replaces_shipment_id,replacement_reason)
      SELECT $1,order_id,port_key,provider_type,$2,1,id,'lost' FROM public.fulfillment_shipments WHERE id=$3`, [sibling, randomUUID(), a.shipmentRef]);
    expect((await call(page, 'operator.label', { ...input, shipmentRef: sibling, providerKind: 'carrier-b' })).ok).toBe(true);
    const refs = (await owner.query("SELECT shipment_id,provider_kind FROM public.shipment_external_refs WHERE ref_role='tracking' AND external_id=$1 ORDER BY provider_kind", [number])).rows;
    expect(refs).toEqual([{ shipment_id: b.shipmentRef, provider_kind: 'carrier-a' }, { shipment_id: sibling, provider_kind: 'carrier-b' }]);
    const selected = (await call(page, 'operator.shipment', { shipmentRef: sibling })).value.order;
    expect(selected.providerTrackingId).toBe(number); expect(selected.providerKind).toBe('carrier-b');
    const original = (await call(page, 'operator.shipment', { shipmentRef: a.shipmentRef })).value.order;
    expect(original.providerTrackingId).toBe(historical); expect(original.providerKind).toBeNull();
    expect((await call(page, 'operator.delivery', { shipmentRef: sibling, status: 'delivered', confirmed: true })).code).toBe('starter_shipment_tracking_before_handoff_forbidden');
    expect((await call(page, 'operator.delivery', { shipmentRef: sibling, status: 'exception', confirmed: true })).ok).toBe(true);
    expect((await call(page, 'operator.delivery', { shipmentRef: sibling, status: 'in_transit', confirmed: true })).code).toBe('starter_shipment_tracking_before_handoff_forbidden');
    expect((await call(page, 'operator.label', { ...input, shipmentRef: sibling, providerKind: 'carrier-b' })).ok).toBe(true);
    const stock = (await owner.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 ORDER BY id', [a.orderRef])).rows;
    expect((await call(page, 'operator.handoff', { shipmentRef: sibling, confirmed: true })).value).toMatchObject({ status: 'handed_over', reservationDisposition: 'reservations_not_recorded', consumedReservationCount: 0 });
    expect((await owner.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 ORDER BY id', [a.orderRef])).rows).toEqual(stock);
    const foreignNumber = `FOREIGN-${randomUUID()}`;
    expect((await call(page, 'operator.label', { ...input, providerTrackingId: foreignNumber })).ok).toBe(true);
    expect((await call(page, 'operator.delivery', { shipmentRef: sibling, providerTrackingId: foreignNumber, status: 'in_transit', confirmed: true })).code).toBe('starter_shipment_tracking_ref_not_active');
  });

  test(`${locale}: shipment operations actual replacement arrival and earlier-only replay preserve the cycle clamp`, async ({ page }) => {
    const f = await purchase(page), first = await parcel(f.orderRef), before = await state(f); await portalOperator(page, locale);
    await owner.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
    const hold = await call(page, 'operator.hold', { orderRef: f.orderRef, reason: 'fulfillment_exception' }); expect(hold.ok).toBe(true);
    const replaced = await call(page, 'operator.replacement', { orderRef: f.orderRef, reason: 'lost', confirmed: true }); expect(replaced.ok).toBe(true);
    const shipmentRef = replaced.value.replacement.fulfillmentOrderId;
    expect((await owner.query('SELECT replaces_shipment_id,delivered_at FROM public.fulfillment_shipments WHERE id=$1', [shipmentRef])).rows[0]).toEqual({ replaces_shipment_id: first.shipmentId, delivered_at: null });
    const panel = await shipmentPanel(page, shipmentRef, locale); await accessible(panel);
    expect((await call(page, 'operator.label', { shipmentRef, providerKind: 'synthetic-carrier', providerTrackingId: `REPLACEMENT-${randomUUID()}`, confirmed: true })).ok).toBe(true);
    expect((await call(page, 'operator.handoff', { shipmentRef, confirmed: true })).ok).toBe(true); expect(await state(f)).toEqual(before);
    const deliveredAt = new Date(before.next_cycle_at.getTime() + 3 * 86400000).toISOString();
    await shipmentPanel(page, shipmentRef, locale);
    const tracking = page.locator('[data-shipment-controls] form').filter({ has: page.getByRole('button', { name: copy[locale].delivery, exact: true }) });
    await tracking.locator('[name=status]').selectOption('delivered'); await tracking.locator('[name=rawEvent]').fill(JSON.stringify({ occurredAt: deliveredAt, captured: 'Original tracking evidence' }));
    await tracking.locator('[name=confirmed]').check();
    const request = page.waitForRequest(r => r.url().endsWith('/api/actions/operator.delivery'));
    await tracking.getByRole('button', { name: copy[locale].delivery, exact: true }).click(); const key = (await request).headers()['idempotency-key']!;
    await expect(page.locator('[data-shipment-result]')).toContainText('delivered');
    const after = await state(f); expect(after.status).toBe('active'); expect(after.next_cycle_at.getTime()).toBeGreaterThanOrEqual(Date.parse(deliveredAt) + f.cadenceDays * 86400000);
    const receipt = async () => (await owner.query("SELECT command FROM public.fulfillment_operator_receipts WHERE kind='tracking' AND idempotency_key=$1", [key])).rows[0].command;
    const originalReceipt = await receipt();
    const earlier = new Date(Date.parse(deliveredAt) - 86400000).toISOString(), later = new Date(Date.parse(deliveredAt) + 86400000).toISOString();
    for (const occurredAt of [earlier,later]) expect((await call(page, 'operator.delivery', { shipmentRef, status: 'delivered', providerTrackingId: originalReceipt.request.providerTrackingId, confirmed: true, rawEvent: { occurredAt, captured: 'Later input' } }, key)).replayed).toBe(true);
    expect((await owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [shipmentRef])).rows[0].delivered_at.toISOString()).toBe(earlier);
    expect(await receipt()).toEqual(originalReceipt); expect(await state(f)).toEqual(after);
    expect((await call(page, 'operator.delivery', { shipmentRef, status: 'in_transit', confirmed: true })).code).toBe('starter_shipment_tracking_after_delivered_forbidden');
    expect((await call(page, 'operator.delivery', { shipmentRef, status: 'exception', confirmed: true }, key)).code).toBe('starter_shipment_tracking_idempotency_conflict');
    expect((await owner.query('SELECT count(*)::int AS n FROM public.subscription_delivery_alignment_arrivals WHERE shipment_id=$1', [shipmentRef])).rows[0].n).toBe(1);
    expect((await runtime.query('SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1', [f.subscriptionId])).rows).toHaveLength(0);
  });

  test(`${locale}: shipment operations recheck human authority on replay and reject forgery and stale parcels`, async ({ page, context }) => {
    const f = await shipmentSubject(page, locale); await portalOperator(page, locale, 'distributor');
    const input = { shipmentRef: f.shipmentRef, confirmed: true, providerKind: 'synthetic-carrier', providerTrackingId: `AUTH-${randomUUID()}` };
    const commands = ['operator.label','operator.handoff','operator.delivery'];
    for (const operation of commands) expect((await call(page, operation, input)).code).toBe('operator_required');
    await context.clearCookies(); const principal = await portalOperator(page, locale);
    const body = (operation: string) => operation === 'operator.label' ? input : { shipmentRef: f.shipmentRef, confirmed: true, ...(operation === 'operator.delivery' ? { status: 'in_transit' } : {}) };
    for (const operation of commands) {
      for (const field of ['actorUserId','principalRef','operatorRef','customerRef','clientId','idempotencyKey'])
        expect((await call(page, operation, { ...body(operation), [field]: principal })).code).toBe('starter_input_invalid');
      expect((await call(page, operation, { ...body(operation), confirmed: false })).code).toBe('starter_input_invalid');
      expect((await call(page, operation, { ...body(operation), shipmentRef: randomUUID() })).code).toBe('starter_shipment_not_found');
    }
    // Shipment audit attribution is the human principal; it does not depend on an unused Commerce row.
    await owner.query('DELETE FROM public.commerce_operators WHERE id=$1', [principal]);
    const keys: string[] = [];
    for (const operation of commands) { const key = randomUUID(); keys.push(key); expect((await call(page, operation, body(operation), key)).ok).toBe(true); }
    const rows = async () => (await owner.query('SELECT to_jsonb(s) AS value FROM public.fulfillment_shipments s WHERE id=$1', [f.shipmentRef])).rows;
    const before = await rows(), root = (await owner.query("SELECT principal_id FROM public.platform_human_memberships WHERE membership_state='active' AND role='admin' AND principal_id<>$1 LIMIT 1", [principal])).rows[0].principal_id;
    const invitations = createDirectOperatorInvitationStore({ connectionString: material.ownerUrl });
    try { await invitations.remove({ actorPrincipalId: root, targetPrincipalId: principal }); } finally { await invitations.close(); }
    for (const [index,operation] of commands.entries()) expect((await call(page, operation, body(operation), keys[index])).code).toBe('operator_required');
    expect(await rows()).toEqual(before); await context.clearCookies();
    for (const operation of commands) expect((await call(page, operation, body(operation))).code).toBe('operator_required');
  });
}

async function preferencesCustomer(page: Page, locale: Locale) {
  const principal = randomUUID(), email = `preferences-${randomUUID()}@example.test`;
  const accounts = createPostgresAccountLinkStore({ connectionString: material.runtimeUrl });
  try { await accounts.createAccount({ email, principalId: principal, acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' }); } finally { await accounts.close(); }
  await signIn(page, email, locale);
  return { principal, email, clientId: (await owner.query('SELECT id FROM public.clients WHERE principal_id=$1', [principal])).rows[0].id as string };
}
const savedAddressInput = (line1 = 'Saved Street 1') => ({ action: 'upsert', kind: 'shipping', label: 'Home', recipientName: null,
  contactPhone: '123456789', line1, city: 'Example City', postalCode: '12345', country: 'ZZ', isDefault: false });
async function saveAddress(page: Page, input: Record<string, unknown> = savedAddressInput()) {
  const result = await call(page, 'account.addresses', input); expect(result.ok).toBe(true);
  const address = result.value.addresses.find((row: { line1: string }) => row.line1 === input.line1);
  if (!address) throw new Error('starter_saved_address_witness_missing'); return address;
}
for (const locale of ['en','pl'] as const) {
  test(`${locale}: account preferences address forms normalize, default, delete and retain separate-commit failure semantics`, async ({ page }) => {
    const f = await preferencesCustomer(page, locale); await page.goto(routes.account[locale]);
    const section = page.locator('#account-preferences'); await accessible(section);
    const form = section.locator('form').filter({ has: page.getByRole('heading', { name: copy[locale].addSavedAddress, exact: true }) });
    await form.locator('[name=label]').fill('Home'); await form.locator('[name=contactPhone]').fill('123456789');
    await form.locator('[name=line1]').fill('Saved Street 1'); await form.locator('[name=city]').fill('Example City'); await form.locator('[name=postalCode]').fill('12345');
    await form.locator('[name=isDefault]').check();
    const request = page.waitForRequest(r => r.url().endsWith('/api/actions/account.addresses'));
    await form.getByRole('button', { name: copy[locale].save, exact: true }).click();
    const sent = await request, key = sent.headers()['idempotency-key']!;
    await expect(section.locator('[data-saved-address]')).toHaveCount(1);
    const book = await call(page, 'account.addresses', { action: 'read' }); expect(book.ok).toBe(true); expect(book.value.billingProfilesAvailable).toBe(false);
    expect(book.value.ordererProfiles).toBeUndefined();
    const first = book.value.addresses[0]; expect(first).toMatchObject({ recipientName: null, postalCode: '12-345', contactPhone: '+999123456789', isDefault: true });
    expect((await call(page, 'account.addresses', { ...sent.postDataJSON(), line1: 'Changed replay input' }, key)).value.addresses[0].line1).toBe('Saved Street 1');
    const second = await saveAddress(page, { ...savedAddressInput('Other Street 2'), isDefault: true });
    const changed = await call(page, 'account.addresses', { action: 'read' });
    expect(changed.value.addresses.find((r: { addressId: string }) => r.addressId === first.addressId).isDefault).toBe(false);
    expect((await call(page, 'account.addresses', { action: 'delete', addressId: second.addressId })).ok).toBe(true);
    await saveAddress(page, { ...savedAddressInput(), addressId: first.addressId, isDefault: true });
    const failedKey = randomUUID(), failedInput = { ...savedAddressInput('Committed before event failure'), isDefault: true };
    const events = async () => (await owner.query("SELECT count(*)::int AS n FROM public.customer_account_events WHERE client_id=$1 AND event_type='customer.address_upserted'", [f.clientId])).rows[0].n;
    const before = await events();
    // Owner-only fault fixture: fail the final event statement, not the earlier committed address/default writes.
    await owner.query("ALTER TABLE public.customer_account_events ADD CONSTRAINT starter_address_event_failure CHECK (event_type<>'customer.address_upserted') NOT VALID");
    try {
      expect((await call(page, 'account.addresses', failedInput, failedKey)).ok).toBe(false);
      const partial = await call(page, 'account.addresses', { action: 'read' }); expect(partial.ok).toBe(true);
      expect(partial.value.addresses.find((r: { line1: string }) => r.line1 === failedInput.line1).isDefault).toBe(true);
      expect(partial.value.addresses.find((r: { addressId: string }) => r.addressId === first.addressId).isDefault).toBe(false);
      expect(await events()).toBe(before);
    } finally { await owner.query('ALTER TABLE public.customer_account_events DROP CONSTRAINT starter_address_event_failure'); }
    expect((await call(page, 'account.addresses', failedInput, failedKey)).ok).toBe(true); expect(await events()).toBe(before + 1);
    expect((await call(page, 'account.addresses', { ...failedInput, line1: 'Ignored replay' }, failedKey)).ok).toBe(true); expect(await events()).toBe(before + 1);
  });

  test(`${locale}: account preferences saved subscription selection preserves replay, ownership and in-use refusal`, async ({ page, context }) => {
    const f = await purchase(page); await signIn(page, f.email, locale);
    const address = await saveAddress(page), billing = await saveAddress(page, { ...savedAddressInput('Billing Street'), kind: 'billing' });
    const before = (await owner.query('SELECT cadence_days,template_version,billing_saved_address_id,next_cycle_at FROM public.subscriptions WHERE id=$1', [f.subscriptionId])).rows[0];
    await page.goto(routes.account[locale]); const selection = page.locator(`[data-saved-selection="${f.subscriptionId}"]`);
    await selection.getByRole('button', { name: copy[locale].savedAddressLoad, exact: true }).click();
    await expect(selection.locator('[name=savedAddressId] option')).toHaveCount(1);
    await selection.locator('[name=savedAddressId]').selectOption(address.addressId); await accessible(selection);
    const request = page.waitForRequest(r => r.url().endsWith('/api/actions/subscription.savedAddress'));
    await selection.getByRole('button', { name: copy[locale].savedAddressSelect, exact: true }).click(); const key = (await request).headers()['idempotency-key']!;
    await expect(selection.locator('[data-saved-address-pointer]')).toHaveText(address.addressId);
    const events = async () => (await runtime.query("SELECT count(*)::int AS n FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.change_shipping_address'", [f.subscriptionId])).rows[0].n;
    const count = await events(); expect(count).toBe(1);
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: 'malformed-replay-input' }, key)).replayed).toBe(true);
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: billing.addressId })).code).toBe('starter_address_invalid');
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: 'malformed-fresh-input' })).code).toBe('starter_address_invalid');
    expect((await owner.query('SELECT cadence_days,template_version,billing_saved_address_id,next_cycle_at FROM public.subscriptions WHERE id=$1', [f.subscriptionId])).rows[0]).toEqual(before);
    const cookies = await context.cookies(); await context.clearCookies();
    await preferencesCustomer(page, locale); const foreign = await saveAddress(page, savedAddressInput('Foreign Street'));
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: foreign.addressId })).code).toBe('starter_subscription_forbidden');
    const ownBook = await call(page, 'account.addresses', { action: 'read' });
    const foreignDelete = await call(page, 'account.addresses', { action: 'delete', addressId: address.addressId });
    // Native deletion acknowledges zero rows without revealing another customer's existence.
    expect(foreignDelete.ok).toBe(true); expect(foreignDelete.value.addresses).toEqual(ownBook.value.addresses);
    expect((await owner.query('SELECT id FROM public.customer_saved_addresses WHERE id=$1', [address.addressId])).rows).toHaveLength(1);
    await context.clearCookies(); await context.addCookies(cookies);
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: foreign.addressId })).code).toBe('starter_address_invalid');
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: foreign.addressId }, key)).replayed).toBe(true); expect(await events()).toBe(count);
    await page.goto(routes.account[locale]); await page.locator('#account-preferences').getByRole('button', { name: copy[locale].savedAddressLoad, exact: true }).click();
    const row = page.locator(`[data-saved-address="${address.addressId}"]`);
    await row.getByRole('button', { name: copy[locale].deleteSavedAddress, exact: true }).click();
    await expect(row.locator('.action-result').last()).toContainText('starter_address_in_use');
    expect((await call(page, 'subscription.command', { subscriptionRef: f.subscriptionId, action: 'pause', pausePreset: '2_weeks' })).ok).toBe(true);
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: address.addressId })).ok).toBe(true);
  });

  test(`${locale}: account preferences retained renewal keeps its destination while future reads materialize edits`, async ({ page }) => {
    const { createPostgresDestinationPort } = await import('@openlup/platform/commerce/server/destinations');
    const f = await purchase(page); await signIn(page, f.email, locale);
    const address = await saveAddress(page), selectKey = randomUUID();
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: address.addressId }, selectKey)).ok).toBe(true);
    const courier = { action: 'save', scope: 'any', deliveryKind: 'courier', providerKind: 'demo-simulator', carrierKind: 'demo-carrier', carrierCode: 'courier', serviceCode: 'preferred-service', pickupPoint: null };
    expect((await call(page, 'account.deliveryPreference', courier)).ok).toBe(true);
    expect((await call(page, 'account.deliveryPreference', { ...courier, scope: 'subscription', deliveryKind: 'parcel-locker', pickupPoint: { id: 'locker', name: 'Locker', address: null } })).ok).toBe(true);
    await failedRenewal(f);
    const operation = (await owner.query('SELECT id,cycle_snapshot FROM public.subscription_renewal_operations WHERE subscription_id=$1 ORDER BY created_at DESC LIMIT 1', [f.subscriptionId])).rows[0];
    const order = (await owner.query('SELECT id,metadata FROM public.commerce_orders WHERE renewal_operation_id=$1', [operation.id])).rows[0];
    expect(order.metadata.selectedDelivery).toMatchObject({ providerKind: 'demo-simulator', serviceCode: 'preferred-service', deliveryKind: 'courier' });
    const destinations = createPostgresDestinationPort(runtime), frozen = await destinations.readWithSaved('order', order.id);
    expect(frozen.address).toMatchObject({ savedAddressId: address.addressId, recipientName: null, line1: address.line1 });
    const snapshot = async () => (await owner.query('SELECT to_jsonb(d) AS value,xmin::text AS version FROM public.commerce_destinations d WHERE id=$1', [frozen.destinationId])).rows;
    const immutable = await snapshot();
    await saveAddress(page, { ...savedAddressInput('Future Street'), addressId: address.addressId, recipientName: 'Future Recipient' });
    expect((await destinations.readWithSaved('order', order.id)).destinationId).toBe(frozen.destinationId); expect(await snapshot()).toEqual(immutable);
    expect((await owner.query('SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1', [operation.id])).rows[0].cycle_snapshot).toEqual(operation.cycle_snapshot);
    const future = await destinations.readWithSaved('subscription', f.subscriptionId);
    expect(future.destinationId).not.toBe(frozen.destinationId); expect(future.address).toMatchObject({ savedAddressId: address.addressId, recipientName: 'Future Recipient', line1: 'Future Street' });
    expect(await snapshot()).toEqual(immutable);
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: address.addressId })).code).toBe('starter_payment_blocked');
    expect((await call(page, 'subscription.savedAddress', { subscriptionRef: f.subscriptionId, savedAddressId: 'malformed-replay-input' }, selectKey)).replayed).toBe(true);
    expect((await state(f)).status).toBe('active');
  });

  test(`${locale}: account preferences scoped selections validate lockers and never replace instruments or existing orders`, async ({ page, context }) => {
    const f = await purchase(page); await signIn(page, f.email, locale); await page.goto(routes.account[locale]);
    const effectSnapshot = async () => (await owner.query(`SELECT jsonb_build_object('subscription',(SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$1),
      'methods',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.subscription_id) FROM public.subscription_method_states m WHERE subscription_id=$1),
      'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.commerce_orders o WHERE client_id=$2),
      'events',(SELECT count(*) FROM public.customer_account_events WHERE client_id=$2)) AS value`, [f.subscriptionId, f.clientId])).rows[0].value;
    const before = await effectSnapshot(); const section = page.locator('#account-preferences'); await accessible(section);
    const payment = section.locator('[data-payment-preferences] form');
    await payment.locator('[name=scope]').selectOption('subscription'); await payment.locator('[name=methodKind]').selectOption('demo-card');
    await payment.getByRole('button', { name: copy[locale].save, exact: true }).click(); await expect(payment.locator('.action-result')).toContainText('demo-card');
    for (const scope of ['one_time','any']) expect((await call(page, 'account.paymentPreference', { action: 'save', scope, methodKind: 'demo-transfer' })).ok).toBe(true);
    expect((await call(page, 'account.paymentPreference', { action: 'read' })).value.preferences).toHaveLength(3);
    const delivery = section.locator('[data-delivery-preferences] form'); await delivery.locator('[name=scope]').selectOption('any');
    await delivery.getByRole('button', { name: copy[locale].save, exact: true }).click(); await expect(delivery.locator('.action-result')).toContainText('demo-warehouse');
    for (const invalid of [{ scope: 'foreign', methodKind: 'demo-card' }, { scope: 'any', methodKind: 'credential' }, { scope: 'any', methodKind: 'demo-card', token: 'forged' }])
      expect((await call(page, 'account.paymentPreference', { action: 'save', ...invalid })).code).toBe('starter_input_invalid');
    expect((await call(page, 'account.deliveryPreference', { action: 'save', scope: 'any', deliveryKind: 'parcel-locker', providerKind: 'demo-simulator', carrierKind: 'carrier', carrierCode: 'courier', serviceCode: 'standard', pickupPoint: null })).code).toBe('starter_input_invalid');
    for (const operation of ['account.addresses','account.paymentPreference','account.deliveryPreference','subscription.savedAddress']) {
      for (const field of ['principalId','principalRef','clientId','customerRef','actorUserId','idempotencyKey'])
        expect((await call(page, operation, { action: 'read', [field]: randomUUID() })).code).toBe('starter_input_invalid');
    }
    expect(await effectSnapshot()).toEqual(before);
    const cookies = await context.cookies(); await context.clearCookies(); await preferencesCustomer(page, locale);
    expect((await call(page, 'account.paymentPreference', { action: 'read' })).value.preferences).toEqual([]);
    expect((await call(page, 'account.deliveryPreference', { action: 'read' })).value.preferences).toEqual([]);
    await context.clearCookies();
    for (const operation of ['account.addresses','account.paymentPreference','account.deliveryPreference','subscription.savedAddress'])
      expect((await call(page, operation, { action: 'read', clientId: f.clientId })).code).toBe('customer_session_required');
    await context.addCookies(cookies);
  });
}

});
