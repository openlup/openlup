import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';

/** Explicit real-database recipe; select this file with testMatch in a local proof config. */
export interface IntakeProofOptions { composeProject: string; operatorEmail: string; customerEmail: string }
const test = base.extend<IntakeProofOptions>({
  composeProject: ['', { option: true }],
  operatorEmail: ['', { option: true }],
  customerEmail: ['', { option: true }],
});

test('native public intake, operator authority, quotas and restart persistence', async ({
  page, context, baseURL, composeProject, operatorEmail, customerEmail,
}) => {
  test.setTimeout(150000);
  if (!baseURL || !/^[a-z0-9-]+$/.test(composeProject) || !operatorEmail || !customerEmail) {
    throw new Error('native_intake_proof_fixture_required');
  }
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '--project-name', composeProject, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const action = async (operation: string, data: Record<string, unknown> = {}, key = randomUUID()) => {
    const response = await page.request.post(`${baseURL}/api/actions/${operation}`, {
      headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key }, data,
    });
    return { status: response.status(), body: await response.json() };
  };
  const signIn = async (kind: 'operator' | 'customer', email: string, locale: 'en' | 'pl' = 'en') => {
    const messages = () => {
      try { return compose('exec', '-T', '--user', 'node', 'application', 'cat',
        '/application/.context/captured-messages/identity.jsonl').trim().split('\n')
        .map(line => JSON.parse(line)).filter(message => message.email === email); }
      catch { return []; }
    };
    const previous = messages().at(-1)?.token;
    let requested = Date.now();
    if (kind === 'operator') {
      await page.goto(routes.admin[locale]);
      const request = page.locator('#operator-sign-in form').first();
      await request.getByLabel(copy[locale].email, { exact: true }).fill(email);
      const response = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
      await request.getByRole('button', { name: copy[locale].operatorRequestSignIn, exact: true }).click();
      expect((await (await response).json()).ok).toBe(true);
    } else expect((await action('auth.request', { email })).body.ok).toBe(true);
    requested = Date.now();
    let token = '';
    await expect.poll(() => {
      token = messages().at(-1)?.token ?? '';
      return token !== previous && /^[A-Za-z0-9_-]{43}$/.test(token);
    }).toBe(true);
    if (kind === 'operator') {
      const redemption = page.locator('#operator-sign-in form').nth(1);
      await redemption.getByLabel(copy[locale].operatorToken, { exact: true }).fill(token);
      const response = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
      await redemption.getByRole('button', { name: copy[locale].operatorRedeemToken, exact: true }).click();
      expect((await (await response).json()).ok).toBe(true);
      expect(await redemption.locator('[name=token]').evaluate(input => (input as HTMLInputElement).value.length === 0)).toBe(true);
    } else expect((await action('auth.verify', { token })).body.ok).toBe(true);
    return requested;
  };

  const status = (await action('application.status')).body.value.bindings;
  expect(status).toHaveLength(52);
  for (const operation of ['partners.submit', 'operator.partners', 'operator.partnerTransition',
    'review.read', 'review.submit', 'operator.reviews', 'operator.reviewModerate']) {
    expect(status.find((item: { operation: string }) => item.operation === operation)?.bound).toBe(true);
  }
  for (const operation of ['acquisition.submit', 'research.submit', 'ingest.submit']) {
    expect(status.find((item: { operation: string }) => item.operation === operation)?.bound).toBe(false);
  }
  expect((await action(['inquiry', 'submit'].join('.'))).status).toBe(404);
  for (const operation of ['operator.partners', 'operator.partnerTransition', 'operator.reviews', 'operator.reviewModerate']) {
    expect((await action(operation, { operatorRef: randomUUID() })).body.code).toBe('operator_required');
  }
  expect((await action('partners.submit', { email: 'invalid' })).body.code).toBe('starter_input_invalid');
  expect((await action('acquisition.submit', { consent: true })).body.code).toBe('host_binding_required');
  expect((await action('research.submit', { caseReference: 'unowned-case' })).body.code).toBe('host_binding_required');

  // No fabricated review/grant rows: these references must reach the real native refusal boundary.
  for (const [grant, readCode, submitCode] of [
    ['', 'access_grant_unavailable', 'access_grant_unavailable'],
    ['invalid', 'order_review_unavailable', 'order_review_invalid'],
    [`review-grant:${randomUUID()}`, 'order_review_unavailable', 'order_review_unavailable'],
    [`order:${randomUUID()}`, 'order_review_unavailable', 'order_review_invalid'],
  ]) {
    expect((await action('review.read', { grant })).body).toEqual({ ok: false, code: readCode });
    expect((await action('review.submit', { grant, rating: 5, comment: 'Fictional feedback' })).body)
      .toEqual({ ok: false, code: submitCode });
  }

  await page.goto(routes.partners.en);
  const form = page.locator('main form');
  const partnerEmail = `partner-${randomUUID()}@example.test`;
  await form.locator('[name=email]').fill(partnerEmail);
  const submission = page.waitForResponse(response => response.url().endsWith('/api/actions/partners.submit'));
  await form.getByRole('button', { name: copy.en.sendInquiry, exact: true }).click();
  const receipt = await (await submission).json();
  expect(receipt.ok).toBe(true);
  expect(Object.keys(receipt.value)).toEqual(['caseRef']);
  expect(JSON.stringify(receipt)).not.toContain(partnerEmail);
  const caseRef = receipt.value.caseRef;
  await expect(form.locator('.action-result')).toContainText(caseRef);
  const replay = page.waitForResponse(response => response.url().endsWith('/api/actions/partners.submit'));
  await form.getByRole('button', { name: copy.en.sendInquiry, exact: true }).click();
  expect((await (await replay).json()).replayed).toBe(true);

  const inquiry = { company: 'Fictional Studio', country: 'ZZ', firstName: 'Alex', lastName: 'Example', email: partnerEmail };
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await action('partners.submit', inquiry)).body.code).toBe('partner_acquisition_conflict');
  }
  expect((await action('partners.submit', inquiry)).body.code).toBe('partner_acquisition_rate_limited');
  // Rotating email does not reset the independent socket-peer quota (five attempts).
  expect((await action('partners.submit', { ...inquiry, email: `second-${randomUUID()}@example.test` })).body.ok).toBe(true);
  expect((await action('partners.submit', { ...inquiry, email: `third-${randomUUID()}@example.test`, requesterKey: randomUUID() })).body.code)
    .toBe('partner_acquisition_rate_limited');

  await signIn('customer', customerEmail);
  for (const operation of ['operator.partners', 'operator.partnerTransition', 'operator.reviews', 'operator.reviewModerate']) {
    expect((await action(operation, { operatorRef: randomUUID() })).body.code).toBe('operator_required');
  }
  await action('auth.signOut');
  expect((await action('auth.operator', { email: 'unknown-operator@example.test' })).body.ok).toBe(true);
  expect((await action('auth.operator', { token: 'x'.repeat(43) })).body.code).toBe('starter_auth_invalid');
  const signedInAt = await signIn('operator', operatorEmail);
  expect((await action('operator.reviews')).body).toEqual({ ok: true, value: { items: [] } });
  expect((await action('operator.reviewModerate', { reviewRef: `order-review:${randomUUID()}`, action: 'publish' })).body.ok).toBe(false);
  expect((await action('operator.partnerTransition', { id: caseRef, expectedVersion: 0, status: 'invalid' })).body.code)
    .toBe('starter_input_invalid');

  await page.goto(routes.admin.en + '#partners');
  const panel = page.locator('#partners');
  await panel.getByRole('button', { name: copy.en.readStatus, exact: true }).click();
  await expect(panel).toContainText(partnerEmail);
  const transition = panel.locator('form');
  await transition.locator('[name=id]').fill(caseRef);
  await transition.locator('[name=status]').selectOption('contacted');
  await transition.getByRole('button', { name: copy.en.save, exact: true }).click();
  await expect(transition.locator('.action-result')).toContainText('contacted');
  expect((await action('operator.partnerTransition', { id: caseRef, expectedVersion: 1, status: 'contacted' })).body.code)
    .toBe('partner_acquisition_conflict');

  compose('restart', 'application');
  await expect.poll(async () => {
    try { return (await page.request.get(`${baseURL}/api/config`)).status(); }
    catch { return 0; }
  }).toBe(200);
  expect((await action('operator.partners')).body.code).toBe('operator_required');
  // Native operator challenges are limited to one per minute; keep the actual limit.
  const delay = Math.max(0, signedInAt + 61000 - Date.now());
  await new Promise(resolve => setTimeout(resolve, delay));
  await context.clearCookies();
  await signIn('operator', operatorEmail, 'pl');
  await page.goto(routes.admin.pl + '#partners');
  await page.locator('#partners').getByRole('button', { name: copy.pl.readStatus, exact: true }).click();
  await expect(page.locator('#partners')).toContainText(caseRef);
  const persisted = (await action('operator.partners')).body.value.cases.find((item: { caseRef: string }) => item.caseRef === caseRef);
  expect(persisted.status).toBe('contacted');
  expect(persisted.version).toBe(2);
});
