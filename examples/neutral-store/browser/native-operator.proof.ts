import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';

/** Fresh installed PostgreSQL only; owns identities and the documented owner roster step. */
const test = base.extend<{ composeProject: string }>({ composeProject: ['', { option: true }] });

test('native support roster, catalogue administration, replay and operator admission', async ({ page, context, baseURL, composeProject }) => {
  test.setTimeout(120000);
  if (!baseURL || !/^[a-z0-9-]+$/.test(composeProject)) throw new Error('native_operator_proof_fixture_required');
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '--project-name', composeProject, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (query: string, runtime = false) => compose('exec', '-T', 'database', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
    ...(runtime ? ['-h', '127.0.0.1', '-U', 'starter_runtime'] : ['-U', 'starter_install']), '-d', 'neutral_store', '-c', query).trim();
  const fixture = JSON.parse(compose('exec', '-T', 'application', 'node', '--input-type=module', '-e', `
    import { randomUUID } from 'node:crypto';
    import { createPostgresOperatorIdentityStore, createPostgresAccountLinkStore } from '@openlup/platform/identity';
    const connectionString='postgresql://starter_runtime@database:5432/neutral_store';
    const operators=createPostgresOperatorIdentityStore({connectionString});
    const accounts=createPostgresAccountLinkStore({connectionString});
    try {
      const operator=await operators.bootstrapFirstAdministrator({email:'operator@example.test'});
      const customer=await accounts.createAccount({principalId:randomUUID(),email:'customer@example.test',acquisitionSource:'direct',lifecycleStage:'customer'});
      console.log(JSON.stringify({operator:operator.principalId,customer:customer.id}));
    } finally { await Promise.all([operators.close(),accounts.close()]); }
  `));
  const privileges = JSON.parse(sql(`SELECT json_agg(json_build_object('routine',p.oid::regprocedure::text,
    'execute',has_function_privilege(current_user,p.oid,'EXECUTE'))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND (p.proname LIKE 'admin_%bundle%' OR p.proname IN ('customer_support_search','customer_support_journey',
    'communications_require_active_operator','communications_operator_is_active','catalog_draft_apply','catalog_draft_get','catalog_draft_list','catalog_draft_record'))`, true));
  expect(privileges.length).toBe(15);
  expect(privileges.every((row: { execute: boolean }) => row.execute)).toBe(true);
  console.log('runtime privileges', JSON.stringify(privileges));
  expect(sql(`SELECT session_user||':'||current_user||':'||rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname=current_user`, true))
    .toBe('starter_runtime:starter_runtime:false:false');
  expect(sql('SELECT count(*) FROM public.platform_communication_operators')).toBe('0');
  const action = async (operation: string, data: Record<string, unknown> = {}, key: string = randomUUID()) => {
    const response = await page.request.post(`${baseURL}/api/actions/${operation}`, {
      headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key }, data,
    });
    return response.json();
  };
  const operatorLocale = (await (await page.request.get(`${baseURL}/api/config`)).json()).config.id === 'coffee' ? 'pl' : 'en';
  const signIn = async (kind: 'operator' | 'customer', email: string) => {
    if (kind === 'operator') {
      await page.goto(routes.admin[operatorLocale]);
      const request = page.locator('#operator-sign-in form').first();
      await request.getByLabel(copy[operatorLocale].email, { exact: true }).fill(email);
      const response = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
      await request.getByRole('button', { name: copy[operatorLocale].operatorRequestSignIn, exact: true }).click();
      expect((await (await response).json()).ok).toBe(true);
    } else expect((await action('auth.request', { email })).ok).toBe(true);
    let token = '';
    await expect.poll(() => {
      try {
        const messages = compose('exec', '-T', '--user', 'node', 'application', 'cat',
          '/application/.context/captured-messages/identity.jsonl').trim().split('\n').map(line => JSON.parse(line));
        token = messages.filter(message => message.email === email).at(-1)?.token ?? '';
        return /^[A-Za-z0-9_-]{43}$/.test(token);
      } catch { return false; }
    }).toBe(true);
    if (kind === 'operator') {
      const redemption = page.locator('#operator-sign-in form').nth(1);
      await redemption.getByLabel(copy[operatorLocale].operatorToken, { exact: true }).fill(token);
      const response = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
      await redemption.getByRole('button', { name: copy[operatorLocale].operatorRedeemToken, exact: true }).click();
      expect((await (await response).json()).ok).toBe(true);
      expect(await redemption.locator('[name=token]').evaluate(input => (input as HTMLInputElement).value.length === 0)).toBe(true);
    } else expect((await action('auth.verify', { token })).ok).toBe(true);
  };
  for (const locale of ['en', 'pl'] as const) {
    await page.goto(routes.admin[locale]);
    const forms = page.locator('#operator-sign-in form');
    await expect(forms.first().getByLabel(copy[locale].email, { exact: true })).toBeVisible();
    const token = forms.nth(1).getByLabel(copy[locale].operatorToken, { exact: true });
    await expect(token).toHaveAttribute('type', 'password');
    await expect(token).toHaveAttribute('pattern', '(?:[A-Za-z0-9_]|-){43}');
    await expect(token).toHaveAttribute('maxlength', '43');
    for (const [index, name, submit] of [[0, 'email', copy[locale].operatorRequestSignIn],
      [1, 'token', copy[locale].operatorRedeemToken]] as const) {
      const form = forms.nth(index);
      const control = form.locator(`[name=${name}]`);
      await expect(control).toHaveAttribute('required', '');
      // Keep production validation. Bypass HTML required only to prove the host refusal.
      await control.evaluate(input => input.removeAttribute('required'));
      const response = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
      await form.getByRole('button', { name: submit, exact: true }).click();
      expect((await (await response).json()).code).toBe('starter_input_invalid');
      await expect(form.locator('.action-result')).toContainText('starter_input_invalid');
      await control.evaluate(input => input.setAttribute('required', ''));
    }
    await token.fill('x'.repeat(43));
    const wrong = page.waitForResponse(item => item.url().endsWith('/api/actions/auth.operator'));
    await forms.nth(1).getByRole('button', { name: copy[locale].operatorRedeemToken, exact: true }).click();
    expect((await (await wrong).json()).code).toBe('starter_auth_invalid');
    await expect(forms.nth(1).locator('.action-result')).toContainText('starter_auth_invalid');
  }
  const operations = ['operator.customerSearch', 'operator.customer', 'operator.bundles', 'operator.bundle',
    'operator.bundleCommand', 'operator.catalogDrafts'];
  const status = (await action('application.status')).value.bindings;
  expect(status).toHaveLength(52);
  expect(status.filter((row: { bound: boolean }) => row.bound)).toHaveLength(25);
  for (const operation of operations) {
    expect(status.find((row: { operation: string }) => row.operation === operation).bound).toBe(true);
    expect((await action(operation, { operatorRef: fixture.operator })).code).toBe('operator_required');
  }
  await signIn('customer', 'customer@example.test');
  for (const operation of operations) expect((await action(operation, { actorRef: fixture.operator })).code).toBe('operator_required');
  await action('auth.signOut');
  await context.addCookies([{ name: 'starter_session', value: randomUUID(), url: baseURL + '/api/actions' }]);
  expect((await action('operator.customerSearch', { query: 'customer@example.test', operatorRef: fixture.operator })).code).toBe('operator_required');
  await context.clearCookies();
  await signIn('operator', 'operator@example.test');
  const cookie = (await context.cookies(baseURL + '/api/actions')).find(item => item.name === 'starter_session');
  expect(cookie).toBeTruthy();
  // Native activation must precede the owner lookup and the sole roster INSERT.
  const principal = sql(`SELECT p.principal_id FROM public.platform_human_principals p
    JOIN public.platform_human_memberships m USING (principal_id)
    WHERE lower(btrim(p.email))=lower(btrim('operator@example.test')) AND m.membership_state='active'
      AND m.role IN ('admin','distributor') AND NOT EXISTS
      (SELECT 1 FROM public.platform_control_operators o WHERE o.principal_id=p.principal_id)`);
  expect(principal).toBe(fixture.operator);
  const support = async (expected: string) => {
    expect((await action('operator.customerSearch', { query: 'customer@example.test' })).code).toBe(expected);
    expect((await action('operator.customer', { customerRef: fixture.customer })).code).toBe(expected);
  };
  await support('customer_support_read_failed');
  // Observe the exact native cause separately; the adapter intentionally erases it.
  expect(() => sql(`SELECT public.customer_support_search('${principal}', 'customer@example.test',0,10,'all')`, true))
    .toThrow(/communications_operator_inactive/);
  await page.goto(routes.admin.en + '#customers');
  const customers = page.locator('#customers');
  await customers.locator('[name=query]').fill('customer@example.test');
  await customers.getByRole('button', { name: copy.en.searchCustomer, exact: true }).click();
  await expect(customers).toContainText('customer_support_read_failed');
  await expect(customers).toContainText(copy.en.supportRosterBody);
  sql(`INSERT INTO public.platform_communication_operators (principal_id, active)
    VALUES ('${principal}'::uuid, true)
    ON CONFLICT (principal_id) DO UPDATE SET active = true, updated_at = now()`);
  // A real active roster row cannot bypass the host's earlier native admission.
  const anonymous = await context.browser()!.newContext();
  const noSession = await anonymous.request.post(`${baseURL}/api/actions/operator.customerSearch`, {
    headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID() },
    data: { query: 'customer@example.test', operatorRef: principal },
  });
  expect((await noSession.json()).code).toBe('operator_required');
  await anonymous.close();
  await customers.getByRole('button', { name: copy.en.searchCustomer, exact: true }).click();
  await expect(customers).toContainText('customer@example.test');
  const search = await action('operator.customerSearch', { query: 'customer@example.test' });
  expect(search.ok).toBe(true);
  expect(search.value.candidates[0].subjectId).toBe(fixture.customer);
  const detailForm = customers.locator('form').nth(1);
  await detailForm.locator('[name=customerRef]').fill(fixture.customer);
  await detailForm.getByRole('button', { name: copy.en.read, exact: true }).click();
  await expect(detailForm.locator('.action-result')).toContainText('customer@example.test');
  const countConnections = () => Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE usename='starter_runtime'`));
  const before = countConnections();
  for (let i = 0; i < 12; i++) {
    expect((await action('operator.customer', { customerRef: fixture.customer })).ok).toBe(true);
    expect((await action('operator.customerSearch', { query: 'customer@example.test' })).ok).toBe(true);
  }
  await expect.poll(countConnections).toBe(before);
  sql(`UPDATE public.platform_communication_operators SET active=false,updated_at=now() WHERE principal_id='${principal}'::uuid`);
  for (let i = 0; i < 12; i++) await support('customer_support_read_failed');
  await expect.poll(countConnections).toBe(before);
  console.log('support closure', JSON.stringify({ before, afterSuccessAndFailure: countConnections(), successCalls: 24, refusedCalls: 24 }));
  // Deactivated roster remains no support grant, but catalogue uses native human membership.
  expect((await action('operator.customerSearch', { query: 'customer@example.test', actorRef: randomUUID() })).code).toBe('starter_input_invalid');
  expect((await action('operator.customer', { customerRef: 'invalid' })).code).toBe('starter_input_invalid');
  const config = (await (await page.request.get(`${baseURL}/api/config`)).json()).config;
  const originalConfig = JSON.stringify(config);
  const code = `demo-${randomUUID()}`;
  const command = (data: Record<string, unknown>, key?: string) => action('operator.bundleCommand', { bundleCode: code, ...data }, key);
  await page.goto(routes.admin.en + '#catalogue');
  const panel = page.locator('#catalogue');
  await expect(panel).toContainText(copy.en.catalogAuthoringBody);
  const create = panel.locator('form').filter({ has: page.getByRole('button', { name: copy.en.bundleDraft, exact: true }) });
  await create.locator('[name=bundleCode]').fill(code);
  await create.locator('[name=title]').fill('Fictional operator bundle');
  await create.getByRole('button', { name: copy.en.bundleDraft, exact: true }).click();
  await expect(create.locator('.action-result')).toContainText(code);
  const replay = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.bundleCommand'));
  await create.getByRole('button', { name: copy.en.bundleDraft, exact: true }).click();
  expect((await (await replay).json()).replayed).toBe(true);
  expect((await command({ action: 'set_composition', components: [] })).code).toBe('starter_input_invalid');
  expect((await command({ action: 'activate', actorRef: randomUUID() })).code).toBe('starter_input_invalid');
  expect((await command({ action: 'activate' })).code).toBe('bundle_rule_conflict');
  const submitBundleForm = async (label: string, fields: Record<string, string> = {}) => {
    const form = panel.locator('form').filter({ has: page.getByRole('button', { name: label, exact: true }) });
    await form.locator('[name=bundleCode]').fill(code);
    for (const [name, value] of Object.entries(fields)) await form.locator(`[name=${name}]`).fill(value);
    const response = page.waitForResponse(item => item.url().endsWith('/api/actions/operator.bundleCommand'));
    await form.getByRole('button', { name: label, exact: true }).click();
    expect((await (await response).json()).ok).toBe(true);
  };
  await submitBundleForm(copy.en.bundleComposition, { components: JSON.stringify([
    { sku: config.offer.products[0].sku, quantity: 1, isAddon: false },
  ]) });
  expect((await command({ action: 'set_target_price', amountMinor: -1 })).code).toBe('starter_input_invalid');
  await submitBundleForm(copy.en.bundleTarget, { amountMinor: String(config.offer.products[0].unitPrice.amountMinor) });
  await submitBundleForm(copy.en.bundleActivate);
  const read = panel.locator('form').first();
  await read.locator('[name=bundleCode]').fill(code);
  await read.getByRole('button', { name: copy.en.read, exact: true }).click();
  await expect(read.locator('.action-result')).toContainText('active');
  const list = panel.locator('section.panel').first();
  await list.getByRole('button', { name: copy.en.readStatus, exact: true }).click();
  await expect(list).toContainText(code);
  const detail = await action('operator.bundle', { bundleCode: code });
  expect(detail.ok).toBe(true);
  expect(detail.value.status).toBe('active');
  expect(detail.value.components[0].sku).toBe(config.offer.products[0].sku);
  expect((await action('offer.validate', { cart: { schemaVersion: 1, configuration: config.id,
    mode: 'one_time', cadenceDays: null, lines: [{ sku: code, quantity: 1 }] } })).code).toBe('unknown_sku');
  expect((await action('operator.bundles')).value.bundles.some((row: { code: string }) => row.code === code)).toBe(true);
  // Every command exposed by the existing panel is exercised, including native state refusals.
  expect((await command({ action: 'deactivate' })).ok).toBe(true);
  expect((await command({ action: 'archive' })).ok).toBe(true);
  expect((await command({ action: 'restore' })).ok).toBe(true);
  expect((await command({ action: 'clone', newCode: code + '-copy' })).ok).toBe(true);
  expect((await command({ action: 'restore' })).code).toBe('bundle_rule_conflict');
  expect(JSON.stringify((await (await page.request.get(`${baseURL}/api/config`)).json()).config)).toBe(originalConfig);
  const draftPanel = page.locator('#catalogue-drafts');
  const draftForm = draftPanel.locator('form').nth(1);
  const draftId = await draftForm.locator('[name=draftId]').inputValue();
  const draftCreated = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy.en.save, exact: true }).click();
  const created = await (await draftCreated).json();
  expect(created.ok).toBe(true);
  expect(created.value.outcome).toBe('committed');
  expect(created.value.record.actorId).toBe(principal);
  expect(sql(`SELECT count(*) FROM public.catalog_products WHERE id='${created.value.record.productId}'::uuid`)).toBe('0');
  const draftReplay = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy.en.save, exact: true }).click();
  expect((await (await draftReplay).json()).replayed).toBe(true);
  const draftRead = await action('operator.catalogDrafts', { action: 'get', draftId });
  expect(draftRead.value.record.revision).toBe(1);
  expect((await action('operator.catalogDrafts')).value.page.items.some((row: { draftId: string }) => row.draftId === draftId)).toBe(true);
  expect((await action('operator.catalogDrafts', { action: 'revise', draftId, expectedRevision: 1, payload: created.value.record.payload })).ok).toBe(true);
  expect((await action('operator.catalogDrafts', { action: 'abandon', draftId, expectedRevision: 2 })).ok).toBe(true);
  expect((await action('operator.catalogDrafts', { action: 'create', draftId: randomUUID(), expectedRevision: 0, payload: {} })).code).toBe('catalog_draft_input_invalid');
  expect((await action('operator.catalogDrafts', { actorRef: principal })).code).toBe('starter_input_invalid');
  await action('auth.signOut');
  for (const operation of operations) expect((await action(operation)).code).toBe('operator_required');
  console.log('operation tally', JSON.stringify({ declared: status.length, bound: status.filter((row: { bound: boolean }) => row.bound).length }));
});
