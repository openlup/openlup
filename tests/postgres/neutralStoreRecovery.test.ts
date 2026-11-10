import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import * as subscriptions from '@openlup/platform/subscriptions';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import { createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { ACQUISITION_TERMS_CAPABILITY } from '@openlup/platform/pricing';
import { createPostgresTransactionalDeliveryStore } from '@openlup/platform/communications';
import { createLifecycleNoticeHost } from '../../examples/neutral-store/host/lifecycle-notices.ts';
import { createPrivateCapture } from '../../examples/neutral-store/host/private-capture.ts';
import { createPostgresOperatorIdentityStore, createPostgresAccountLinkStore, createDirectOperatorInvitationStore } from '@openlup/platform/identity';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import type { ActionResult, Operation } from '../../examples/neutral-store/shared/api.ts';
import { parseHostArguments } from '../../examples/neutral-store/shared/config.ts';
import { isRecord } from '../../examples/neutral-store/shared/offer.ts';
import { closePostgres, dockerAvailable, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
import type { NativeRetryDriverOptions, SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';
import type { RenewalReadback } from '@openlup/platform/subscriptions/contracts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const upper = (value: string) => value.toUpperCase();

describe.each(Object.values(configurations))('$id recurring recovery HTTP boundary', config => {
  let container: PostgresContainer | undefined;
  let owner: Pool, migration: Pool, runtime: Pool;
  let host: ChildProcess | undefined;
  let base: string, state: string, runtimeUrl: string, keyringFile: string, port: number;
  let logs = '';
  const outputs: string[] = [];
  const privateValues = new Set<string>();
  const cookies = new Map<string, string>();

  async function call(operation: Operation, payload: Record<string, unknown>, actor?: string, key = randomUUID()) {
    const response = await fetch(`${base}/api/actions/${operation}`, { method: 'POST', headers: {
      Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': key,
      ...(actor && cookies.has(actor) ? { Cookie: cookies.get(actor)! } : {}),
    }, body: JSON.stringify(payload) });
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) cookies.set(actor, cookie.split(';')[0]!);
    const result = await response.json() as ActionResult;
    if (operation === 'operator.recovery' || operation === 'payment.recover') outputs.push(JSON.stringify(result));
    return result;
  }
  async function stopHost() {
    if (host && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit'); host.kill('SIGTERM'); await exited;
    }
    host = undefined; cookies.clear();
  }
  async function startHost() {
    const hostUrl = new URL(runtimeUrl); hostUrl.password = ''; hostUrl.protocol = 'postgresql:';
    parseHostArguments(['--database-url', hostUrl.toString()]);
    host = spawn(process.execPath, ['--experimental-strip-types', resolve('examples/neutral-store/host/server.ts'),
      '--configuration', config.id, '--port', String(port), '--database-url', hostUrl.toString(),
      '--quote-acceptance-key-file', keyringFile],
    { cwd: state, env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('recovery_host_start_timeout')), 15_000);
      const failed = () => { clearTimeout(timer);
        void writeFile(resolve('.context/scratch/r2a', `startup-${config.id}.private.log`), logs, { mode: 0o600 })
          .finally(() => fail(new Error('recovery_host_start_failed'))); };
      host!.once('error', failed); host!.once('exit', failed);
      host!.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
      host!.stdout?.on('data', (data: Buffer) => {
        logs += data.toString();
        if (data.toString().includes('Neutral store local candidate:')) {
          clearTimeout(timer); host!.removeListener('error', failed); host!.removeListener('exit', failed); done();
        }
      });
    });
  }
  async function signIn(email: string, operator = false) {
    privateValues.add(email);
    // Honor both native one-minute challenge cadences across real host restarts.
    const source = operator
      ? 'public.operator_identity_challenges challenge JOIN public.platform_human_principals client ON client.principal_id=challenge.principal_id'
      : 'public.customer_identity_challenges challenge JOIN public.clients client ON client.id=challenge.client_id';
    const wait = Number((await owner.query(`SELECT GREATEST(0,extract(epoch FROM
      (max(challenge.created_at)+interval '60.1 seconds'-now()))*1000) AS wait_ms
      FROM ${source} WHERE client.email=$1`, [email])).rows[0].wait_ms);
    for (let remaining = Math.ceil(wait); remaining > 0; remaining -= 30_000) {
      await new Promise(done => setTimeout(done, Math.min(remaining, 30_000)));
    }
    const mailbox = resolve(state, '.context/captured-messages/identity.jsonl');
    const messages = async () => (await readFile(mailbox, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const priorTokens = new Set((await messages()).filter(row => row.email === email).map(row => row.token));
    const requested = await call(operator ? 'auth.operator' : 'auth.request', { email }, email);
    expect(requested.ok).toBe(true);
    // Operator acceptance deliberately precedes private mailbox delivery.
    let message: { token: string } | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      message = (await messages()).filter(row => row.email === email && typeof row.token === 'string'
        && !priorTokens.has(row.token)).at(-1);
      if (message) break;
      await new Promise(done => setTimeout(done, 25));
    }
    if (!message) throw new Error('recovery_challenge_missing');
    privateValues.add(message.token);
    expect((await call(operator ? 'auth.operator' : 'auth.verify', { token: message.token }, email)).ok).toBe(true);
  }
  async function createOrder(email: string, mode: 'one_time' | 'subscription' = 'subscription') {
    privateValues.add(email);
    const payload = { locale: 'en', email, configuration: config.id,
      acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
      country: config.market.country, termsAccepted: true, termsRevision: config.legal.revision,
      firstName: 'Example', lastName: 'Buyer', phone: '000000000', line1: '1 Example Lane',
      city: 'Example City', postalCode: '00000', cart: { schemaVersion: 1, configuration: config.id,
        mode, cadenceDays: mode === 'subscription' ? config.offer.defaultCadenceDays : null,
        lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] } };
    const quote = await call('offer.validate', payload);
    if (!quote.ok || !isRecord(quote.value)) throw new Error('recovery_quote_required');
    const result = await call('checkout.create', { ...payload,
      quoteAcceptance: quote.value.quoteAcceptance, expectedTotal: quote.value.expectedTotal });
    if (!result.ok || !isRecord(result.value) || typeof result.value.orderRef !== 'string'
      || typeof result.value.token !== 'string') throw new Error('recovery_checkout_required');
    privateValues.add(result.value.token);
    return { orderRef: result.value.orderRef, token: result.value.token };
  }
  async function transaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> {
    const db = await runtime.connect();
    try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async function declined(registered = false) {
    const email = `recover-${randomUUID()}@example.test`;
    if (registered) {
      const accounts = createPostgresAccountLinkStore({ connectionString: runtimeUrl });
      try { await accounts.createAccount({ email, principalId: randomUUID(), acquisitionSource: 'local-demonstration', lifecycleStage: 'customer' }); }
      finally { await accounts.close(); }
    }
    const initial = await createOrder(email);
    const paid = await call('payment.simulate', { ...initial, outcome: 'captured' });
    expect(paid.ok).toBe(true);
    const activation = (await runtime.query('SELECT subscription_id FROM public.subscription_activations WHERE order_id=$1', [initial.orderRef])).rows[0];
    if (!activation?.subscription_id) throw new Error('recovery_activation_required');
    const subscriptionId: string = activation.subscription_id;
    const dueAt = (await runtime.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1', [subscriptionId])).rows[0].next_cycle_at.toISOString();
    const codec = subscriptions.createNativeRenewalCodec();
    const store = subscriptions.createPostgresRenewalStore(runtime, codec, transaction);
    const due = (await store.listDue(500, dueAt)).find(row => row.subscriptionId === subscriptionId);
    if (!due) throw new Error('recovery_due_required');
    const method = await subscriptions.createPostgresPurchaseRenewalWriter(runtime).readMethod(subscriptionId);
    const lifecycle = subscriptions.createPostgresRetryLifecycleBinding({ executor: runtime, withTransaction: transaction,
      settlement: db => subscriptions.createPostgresRenewalSettlementPort(db, codec, transaction), correlate: wire => codec.decode(wire).cycle,
      failureTemplate: 'failed', recoveryPath: '/account/payment/recover' });
    const rail = subscriptions.createPostgresSandboxRenewalRail(runtime, { scenario: 'declined', now: () => dueAt });
    const result = await subscriptions.runOneAutomaticSubscriptionRenewal({ store, settlement: lifecycle.settlement,
      failureHandoff: lifecycle.failureHandoff, inventory: createPostgresRenewalReservationPort(runtime),
      paymentRails: { resolve: () => rail }, workerId: 'starter-recovery-proof', policy: subscriptions.createSandboxRenewalPolicy(String(method!.methodRef)) }, due, dueAt);
    expect(result.status).toBe('refused');
    const row = await subscriptions.createPostgresRetryStore(runtime).read(result.operationId);
    if (!row?.caseId) throw new Error('recovery_obligation_required');
    return { email, initial, subscriptionId, due, codec, method: method!, row, operationId: result.operationId };
  }
  async function issue(f: Awaited<ReturnType<typeof declined>>, expires = 86400) {
    const raw = 'rcv_' + randomBytes(32).toString('base64url');
    privateValues.add(raw);
    const result = await runtime.query('SELECT public.dunning_lifecycle_issue_recovery_token($1,$2,now()+$3*interval \'1 second\') AS result', [f.row.caseId, sha(raw), expires]);
    expect(result.rows[0].result.issued).toBe(true);
    return raw;
  }
  async function digest() {
    const result: string[] = [];
    for (const table of ['commerce_orders', 'commerce_settlement_intents', 'payment_truth_events', 'payment_simulator_attempts',
      'subscription_activations', 'subscriptions', 'subscription_cycles', 'subscription_retry_obligations',
      'subscription_retry_recovery_authorizations', 'subscription_retry_receipts', 'commerce_checkout_recovery_tokens']) {
      const rows = (await owner.query(`SELECT to_jsonb(t)::text AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      result.push(sha(JSON.stringify(rows)));
    }
    return sha(result.join('\n'));
  }
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error('Recovery proof requires Docker PostgreSQL');
    await mkdir(resolve('.context/scratch'), { recursive: true });
    state = await mkdtemp(resolve('.context/scratch', `starter-recovery-${config.id}-`));
    keyringFile = resolve(state, 'quote-acceptance-keyring.json');
    const current = randomBytes(32).toString('base64url');
    privateValues.add(current);
    await writeFile(keyringFile, JSON.stringify({ current }), { mode: 0o600 });
    container = await runPostgresContainer({ name: `starter-recovery-${config.id}-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance' });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Recovery PostgreSQL unavailable');
    owner = new Pool({ connectionString: container.connectionString });
    for (const role of ['starter_runtime', 'starter_restore']) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
    const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres', migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
    migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
    const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => migration });
    await runner.apply(); expect((await runner.status()).pending).toEqual([]);
    await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
    await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
      stock: createPostgresFulfillmentStockSyncPort(owner, { sourceKey: `starter-demo:${config.id}`, readLocalInventoryStock: async () => [] }),
      close: async () => {} });
    const url = new URL(container.connectionString); url.username = 'starter_runtime'; url.password = 'synthetic-conformance'; runtimeUrl = url.toString();
    runtime = new Pool({ connectionString: runtimeUrl });
    expect((await runtime.query("SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows[0]).toEqual({ current_user: 'starter_runtime', elevated: false });
    const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('recovery_port_required');
    port = address.port; await new Promise<void>(done => probe.close(() => done())); base = `http://127.0.0.1:${port}`;
    await startHost();
  }, 60_000);
  afterAll(async () => {
    try {
      await stopHost();
      const output = [logs, ...outputs].join('\n');
      for (const value of privateValues) expect(output.includes(value), 'private mailbox material in output').toBe(false);
    } finally {
      await closePostgres(container, [owner, migration, runtime].filter(Boolean));
      if (state) await rm(state, { recursive: true, force: true });
    }
  }, postgresTeardownTimeoutMs);

  // Measured 2.28–2.96 s including the UI build; 15 s exceeds four times the maximum.
  // Local browser evidence is required when Chromium is installed.
  it.runIf(existsSync(chromium.executablePath()))('runs the recurring recovery browser journey against PostgreSQL', async () => {
    const f = await declined(true), token = await issue(f);
    const app = resolve('examples/neutral-store');
    const fixture = resolve(state, 'recovery-browser.private.json');
    const configuration = resolve(app, '.context', `recovery-${config.id}.config.mjs`);
    await mkdir(resolve(app, '.context'), { recursive: true });
    await writeFile(fixture, JSON.stringify({ token, email: f.email,
      identityMailbox: resolve(state, '.context/captured-messages/identity.jsonl') }), { mode: 0o600 });
    await writeFile(configuration, `import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'../browser',testMatch:'recovery.proof.ts',workers:1,fullyParallel:false,
  reporter:'list',metadata:{recoveryFixture:${JSON.stringify(fixture)}},
  use:{baseURL:${JSON.stringify(base)},headless:true,trace:'off',screenshot:'off',video:'off'}});`);
    try {
      execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], { cwd: app, stdio: 'pipe' });
      process.stdout.write(execFileSync(process.execPath, [resolve('node_modules/@playwright/test/cli.js'),
        'test', '--config', configuration], { cwd: app, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' }));
    } catch (error) {
      if (error && typeof error === 'object' && 'stdout' in error) process.stdout.write(String(error.stdout));
      throw new Error('starter_recovery_browser_failed');
    } finally {
      await rm(fixture, { force: true }); await rm(configuration, { force: true });
    }
  }, 15_000);

  // Measured 0.85–1.57 s; retain the adjacent HTTP proof's 10 s bound.
  it('refuses old quote proofs after key rotation without effects and accepts a fresh quote', async () => {
    const payload = { locale: 'en', email: `rotate-${randomUUID()}@example.test`, configuration: config.id,
      acquisitionCapability: ACQUISITION_TERMS_CAPABILITY, country: config.market.country,
      termsAccepted: true, termsRevision: config.legal.revision, firstName: 'Example', lastName: 'Buyer',
      phone: '000000000', line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
      cart: { schemaVersion: 1, configuration: config.id, mode: 'subscription',
        cadenceDays: config.offer.defaultCadenceDays, lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] } };
    const quote = await call('offer.validate', payload);
    expect(quote.ok && isRecord(quote.value)).toBe(true);
    if (!quote.ok || !isRecord(quote.value)) throw new Error('rotation_quote_required');
    const retained = { ...payload, quoteAcceptance: quote.value.quoteAcceptance, expectedTotal: quote.value.expectedTotal };
    // A separate already-created checkout exercises the unchanged command/proof retry.
    const priorPayload = { ...payload, email: `prior-${randomUUID()}@example.test` };
    const priorQuote = await call('offer.validate', priorPayload);
    if (!priorQuote.ok || !isRecord(priorQuote.value)) throw new Error('rotation_quote_required');
    const priorInput = { ...priorPayload, quoteAcceptance: priorQuote.value.quoteAcceptance, expectedTotal: priorQuote.value.expectedTotal };
    const priorKey = randomUUID();
    const priorCreated = await call('checkout.create', priorInput, undefined, priorKey);
    if (!priorCreated.ok || !isRecord(priorCreated.value)) throw new Error('rotation_checkout_required');
    const counts = async () => (await owner.query(`SELECT
      (SELECT count(*) FROM public.commerce_checkout_resume_drafts) AS drafts,
      (SELECT count(*) FROM public.commerce_order_draft_receipts) AS receipts,
      (SELECT count(*) FROM public.commerce_orders) AS orders,
      (SELECT count(*) FROM public.payment_truth_events) AS payments,
      (SELECT count(*) FROM public.payment_simulator_attempts) AS attempts,
      (SELECT count(*) FROM public.commerce_settlement_intents) AS settlements,
      (SELECT count(*) FROM public.clients) AS contacts`)).rows;
    const before = await counts();
    await stopHost();
    const current = randomBytes(32).toString('base64url'); privateValues.add(current);
    await writeFile(keyringFile, JSON.stringify({ current }), { mode: 0o600 });
    await startHost();
    expect(await call('checkout.create', retained)).toEqual({ ok: false, code: 'starter_quote_refresh_required' });
    expect(await counts()).toEqual(before);
    const replay = await call('checkout.create', priorInput, undefined, priorKey);
    expect(replay.ok).toBe(true);
    if (!replay.ok || !isRecord(replay.value)) throw new Error('rotation_receipt_required');
    expect(replay.value.orderRef).toBe(priorCreated.value.orderRef);
    expect(await counts()).toEqual(before);
    const fresh = await call('offer.validate', payload);
    if (!fresh.ok || !isRecord(fresh.value)) throw new Error('rotation_quote_required');
    const created = await call('checkout.create', { ...payload,
      quoteAcceptance: fresh.value.quoteAcceptance, expectedTotal: fresh.value.expectedTotal });
    expect(created.ok).toBe(true);
    if (!created.ok || !isRecord(created.value)) throw new Error('rotation_checkout_required');
    const paid = await call('payment.simulate', { orderRef: created.value.orderRef, token: created.value.token, outcome: 'captured' });
    expect(paid.ok).toBe(true);
    expect((await owner.query('SELECT status FROM public.commerce_orders WHERE id=$1', [created.value.orderRef])).rows[0]?.status).toBe('paid');
  }, 30_000);

  it('fences every checkout continuation and simulator/activation entry for guest and owner, including a misleading order', async () => {
    const f = await declined(), raw = await issue(f), control = await createOrder(f.email);
    await signIn(f.email);
    for (const actor of [undefined, f.email]) {
      for (const orderRef of [undefined, upper(f.row.orderId), upper(control.orderRef)]) {
        const input = { token: raw, ...(orderRef ? { orderRef } : {}) };
        const before = await digest();
        expect((await call('checkout.read', input, actor)).ok).toBe(false);
        expect((await call('payment.simulate', { ...input, outcome: 'captured' }, actor)).ok).toBe(false);
        expect(await digest()).toBe(before);
      }
    }
    const before = await digest();
    expect((await call('checkout.read', { orderRef: upper(f.row.orderId) }, f.email)).ok).toBe(false);
    expect((await call('payment.simulate', { orderRef: upper(f.row.orderId), outcome: 'captured' }, f.email)).ok).toBe(false);
    expect(await digest()).toBe(before);
    expect((await call('checkout.read', { ...control, orderRef: upper(control.orderRef) })).ok).toBe(true);
    expect((await call('payment.simulate', { ...control, orderRef: upper(control.orderRef), outcome: 'captured' })).ok).toBe(true);
    const acquisition = (await runtime.query(`SELECT cycle.id,cycle.renewal_operation_id
      FROM public.commerce_orders orders JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
      WHERE orders.id=$1`, [control.orderRef])).rows;
    expect(acquisition).toHaveLength(1); expect(acquisition[0].renewal_operation_id).toBeNull();
    // Acquisition has a real cycle but no recurring relation: both continuations remain valid.
    expect((await call('checkout.read', control)).ok).toBe(true);
    expect((await call('checkout.read', { orderRef: upper(control.orderRef) }, f.email)).ok).toBe(true);
    expect(logs.includes(raw)).toBe(false);
  }, 10_000);

  // Measured 121.8 s including two real native 60 s login cadences; 180 s adds headroom.
  it('requires the owned chain and server method facts, survives restart, and schedules the same unpaid obligation', async () => {
    const f = await declined(), raw = await issue(f), other = await createOrder(`other-${randomUUID()}@example.test`);
    expect(await call('payment.recover', { token: raw, action: 'read' })).toEqual({ ok: false, code: 'customer_session_required' });
    const otherEmail = (await runtime.query('SELECT email FROM public.clients WHERE id=(SELECT client_id FROM public.commerce_orders WHERE id=$1)', [other.orderRef])).rows[0].email;
    await signIn(otherEmail);
    const before = await digest();
    expect((await call('payment.recover', { token: raw }, otherEmail)).ok).toBe(false);
    expect(await digest()).toBe(before);
    await signIn(f.email);
    for (const fields of [{ orderRef: other.orderRef }, { caseRef: randomUUID() }, { operationRef: randomUUID() },
      { methodRef: 'forged', evidence: 'forged', amount: 1, clientId: f.row.subscriptionId, status: 'paid' }]) {
      const before = await digest();
      expect((await call('payment.recover', { token: raw, ...fields }, f.email)).ok).toBe(false);
      expect(await digest()).toBe(before);
    }
    const writer = subscriptions.createPostgresPurchaseRenewalWriter(runtime);
    await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: `missing:${randomUUID()}`, expectedState: 'healthy', healthState: 'method_missing', methodRef: String(f.method.methodRef), evidenceRef: 'missing-sandbox-method' });
    const methodResult = await call('payment.recover', { token: raw }, f.email);
    expect(methodResult).toEqual({ ok: true, value: { state: 'method_unavailable' } });
    await writer.transitionMethod({ subscriptionId: f.subscriptionId, eventKey: `healthy:${randomUUID()}`, expectedState: 'method_missing', healthState: 'healthy', methodRef: String(f.method.methodRef), evidenceRef: 'sandbox:repair-evidence' });
    await stopHost(); await startHost(); await signIn(f.email);
    const result = await call('payment.recover', { token: raw, orderRef: upper(f.row.orderId), caseRef: upper(f.row.caseId!), operationRef: upper(f.operationId) }, f.email);
    expect(result).toEqual({ ok: true, value: { state: 'authorized_retry' } });
    const authorized = (await runtime.query('SELECT * FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1)', [f.operationId])).rows;
    expect(authorized).toHaveLength(1); expect(authorized[0].method_evidence_ref).toBe('sandbox:repair-evidence');
    expect((await runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [f.row.orderId])).rows[0].status).toBe('pending_payment');
    await stopHost(); await startHost(); await signIn(f.email);
    const replay = await digest();
    expect(await call('payment.recover', { token: raw }, f.email)).toEqual(result);
    expect(await digest()).toBe(replay);
    const simulator = createPostgresSandboxPaymentSimulator(runtime, config.purchase.sandbox);
    let executions = 0;
    const policy = subscriptions.createSandboxRenewalPolicy(String(f.method.methodRef));
    const options: NativeRetryDriverOptions = { executor: runtime, withTransaction: transaction, decode: f.codec.decode,
      readFrozenMandate: async snapshot => ({ authorized: (await writer.readMethod(snapshot.subscriptionId))?.healthState === 'healthy',
        authorizationRef: snapshot.authorizationRef, paymentMethodRef: String(f.method.methodRef) }),
      retryInput: (snapshot, row) => ({ ...policy.executionInput(f.due, { cycleSnapshot: snapshot, identityKey: row.identityKey,
        operationFingerprint: row.requestFingerprint } as RenewalReadback, { settlementIntentId: row.settlementIntentId, orderId: row.orderId }),
        executionIdempotencyKey: `${row.identityKey}:retry:${row.retryAttempt}`, externalIdempotencyKey: `${row.identityKey}:retry-provider:${row.retryAttempt}` }),
      validateInput: policy.validateInput,
      payments: {
        execute: async input => {
          executions++;
          const attempt = await simulator.beginAttempt({ settlementIntentId: input.paymentIntentId, idempotencyKey: input.executionIdempotencyKey,
            requestFingerprint: input.requestFingerprint, methodFacts: { authorizationRef: f.due.authorizationRef,
              unattendedChargeAuthorizedAt: f.due.unattendedChargeAuthorizedAt, payerAccountRef: f.due.payerAccountRef,
              methodRef: String(f.method.methodRef), methodEvidenceRef: 'sandbox:repair-evidence' }, at: new Date().toISOString() });
          await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `${input.executionIdempotencyKey}:observation`, outcome: 'captured', occurredAt: attempt.dispatchedAt });
          return { status: 'pending', externalAttemptRef: attempt.id };
        },
        readOutcome: async (prepared, snapshot) => {
          const attempt = await simulator.readAttempt({ settlementIntentId: prepared.settlementIntentId });
          if (!attempt?.latestObservation) throw new Error('recovery_attempt_readback_required');
          const evidence = attempt.latestObservation;
          return { status: 'succeeded', disposition: 'observed', operationId: f.operationId,
            eventKey: `retry-observation:${prepared.obligationId}:${prepared.attemptSequence}`,
            requestFingerprint: prepared.operationFingerprint, verifiedEvidenceRef: `sandbox:${evidence.id}`,
            externalAttemptRef: attempt.id, occurredAt: evidence.occurredAt, observedAt: evidence.occurredAt,
            firstRecordedAt: evidence.occurredAt, amountMinor: snapshot.pricingSnapshot.totalAmountMinor,
            currency: snapshot.pricingSnapshot.currency, reason: null,
            sourceEvidence: { sourceKind: 'accepted_event', sourceReference: evidence.id, attemptRef: attempt.id,
              observedStatus: evidence.outcome, observedAt: evidence.occurredAt, payloadFingerprint: evidence.fingerprint } };
        },
      }, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/account/payment/recover', classifyFailure: () => 'temporary' };
    const driver = subscriptions.createNativeRetryDriver(options);
    expect(await driver.run(new Date().toISOString(), 50)).toContainEqual({ operationId: f.operationId, status: 'succeeded' });
    expect(executions).toBe(1);
    expect(await call('payment.recover', { token: raw, action: 'read' }, f.email)).toEqual({ ok: true, value: { state: 'recovered' } });
    expect((await runtime.query('SELECT status FROM public.subscriptions WHERE id=$1', [f.subscriptionId])).rows[0].status).toBe('active');
    const blocker = await owner.connect();
    let accounts: Promise<ActionResult>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE public.subscriptions IN ACCESS EXCLUSIVE MODE');
      accounts = Array.from({ length: 4 }, () => call('account.read', {}, f.email));
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 4 && Date.now() < deadline) {
        waiting = Number((await owner.query(`SELECT count(*) AS count FROM pg_stat_activity
          WHERE usename='starter_runtime' AND wait_event_type='Lock'`)).rows[0].count);
        if (waiting < 4) await new Promise(done => setTimeout(done, 25));
      }
      expect(waiting).toBe(4);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    for (const account of await Promise.all(accounts)) {
      expect(account.ok).toBe(true);
      if (account.ok && isRecord(account.value)) {
        expect(account.value.renewal).toMatchObject({ subscriptions: [{ subscriptionId: f.subscriptionId }] });
      }
    }
    expect(logs.includes(raw)).toBe(false);
  }, 180_000);

  it('refuses unusable credentials without changing the original obligation', async () => {
    const f = await declined(); await signIn(f.email);
    const expired = await issue(f, 1);
    await runtime.query('SELECT pg_sleep(1.1)');
    const beforeExpired = await digest();
    expect(await call('payment.recover', { token: expired }, f.email)).toEqual({ ok: false, code: 'starter_recovery_unavailable' });
    expect(await digest()).toBe(beforeExpired);
    const revoked = await issue(f);
    const used = await issue(f);
    const beforeRevoked = await digest();
    expect(await call('payment.recover', { token: revoked }, f.email)).toEqual({ ok: false, code: 'starter_recovery_unavailable' });
    expect(await digest()).toBe(beforeRevoked);
    const tokenId = (await runtime.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1', [sha(used)])).rows[0].id;
    await subscriptions.createPostgresRetryStore(runtime).authorizeRecovery(f.operationId, tokenId,
      String(f.method.methodRef), String(f.method.evidenceRef), new Date().toISOString());
    const beforeUsed = await digest();
    expect(await call('payment.recover', { token: used }, f.email)).toEqual({ ok: false, code: 'starter_recovery_unavailable' });
    expect(await digest()).toBe(beforeUsed);
  }, 10_000);

  it('captures a human-operator link once and refuses missing or changed capture on replay', async () => {
    const f = await declined(true);
    const identity = createPostgresOperatorIdentityStore({ connectionString: container!.connectionString });
    const operatorEmail = `operator-${config.id}@example.test`;
    let operator: string;
    try { operator = (await identity.bootstrapFirstAdministrator({ email: operatorEmail })).principalId; } finally { await identity.close(); }
    await signIn(operatorEmail, true);
    // Existing roster is install/operator configuration, never browser authority.
    await owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true) ON CONFLICT(principal_id) DO UPDATE SET active=true", [operator]);
    const key = randomUUID(), input = { customerRef: upper(f.row.subscriptionId), caseRef: upper(f.row.caseId!), locale: 'en' };
    const clientId = (await runtime.query('SELECT client_id FROM public.subscriptions WHERE id=$1', [f.subscriptionId])).rows[0].client_id;
    input.customerRef = upper(clientId);
    const operatorResult = await call('operator.recovery', input, operatorEmail, key);
    expect(operatorResult.ok).toBe(true);
    const notice = (await runtime.query("SELECT id,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 AND notification_kind='payment_recovery'", [f.row.caseId])).rows[0];
    const messageKey = `subscription-notice:dunning:${notice.id}`, path = resolve(state, '.context/captured-messages', sha(messageKey) + '.json');
    const bytes = await readFile(path, 'utf8');
    const original = JSON.parse(bytes).record;
    expect(original.kind).toBe('payment_recovery');
    expect(original.schemaVersion).toBe(1);
    privateValues.add(original.token); privateValues.add(original.recoveryUrl); privateValues.add(original.recipient);
    const before = await digest();
    expect((await call('operator.recovery', { ...input, customerRef: clientId, caseRef: f.row.caseId }, operatorEmail, key)).ok).toBe(true);
    expect(await digest()).toBe(before); expect((await readFile(path, 'utf8')) === bytes).toBe(true);
    await stopHost(); await startHost(); await signIn(operatorEmail, true);
    expect((await call('operator.recovery', input, operatorEmail, key)).ok).toBe(true);
    expect((await readFile(path, 'utf8')) === bytes).toBe(true);
    const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    try {
      const claimed = (await runtime.query('SELECT * FROM public.subscription_dunning_claim_batch(100,60,6)')).rows
        .find(row => row.id === notice.id);
      expect(Boolean(claimed)).toBe(true);
      const notices = createLifecycleNoticeHost({ config, publicOrigin: base, withTransaction: transaction,
        capture: createPrivateCapture(resolve(state, '.context/captured-messages')), receipts });
      const command = { ...await notices.bind({ id: notice.id, messageKey, source: 'dunning',
        subscriptionId: f.subscriptionId, clientId, kind: 'payment_recovery',
        templateSlug: 'subscription-payment-recovery', payload: {}, recoveryUrlPath: notice.recovery_url_path },
      { email: f.email, firstName: null, country: null }), idempotencyKey: messageKey };
      const tokenBefore = (await runtime.query('SELECT id,revoked_at,xmin::text FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1', [sha(original.token)])).rows;
      expect((await notices.delivery.send(command)).state).toBe('accepted');
      outputs.push(JSON.stringify(command), JSON.stringify(await notices.delivery.readReceipt(messageKey)));
      expect((await readFile(path, 'utf8')) === bytes).toBe(true);
      expect((await runtime.query('SELECT id,revoked_at,xmin::text FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1', [sha(original.token)])).rows).toEqual(tokenBefore);
      await rm(path);
      await expect(notices.delivery.send(command)).rejects.toThrow('starter_notice_identity_unavailable');
      await writeFile(path, bytes, { mode: 0o600 });
    } finally { await receipts.close(); }
    await rm(path);
    expect((await call('operator.recovery', input, operatorEmail, key)).ok).toBe(false);
    expect((await readdir(resolve(state, '.context/captured-messages'))).includes(sha(messageKey) + '.json')).toBe(false);
    await writeFile(path, bytes, { mode: 0o600 });
    const changed = JSON.parse(bytes); changed.record.orderId = randomUUID();
    const changedBytes = JSON.stringify(changed) + '\n';
    await writeFile(path, changedBytes, { mode: 0o600 });
    const beforeChanged = await digest();
    expect((await call('operator.recovery', input, operatorEmail, key)).ok).toBe(false);
    expect(await digest()).toBe(beforeChanged);
    expect((await readFile(path, 'utf8')) === changedBytes).toBe(true);
    await owner.query('UPDATE public.platform_communication_operators SET active=false WHERE principal_id=$1', [operator]);
    expect((await call('operator.recovery', input, operatorEmail, key)).ok).toBe(false);
    await writeFile(path, bytes, { mode: 0o600 });
    await owner.query('UPDATE public.platform_communication_operators SET active=true WHERE principal_id=$1', [operator]);
    const backup = randomUUID(), backupEmail = `backup-${config.id}@example.test`;
    await owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [backup, backupEmail]);
    const invitations = createDirectOperatorInvitationStore({ connectionString: container!.connectionString });
    try {
      expect((await invitations.issue({ actorPrincipalId: operator, targetPrincipalId: backup,
        email: backupEmail, role: 'admin', ttlSeconds: 3600 })).code).toBe('INVITATION_CREATED');
      await signIn(backupEmail, true);
      expect((await invitations.read(backup))?.membershipState).toBe('active');
      expect(await invitations.remove({ actorPrincipalId: backup, targetPrincipalId: operator,
        reason: 'Synthetic recovery revalidation' })).toEqual({ revoked: true });
    } finally { await invitations.close(); }
    expect((await call('operator.recovery', input, operatorEmail, key)).ok).toBe(false);
    const raw = new URL(notice.recovery_url_path, base).searchParams.get('token')!;
    expect(logs.includes(raw)).toBe(false);
  }, 180_000);



});
