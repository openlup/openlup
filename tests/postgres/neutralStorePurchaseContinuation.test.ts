/**
 * Explicit composition of the storefront purchase-continuation controller, from
 * the built package, with the neutral starter's real host over a disposable
 * PostgreSQL. The client bindings below are a complete binding to the starter:
 * the command key is the continuation value, a read continues the order by key,
 * and the outcome classifier is the storefront example classifier.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import {
  createPurchaseContinuation,
  toCommandKey,
  type CommandKey,
  type ContinuationRecord,
  type StatusReading,
  type SubmitFailureClass,
} from '@openlup/platform/storefront';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { checkoutLateCreateMs, type ActionResult, type Operation } from '../../examples/neutral-store/shared/api.ts';
import { isRecord } from '../../examples/neutral-store/shared/offer.ts';
// eslint-disable-next-line no-restricted-imports -- bind the storefront example classifier the unit witness also proves, not a copy
import { classifyStarterAnswer } from '../../packages/platform/test/storefront/outcomeClassifierExamples.ts';
import { closePostgres, dockerAvailable, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

const config = Object.values(configurations)[0]!;
const scenarioHelper = resolve('tests/helpers/neutralStoreScenario.mjs');
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * The starter client's own request timeout: `examples/neutral-store/client/api.ts` passes it to
 * `AbortSignal.timeout` for every action. The controller has no transport timeout, so the host
 * supplies it: the witness sends with it, and its finality wait adds the starter's late-create bound.
 */
const starterRequestTimeoutMs = 20_000;

let container: PostgresContainer | undefined;
let owner: Pool | undefined;
let migration: Pool | undefined;
let host: ChildProcess | undefined;
let state: string | undefined;
let base: string;

async function action(operation: Operation, payload: Record<string, unknown>, key: string = randomUUID()): Promise<ActionResult> {
  const response = await fetch(`${base}/api/actions/${operation}`, {
    method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(starterRequestTimeoutMs),
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
  return { ...input, expectedTotal: quote.value.expectedTotal };
}

type Payload = Awaited<ReturnType<typeof reviewed>>;
type Sent = { key: CommandKey; body: Payload };

/**
 * The witness host's reading of a `checkout.continuation` abandon answer. "No order under this key"
 * is final only once the host's own request timeout plus the starter's late-create bound have passed
 * since the last unanswered create, because a create sent earlier can still arrive until then.
 */
function abandonReading(answer: ActionResult,
  finality: { requestTimeoutMs: number; unansweredCreateSince: number | null; now: number }): StatusReading {
  const value = valueOf(answer);
  if (answer.ok && value.abandoned === true) return { kind: 'terminal' };
  if (answer.ok && value.abandoned === false && value.orderRef === undefined) {
    const since = finality.unansweredCreateSince;
    return since === null || finality.now - since > finality.requestTimeoutMs + checkoutLateCreateMs
      ? { kind: 'terminal' } : { kind: 'checking' };
  }
  if (answer.ok && value.abandoned === false) return value.status === 'cancelled' ? { kind: 'terminal' } : { kind: 'active' };
  if (!answer.ok && ['starter_checkout_not_abandonable', 'starter_checkout_paid'].includes(answer.code)) return { kind: 'active' };
  return { kind: 'checking' };
}

/** One buyer page: the controller over the starter's real actions, with storage that survives the page. */
function purchase(options: { requestTimeoutMs: number; loseFirstAnswer?: boolean }) {
  const now = () => performance.now();
  let stored: ContinuationRecord | null = null;
  const operations: string[] = [];
  const keys = new Set<string>();
  /** The host's durable map from a payment attempt reference to the attempt number it was read under. */
  const attempts = new Map<string, number>();
  let unansweredCreateSince: number | null = null;
  const send = async (operation: Operation, payload: Record<string, unknown>, key?: string) => {
    operations.push(operation);
    return await action(operation, payload, key);
  };
  const create = async (request: Sent) => {
    keys.add(request.key);
    try {
      const answer = await send('checkout.create', request.body, request.key);
      unansweredCreateSince = null;
      return answer;
    } catch (error) {
      unansweredCreateSince ??= now();
      throw error;
    }
  };
  let lost = false;
  const c = createPurchaseContinuation<Payload, Sent, ActionResult>({
    storage: { read: () => stored, write: (record) => { stored = record; }, clear: () => { stored = null; } },
    identifier: { next: () => randomUUID(), accepts: (value) => uuidV4.test(value) },
    changedPayload: 'refuse_changed',
    commandKeyFor: ({ continuationId }) => toCommandKey(continuationId),
    request: {
      fingerprint: (payload) => JSON.stringify(payload),
      build: (payload, { commandKey }) => ({ key: commandKey, body: payload }),
    },
    transport: {
      submit: async (request) => {
        if (options.loseFirstAnswer && !lost) {
          lost = true;
          await create(request);
          unansweredCreateSince ??= now();
          throw new TypeError('fetch failed');
        }
        return await create(request);
      },
      replay: async (request) => await create(request),
      read: async ({ continuationId, attempt, result }) => {
        const resumed = await send('checkout.continuation', { action: 'resume', locale: 'en' }, continuationId);
        const value = valueOf(resumed);
        if (resumed.ok && value.status === 'pending_payment' && typeof value.token === 'string') {
          const inspected = await send('checkout.payment', { action: 'inspect', orderRef: value.orderRef, token: value.token });
          if (!inspected.ok) return inspected;
          const { attemptRef, state: attemptState } = valueOf(inspected);
          if (typeof attemptRef === 'string' && !attempts.has(attemptRef)) attempts.set(attemptRef, attempt);
          return { ...resumed, value: { ...value, attemptRef, attemptState } };
        }
        const last = valueOf(result);
        if (!resumed.ok && resumed.code === 'starter_checkout_not_payable' && typeof last.token === 'string') {
          return await send('checkout.read', { orderRef: last.orderRef, token: last.token });
        }
        return resumed;
      },
      abandon: async ({ continuationId }) => abandonReading(
        await send('checkout.continuation', { action: 'abandon', locale: 'en' }, continuationId),
        { requestTimeoutMs: options.requestTimeoutMs, unansweredCreateSince, now: now() }),
    },
    classifySubmitFailure: (error): SubmitFailureClass => error instanceof TypeError ? 'transport_uncertain'
      : error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'other',
    classifyOutcome: classifyStarterAnswer,
    activationPending: () => false,
    declinedAttempt: (result) => {
      const ref = valueOf(result).attemptRef;
      return typeof ref === 'string' ? attempts.get(ref) ?? null : null;
    },
  });
  return { c, operations, keys, stored: () => stored };
}

const contactOrders = async (email: string) => (await owner!.query<{ id: string }>(`SELECT o.id FROM public.commerce_orders o
  JOIN public.clients c ON c.id=o.client_id WHERE c.email=$1`, [email])).rows.map(row => row.id);
const heldFor = async (orders: string[]) => Number((await owner!.query(`SELECT count(*) AS n FROM public.fulfillment_inventory_reservations
  WHERE purchase_order_id = ANY($1::uuid[]) AND status='held'`, [orders])).rows[0].n);
const address = (label: string) => `continuation-${label}-${randomUUID().slice(0, 8)}@example.test`;

describe('the witness host binding', () => {
  const none: ActionResult = { ok: true, value: { abandoned: false } };
  const since = 1_000;
  const reading = (answer: ActionResult, now = since, unansweredCreateSince: number | null = since) =>
    abandonReading(answer, { requestTimeoutMs: starterRequestTimeoutMs, unansweredCreateSince, now }).kind;

  it('sends with the starter client\'s own request timeout', async () => {
    const client = await readFile(resolve('examples/neutral-store/client/api.ts'), 'utf8');
    expect([...client.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map(match => Number(match[1]))).toEqual([starterRequestTimeoutMs]);
  });

  it('treats no order under the key as final only after the request timeout plus the late-create bound', () => {
    // The starter's 20 s request timeout plus its 15 s late-create bound.
    expect(reading(none, since + 34_999)).toBe('checking');
    expect(reading(none, since + 35_000)).toBe('checking');
    expect(reading(none, since + 35_001)).toBe('terminal');
    expect(reading(none, since, null)).toBe('terminal');
  });

  it('maps every other abandon answer', () => {
    expect(reading({ ok: true, value: { abandoned: true, orderRef: 'order' } })).toBe('terminal');
    expect(reading({ ok: true, value: { abandoned: false, orderRef: 'order', status: 'cancelled' } })).toBe('terminal');
    expect(reading({ ok: true, value: { abandoned: false, orderRef: 'order', status: 'expired' } })).toBe('active');
    for (const code of ['starter_checkout_not_abandonable', 'starter_checkout_paid']) expect(reading({ ok: false, code })).toBe('active');
    for (const code of ['starter_checkout_in_progress', 'starter_purchase_unavailable']) expect(reading({ ok: false, code })).toBe('checking');
  });
});

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
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs });
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
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs });
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
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs });
    const email = address('refused');
    const corrected = await reviewed(email);
    expect((await p.c.submit({ payload: { ...corrected, email: 'not-an-address' } })).snapshot)
      .toMatchObject({ status: 'refused', outcome: 'refused' });
    expect((await p.c.submit({ payload: corrected })).snapshot).toMatchObject({ status: 'awaiting_payment', source: 'submit' });
    expect(p.keys.size).toBe(1);
    expect(p.operations.filter(operation => operation === 'checkout.create')).toHaveLength(2);
    expect(await contactOrders(email)).toHaveLength(1);
  }, 60_000);

  it('E4 closed: a cancelled order is closed, clears the record and sends nothing more', async () => {
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs });
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
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs });
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
    const p = purchase({ requestTimeoutMs: starterRequestTimeoutMs, loseFirstAnswer: true });
    const email = address('uncertain');
    const { snapshot } = await p.c.submit({ payload: await reviewed(email) });
    expect(snapshot).toMatchObject({ status: 'awaiting_payment', source: 'replay', result: { ok: true, replayed: true } });
    expect(p.keys.size).toBe(1);
    const orders = await contactOrders(email);
    expect(orders).toEqual([valueOf(snapshot.result).orderRef]);
    expect(await heldFor(orders)).toBe(1);
  }, 60_000);
});
