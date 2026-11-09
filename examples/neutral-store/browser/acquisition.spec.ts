import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import * as subscriptions from '@openlup/platform/subscriptions';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import { createPostgresAccountLinkStore, createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
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

interface Material { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string }
interface Purchase { email: string; subscriptionId: string; clientId: string; nextCycleAt: string; cadenceDays: number }
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
  return { email, subscriptionId: String(row.id), clientId: String(row.client_id), nextCycleAt: row.next_cycle_at.toISOString(), cadenceDays: Number(row.cadence_days) };
}
async function signIn(page: Page, email: string, locale: Locale, landing?: string, operator = false) {
  await page.goto(landing ?? routes.auth[locale]);
  if (landing) await page.locator('main').getByRole('link', { name: copy[locale].signIn, exact: true }).click();
  if (operator) {
    expect((await call(page, 'auth.operator', { email })).ok).toBe(true);
  } else {
    await page.getByLabel(copy[locale].email, { exact: true }).fill(email);
    await page.getByRole('button', { name: copy[locale].sendSignIn, exact: true }).click();
    await expect(page.locator('.action-result').first()).toContainText('accepted');
  }
  const path = resolve(material.state, '.context/captured-messages/identity.jsonl');
  let token: string | undefined;
  await expect.poll(async () => {
    const messages = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    token = messages.filter(row => row.email === email).at(-1)?.token; return !!token;
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
  test.fixme(true, 'Native auto-resume guard still blocks historical paid orders.');
  const f = await purchase(page); await signIn(page, f.email, 'en'); await pause(page, f, 'en');
  const window = (await runtime.query('SELECT ends_at FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL', [f.subscriptionId])).rows[0];
  const at = new Date(window.ends_at.getTime() + 1000).toISOString();
  await runCare('en', at); expect((await state(f)).status).toBe('active');
  const message = await notice(f, 'subscription.resumed'); expect(message.subject).toBe(copy.en.careResumed);
  await page.getByRole('button', { name: copy.en.careRead, exact: true }).click();
  await expect(cardFor(page, f).locator('[data-care-state]')).toHaveAttribute('data-care-state', 'active');
  await runCare('en', at);
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
