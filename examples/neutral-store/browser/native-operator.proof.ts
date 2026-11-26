import { market } from '../owned/market.config.ts';
import { test as base, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import pg from 'pg';
import { buildCatalogReleaseDraftV3, canonicalCatalogDraftJson, catalogInternalGtin,
  createPostgresCatalogDraftStoreV4, createPostgresCatalogPublicationCommands } from '@openlup/platform/catalog';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import { createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
import { catalogueWatchdogPrincipalId, startCatalogueReadinessJobs } from '../host/catalogue-readiness-jobs.ts';
import { starterCatalogue } from '../host/editor-catalogue.ts';
import { createPrivateCapture } from '../host/private-capture.ts';
import { runScheduledCare } from '../host/scheduled-renewal.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';
import { selectConfiguration } from '../owned/store.config.ts';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';
import { operations as declaredOperations } from '../shared/api.ts';

/** Fresh installed PostgreSQL only; owns identities and the documented owner roster step. */
const test = base.extend<{ composeProject: string }>({ composeProject: ['', { option: true }] });

test('native support roster, catalogue administration, replay and operator admission', async ({ page, context, baseURL, composeProject }) => {
  test.setTimeout(120000);
  test.skip(!composeProject, 'Uses the demonstration Compose fixture.');
  if (!baseURL || !/^[a-z0-9-]+$/.test(composeProject)) throw new Error('native_operator_proof_fixture_required');
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '--project-name', composeProject, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (query: string, runtime = false) => runtime
    ? compose('exec', '-T', 'application', 'node', '--input-type=module', '-e', `
      import pg from 'pg'; import { runtimeConnectionString } from './host/runtime-database.ts';
      const pool = new pg.Pool({ connectionString: runtimeConnectionString() });
      try { for (const row of (await pool.query(process.argv[1])).rows) {
        const [value] = Object.values(row); console.log(typeof value === 'object' ? JSON.stringify(value) : value);
      } } finally { await pool.end(); }
    `, query).trim()
    : compose('exec', '-T', 'database', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'starter_install', '-d', 'neutral_store', '-c', query).trim();
  const fixture = JSON.parse(compose('exec', '-T', 'application', 'node', '--input-type=module', '-e', `
    import { runtimeConnectionString } from './host/runtime-database.ts';

    import { randomUUID } from 'node:crypto';
    import { createPostgresOperatorIdentityStore, createPostgresAccountLinkStore } from '@openlup/platform/identity';
    const connectionString=runtimeConnectionString();
    const operators=createPostgresOperatorIdentityStore({connectionString});
    const accounts=createPostgresAccountLinkStore({connectionString});
    try {
      const operator=await operators.bootstrapFirstAdministrator({email:process.argv[1]});
      const customer=await accounts.createAccount({principalId:randomUUID(),email:'customer@example.test',acquisitionSource:'direct',lifecycleStage:'customer'});
      console.log(JSON.stringify({operator:operator.principalId,customer:customer.id}));
    } finally { await Promise.all([operators.close(),accounts.close()]); }
  `, 'operator@example.test'));
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
  const operatorLocale = market.defaultLocale;
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
  for (const locale of market.locales) {
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
  expect(status.map((row: { operation: string }) => row.operation)).toEqual(declaredOperations);
  expect(status).toContainEqual({ operation: 'catalogue.demoTarget', declared: true, bound: true, checked: false });
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
  await page.goto(routes.admin[market.defaultLocale] + '#customers');
  const customers = page.locator('#customers');
  await customers.locator('[name=query]').fill('customer@example.test');
  await customers.getByRole('button', { name: copy[market.defaultLocale].searchCustomer, exact: true }).click();
  await expect(customers).toContainText('customer_support_read_failed');
  await expect(customers).toContainText(copy[market.defaultLocale].supportRosterBody);
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
  await customers.getByRole('button', { name: copy[market.defaultLocale].searchCustomer, exact: true }).click();
  await expect(customers).toContainText('customer@example.test');
  const search = await action('operator.customerSearch', { query: 'customer@example.test' });
  expect(search.ok).toBe(true);
  expect(search.value.candidates[0].subjectId).toBe(fixture.customer);
  const detailForm = customers.locator('form').nth(1);
  await detailForm.locator('[name=customerRef]').fill(fixture.customer);
  await detailForm.getByRole('button', { name: copy[market.defaultLocale].read, exact: true }).click();
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
  await page.goto(routes.admin[market.defaultLocale] + '#catalogue');
  const panel = page.locator('#catalogue');
  await expect(panel).toContainText(copy[market.defaultLocale].catalogAuthoringBody);
  const create = panel.locator('form').filter({ has: page.getByRole('button', { name: copy[market.defaultLocale].bundleDraft, exact: true }) });
  await create.locator('[name=bundleCode]').fill(code);
  await create.locator('[name=title]').fill('Fictional operator bundle');
  await create.getByRole('button', { name: copy[market.defaultLocale].bundleDraft, exact: true }).click();
  await expect(create.locator('.action-result')).toContainText(code);
  const replay = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.bundleCommand'));
  await create.getByRole('button', { name: copy[market.defaultLocale].bundleDraft, exact: true }).click();
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
  await submitBundleForm(copy[market.defaultLocale].bundleComposition, { components: JSON.stringify([
    { sku: config.offer.products[0].sku, quantity: 1, isAddon: false },
  ]) });
  expect((await command({ action: 'set_target_price', amountMinor: -1 })).code).toBe('starter_input_invalid');
  await submitBundleForm(copy[market.defaultLocale].bundleTarget, { amountMinor: String(config.offer.products[0].unitPrice.amountMinor) });
  await submitBundleForm(copy[market.defaultLocale].bundleActivate);
  const read = panel.locator('form').first();
  await read.locator('[name=bundleCode]').fill(code);
  await read.getByRole('button', { name: copy[market.defaultLocale].read, exact: true }).click();
  await expect(read.locator('.action-result')).toContainText('active');
  const list = panel.locator('section.panel').first();
  await list.getByRole('button', { name: copy[market.defaultLocale].readStatus, exact: true }).click();
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
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  const created = await (await draftCreated).json();
  expect(created.ok).toBe(true);
  expect(created.value.outcome).toBe('committed');
  expect(created.value.record.actorId).toBe(principal);
  expect(sql(`SELECT count(*) FROM public.catalog_products WHERE id='${created.value.record.productId}'::uuid`)).toBe('0');
  const draftReplay = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  expect((await (await draftReplay).json()).replayed).toBe(true);
  const typeVersion = Number(created.value.record.payload.product.type.version);
  expect(Number.isSafeInteger(typeVersion) && typeVersion > 1).toBe(true);
  expect(sql(`SELECT count(*) FROM public.catalog_type_versions WHERE type_key='starter:item' AND version=${typeVersion}`)).toBe('1');
  const staleDraft = structuredClone(created.value.record.payload);
  const uninstalledVersion = typeVersion === 2 ? 3 : 2;
  staleDraft.product.type.version = uninstalledVersion;
  await draftForm.locator('[name=draftId]').fill(randomUUID());
  await draftForm.locator('[name=payload]').fill(JSON.stringify(staleDraft));
  const staleReply = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  const fix = `rules version ${uninstalledVersion} is not installed; run ./lifecycle up`;
  expect(await (await staleReply).json()).toMatchObject({ ok: false,
    issues: [{ path: 'product.type', code: 'type_not_installed', message: fix }] });
  await expect(draftForm.locator('.action-result')).toContainText(fix);
  const invalidDraft = structuredClone(created.value.record.payload);
  invalidDraft.product.sharedContent.title = '';
  await draftForm.locator('[name=draftId]').fill(randomUUID());
  await draftForm.locator('[name=payload]').fill(JSON.stringify(invalidDraft));
  const reply = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  expect(await (await reply).json()).toMatchObject({ ok: false, code: 'catalog_draft_payload_invalid',
    issues: [{ path: 'product.sharedContent.title', code: 'title_required' }] });
  await expect(draftForm.locator('.action-result')).toContainText('product.sharedContent.title');
  const draftRead = await action('operator.catalogDrafts', { action: 'get', draftId });
  expect(draftRead.value.record.revision).toBe(1);
  expect((await action('operator.catalogDrafts')).value.page.items.some((row: { draftId: string }) => row.draftId === draftId)).toBe(true);
  expect((await action('operator.catalogDrafts', { action: 'revise', draftId, expectedRevision: 1, payload: created.value.record.payload })).ok).toBe(true);
  expect((await action('operator.catalogDrafts', { action: 'abandon', draftId, expectedRevision: 2 })).ok).toBe(true);
  await draftPanel.getByRole('button', { name: /Load draft example|Wczytaj przykładowy szkic/u }).click();
  const draftInput = draftForm.locator('[name=payload]');
  await expect(draftInput).toHaveValue(/"schemaVersion": 3/u);
  const example = JSON.parse(await draftInput.inputValue());
  expect(example.product.type.version).toBe(typeVersion);
  const exampleId = randomUUID();
  await draftForm.locator('[name=draftId]').fill(exampleId);
  await draftInput.fill(JSON.stringify({ ...example, product: { ...example.product,
    sharedContent: { ...example.product.sharedContent, presentation: {} } } }));
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  await expect(draftForm.locator('.action-result')).toContainText('product.sharedContent.presentation.title');
  await draftInput.fill(JSON.stringify(example));
  const savedExample = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await draftForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
  expect(await (await savedExample).json()).toMatchObject({ ok: true, value: { record: { draftId: exampleId, revision: 1 } } });
  const prepareDraft = draftPanel.locator('form').filter({ has: page.getByRole('button', { name: /Prepare saved draft|Przygotuj zapisany szkic/u }) });
  await prepareDraft.locator('[name=draftId]').fill(exampleId);
  const preparedExample = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.catalogDrafts'));
  await prepareDraft.locator('button[type=submit]').click();
  expect(await (await preparedExample).json()).toMatchObject({ ok: true, value: { structural: { outcome: 'unknown' } } });
  expect((await action('operator.catalogDrafts', { action: 'create', draftId: randomUUID(), expectedRevision: 0, payload: {} })).code).toBe('catalog_draft_input_invalid');
  expect((await action('operator.catalogDrafts', { actorRef: principal })).code).toBe('starter_input_invalid');
  await action('auth.signOut');
  for (const operation of operations) expect((await action(operation)).code).toBe('operator_required');
  console.log('operation tally', JSON.stringify({ declared: status.length, bound: status.filter((row: { bound: boolean }) => row.bound).length }));
});

type PublicationFixture = { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string };

async function isolatePublicationFixture(selected: PublicationFixture) {
  const admin = new pg.Client({ connectionString: selected.ownerUrl });
  const database = 'publication_browser_' + randomUUID().replaceAll('-', '');
  const owner = new URL(selected.ownerUrl), runtime = new URL(selected.runtimeUrl);
  owner.pathname = runtime.pathname = '/' + database;
  const state = await mkdtemp(join(selected.state, 'publication-'));
  let created = false, host: ChildProcess | undefined;
  async function close() {
    try {
      if (host && host.exitCode === null && host.signalCode === null) {
        const exited = once(host, 'exit');
        host.kill('SIGTERM');
        await exited;
      }
      if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    } finally { await Promise.all([admin.end(), rm(state, { recursive: true, force: true })]); }
  }
  try {
    await admin.connect();
    // Earlier browser journeys create settled orders, and this proof changes demo prices and job controls.
    await admin.query(`CREATE DATABASE ${database} TEMPLATE catalogue_browser_template`);
    created = true;
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as { port: number };
    await new Promise<void>(done => probe.close(() => done()));
    const runtimeUrl = runtime.href;
    const password = decodeURIComponent(runtime.password);
    runtime.password = '';
    host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-', '--configuration', selected.id, '--port', String(port)],
      { env: { PGPASSWORD: password }, stdio: ['pipe', 'ignore', 'ignore'] });
    host.stdin!.end(`
      import { readFileSync } from 'node:fs';
      import { createApplication } from './host/server.ts';
      import { composeNativeBindings } from './host/native-composition.ts';
      import { createOriginPolicy } from './host/origin-policy.ts';
      import { selectConfiguration } from './owned/store.config.ts';
      process.chdir(${JSON.stringify(state)});
      const config = selectConfiguration(${JSON.stringify(selected.id)});
      const password = readFileSync(${JSON.stringify(join(selected.state, 'publication-password'))}, 'utf8').trim();
      const bindings = await composeNativeBindings(${JSON.stringify(runtime.href)}, createOriginPolicy(config, ${port}), config,
        undefined, password);
      const server = createApplication(bindings).listen(${port}, '127.0.0.1');
      process.once('SIGTERM', () => { server.close(() => { void bindings.close(); }); server.closeIdleConnections(); });
    `);
    return { baseURL: `http://127.0.0.1:${port}`, ownerUrl: owner.href, runtimeUrl, state, close };
  } catch (error) { await close(); throw error; }
}

test('authenticated Publish discloses only owned degraded jobs and supports exact repair', async ({ request, baseURL, composeProject }, info) => {
  test.skip(!!composeProject, 'Uses the process-hosted installed price fixture.');
  const entries = JSON.parse(readFileSync('.context/care-browser/fixtures.json', 'utf8')) as PublicationFixture[];
  const selected = entries.find(row => row.baseURL === baseURL && row.id === info.project.name);
  if (!selected) throw new Error('native_operator_proof_fixture_required');
  const fixture = await isolatePublicationFixture(selected);
  const owner = new pg.Pool({ connectionString: fixture.ownerUrl });
  const runtime = new pg.Pool({ connectionString: fixture.runtimeUrl });
  const identities = createPostgresOperatorIdentityStore({ connectionString: fixture.runtimeUrl });
  const config = selectConfiguration(selected.id);
  const ownedJob = `subscription-care:${config.id}`, unownedJob = 'external:fixture';
  const invocation = { triggerKind: 'scheduler' as const, invocationSource: 'operator-proof' };
  const ledger = createPostgresPlatformJobRunLedger(runtime, { releaseCorrelation: () => ({}), defaultFailureReason: 'fixture_failed' });
  const send = (operation: string, data: object, key = randomUUID()) => request.post(fixture.baseURL + '/api/actions/' + operation, {
    data, headers: { Origin: fixture.baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': key },
  });
  const control = async () => (await owner.query(`SELECT last_run_id,last_status,metadata FROM public.platform_job_controls
    WHERE job_name='platform-watchdog'`)).rows[0];
  async function tick(ready: boolean) {
    const previous = (await control())?.last_run_id;
    const close = startCatalogueReadinessJobs(fixture.runtimeUrl, catalogueWatchdogPrincipalId(config));
    try {
      await expect.poll(async () => (await control())?.last_run_id).not.toBe(previous);
      await expect.poll(control).toMatchObject({ last_status: 'success', metadata: { promotionReady: ready } });
    } finally { await close(); }
  }
  try {
    await expect.poll(async () => (await request.get(fixture.baseURL + '/api/config').catch(() => null))?.status()).toBe(200);
    await tick(true);
    const email = 'publication-operator@example.test';
    const actor = (await identities.bootstrapFirstAdministrator({ email })).principalId;
    expect((await (await send('auth.operator', { email })).json()).ok).toBe(true);
    let token: string | undefined;
    await expect.poll(() => {
      try {
        const messages = readFileSync(join(fixture.state, '.context/captured-messages/identity.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        token = messages.find(row => row.email === email)?.token;
      } catch { /* The private mailbox is written after request acceptance. */ }
      return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(token);
    }).toBe(true);
    expect((await (await send('auth.operator', { token })).json()).ok).toBe(true);

    const catalogue = starterCatalogue(), type = catalogue.current!;
    const grams = { dimension: 'mass', unit: 'openlup:g', unscaled: '100', scale: 0 } as const;
    const { release, activation } = buildCatalogReleaseDraftV3({ namespace: 'fixture', type: { key: type.key, version: type.version },
      slug: 'readiness-article', name: 'Readiness article', presentation: { title: 'Readiness article' }, skus: [{
        code: 'READINESS-ARTICLE', title: 'Readiness article', options: {}, netContent: grams,
        grossMass: { ...grams, unscaled: '110' }, logisticsRef: 'fixture:article',
        identifiers: [{ scheme: 'gs1:gtin', issuer: 'fixture', value: catalogInternalGtin(119), packagingLevel: 'unit' }],
        sell: { oneTime: true, subscription: false },
      }] });
    const commands = createPostgresCatalogPublicationCommands({ authorizeHuman: async () => ({ ok: true, userId: actor, role: 'admin', isMachineActor: false }),
      catalogPublicationOwner: { async run(work) {
        const db = await owner.connect();
        try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; }
        finally { db.release(); }
      } }, registry: catalogue.registry });
    const human = (await commands.authorize(null))!;
    const draftId = randomUUID(), productId = release.payload.product.id;
    async function approve(payload: typeof release.payload, revision: number, expectedHead: import('@openlup/platform/catalog').CatalogHeadRef | null) {
      const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: payload.schemaVersion, action: revision === 1 ? 'create' : 'revise',
        draftId, commandKey: randomUUID(), expectedRevision: revision - 1, payload });
      const fingerprint = createHash('sha256').update(canonicalCommand).digest('hex');
      expect((await createPostgresCatalogDraftStoreV4(owner).apply({ canonicalCommand, fingerprint, actorId: actor })).outcome).toBe('committed');
      const candidate = await commands.prepareCandidate({ draftId, draftRevision: revision, expectedHead }, human);
      if (!('candidateRef' in candidate) || !candidate.preparation?.postStateDigest) throw new Error(JSON.stringify(candidate));
      const target = { productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
      expect((await commands.execute({ ...target, action: 'approve', commandKey: randomUUID(),
        postStateDigest: candidate.preparation.postStateDigest }, human)).outcome).toBe('committed');
      return { ...target, action: 'publish' as const, expectedHead, changes: [] };
    }
    const released = await commands.execute({ ...await approve(release.payload, 1, null), commandKey: randomUUID() }, human);
    if (released.outcome !== 'committed' || !('head' in released.receipt)) throw new Error(JSON.stringify(released));
    const variantId = release.payload.skus[0]!.id;
    await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      SELECT id,$1,'one_time',3400,statement_timestamp() FROM public.price_lists WHERE status='active'`, [variantId]);
    const publish = await approve(activation.payload, 2, released.receipt.head);
    const key = randomUUID();
    const wire = async () => {
      const response = await send('operator.catalogPublication', publish, key);
      expect(response.status()).toBe(409);
      const body = await response.json();
      expect(body).toEqual({ ok: false, code: 'publication_price_readiness', reason: body.reason, path: 'pricing.readiness',
        subject: body.reason, message: expect.any(String), issues: [{ code: 'publication_price_readiness', path: 'pricing.readiness',
          subject: body.reason, message: body.message, ...(body.issues[0].failedJobs ? { failedJobs: body.issues[0].failedJobs } : {}) }] });
      return body;
    };
    const legacy = buildDemoSeed(config).prices.find(entry => entry.mode === 'subscription')!;
    await owner.query(`INSERT INTO public.price_entries
      (id,price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,active,valid_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [legacy.id,legacy.price_list_id,legacy.variant_id,legacy.mode,
      legacy.min_qty,legacy.unit_price_minor,legacy.amount_kind,legacy.active,legacy.valid_from]);
    expect(await wire()).toMatchObject({ reason: 'catalog_1490_legacy_1340_invalid',
      message: expect.stringContaining('Restore one effective list and verify each eligible SKU’s base and subscription branch with the pricing owner.') });
    const repair = await owner.query(`UPDATE public.price_entries
      SET active=false,valid_to=statement_timestamp(),updated_at=statement_timestamp() WHERE id=$1 AND active`, [legacy.id]);
    expect(repair.rowCount).toBe(1);
    expect((await owner.query('SELECT public.commerce_offer_policy_v2_readiness() AS verdict')).rows[0].verdict)
      .toMatchObject({ reasons: [], evidence: { priceMismatchCount: 0 } });
    for (const name of [ownedJob, unownedJob]) {
      const run = await ledger.claimJobRun(name, invocation, 300);
      expect(run.acquired).toBe(true);
      expect(await ledger.finishJobRun(name, run.runId!, invocation, 'failed',
        { checked: 0, updated: 0, failures: 1, skipped: false })).toBe(true);
    }
    await tick(false);
    expect(await wire()).toMatchObject({ reason: 'promotion_watchdog_not_ready', issues: [{ failedJobs: [ownedJob] }] });
    const watchdogRun = (await control()).last_run_id;
    await owner.query("UPDATE public.platform_job_controls SET last_success_at=statement_timestamp()-interval '7 hours' WHERE job_name='platform-watchdog'");
    const withoutEvidence = await wire();
    expect(withoutEvidence.issues[0]).not.toHaveProperty('failedJobs');
    await owner.query(`UPDATE public.platform_job_controls SET last_success_at=(SELECT finished_at FROM public.platform_job_runs WHERE id=$1)
      WHERE job_name='platform-watchdog'`, [watchdogRun]);
    const blocker = await owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE public.platform_job_runs IN ACCESS EXCLUSIVE MODE');
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      const blockedReads = async () => (await owner.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
          AND query LIKE 'SELECT r.metadata%'`, [pid])).rowCount;
      const started = performance.now();
      const [same] = await Promise.all([wire(), expect.poll(blockedReads, { intervals: [25], timeout: 1000 }).toBe(1)]);
      expect(Math.round(performance.now() - started)).toBeGreaterThanOrEqual(450);
      expect(Math.round(performance.now() - started)).toBeLessThan(1200);
      expect(same).toEqual(withoutEvidence);
      // Keep the lock held until PostgreSQL has stopped the optional query.
      await expect.poll(blockedReads, { timeout: 1200 }).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const core = findPackageJSON('@openlup/core/catalog', import.meta.url)!;
    const guide = readFileSync(join(dirname(core), 'docs/guide/how-to/build/customize-the-starter.md'), 'utf8');
    expect(guide).toContain('./lifecycle care --configuration <id> --database-url <runtime-url>');
    // The CLI pins the demo database name. Run the same care handler against the isolated clone.
    expect(await runScheduledCare(fixture.runtimeUrl, config, { publicOrigin: fixture.baseURL,
      capture: createPrivateCapture(join(fixture.state, '.context/captured-messages')) })).toHaveProperty('messages');
    await owner.query('UPDATE public.platform_job_controls SET enabled=false WHERE job_name=$1', [unownedJob]);
    await tick(true);
    const committed = await (await send('operator.catalogPublication', publish, key)).json();
    expect(committed).toMatchObject({ ok: true, value: { outcome: 'committed' } });
    expect(await (await send('operator.catalogPublication', publish, key)).json()).toMatchObject({ ok: true, replayed: true });
  } finally {
    try { await Promise.all([owner.end(), runtime.end(), identities.close()]); }
    finally { await fixture.close(); }
  }
});

test('installed adopter pack refuses missing builds and resumes exact-pair authoring', async ({ page, baseURL, composeProject }) => {
  test.setTimeout(180_000);
  test.skip(!/^st1-pr2-recipe-[a-z0-9-]+$/u.test(composeProject), 'Requires the installed adopter-pack fixture.');
  if (!baseURL) throw new Error('starter_pack_recipe_fixture_required');
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '--project-name', composeProject, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const sql = (statement: string) => compose('exec', '-T', 'database', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'starter_install', '-d', 'neutral_store', '-c', statement);
  const email = 'pack-operator@example.test', actionPath = '/api/actions/operator.catalogDrafts';
  if (sql("SELECT count(*) FROM public.platform_human_principals WHERE email='pack-operator@example.test'").trim() === '0')
    compose('exec', '-T', 'application', 'node', '--input-type=module', '-e', `
    import { runtimeConnectionString } from './host/runtime-database.ts';

    import { createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
    const operators = createPostgresOperatorIdentityStore({connectionString:runtimeConnectionString()});
    try { await operators.bootstrapFirstAdministrator({email:${JSON.stringify(email)}}); } finally { await operators.close(); }
  `);
  async function login() {
    const auth = (data: object) => page.request.post(baseURL + '/api/actions/auth.operator', { data,
      headers: { Origin: baseURL!, 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID() } });
    let token = '';
    // Age only consumed challenges belonging to this disposable fixture identity between restarts.
    sql(`UPDATE public.operator_identity_challenges SET created_at=created_at-interval '2 hours',
      expires_at=expires_at-interval '2 hours', used_at=used_at-interval '2 hours'
      WHERE used_at IS NOT NULL AND created_at > now()-interval '1 hour'
        AND principal_id=(SELECT principal_id FROM public.platform_human_principals WHERE email='pack-operator@example.test')`);
    const previous = new Set<string>();
    function mail(): {email: string; token: string}[] {
      try { return compose('exec', '-T', 'application', 'cat', '/application/.context/captured-messages/identity.jsonl')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; }
    }
    for (const message of mail()) previous.add(message.token);
    expect((await (await auth({ email })).json()).ok).toBe(true);
    await expect.poll(() => {
      token = mail().find(message => message.email === email && !previous.has(message.token))?.token ?? '';
      return /^[A-Za-z0-9_-]{43}$/u.test(token);
    }).toBe(true);
    expect((await (await auth({ token })).json()).ok).toBe(true);
  }
  const template = compose('exec', '-T', 'application', 'node', '--input-type=module', '-e',
    "import { fixtures } from './owned/catalogue/fixtures.ts'; console.log(JSON.stringify(fixtures.drafts[0]));");
  const pair = JSON.parse(template).product.type;
  expect(pair).toMatchObject({ key: 'stationery:notebook', version: 1 });
  function draft() {
    const { product, skus } = JSON.parse(template);
    return JSON.parse(template.replaceAll(product.id, randomUUID()).replaceAll(skus[0].id, randomUUID())
      .replaceAll(skus[0].code, `NOTEBOOK-${randomUUID()}`));
  }
  await login();
  await page.goto(routes.admin[market.defaultLocale]);
  const panel = page.locator('#catalogue-drafts');
  const saveForm = panel.locator('form').filter({ has: page.locator('[name=payload]') });
  const prepareForm = panel.locator('form').filter({ has: page.getByRole('button', { name: /Prepare saved draft|Przygotuj zapisany szkic/u }) });
  async function save(id: string, payload: object) {
    await saveForm.locator('[name=draftId]').fill(id);
    await saveForm.locator('[name=payload]').fill(JSON.stringify(payload));
    const response = page.waitForResponse(r => r.url().endsWith(actionPath));
    await saveForm.getByRole('button', { name: copy[market.defaultLocale].save, exact: true }).click();
    return (await response).json();
  }
  async function prepare(id: string) {
    await prepareForm.locator('[name=draftId]').fill(id);
    const response = page.waitForResponse(r => r.url().endsWith(actionPath));
    await prepareForm.locator('button[type=submit]').click();
    return (await response).json();
  }
  const invalid = draft();
  invalid.product.sharedContent.presentation.title = '';
  expect(await save(randomUUID(), invalid)).toMatchObject({ code: 'catalog_draft_payload_invalid',
    issues: [{ code: 'title_required' }] });
  const savedId = randomUUID(), savedPayload = draft();
  const posted = page.waitForRequest(r => r.url().endsWith(actionPath));
  const saved = await save(savedId, savedPayload);
  expect(saved, saved.code).toMatchObject({ ok: true, value: { record: { payload: { product: { type: pair } } } } });
  const originalKey = (await posted).headers()['idempotency-key']!;
  const missingId = randomUUID(), missingPayload = draft();
  const target = `/application/.context/catalogue-builds/packs/stationery@${pair.version}.json`;
  const buildDigest = () => compose('exec', '-T', 'application', 'node', '-e',
    'const fs=require("node:fs"), crypto=require("node:crypto"); console.log(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', target).trim();
  const ledgerReceipt = () => sql(`SELECT receipt::text FROM public.catalog_definition_installs
    WHERE pack_id='stationery' AND pack_version=${pair.version}`).trim();
  const beforeBuild = buildDigest(), beforeReceipt = ledgerReceipt();
  expect(beforeBuild).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.parse(beforeReceipt)).toMatchObject({ packId: 'stationery', packVersion: pair.version });
  compose('run', '--rm', '--no-deps', '-T', 'installation', 'node', '-e', 'require("node:fs").unlinkSync(process.argv[1])', target);
  compose('restart', 'application');
  await expect.poll(async () => (await page.request.get(baseURL + '/api/config').catch(() => null))?.status()).toBe(200);
  await login();
  const missing = { ok: false, code: 'starter_catalogue_build_missing', path: '/packs/1/pack',
    observed: 'No verified pack build is available for stationery:notebook@1.',
    cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String) };
  expect(await save(missingId, missingPayload)).toMatchObject(missing);
  await expect(saveForm.locator('.action-result')).toContainText(missing.code);
  expect(await prepare(savedId)).toMatchObject(missing);
  await expect(prepareForm.locator('.action-result')).toContainText(missing.code);
  await page.route('**' + actionPath, route => route.continue({ headers: { ...route.request().headers(), 'idempotency-key': originalKey } }), { times: 1 });
  expect(await save(savedId, savedPayload)).toMatchObject({ ok: true, replayed: true });

  const report = JSON.parse(execFileSync('./lifecycle', ['up', '--configuration', 'coffee', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, COMPOSE_PROJECT_NAME: composeProject } }));
  expect(report.packs).toContainEqual({ id: 'stationery', version: 1, outcome: 'unchanged', types: [pair], taxClasses: ['standard'] });
  expect(buildDigest()).toBe(beforeBuild);
  expect(ledgerReceipt()).toBe(beforeReceipt);
  await login();
  expect(await prepare(savedId)).toMatchObject({ ok: true });
  expect(await save(missingId, missingPayload)).toMatchObject({ ok: true, value: { record: { payload: { product: { type: pair } } } } });
  const original = sql("SELECT pg_get_functiondef('public.catalog_draft_get(uuid,integer,text)'::regprocedure)");
  // Supply a valid receipt for another command so the draft handler detects an unavailable dependency.
  sql(`CREATE OR REPLACE FUNCTION public.catalog_draft_get(p_draft_id uuid, p_revision integer DEFAULT NULL,
    p_command_key text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS
    $$ SELECT public.catalog_draft_record('${savedId}'::uuid, 1) $$`);
  try { expect(await save(randomUUID(), draft())).toMatchObject({ ok: false, code: 'catalog_draft_dependency_unavailable' }); }
  finally { sql(original); }
});
