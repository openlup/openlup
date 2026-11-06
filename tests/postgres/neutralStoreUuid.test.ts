import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createPostgresContactClientRegistrar } from '@openlup/platform/identity';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import type { ActionResult, Operation } from '../../examples/neutral-store/shared/api.ts';
import { isRecord } from '../../examples/neutral-store/shared/offer.ts';
import {
  closePostgres, dockerAvailable, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer,
} from '../helpers/postgresContainer.js';

const spellings = {
  uppercase: (id: string) => id.toUpperCase(),
  mixed: (id: string) => {
    let upper = false;
    return id.replace(/[a-f]/g, letter => {
      upper = !upper;
      return upper ? letter.toUpperCase() : letter;
    });
  },
};

// Setup previously measured below six seconds per configuration. Allow install
// headroom separately from the sub-second host actions and their 150 ms floor.
describe.each(Object.values(configurations))('$id host UUID identity', config => {
  let container: PostgresContainer | undefined;
  let owner: Pool | undefined;
  let migration: Pool | undefined;
  let host: ChildProcess | undefined;
  let base: string;
  let state: string;
  let cookie: string | undefined;
  let runtimeConnection: string;
  let pending: { orderRef: string; token: string };
  const paid = new Map<string, Record<string, unknown>>();
  const email = `uuid-${config.id}@example.test`;

  async function exchange(operation: Operation, payload: Record<string, unknown>, signedIn = false, key = randomUUID()) {
    const started = performance.now();
    const response = await fetch(`${base}/api/actions/${operation}`, {
      method: 'POST', headers: {
        Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1',
        'Idempotency-Key': key, ...(signedIn && cookie ? { Cookie: cookie } : {}),
      }, body: JSON.stringify(payload),
    });
    const issuedCookie = response.headers.get('set-cookie');
    if (issuedCookie) cookie = issuedCookie.split(';')[0];
    return { body: await response.json() as ActionResult, status: response.status, elapsed: performance.now() - started };
  }

  async function call(operation: Operation, payload: Record<string, unknown>, signedIn = false, key = randomUUID()) {
    return (await exchange(operation, payload, signedIn, key)).body;
  }

  async function quotedSubscription(payload: Record<string, unknown>) {
    const capable = { ...payload, acquisitionCapability: 'subscription-acquisition.v1' };
    const quoted = await call('offer.validate', capable);
    expect(quoted.ok).toBe(true);
    if (!quoted.ok || !isRecord(quoted.value)) throw new Error('host_server_quote_required');
    return { ...capable, quoteAcceptance: quoted.value.quoteAcceptance, expectedTotal: quoted.value.expectedTotal };
  }

  async function control(permissive: boolean | null, emailLimit?: number, cadenceDays?: number[]) {
    return new Promise<{ registrations: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host_control_timeout')), 5_000);
      host!.once('message', message => {
        clearTimeout(timer);
        resolve(message as { registrations: number });
      });
      host!.send({ permissive, emailLimit, cadenceDays });
    });
  }

  const checkout = (address: string) => ({
    locale: 'en', email: address, configuration: config.id, country: config.market.country,
    termsAccepted: true, termsRevision: config.legal.revision,
    firstName: 'Example', lastName: 'Buyer', phone: '000000000',
    line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
    cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
  });

  async function createOrder(signedIn = false) {
    const result = await call('checkout.create', {
      locale: 'en', email, configuration: config.id, country: config.market.country,
      termsAccepted: true, termsRevision: config.legal.revision,
      firstName: 'Example', lastName: 'Buyer', phone: '000000000',
      line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
      cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
        lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
    }, signedIn);
    if (!result.ok || !isRecord(result.value)
      || typeof result.value.orderRef !== 'string' || typeof result.value.token !== 'string') {
      throw new Error('uuid_host_checkout_required');
    }
    return { orderRef: result.value.orderRef, token: result.value.token };
  }

  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error('UUID host proof requires Docker PostgreSQL');
    const scratch = resolve('.context/scratch');
    await mkdir(scratch, { recursive: true });
    state = await mkdtemp(resolve(scratch, `starter-uuid-${config.id}-`));
    container = await runPostgresContainer({
      name: `starter-uuid-${config.id}-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance',
    });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('UUID PostgreSQL unavailable');
    owner = new Pool({ connectionString: container.connectionString });
    for (const role of ['starter_runtime', 'starter_restore']) {
      await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
    }
    const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres',
      migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
    migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
    const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, {
      installation: selection, poolFactory: () => migration!,
    });
    await runner.apply();
    expect((await runner.status()).pending).toEqual([]);
    await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
    await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
      stock: createPostgresFulfillmentStockSyncPort(owner, { sourceKey: `starter-demo:${config.id}`, readLocalInventoryStock: async () => [] }),
      close: async () => {} });
    const runtimeUrl = new URL(container.connectionString);
    runtimeUrl.username = 'starter_runtime';
    runtimeUrl.protocol = 'postgresql:';
    runtimeUrl.password = '';
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('uuid_host_port_required');
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    // The starter owns its strict compiler profile; exercise its actual CLI and
    // HTTP host instead of importing its whole graph into the root test profile.
    const entry = resolve('examples/neutral-store/host/server.ts');
    runtimeConnection = runtimeUrl.toString();
    // Child-only composition uses the real HTTP host and restricted native ports.
    // IPC replaces only the existing callback seam and observes registrar calls.
    const bootstrap = String.raw`
      import { pathToFileURL } from 'node:url';
      import { Pool } from 'pg';
      import { createPostgresContactClientRegistrar } from '@openlup/platform/identity';
      import { createPostgresRoleFreeTransactionLane } from '@openlup/platform/data';
      import { createPostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
      const entry = ${JSON.stringify(entry)};
      const load = relative => import(new URL(relative, pathToFileURL(entry)).href);
      const { createApplication } = await load('./server.ts');
      const { composeNativeBindings } = await load('./native-composition.ts');
      const { composePurchaseCapabilities } = await load('./purchase-composition.ts');
      const { createCheckoutRecoveryDelivery } = await load('./checkout-recovery.ts');
      const { createOriginPolicy } = await load('./origin-policy.ts');
      const { selectConfiguration } = await load('../owned/store.config.ts');
      const config = selectConfiguration(${JSON.stringify(config.id)});
      const port = ${port};
      const connectionString = ${JSON.stringify(runtimeConnection)};
      const base = 'http://127.0.0.1:' + port;
      process.chdir(${JSON.stringify(state)});
      const keyring = { current: 'fixture-only-acceptance-key-00000000000000' };
      const bindings = await composeNativeBindings(connectionString, createOriginPolicy(config, port), keyring);
      const pool = new Pool({ connectionString });
      const registrar = createPostgresContactClientRegistrar({ connectionString });
      const lane = createPostgresRoleFreeTransactionLane({ connectionString });
      const recovery = { tokens: createPostgresCheckoutRecoveryTokenPort(lane), deliver: createCheckoutRecoveryDelivery(base) };
      let registrations = 0;
      const contacts = { ensureContactClient: input => { registrations++; return registrar.ensureContactClient(input); }, close: async () => {} };
      process.on('message', message => {
        if (message.cadenceDays !== undefined) config.offer.cadenceDays = message.cadenceDays;
        if (message.emailLimit !== undefined) config.purchase.inputLimits.email = message.emailLimit;
        if (message.permissive !== null) {
          config.purchase.attemptLimits = { ...config.purchase.attemptLimits, maxPerEmail: 2, maxPerRequester: 2, maxEntries: 8 };
          registrations = 0;
          bindings.actions['checkout.create'] = composePurchaseCapabilities(pool, contacts,
            message.permissive ? async () => ({ allowed: true }) : undefined, recovery, { keyring })['checkout.create'];
        }
        process.send({ registrations });
      });
      const server = createApplication(bindings);
      server.listen(port, '127.0.0.1', () => process.stdout.write('Neutral store local candidate: ' + base + '\n'));
      process.once('SIGTERM', () => server.close(async () => {
        await Promise.all([bindings.close(), pool.end(), registrar.close(), lane.close()]);
        process.disconnect();
      }));
    `;
    host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', bootstrap,
      'starter-host-proof', '--configuration', config.id, '--port', String(port), '--database-url', runtimeConnection],
    { cwd: resolve('.'), env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('uuid_host_start_timeout')), 10_000);
      const fail = () => { clearTimeout(timer); reject(new Error('uuid_host_start_failed')); };
      host!.once('error', fail);
      host!.once('exit', fail);
      host!.stderr?.resume();
      let output = '';
      host!.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`Neutral store local candidate: ${base}\n`)) {
          clearTimeout(timer);
          host!.removeListener('error', fail);
          host!.removeListener('exit', fail);
          resolve();
        }
      });
    });
    pending = await createOrder();
    expect((await call('auth.request', { email })).ok).toBe(true);
    const messages = (await readFile(resolve(state, '.context/captured-messages/identity.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { email: string; token: string });
    const challenge = messages.filter(message => message.email === email).at(-1);
    if (!challenge) throw new Error('uuid_native_challenge_required');
    expect((await call('auth.verify', { token: challenge.token })).ok).toBe(true);
    expect(cookie).toBeDefined();
    for (const signedIn of [false, true]) {
      const order = await createOrder(signedIn);
      const result = await call('payment.simulate', { ...order, outcome: 'captured' }, signedIn);
      if (!result.ok || !isRecord(result.value)) throw new Error('uuid_lowercase_payment_required');
      paid.set(String(signedIn), result.value);
    }
  }, 30_000);

  afterAll(async () => {
    try {
      if (host && host.exitCode === null && host.signalCode === null) {
        const exited = once(host, 'exit');
        const timer = setTimeout(() => host!.kill('SIGKILL'), 10_000);
        host.kill('SIGTERM');
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally {
      await closePostgres(container, [owner, migration].filter((pool): pool is Pool => pool !== undefined));
      if (state) await rm(state, { recursive: true, force: true });
    }
  }, postgresTeardownTimeoutMs);

  for (const signedIn of [false, true]) {
    const actor = signedIn ? 'signed-in' : 'guest';
    for (const [spelling, changeCase] of Object.entries(spellings)) {
      it(`${actor} ${spelling} token orderRef reads exactly like lowercase`, async () => {
        const order = await createOrder(signedIn);
        const lower = await call('checkout.read', order, signedIn);
        expect(lower.ok).toBe(true);
        const changed = { ...order, orderRef: changeCase(order.orderRef) };
        expect(await call('checkout.read', changed, signedIn)).toEqual(lower);
        if (signedIn) {
          expect(await call('checkout.read', { orderRef: changed.orderRef }, true))
            .toEqual(await call('checkout.read', { orderRef: order.orderRef }, true));
        }
        expect(changed.orderRef).toBe(changeCase(order.orderRef));
      }, 30_000);

      it(`${actor} ${spelling} token orderRef pays exactly like lowercase`, async () => {
        const order = await createOrder(signedIn);
        const input = { ...order, orderRef: changeCase(order.orderRef), outcome: 'captured' };
        const result = await call('payment.simulate', input, signedIn);
        expect(result).toEqual({ ok: true, value: { ...paid.get(String(signedIn)), orderRef: order.orderRef }, replayed: false });
        expect(input.orderRef).toBe(changeCase(order.orderRef));
      }, 30_000);
    }

    for (const operation of ['checkout.read', 'payment.simulate'] as const) {
      it(`${actor} non-UUID still refuses ${operation}`, async () => {
        expect(await call(operation, { orderRef: 'invalid-order-reference', token: pending.token,
          ...(operation === 'payment.simulate' ? { outcome: 'captured' } : {}) }, signedIn))
          .toEqual({ ok: false, code: operation === 'checkout.read' ? 'starter_recovery_unavailable' : 'starter_order_not_found' });
      }, 30_000);
    }
  }

  // New cases measured locally; each retains the existing 30 s hosted bound.
  it('native cadence boundary accepts 120 and refuses 121 before contact resolution', async () => {
    const before = Number((await owner!.query('SELECT count(*) AS count FROM public.clients')).rows[0].count);
    try {
      // Bypass configuration validation to exercise the independent HTTP admission guard.
      await control(null, undefined, [120, 121]);
      const input = checkout(`cadence-${config.id}@example.test`);
      const refused = await call('checkout.create', { ...input, acquisitionCapability: 'subscription-acquisition.v1', cart: { ...input.cart, mode: 'subscription', cadenceDays: 121 } });
      expect(refused).toEqual({ ok: false, code: 'cadence_unavailable' });
      expect(Number((await owner!.query('SELECT count(*) AS count FROM public.clients')).rows[0].count)).toBe(before);
      const accepted = await call('checkout.create', await quotedSubscription({ ...input, cart: { ...input.cart, mode: 'subscription', cadenceDays: 120 } }));
      expect(accepted.ok).toBe(true);
      if (!accepted.ok || !isRecord(accepted.value)) throw new Error('cadence_purchase_required');
      const read = await call('checkout.read', { orderRef: accepted.value.orderRef, token: accepted.value.token });
      expect(read.ok && isRecord(read.value) && read.value.cadenceDays).toBe(120);
    } finally { await control(null, undefined, [...config.offer.cadenceDays]); }
  }, 30_000);

  it('padded customer challenge email preserves the normalized address, public shape and floor', async () => {
    const address = `padded-${email}`;
    expect((await call('checkout.create', checkout(address))).ok).toBe(true);
    const padded = await exchange('auth.request', { email: `  ${address}  ` });
    const plain = await exchange('auth.request', { email: address });
    expect(plain.status).toBe(200);
    expect(padded.status).toBe(plain.status);
    expect(plain.body).toEqual({ ok: true, value: { accepted: true } });
    expect(padded.body).toEqual(plain.body);
    expect(plain.elapsed).toBeGreaterThanOrEqual(395);
    expect(padded.elapsed).toBeGreaterThanOrEqual(395);
    const messages = (await readFile(resolve(state, '.context/captured-messages/identity.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { email: string });
    expect(messages.at(-1)?.email).toBe(address);
  }, 30_000);

  it('shared email boundary preserves purchase, payment and later native sign-in', async () => {
    const address = 'a'.repeat(60) + '@' + 'b'.repeat(49) + '.' + 'c'.repeat(44) + '.test';
    expect(address.length).toBe(160);
    const created = await call('checkout.create', checkout(address));
    expect(created.ok).toBe(true);
    if (!created.ok || !isRecord(created.value)) throw new Error('boundary_purchase_required');
    expect((await call('payment.simulate', { orderRef: created.value.orderRef, token: created.value.token, outcome: 'captured' })).ok).toBe(true);
    expect(await call('auth.request', { email: ' ' + address.toUpperCase() + ' ' })).toEqual({ ok: true, value: { accepted: true } });
    const messages = (await readFile(resolve(state, '.context/captured-messages/identity.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { email: string; token: string });
    const challenge = messages.filter(message => message.email === address).at(-1);
    if (!challenge) throw new Error('boundary_challenge_required');
    expect((await call('auth.verify', { token: challenge.token })).ok).toBe(true);
    const orders = await call('account.orders', {}, true);
    expect(orders.ok).toBe(true);
    expect(JSON.stringify(orders)).toContain(created.value.orderRef);
    const count = async () => Number((await owner!.query('SELECT count(*) AS n FROM public.clients')).rows[0].n);
    const before = await count();
    expect(await call('checkout.create', checkout('a' + address)))
      .toEqual({ ok: false, code: 'starter_email_invalid' });
    expect(await count()).toBe(before);
    // A lower owned value governs auth too; restoring a literal 160 fails here.
    await control(null, 159);
    try {
      expect(await call('auth.request', { email: address })).toEqual({ ok: false, code: 'starter_input_invalid' });
      expect(await call('checkout.create', checkout(address))).toEqual({ ok: false, code: 'starter_email_invalid' });
      expect(await count()).toBe(before);
    } finally { await control(null, config.purchase.inputLimits.email); }
  }, 30_000);

  it('subscription address uses the checkout phone and postal bounds', async () => {
    const payload = checkout(`address-${config.id}@example.test`);
    const cart = { ...payload.cart, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays };
    const created = await call('checkout.create', await quotedSubscription({ ...payload, cart }));
    expect(created.ok).toBe(true);
    if (!created.ok || !isRecord(created.value)) throw new Error('address_purchase_required');
    expect((await call('payment.simulate', { orderRef: created.value.orderRef, token: created.value.token, outcome: 'captured' })).ok).toBe(true);
    expect((await call('auth.request', { email: payload.email })).ok).toBe(true);
    const messages = (await readFile(resolve(state, '.context/captured-messages/identity.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { email: string; token: string });
    const challenge = messages.filter(message => message.email === payload.email).at(-1);
    if (!challenge) throw new Error('address_challenge_required');
    expect((await call('auth.verify', { token: challenge.token })).ok).toBe(true);
    const subscriptionRef = (await owner!.query('SELECT subscription_id FROM public.subscription_activations WHERE order_id=$1', [created.value.orderRef])).rows[0].subscription_id;
    const address = { subscriptionRef, recipientName: 'Example Buyer', line1: '1 Example Lane', city: 'Example City',
      postalCode: '0'.repeat(config.purchase.inputLimits.postalCode), phone: '0'.repeat(config.purchase.inputLimits.phone), countryCode: config.market.country };
    expect((await call('subscription.address', address, true)).ok).toBe(true);
    for (const field of ['phone', 'postalCode'] as const) {
      expect(await call('subscription.address', { ...address, [field]: address[field] + '0' }, true))
        .toEqual({ ok: false, code: 'starter_input_invalid' });
    }
  }, 30_000);

  it('guest creation has one observable shape and floor for new, unlinked and linked e-mails', async () => {
    const connection = new URL(runtimeConnection); connection.password = 'synthetic-conformance';
    const registrar = createPostgresContactClientRegistrar({ connectionString: connection.toString() });
    const unlinked = `unlinked-${config.id}@example.test`;
    try { expect((await registrar.ensureContactClient({ email: unlinked, ...config.purchase.contact })).ok).toBe(true); }
    finally { await registrar.close(); }
    const before = (await owner!.query('SELECT row_to_json(c)::text AS bytes,xmin::text FROM public.clients c WHERE email=$1', [email])).rows[0];
    expect((await owner!.query('SELECT principal_id FROM public.clients WHERE email=$1', [email])).rows[0].principal_id).not.toBeNull();
    const results: ActionResult[] = [];
    for (const address of [`new-${config.id}@example.test`, unlinked, email]) {
      const result = await exchange('checkout.create', checkout(address));
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.elapsed).toBeGreaterThanOrEqual(config.purchase.responseFloorMs - 5);
      if (!result.body.ok || !isRecord(result.body.value)) throw new Error('guest_checkout_required');
      expect(typeof result.body.value.token).toBe('string');
      expect(JSON.stringify(result.body)).not.toMatch(/"(?:linked|created|clientId|principalId|email|account)"/);
      results.push({ ...result.body, value: { ...result.body.value, orderRef: '<order>', token: '<token>' } });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect((await owner!.query('SELECT row_to_json(c)::text AS bytes,xmin::text FROM public.clients c WHERE email=$1', [email])).rows[0]).toEqual(before);
  }, 30_000);

  for (const permissive of [false, true]) it(`retained key binds identity before contact writes with ${permissive ? 'permissive' : 'interim'} quota`, async () => {
    await control(permissive);
    const count = async () => Number((await owner!.query('SELECT count(*) AS n FROM public.clients')).rows[0].n);
    const before = await count();
    const key = randomUUID();
    const address = `bound-${permissive}-${config.id}@example.test`;
    const first = await call('checkout.create', checkout(address), false, key);
    expect(first.ok).toBe(true);
    if (!first.ok || !isRecord(first.value)) throw new Error('bound_checkout_required');
    expect(await count()).toBe(before + 1);
    const original = { ...first.value }; delete original.token;
    const changedResults: Array<Awaited<ReturnType<typeof exchange>>> = [];
    for (let index = 0; index < 5; index++) {
      const changed = await exchange('checkout.create', checkout(`changed-${permissive}-${index}-${config.id}@example.test`), false, key);
      changedResults.push(changed);
    }
    expect(await count()).toBe(before + 1);
    for (const changed of changedResults) {
      expect(changed.body).toEqual({ ok: false, code: 'starter_attempt_limited' });
      expect(changed.status).toBe(409);
      expect(changed.elapsed).toBeGreaterThanOrEqual(config.purchase.responseFloorMs - 5);
    }
    expect((await control(null)).registrations).toBe(1);
    expect(await call('checkout.create', checkout(address.toUpperCase()), false, key))
      .toEqual({ ok: true, value: original, replayed: true });
    // A fresh second key still fits the native requester quota after all refusals.
    expect((await call('checkout.create', checkout(`second-${permissive}-${config.id}@example.test`))).ok).toBe(true);
    await control(permissive);
    const concurrentBefore = await count();
    const concurrentKey = randomUUID();
    const results = await Promise.all([0, 1].map(index => call('checkout.create',
      checkout(`race-${permissive}-${index}-${config.id}@example.test`), false, concurrentKey)));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'starter_attempt_limited' }]);
    expect(await count()).toBe(concurrentBefore + 1);
    expect((await control(null)).registrations).toBe(1);
  }, 30_000);

});
