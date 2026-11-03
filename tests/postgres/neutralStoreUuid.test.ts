import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
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
  let pending: { orderRef: string; token: string };
  const paid = new Map<string, Record<string, unknown>>();
  const email = `uuid-${config.id}@example.test`;

  async function call(operation: Operation, payload: Record<string, unknown>, signedIn = false) {
    const response = await fetch(`${base}/api/actions/${operation}`, {
      method: 'POST', headers: {
        Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1',
        'Idempotency-Key': randomUUID(), ...(signedIn && cookie ? { Cookie: cookie } : {}),
      }, body: JSON.stringify(payload),
    });
    const issuedCookie = response.headers.get('set-cookie');
    if (issuedCookie) cookie = issuedCookie.split(';')[0];
    return await response.json() as ActionResult;
  }

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
    await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime', close: async () => {} });
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
    host = spawn(process.execPath, ['--experimental-strip-types', entry,
      '--configuration', config.id, '--port', String(port), '--database-url', runtimeUrl.toString()],
    { cwd: state, env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' },
      stdio: ['ignore', 'pipe', 'pipe'] });
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
      }, 10_000);

      it(`${actor} ${spelling} token orderRef pays exactly like lowercase`, async () => {
        const order = await createOrder(signedIn);
        const input = { ...order, orderRef: changeCase(order.orderRef), outcome: 'captured' };
        const result = await call('payment.simulate', input, signedIn);
        expect(result).toEqual({ ok: true, value: { ...paid.get(String(signedIn)), orderRef: order.orderRef }, replayed: false });
        expect(input.orderRef).toBe(changeCase(order.orderRef));
      }, 10_000);
    }

    for (const operation of ['checkout.read', 'payment.simulate'] as const) {
      it(`${actor} non-UUID still refuses ${operation}`, async () => {
        expect(await call(operation, { orderRef: 'invalid-order-reference', token: pending.token,
          ...(operation === 'payment.simulate' ? { outcome: 'captured' } : {}) }, signedIn))
          .toEqual({ ok: false, code: operation === 'checkout.read' ? 'starter_recovery_unavailable' : 'starter_order_not_found' });
      }, 10_000);
    }
  }
});
