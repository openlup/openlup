import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';

/** Run against an explicitly selected, fresh disposable PostgreSQL installation. */
interface AcquisitionProofOptions {
  composeProject: string; operatorEmail: string; operatorRef: string;
  customerEmail: string; customerRef: string;
}
const test = base.extend<AcquisitionProofOptions>({
  composeProject: ['', { option: true }], operatorEmail: ['', { option: true }],
  operatorRef: ['', { option: true }], customerEmail: ['', { option: true }], customerRef: ['', { option: true }],
});

test('native acquisition, replay, quotas, durable read and unresolved support authority', async ({
  page, baseURL, composeProject, operatorEmail, operatorRef, customerEmail, customerRef,
}) => {
  if (!baseURL || !/^[a-z0-9-]+$/.test(composeProject) || !operatorEmail || !operatorRef || !customerEmail || !customerRef) {
    throw new Error('native_acquisition_proof_fixture_required');
  }
  const compose = (args: string[], input?: string) => execFileSync('docker', ['compose', '--project-name', composeProject, ...args],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
  const native = (source: string) => JSON.parse(compose(['exec', '-T', 'application', 'node', '--input-type=module'], source));
  const action = async (operation: string, data: Record<string, unknown> = {}, key = randomUUID()) => {
    const response = await page.request.post(`${baseURL}/api/actions/${operation}`, {
      headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key,
        'X-Forwarded-For': randomUUID() }, data,
    });
    return response.json();
  };
  const signIn = async (kind: 'operator' | 'customer', email: string) => {
    expect((await action(kind === 'operator' ? 'auth.operator' : 'auth.request', { email })).ok).toBe(true);
    let token = '';
    await expect.poll(() => {
      try {
        const messages = compose(['exec', '-T', '--user', 'node', 'application', 'cat',
          '/application/.context/captured-messages/identity.jsonl']).trim().split('\n').map(line => JSON.parse(line));
        token = messages.filter(message => message.email === email).at(-1)?.token ?? '';
      } catch { token = ''; }
      return token;
    }).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await action(kind === 'operator' ? 'auth.operator' : 'auth.verify', { token })).ok).toBe(true);
  };
  const status = (await action('application.status')).value.bindings;
  expect(status).toHaveLength(52);
  expect(status.filter((item: { bound: boolean }) => item.bound)).toHaveLength(20);
  expect(status.find((item: { operation: string }) => item.operation === 'acquisition.submit').bound).toBe(true);
  for (const operation of ['operator.customerSearch', 'operator.customer', 'operator.bundles',
    'operator.bundle', 'operator.bundleCommand', 'operator.catalogDrafts', 'research.submit', 'ingest.submit']) {
    expect(status.find((item: { operation: string }) => item.operation === operation).bound).toBe(false);
  }
  const contact = `applicant-${randomUUID()}@example.test`;
  const valid = { email: contact, consent: true, locale: 'en', addressChoiceId: acquisitionAddresses[0]!.id };
  expect(await action('acquisition.submit', { ...valid, consent: false })).toEqual({ ok: false, code: 'starter_input_invalid' });
  expect(await action('acquisition.submit', { ...valid, addressChoiceId: 'unknown' })).toEqual({ ok: false, code: 'starter_input_invalid' });
  for (const field of ['reference', 'source', 'revision', 'provenance', 'addressReference', 'requesterKey', 'actorRef']) {
    expect(await action('acquisition.submit', { ...valid, [field]: 'caller-controlled' }))
      .toEqual({ ok: false, code: 'starter_input_invalid' });
  }
  await page.goto(routes.acquisition.en);
  const form = page.locator('main form');
  await expect(form.locator('[name=firstName], [name=lastName]')).toHaveCount(0);
  await form.locator('[name=email]').fill(contact);
  await form.locator('[name=addressChoiceId]').selectOption(acquisitionAddresses[0]!.id);
  await expect(form.locator('[name=consent]')).not.toBeChecked();
  await form.getByRole('button', { name: copy.en.apply, exact: true }).click();
  await expect(form.locator('[name=consent]:invalid')).toHaveCount(1);
  await expect(form.locator('.action-result')).toBeEmpty();
  await form.locator('[name=consent]').check();
  const submission = page.waitForResponse(response => response.url().endsWith('/api/actions/acquisition.submit'));
  const request = page.waitForRequest(request => request.url().endsWith('/api/actions/acquisition.submit'));
  await form.getByRole('button', { name: copy.en.apply, exact: true }).click();
  const sent = (await request).postDataJSON();
  expect(Object.keys(sent).sort()).toEqual(['addressChoiceId', 'consent', 'email', 'locale']);
  const receipt = await (await submission).json();
  expect(receipt.ok).toBe(true);
  expect(Object.keys(receipt.value)).toEqual(['caseRef']);
  expect(JSON.stringify(receipt)).not.toContain(contact);
  const caseRef: string = receipt.value.caseRef;
  await expect(form.locator('.action-result')).toContainText(caseRef);
  const replay = page.waitForResponse(response => response.url().endsWith('/api/actions/acquisition.submit'));
  await form.getByRole('button', { name: copy.en.apply, exact: true }).click();
  expect(await (await replay).json()).toEqual({ ok: true, value: { caseRef }, replayed: true });
  for (let index = 0; index < 2; index++) expect((await action('acquisition.submit', valid)).code).toBe('acquisition_case_conflict');
  expect((await action('acquisition.submit', valid)).code).toBe('acquisition_case_rate_limited');
  // The fifth peer attempt still works for another email; forwarding headers do not reset the sixth.
  expect((await action('acquisition.submit', { ...valid, email: `other-${randomUUID()}@example.test` })).ok).toBe(true);
  expect((await action('acquisition.submit', { ...valid, email: `quota-${randomUUID()}@example.test` })).code)
    .toBe('acquisition_case_rate_limited');

  for (const operation of ['operator.customerSearch', 'operator.customer']) {
    expect((await action(operation, { query: customerEmail, customerRef, operatorRef })).code).toBe('operator_required');
  }
  await signIn('customer', customerEmail);
  for (const operation of ['operator.customerSearch', 'operator.customer']) {
    expect((await action(operation, { query: customerEmail, customerRef, operatorRef })).code).toBe('operator_required');
  }
  await action('auth.signOut');
  // A wrong actor in the payload never grants a session.
  expect((await action('operator.customer', { customerRef, actorRef: operatorRef })).code).toBe('operator_required');
  await signIn('operator', operatorEmail);
  for (const operation of ['operator.customerSearch', 'operator.customer']) {
    expect((await action(operation, { query: customerEmail, customerRef })).code).toBe('host_binding_required');
  }
  await page.goto(routes.admin.en + '#customers');
  const customerForms = page.locator('#customers form');
  await customerForms.nth(0).locator('[name=query]').fill(customerEmail);
  await customerForms.nth(0).getByRole('button', { name: copy.en.searchCustomer, exact: true }).click();
  await expect(customerForms.nth(0).locator('.action-result')).toContainText('host_binding_required');
  await customerForms.nth(1).locator('[name=customerRef]').fill(customerRef);
  await customerForms.nth(1).getByRole('button', { name: copy.en.read, exact: true }).click();
  await expect(customerForms.nth(1).locator('.action-result')).toContainText('host_binding_required');

  const durable = native(`
    import { createPostgresAcquisitionCasePort } from '@openlup/platform/marketing/server/postgres';
    const port = createPostgresAcquisitionCasePort({connectionString:'postgresql://starter_runtime@database:5432/neutral_store'});
    try { console.log(JSON.stringify(await port.list({scope:'public_tester_application',actorRef:${JSON.stringify(operatorRef)},limit:30}))); }
    finally { await port.close(); }
  `);
  expect(durable.ok).toBe(true);
  const persisted = durable.value.cases.find((item: { caseRef: string }) => item.caseRef === caseRef);
  expect(persisted.state).toBe('submitted');
  expect(persisted.version).toBe(1);
  expect(persisted.addressReference).toEqual(acquisitionAddresses[0]!.addressReference);
  expect(persisted.consent.sourcePath).toBe('/tester-application');
  const support = native(`
    import { createPostgresCustomerSupportJourneyPort } from '@openlup/platform/account-support/postgres';
    const port = createPostgresCustomerSupportJourneyPort({connectionString:'postgresql://starter_runtime@database:5432/neutral_store',operatorId:${JSON.stringify(operatorRef)}});
    const results = [];
    try { for (const work of [()=>port.searchCustomerJourney({query:${JSON.stringify(customerEmail)},pageSize:25}),
      ()=>port.getCustomerJourney({subjectId:${JSON.stringify(customerRef)},pageSize:25})]) {
      try { await work(); results.push('unexpected_success'); } catch (error) { results.push(error.message); }
    } console.log(JSON.stringify(results)); } finally { await port.close(); }
  `);
  expect(support).toEqual(['customer_support_read_failed', 'customer_support_read_failed']);
});
