/**
 * Explicit composition of the storefront purchase-continuation controller, from
 * the built package, with the neutral starter's real host over a disposable
 * PostgreSQL. The client bindings are the starter's own module
 * (`examples/neutral-store/shared/storefront-bindings.ts`): the command key is
 * the continuation value, a read continues the order by key, and the outcome
 * classifier is the starter's. The witness supplies only the transport target,
 * a page's tab storage, the clock and the identifier source.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import { createPurchaseContinuation } from '@openlup/platform/storefront';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { actionRequestTimeoutMs, type ActionInput, type ActionResult, type Operation } from '../../examples/neutral-store/shared/api.ts';
import { isRecord } from '../../examples/neutral-store/shared/offer.ts';
import { checkoutRecordKey, createCheckoutBindings } from '../../examples/neutral-store/shared/storefront-bindings.ts';
import { closePostgres, dockerAvailable, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

const config = Object.values(configurations)[0]!;
const scenarioHelper = resolve('tests/helpers/neutralStoreScenario.mjs');

let container: PostgresContainer | undefined;
let owner: Pool | undefined;
let migration: Pool | undefined;
let host: ChildProcess | undefined;
let state: string | undefined;
let base: string;

/** The starter's action wire against the witness host: an absolute URL and the browser's `Origin`. */
async function action(operation: Operation, payload: ActionInput, key: string = randomUUID(),
  timeoutMs: number = actionRequestTimeoutMs): Promise<ActionResult> {
  const response = await fetch(`${base}/api/actions/${operation}`, {
    method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': key },
  });
  return await response.json() as ActionResult;
}

const valueOf = (result: unknown) => isRecord(result) && result.ok === true && isRecord(result.value) ? result.value : {};

async function reviewed(email: string) {
  const input = {
    locale: 'en', email, configuration: config.id, country: config.market.country,
    termsAccepted: true, termsRevision: config.legal.revision,
    firstName: 'Example', lastName: 'Buyer', phone: '000000000',
    line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
    cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
  };
  const quote = await action('offer.validate', input);
  if (!quote.ok || !isRecord(quote.value)) throw new Error('continuation_quote_required');
  const body = { ...input, expectedTotal: quote.value.expectedTotal };
  const { locale: _locale, ...details } = body;
  return { reviewed: JSON.stringify(details), body };
}

/**
 * One buyer page: the controller over the starter's bindings and real actions, with tab storage that survives
 * the page. `loseAnswers` creates reach the host but their answers are lost in transport.
 */
function purchase(options: { loseAnswers?: number; tab?: Map<string, string> } = {}) {
  const tab = options.tab ?? new Map<string, string>();
  const operations: string[] = [];
  const keys = new Set<string>();
  let lose = options.loseAnswers ?? 0;
  const checkout = createCheckoutBindings({
    configuration: config.id,
    storage: { getItem: name => tab.get(name) ?? null, setItem: (name, value) => { tab.set(name, value); }, removeItem: name => { tab.delete(name); } },
    act: async (operation, input, commandKey, timeoutMs) => {
      operations.push(operation);
      if (operation === 'checkout.create') keys.add(commandKey);
      const answer = await action(operation, input, commandKey, timeoutMs);
      if (operation !== 'checkout.create' || lose === 0) return answer;
      lose -= 1;
      return { ok: false, code: 'starter_transport_unavailable' };
    },
    now: () => performance.now(),
    nextId: () => randomUUID(),
    token: () => null,
    locale: () => 'en',
  });
  const c = createPurchaseContinuation(checkout.bindings);
  const stored = () => { const raw = tab.get(checkoutRecordKey(config.id)); return raw === undefined ? null : JSON.parse(raw) as Record<string, unknown>; };
  return { c, operations, keys, stored, tab };
}

const contactOrders = async (email: string) => (await owner!.query<{ id: string }>(`SELECT o.id FROM public.commerce_orders o
  JOIN public.clients c ON c.id=o.client_id WHERE c.email=$1`, [email])).rows.map(row => row.id);
const heldFor = async (orders: string[]) => Number((await owner!.query(`SELECT count(*) AS n FROM public.fulfillment_inventory_reservations
  WHERE purchase_order_id = ANY($1::uuid[]) AND status='held'`, [orders])).rows[0].n);
const orderStatus = async (orderRef: unknown) => (await owner!.query<{ status: string }>(
  'SELECT status FROM public.commerce_orders WHERE id=$1', [orderRef])).rows[0]?.status;
const address = (label: string) => `continuation-${label}-${randomUUID().slice(0, 8)}@example.test`;

describe('purchase continuation over the neutral starter', () => {
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error('Purchase continuation proof requires Docker PostgreSQL');
    container = await runPostgresContainer({ name: `starter-continuation-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance' });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Purchase continuation PostgreSQL unavailable');
    owner = new Pool({ connectionString: container.connectionString });
    for (const role of ['starter_runtime', 'starter_restore']) {
      await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
    }
    const installation = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres',
      migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
    migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
    const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration! });
    await runner.apply();
    expect((await runner.status()).pending).toEqual([]);
    await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
    await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
      stock: createPostgresFulfillmentStockSyncPort(owner, { sourceKey: `starter-demo:${config.id}`, readLocalInventoryStock: async () => [] }),
      close: async () => {} });

    // The starter host as the scenario helper starts it, with its captured messages in a private directory.
    state = await mkdtemp(join(tmpdir(), 'starter-continuation-'));
    const keyFile = join(state, 'quote-acceptance-key.json');
    await writeFile(keyFile, JSON.stringify({ current: 'fixture-only-acceptance-key-00000000000000' }));
    const runtime = new URL(container.connectionString);
    runtime.username = 'starter_runtime';
    runtime.password = '';
    runtime.protocol = 'postgresql:';
    const child = spawn(process.execPath, ['--experimental-strip-types', scenarioHelper, '--configuration', config.id,
      '--database-url', runtime.toString(), '--quote-acceptance-key-file', keyFile],
    { cwd: state, env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' }, stdio: ['ignore', 'pipe', 'pipe'] });
    host = child;
    base = await new Promise<string>((done, fail) => {
      let output = '', errors = '';
      const timer = setTimeout(() => fail(new Error('continuation_host_start_timeout')), 20_000);
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { errors = (errors + chunk).slice(-4096); });
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        output = (output + chunk).slice(-2048);
        const origin = /Neutral store local candidate: (http:\/\/127\.0\.0\.1:\d+)\n/.exec(output)?.[1];
        if (origin) { clearTimeout(timer); done(origin); }
      });
      child.once('exit', () => { clearTimeout(timer); fail(new Error(`continuation_host_exited: ${errors}`)); });
    });
  }, 300_000);

  afterAll(async () => {
    if (host && host.exitCode === null) {
      const closed = new Promise(done => host!.once('exit', done));
      host.kill('SIGTERM');
      const kill = setTimeout(() => host!.kill('SIGKILL'), 10_000);
      await closed;
      clearTimeout(kill);
    }
    if (state) await rm(state, { recursive: true, force: true });
    await closePostgres(container, [owner, migration].filter((pool): pool is Pool => pool !== undefined));
  }, postgresTeardownTimeoutMs);

  it('E1 settled: a captured payment read by key is paid, clears the record and refuses a later submit', async () => {
    const p = purchase();
    const payload = await reviewed(address('settled'));
    expect((await p.c.submit({ payload })).snapshot.status).toBe('awaiting_payment');
    const created = valueOf(p.c.getSnapshot().result);
    expect((await action('payment.simulate', { orderRef: created.orderRef, token: created.token, outcome: 'captured' })).ok).toBe(true);
    expect((await p.c.resume()).snapshot).toMatchObject({ status: 'paid', outcome: 'settled', source: 'read', hasContinuation: false });
    expect(p.stored()).toBeNull();
    const before = p.operations.length;
    expect((await p.c.submit({ payload })).accepted).toBe(false);
    expect(p.operations.length).toBe(before);
  }, 60_000);

  it('E2 declined: a refused attempt advances the attempt once over two reads and keeps one order', async () => {
    const p = purchase();
    const email = address('declined');
    await p.c.submit({ payload: await reviewed(email) });
    const created = valueOf(p.c.getSnapshot().result);
    expect((await action('payment.simulate', { orderRef: created.orderRef, token: created.token, outcome: 'refused' })).ok).toBe(true);
    expect((await p.c.resume()).snapshot).toMatchObject({ status: 'declined', attempt: 1 });
    expect((await p.c.resume()).snapshot).toMatchObject({ status: 'declined', attempt: 1, hasContinuation: true });
    expect(p.stored()?.attempt).toBe(1);
    expect(await contactOrders(email)).toHaveLength(1);
  }, 60_000);

  it('E3 refused: an invalid e-mail is refused, then the corrected payload is sent under the same key', async () => {
    const p = purchase();
    const email = address('refused');
    const corrected = await reviewed(email);
    const body = { ...corrected.body, email: 'not-an-address' };
    const invalid = await p.c.submit({ payload: { reviewed: JSON.stringify({ ...JSON.parse(corrected.reviewed), email: body.email }), body } });
    const resent = await p.c.submit({ payload: corrected });
    // The corrected submit's status first: a refusal the classifier does not recognise leaves it details_changed.
    expect(resent.snapshot.status).toBe('awaiting_payment');
    expect(resent.snapshot.source).toBe('submit');
    expect(invalid.snapshot).toMatchObject({ status: 'refused', outcome: 'refused' });
    expect(p.keys.size).toBe(1);
    expect(p.operations.filter(operation => operation === 'checkout.create')).toHaveLength(2);
    expect(await contactOrders(email)).toHaveLength(1);
  }, 60_000);

  it('E4 closed: a cancelled order is closed, clears the record and sends nothing more', async () => {
    const p = purchase();
    await p.c.submit({ payload: await reviewed(address('closed')) });
    const created = valueOf(p.c.getSnapshot().result);
    // Labelled bypass: the fixture cancels the order as the existing continuation witness does.
    await owner!.query('SELECT public.commerce_cancel_abandoned_purchase_checkout($1,$2::uuid,$3,now())',
      [`fixture-close:${String(created.orderRef)}`, created.orderRef, 'fixture_closed']);
    const before = p.operations.length;
    expect((await p.c.resume()).snapshot).toMatchObject({ status: 'closed', outcome: 'closed', source: 'read', hasContinuation: false });
    expect(p.stored()).toBeNull();
    expect(p.operations.slice(before)).toEqual(['checkout.continuation', 'checkout.read']);
  }, 60_000);

  it('E5 not closed: an expired order with a refused attempt stays unknown and keeps its key', async () => {
    const p = purchase();
    await p.c.submit({ payload: await reviewed(address('expired')) });
    const created = valueOf(p.c.getSnapshot().result);
    const record = p.stored();
    expect((await action('payment.simulate', { orderRef: created.orderRef, token: created.token, outcome: 'refused' })).ok).toBe(true);
    // Labelled bypass: age the order past its link lifetime as the existing continuation witness does.
    await owner!.query("UPDATE public.commerce_orders SET created_at=created_at - interval '25 hours' WHERE id=$1", [created.orderRef]);
    expect((await p.c.resume()).snapshot).toMatchObject({ status: 'unknown', source: 'read', hasContinuation: true,
      result: { ok: false, code: 'starter_checkout_expired' } });
    expect(p.stored()).toEqual(record);
    expect(p.keys.size).toBe(1);
  }, 60_000);

  it('E6 uncertain submit: the replay under the same key returns the first order', async () => {
    const p = purchase({ loseAnswers: 1 });
    const email = address('uncertain');
    const { snapshot } = await p.c.submit({ payload: await reviewed(email) });
    expect(snapshot).toMatchObject({ status: 'awaiting_payment', source: 'replay', result: { ok: true, replayed: true } });
    expect(p.keys.size).toBe(1);
    const orders = await contactOrders(email);
    expect(orders).toEqual([valueOf(snapshot.result).orderRef]);
    expect(await heldFor(orders)).toBe(1);
  }, 60_000);

  it('E7 startOver of an unpaid order without an attempt: abandoned, record cleared, the next submit is a new order', async () => {
    const p = purchase();
    const email = address('start-over');
    const payload = await reviewed(email);
    await p.c.submit({ payload });
    const first = valueOf(p.c.getSnapshot().result).orderRef;
    expect((await p.c.startOver()).snapshot).toMatchObject({ status: 'idle', hasContinuation: false, result: null });
    expect(p.stored()).toBeNull();
    expect(await orderStatus(first)).toBe('cancelled');
    expect((await p.c.submit({ payload })).snapshot.status).toBe('awaiting_payment');
    expect(p.keys.size).toBe(2);
    const orders = await contactOrders(email);
    expect(orders).toHaveLength(2);
    expect(await orderStatus(orders.find(order => order !== first)!)).toBe('pending_payment');
  }, 60_000);

  it('E8 startOver after a payment attempt: not abandonable, record and status kept', async () => {
    const p = purchase();
    await p.c.submit({ payload: await reviewed(address('attempted')) });
    const created = valueOf(p.c.getSnapshot().result);
    expect((await action('payment.simulate', { orderRef: created.orderRef, token: created.token, outcome: 'refused' })).ok).toBe(true);
    const record = p.stored();
    const before = p.operations.length;
    const { snapshot } = await p.c.startOver();
    expect(p.operations.slice(before)).toEqual(['checkout.continuation']);
    expect(snapshot).toMatchObject({ status: 'awaiting_payment', hasContinuation: true, error: undefined });
    expect(p.stored()).toEqual(record);
    expect(await orderStatus(String(created.orderRef))).toBe('pending_payment');
  }, 60_000);

  it('E10 a second page continues by key: after a lost first answer it sends the same key and gets the first order', async () => {
    const first = purchase({ loseAnswers: 2 });
    const email = address('second-page');
    const payload = await reviewed(email);
    // The create and its one replay both reach the host; both answers are lost.
    expect((await first.c.submit({ payload })).snapshot).toMatchObject({ status: 'unknown', source: 'submit', hasContinuation: true });
    const second = purchase({ tab: first.tab });
    const { snapshot } = await second.c.submit({ payload });
    expect(snapshot).toMatchObject({ status: 'awaiting_payment', source: 'submit' });
    expect([...second.keys]).toEqual([...first.keys]);
    expect(first.keys.size).toBe(1);
    const orders = await contactOrders(email);
    expect(orders).toEqual([valueOf(snapshot.result).orderRef]);
    expect(await heldFor(orders)).toBe(1);
  }, 60_000);
});
