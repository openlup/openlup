import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type * as Invoices from '@openlup/platform/invoicing';
import type * as Identity from '@openlup/platform/identity';
import type * as Native from '@openlup/platform/invoicing/postgres';
import type * as Fulfillment from '@openlup/platform/fulfillment';
import type { composeE4Capabilities } from '../../examples/neutral-store/host/e4-composition.ts';
import type * as Migrations from '@openlup/platform/migrations';
import type { InvoiceFacts, InvoiceHostPorts } from '@openlup/platform/invoicing/contracts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { operationLimits } from '../../examples/neutral-store/shared/limits.ts';
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

let container: PostgresContainer | undefined;
let bootstrap: Pool, installer: Pool, runtime: Pool;
let invoices: typeof Invoices, native: typeof Native, fulfillment: typeof Fulfillment;
let composeReads: typeof composeE4Capabilities;
let browserShipmentRef: string;
let scratch: string, app: string, runtimeUrl: string, runtimeConnection: string;
const children: ChildProcess[] = [];
const hosts: Array<{ id: string; baseURL: string }> = [];
const customerEmail = 'document-customer@example.test', operatorEmail = 'document-operator@example.test';
let operatorId: string, principalId: string;
let customerCookie = '', operatorCookie = '';
const providerRef = configurations.supplements!.documents.sandbox.providerRef;
const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres',
  migrationLogin: 'starter_install', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
const seller = { name: 'Synthetic seller', address: { line1: '1 Example Street', postalCode: '12345', city: 'Example' },
  taxIdentifier: { scheme: 'synthetic', value: 'seller' }, bankAccount: null, routingRef: null };
const proof = { evidenceRef: 'synthetic-money', fingerprint: 'a'.repeat(64), observedAt: '2026-11-01T12:00:00Z' };
const command = (file: string, args: string[], cwd = app) => execFileSync(file, args,
  { cwd, encoding: 'utf8', timeout: 180000, env: { ...processEnvironment, NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });

async function start(id: string) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('starter_port_required');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'host/server.ts', '--configuration', id,
    '--port', String(port), '--database-url', runtimeUrl], { cwd: app, env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let errorText = '';
  child.stderr!.on('data', chunk => { errorText += String(chunk); });
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('starter_host_start_failed ' + errorText.slice(-800)); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('starter_host_start_timeout')), 15000); timer.unref(); }),
  ]);
  return { id, baseURL: `http://127.0.0.1:${port}` };
}

async function action(operation: string, data: Record<string, unknown> = {}, cookie = operatorCookie,
  key: string = randomUUID(), baseURL = hosts[0]!.baseURL) {
  const response = await fetch(`${baseURL}/api/actions/${operation}`, { method: 'POST',
    headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Content-Type': 'application/json',
      'Idempotency-Key': key, Cookie: cookie }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000) });
  return { response, body: await response.json() };
}
async function login(operator: boolean, email: string) {
  const mailbox = join(app, '.context/captured-messages/identity.jsonl');
  const messages = () => existsSync(mailbox) ? readFileSync(mailbox, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const priorCount = messages().length;
  const operation = operator ? 'auth.operator' : 'auth.request';
  expect((await action(operation, { email }, '')).body.ok).toBe(true);
  let token = '';
  await vi.waitFor(() => {
    token = messages().slice(priorCount).filter(message => message.email === email).at(-1)?.token ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, { timeout: 5000, interval: 50 });
  const result = await action(operator ? 'auth.operator' : 'auth.verify', { token }, '');
  expect(result.body.ok).toBe(true);
  return result.response.headers.get('set-cookie')!.split(';')[0]!;
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Starter order/document proof requires real PostgreSQL');
  mkdirSync('.context/scratch', { recursive: true });
  scratch = mkdtempSync(resolve('.context/scratch/starter-order-documents-'));
  app = join(scratch, 'app');
  command(process.execPath, ['examples/neutral-store/extract.mjs', app], process.cwd());
  const packs = join(scratch, 'packs'); mkdirSync(packs);
  for (const name of ['core', 'outbox', 'platform']) {
    const [info] = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packs], resolve('packages', name)));
    writeFileSync(join(app, 'artifacts', `openlup-${name}.tgz`), readFileSync(join(packs, info.filename)));
  }
  command('npm', ['install', '--prefer-offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--fund=false']);
  command('npm', ['test']);
  command('npm', ['run', 'typecheck']);
  command('npm', ['run', 'build']);
  const require = createRequire(join(app, 'package.json'));
  async function installed<T>(entry: string): Promise<T> {
    const path = require.resolve(entry);
    expect(realpathSync(path).startsWith(join(app, 'node_modules/@openlup/'))).toBe(true);
    return import(/* @vite-ignore */ pathToFileURL(path).href) as Promise<T>;
  }
  fulfillment = await installed<typeof Fulfillment>('@openlup/platform/fulfillment');
  composeReads = (await import(/* @vite-ignore */ pathToFileURL(join(app, 'host/e4-composition.ts')).href)).composeE4Capabilities;
  invoices = await installed<typeof Invoices>('@openlup/platform/invoicing');
  native = await installed<typeof Native>('@openlup/platform/invoicing/postgres');
  const identity = await installed<typeof Identity>('@openlup/platform/identity');
  const migrations = await installed<typeof Migrations>('@openlup/platform/migrations');
  container = await runPostgresContainer({ name: `starter-order-documents-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance' });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Starter PostgreSQL unavailable');
  bootstrap = new Pool({ connectionString: container.connectionString });
  await bootstrap.query(`CREATE ROLE starter_install LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance';
    ALTER DATABASE neutral_store OWNER TO starter_install;
    CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance';
    CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  const installUrl = new URL(container.connectionString); installUrl.username = 'starter_install';
  installer = new Pool({ connectionString: installUrl.toString(), options: migrations.qualifiedPostgresStartupOptions(selection) });
  const runner = migrations.createPlatformPostgresMigrationRunner({ connectionString: installUrl.toString() },
    { installation: selection, poolFactory: () => installer });
  await runner.apply();
  expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString); url.username = 'starter_runtime';
  runtimeConnection = url.toString();
  url.password = ''; url.protocol = 'postgresql:'; runtimeUrl = url.toString();
  runtime = new Pool({ connectionString: runtimeConnection });
  expect((await runtime.query('SELECT session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
    .toEqual([{ session_user: 'starter_runtime', rolsuper: false, rolbypassrls: false }]);
  const seed = await import(/* @vite-ignore */ pathToFileURL(join(app, 'installation/install.ts')).href);
  await installer.query("COMMENT ON DATABASE neutral_store IS 'openlup-neutral-store-demo-v1'");
  // Purchases use one configuration; both hosts exercise the same owned reads.
  await seed.applyDemoSeed(configurations.supplements!,
    { connection: installer, installRole: 'starter_install', runtimeRole: 'starter_runtime' });
  const operators = identity.createPostgresOperatorIdentityStore({ connectionString: runtimeConnection });
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeConnection });
  try {
    operatorId = (await operators.bootstrapFirstAdministrator({ email: operatorEmail })).principalId;
    principalId = randomUUID();
    await accounts.createAccount({ principalId, email: customerEmail, acquisitionSource: 'direct', lifecycleStage: 'customer' });
    await accounts.createAccount({ principalId: randomUUID(), email: 'foreign-document@example.test', acquisitionSource: 'direct', lifecycleStage: 'customer' });
  } finally { await Promise.all([operators.close(), accounts.close()]); }
  // Owner-controlled setup is deliberately separate from request-time authority.
  await installer.query('INSERT INTO public.commerce_operators(id,label) VALUES($1,$2)', [operatorId, 'Synthetic operator']);
  hosts.push(await start('supplements'), await start('coffee'));
  customerCookie = await login(false, customerEmail);
  operatorCookie = await login(true, operatorEmail);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  await closePostgres(container, [bootstrap, installer, runtime]);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, postgresTeardownTimeoutMs);

async function purchase(paid: boolean, cookie = customerCookie) {
  const config = configurations.supplements!;
  const cart = { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
    lines: [{ sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits }] };
  const created = await action('checkout.create', { cart, email: `guest-${randomUUID()}@example.test`,
    configuration: config.id, country: config.market.country, termsAccepted: true, termsRevision: config.legal.revision,
    locale: 'en', firstName: 'Example', lastName: 'Customer', phone: '123456789', line1: '1 Example Street', city: 'Example', postalCode: '12345' }, cookie);
  if (!created.body.ok) throw new Error('starter_fixture_checkout_' + created.body.code);
  const orderRef = created.body.value.orderRef as string;
  if (paid) {
    const result = await action('payment.simulate', { orderRef, token: created.body.value.token, outcome: 'captured' }, cookie);
    if (!result.body.ok) throw new Error('starter_fixture_payment_' + result.body.code);
  }
  return orderRef;
}

async function invoiceFixture(mode: 'pending' | 'issued' | 'corrected' | 'retry' | 'guest') {
  const orderId = await purchase(true, mode === 'guest' ? '' : customerCookie);
  const order = (await runtime.query('SELECT total_amount_minor,currency_code FROM public.commerce_orders WHERE id=$1', [orderId])).rows[0]!;
  const intent = (await runtime.query('SELECT id FROM public.commerce_settlement_intents WHERE order_id=$1', [orderId])).rows[0]!.id;
  const total = Number(order.total_amount_minor), currency = order.currency_code;
  const store = invoices.createPostgresInvoiceStore(runtime, { seller: { read: async () => ({ kind: 'found', seller, revisionRef: 'seller-v1' }) } });
  const duty = await store.captureDuty({ requestKey: `invoice:${orderId}`, sourceKind: 'paid', sourceId: randomUUID(), orderId,
    occurredAt: proof.observedAt, evidence: { settlementIntentId: intent, amountMinor: total, currency } });
  if ('kind' in duty) throw new Error('starter_fixture_invoice_duty');
  const items = (await runtime.query('SELECT quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal', [orderId])).rows;
  const facts: InvoiceFacts = { factRevision: `facts:${orderId}`, policyVersion: 'sandbox-v1',
    refs: { orderId, orderRef: `ORDER/${orderId}`, invoiceRef: `INVOICE/${orderId}` },
    dates: { issueDate: '2026-11-01', sellDate: '2026-11-01', handedOverAt: null, paymentCompletedAt: proof.observedAt },
    documentKind: 'sandbox-document', clearanceRequired: false, currency,
    buyer: { name: 'Example Customer', email: null, taxIdentifier: null, companyName: null, address: null },
    payment: { intentRef: intent, providerRef: 'sandbox-money', providerPaymentRef: null, amountMinor: total, currency, localSettlementState: 'matched' },
    orderMoney: null, lines: items.map(item => ({ description: 'Synthetic item', quantity: item.quantity,
      unitNetMinor: Number(item.unit_amount_minor), unitGrossMinor: Number(item.unit_amount_minor),
      totalNetMinor: Number(item.line_amount_minor), totalTaxMinor: 0, totalGrossMinor: Number(item.line_amount_minor), taxRateBps: 0,
      positionKind: 'item', catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null, shippingDiscountMinor: null })),
    totalNetMinor: total, totalTaxMinor: 0, totalGrossMinor: total, chargedTotalGrossMinor: total };
  await store.installFacts({ dutyId: duty.dutyId, facts });
  const sweep = await store.sweep(100);
  if ('kind' in sweep) throw new Error('starter_fixture_sweep');
  const lease = sweep.claims.find(row => row.dutyId === duty.dutyId)!;
  const prepared = await store.prepareFacts(lease);
  if ('kind' in prepared || prepared.status !== 'ready') throw new Error('starter_fixture_prepare');
  await store.finishFacts({ ...lease, result: { ...prepared, status: 'ready' } });
  const captured = native.createCapturedPostgresInvoiceProvider(runtime, { enabled: true, providerRef });
  const money: InvoiceHostPorts['money'] = { read: async () => ({ kind: 'observed', status: 'succeeded', amountMinor: total, currency, proof }) };
  const issue = () => invoices.runNativeInvoiceIssueJob({ store, provider: captured.provider, money,
    readLocalPayment: () => money.read({ intentRef: intent, providerRef: 'sandbox-money', providerPaymentRef: null,
      expectedMoney: { amountMinor: total, currency } }), providerRef, orderId });
  if (mode === 'retry') {
    const batch = await store.claim({ providerRef, orderId, limit: 1, visibilitySeconds: 300 });
    if ('kind' in batch || !batch[0]) throw new Error('starter_fixture_claim');
    await store.fail({ claim: batch[0], retrySeconds: 123, kind: 'retryable', phase: 'before_send', proof: null });
  } else if (mode !== 'pending') {
    expect(await issue()).toMatchObject({ failures: 0 });
    expect(await issue()).toMatchObject({ updated: 0 });
    if (mode === 'corrected') {
      await store.requestReversal({ requestKey: `reverse:${orderId}`, orderId, reason: 'order_refunded', proof });
      expect(await issue()).toMatchObject({ failures: 0 });
    }
  }
  return { orderId, total, dutyId: duty.dutyId };
}

async function snapshot() {
  const tables = (await installer.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND
    (tablename LIKE 'commerce_%' OR tablename LIKE 'payment_%' OR tablename LIKE 'fulfillment_%'
    OR tablename LIKE 'inventory_%' OR tablename LIKE 'subscription%' OR tablename LIKE 'invoicing_%'
    OR tablename LIKE 'accounting_%' OR tablename LIKE '%outbox%') ORDER BY tablename`)).rows;
  const result: Record<string, string> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('starter_snapshot_table_invalid');
    result[tablename] = (await installer.query(`SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb)::text AS value FROM
      (SELECT to_jsonb(t) AS row FROM public."${tablename}" t) x`)).rows[0]!.value;
  }
  return result;
}

// These are case deadlines, not expected runtimes. The installed snapshot matrix
// is measured separately from the existing extraction/container setup.
const shipmentReadTimeoutMs = 60000;
for (const zone of ['default', 'Etc/GMT-9', 'Etc/GMT+5']) it(`reads shipment snapshots without writes in ${zone}`, async () => {
  const orderId = await purchase(true);
  await installer.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('starter-read-port','3pl',true) ON CONFLICT DO NOTHING");
  const shipment = await fulfillment.createPostgresFulfillmentShipmentSpinePort(runtime, { portKey: 'starter-read-port' })
    .createShipment({ idempotencyKey: `read-${orderId}`, orderId, requestedAt: '2026-11-04T12:00:00Z' });
  const shipmentId = shipment.shipmentId;
  const original = (await runtime.query('SELECT public.commerce_view_shipment_destination($1::uuid) AS value', [shipmentId])).rows[0].value;
  // Owner-only fixture facts model an already pinned parcel and a newer order
  // destination. The read under test cannot create or alter either binding.
  const clone = async (line1: string) => (await installer.query(`INSERT INTO public.commerce_destinations(client_id,address,created_at)
    SELECT client_id,jsonb_set(address,'{line1}',to_jsonb($2::text)),'2026-11-04T12:00:00Z'
    FROM public.commerce_destinations WHERE id=$1 RETURNING id`, [original.destinationId, line1])).rows[0].id;
  const pinned = await clone('Pinned example street'), current = await clone('Current example street');
  const beforeUnpinned = await snapshot();
  expect((await action('operator.shipment', { shipmentRef: shipmentId.toUpperCase() })).body)
    .toMatchObject({ ok: true, value: { order: { id: shipmentId, orderId } } });
  expect((await action('operator.shipments')).body.ok).toBe(true);
  expect(await snapshot()).toEqual(beforeUnpinned);
  await installer.query("INSERT INTO public.commerce_destination_bindings(shipment_id,destination_id,updated_at) VALUES($1,$2,'2026-11-04T12:00:00Z')", [shipmentId, pinned]);
  await installer.query("UPDATE public.commerce_destination_bindings SET destination_id=$2,updated_at='2026-11-04T12:00:00Z' WHERE order_id=$1", [orderId, current]);
  const before = await snapshot();
  for (const selector of [{ shipmentRef: shipmentId.toUpperCase() }, { orderRef: orderId.toUpperCase() },
    { orderRef: orderId.slice(0, 18).toUpperCase() + orderId.slice(18) },
    { shipmentRef: shipmentId.slice(0, 18).toUpperCase() + shipmentId.slice(18), orderRef: randomUUID() }]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await action('operator.shipment', selector);
      expect(result.body).toMatchObject({ ok: true, value: { order: { id: shipmentId, orderId, clientId: null,
        providerKind: null, shippingAddress: { addressId: null, line1: 'Pinned example street' } } } });
    }
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await action('operator.shipments', { status: 'created', page: 1, pageSize: 100 });
    expect(result.body.ok).toBe(true);
    expect(result.body.value.orders.find((order: { id: string }) => order.id === shipmentId)).toMatchObject({
      shippingAddress: { line1: 'Pinned example street' }, inventory: { locationId: null, locationCode: null },
      lines: [expect.objectContaining({ id: null, inventoryReservationIds: [] })] });
  }
  expect((await runtime.query("SELECT public.commerce_read_destination('order',$1::uuid) AS value", [orderId])).rows[0].value)
    .toMatchObject({ destinationId: current, address: { line1: 'Current example street' } });
  expect((await action('operator.shipment', { shipmentRef: randomUUID() })).body.code).toBe('starter_shipment_not_found');
  expect((await action('operator.shipment', { shipmentRef: orderId })).body.code).toBe('starter_shipment_not_found');
  expect((await action('operator.shipment', { shipmentRef: shipmentId }, customerCookie)).body.code).toBe('operator_required');
  expect(await snapshot()).toEqual(before);
  const zonePool = new Pool({ connectionString: runtimeConnection,
    ...(zone === 'default' ? {} : { options: `-c timezone=${zone}` }) });
  let queries = 0, snapshots = 0;
  const observedPool = { async connect() {
    const db = await zonePool.connect();
    return { async query(sql: string, values?: unknown[]) {
      queries++;
      if (sql.startsWith('SELECT') || sql.startsWith('WITH')) {
        const state = (await db.query(`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly,current_setting('TimeZone') AS zone`)).rows[0];
        expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on', zone: zone === 'default' ? 'Etc/UTC' : zone });
        snapshots++;
      }
      return db.query(sql, values);
    }, release: () => db.release() };
  } } as unknown as Pool;
  const context = { actor: { customerRef: null, operatorRef: operatorId, principalRef: operatorId },
    commandKey: randomUUID(), config: configurations.supplements! };
  try {
    const actions = composeReads(observedPool, async () => true);
    expect(await actions['operator.shipment']!({ shipmentRef: shipmentId.toUpperCase() }, context)).toMatchObject({ ok: true });
    expect(await actions['operator.shipments']!({}, context)).toMatchObject({ ok: true });
    const successfulQueries = queries;
    const refused = composeReads(observedPool, async () => false);
    for (const operation of ['operator.shipments', 'operator.shipment'] as const) {
      expect(await refused[operation]!({ shipmentRef: shipmentId, operatorRef: operatorId }, context)).toEqual({ ok: false, code: 'operator_required' });
    }
    expect(await actions['operator.shipment']!({ documentRef: shipmentId }, context)).toEqual({ ok: false, code: 'starter_input_invalid' });
    expect(await actions['operator.shipment']!({ shipmentRef: shipmentId, principalRef: randomUUID() }, context))
      .toEqual({ ok: false, code: 'starter_input_invalid' });
    expect(await actions['operator.shipments']!({ orderRef: orderId }, context))
      .toEqual({ ok: false, code: 'starter_input_invalid' });
    expect(queries).toBe(successfulQueries);
    expect(snapshots).toBeGreaterThan(3);
    expect(await snapshot()).toEqual(before);
  } finally { await zonePool.end(); }
  browserShipmentRef = shipmentId;
}, shipmentReadTimeoutMs);

it('reads pending, issued, corrected, retry and guest summaries and owned PDF bytes with no read effects', async () => {
  let issued: Awaited<ReturnType<typeof invoiceFixture>> | undefined;
  for (const mode of ['pending', 'issued', 'corrected', 'retry', 'guest'] as const) {
    const fixture = await invoiceFixture(mode);
    const before = await snapshot();
    const result = await action('operator.invoice', { orderRef: fixture.orderId.toUpperCase(), accountRef: operatorId });
    if (!result.body.ok) throw new Error('starter_operator_invoice_' + result.body.code);
    const summary = result.body.value;
    expect(summary.orderId).toBe(fixture.orderId.toUpperCase());
    expect(summary.documents.length).toBe(mode === 'corrected' ? 2 : 1);
    expect(summary.customerPrincipalRef).toBe(mode === 'guest' ? null : principalId);
    expect(summary.status).toBe(mode === 'pending' ? 'issue_requested' : mode === 'retry' ? 'outbox_failed' : mode === 'corrected' ? 'issued' : 'issued');
    if (mode === 'corrected') expect(summary.documents.map((document: { totalGrossMinor: number }) => document.totalGrossMinor)).toEqual([fixture.total, -fixture.total]);
    if (mode === 'retry') expect(summary.duties.duties[0]).toMatchObject({ attempts: 1, diagnosticCode: 'retryable' });
    if (mode === 'corrected') {
      const history = await action('account.invoice', { orderRef: fixture.orderId.toUpperCase() }, customerCookie);
      expect(history.body.ok).toBe(true);
      expect(history.body.value.documents.map((document: { role: string }) => document.role)).toEqual(['original', 'correction']);
      for (const document of history.body.value.documents) {
        const download = await action('account.invoice', { orderRef: fixture.orderId.toUpperCase(),
          documentRef: document.documentRef.toUpperCase() }, customerCookie);
        expect(download.body.ok).toBe(true);
      }
    }
    expect(await snapshot()).toEqual(before);
    if (mode === 'issued') issued = fixture;
  }
  if (!issued) throw new Error('starter_issued_fixture_missing');
  const history = await action('account.invoice', { orderRef: issued.orderId.toUpperCase(), accountRef: operatorId }, customerCookie);
  expect(history.body.ok).toBe(true);
  const documentRef = history.body.value.documents[0].documentRef;
  const pdf = await action('account.invoice', { orderRef: issued.orderId.toUpperCase(), documentRef: documentRef.toUpperCase(),
    accountRef: operatorId, receipt: 'forged' }, customerCookie);
  expect(pdf.body.ok).toBe(true);
  expect(pdf.response.headers.get('cache-control')).toBe('no-store');
  expect(pdf.body.value.contentType).toBe('application/pdf');
  expect(Buffer.from(pdf.body.value.base64, 'base64').toString().includes('NON-FISCAL TEST DOCUMENT')).toBe(true);
  expect(pdf.body.value.fileName.endsWith('.pdf')).toBe(true);
  const foreignCookie = await login(false, 'foreign-document@example.test');
  expect((await action('account.invoice', { orderRef: issued.orderId, documentRef }, foreignCookie)).body.code).toBe('starter_invoice_denied');
  expect((await action('account.invoice', { orderRef: issued.orderId, documentRef: randomUUID() }, customerCookie)).body.code).toBe('starter_invoice_denied');
  expect((await action('operator.invoice', { orderRef: randomUUID() })).body.code).toBe('starter_invoice_missing');
  const orderItemId = (await runtime.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1 LIMIT 1', [issued.orderId])).rows[0]!.id;
  writeFileSync(join(scratch, 'browser-fixture.json'), JSON.stringify({ mailbox: join(app, '.context/captured-messages/identity.jsonl'),
    customerEmail, operatorEmail, orderRef: issued.orderId, documentRef, orderItemId, shipmentRef: browserShipmentRef }));
}, 120000);

// Measured separately from installation and browser challenge-window waits.
const adminReadRefusalTimeoutMs = 60000;
it('admits an active distributor session but refuses admin-only OMS, shipment and invoice reads before I/O', async () => {
  expect((await runtime.query('SHOW TimeZone')).rows[0].TimeZone).toBe('Etc/UTC');
  const distributorId = randomUUID(), email = 'document-distributor@example.test';
  // Same owner-seeded active legacy membership as the identity upgrade witness;
  // challenge issuance/redemption and request-time admission remain native.
  await installer.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [distributorId, email]);
  await installer.query(`INSERT INTO public.platform_human_memberships
    (principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'distributor','active','legacy',now())`, [distributorId]);
  const cookie = await login(true, email);
  const { orderId } = await invoiceFixture('issued');
  await installer.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('starter-read-port','3pl',true) ON CONFLICT DO NOTHING");
  const { shipmentId } = await fulfillment.createPostgresFulfillmentShipmentSpinePort(runtime, { portKey: 'starter-read-port' })
    .createShipment({ idempotencyKey: `distributor-read-${orderId}`, orderId, requestedAt: '2026-11-04T12:00:00Z' });
  expect((await installer.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1', [shipmentId])).rows)
    .toEqual([{ id: shipmentId }]);
  expect((await installer.query('SELECT id FROM public.accounting_documents WHERE order_id=$1', [orderId])).rows)
    .toHaveLength(1);
  const before = await snapshot();
  const fence = await installer.connect();
  try {
    await fence.query('BEGIN');
    // These are the first read tables of the real OMS/shipment/invoice ports. An
    // accidentally admitted read cannot complete while these fences are held.
    await fence.query('LOCK TABLE public.fulfillment_shipments, public.commerce_orders, public.accounting_documents IN ACCESS EXCLUSIVE MODE');
    for (const [operation, payload] of [
      ['operator.orders', {}],
      ['operator.order', { orderRef: orderId }],
      ['operator.shipments', {}],
      ['operator.shipment', { shipmentRef: shipmentId }],
      ['operator.invoice', { orderRef: orderId }],
    ] as const) {
      expect((await action(operation, payload, cookie)).body).toEqual({ ok: false, code: 'operator_required' });
      expect((await fence.query(`SELECT count(*)::int AS blocked FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.usename='starter_runtime'
        AND a.datname=current_database() AND NOT l.granted AND l.relation=ANY($1::regclass[])`,
      [['public.fulfillment_shipments', 'public.commerce_orders', 'public.accounting_documents']])).rows)
        .toEqual([{ blocked: 0 }]);
    }
  } finally {
    try { await fence.query('ROLLBACK'); } finally { fence.release(); }
  }
  expect(await snapshot()).toEqual(before);
}, adminReadRefusalTimeoutMs);

it('all six operation limits preserve the complete effect snapshot over replay and forgery', async () => {
  const orderRef = await purchase(false);
  const paid = await purchase(true);
  const before = await snapshot();
  for (const [operation, limit] of Object.entries(operationLimits)) {
    const cookie = operation.startsWith('operator.') || operation === 'ingest.submit' ? operatorCookie : customerCookie;
    const key = randomUUID();
    for (const [commandKey, forgedRef] of [[key, orderRef], [key, orderRef], [randomUUID(), paid], [randomUUID(), randomUUID()]]) {
      const result = await action(operation, { orderRef: forgedRef, shipmentRef: forgedRef, returnRef: forgedRef, holdRef: forgedRef, reason: 'manual_support',
        actorUserId: operatorId, principalRef: principalId, receipt: { ok: true }, proofGrade: 'delivered' }, cookie, commandKey);
      expect(result.body.code).toBe(limit.code);
    }
  }
  const removed = await action('operator.returns');
  expect(removed.response.status).toBe(404);
  expect(removed.body.code).toBe('starter_operation_unknown');
  for (const host of hosts) {
    const status = (await action('application.status', {}, operatorCookie, randomUUID(), host.baseURL)).body.value.bindings;
    expect(status.length).toBe(60);
    expect(status.filter((item: { bound: boolean }) => item.bound)).toHaveLength(53);
    for (const operation of Object.keys(operationLimits)) {
      expect(status.find((item: { operation: string }) => item.operation === operation).bound).toBe(false);
    }
  }
  expect(await snapshot()).toEqual(before);
  await action('auth.signOut', {}, operatorCookie);
  for (const operation of ['operator.hold', 'operator.release', 'operator.shipments', 'operator.shipment']) {
    expect((await action(operation, { orderRef, holdRef: orderRef, reason: 'manual_support' }, operatorCookie)).body.code).toBe('operator_required');
  }
}, 60000);

// The browser journey is local preview evidence; hosted runners do not install browsers.
it.runIf(existsSync(chromium.executablePath()))('runs the separate browser spec in both installed configurations without changing the purchase witness', () => {
  const fixturePath = join(scratch, 'browser-fixture.json');
  const config = join(app, '.context/e4-browser.config.mjs');
  writeFileSync(config, `import {defineConfig} from '@playwright/test';\nexport default defineConfig({testDir:'../browser',testMatch:'e4.spec.ts',workers:1,fullyParallel:false,
    use:{headless:true,trace:'off',screenshot:'off',video:'off',fixturePath:${JSON.stringify(fixturePath)}},
    projects:${JSON.stringify(hosts.map(host => ({ name: host.id, use: { baseURL: host.baseURL } })))}});\n`);
  try { process.stdout.write(command(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', config])); }
  catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) process.stdout.write(String(error.stdout));
    throw error;
  }
}, 180000);
