import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresContactClientRegistrar, createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
import { env as processEnvironment } from 'node:process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from '@openlup/platform/migrations';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { asPostgresSqlExecutor } from '@openlup/platform/data';
import { createPostgresStorefrontObserver } from '@openlup/platform/storefront/testing';
import { applyDemoSeed, demonstrationMarker } from '../../examples/neutral-store/installation/install.ts';
import type { ActionResult, Operation } from '../../examples/neutral-store/shared/api.ts';
import { isRecord } from '../../examples/neutral-store/shared/offer.ts';
import { choices, set, type SubscriptionOffers } from '../../examples/neutral-store/shared/subscription-offer.ts';
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer, type PostgresContainerSpec,
} from '../helpers/postgresContainer.js';

const ledgerSignature = 'public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint)';
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

const scenarioSetupTimeoutMs = 30_000;
const setupJoinTimeoutMs = 2_000;
const hostTerminateTimeoutMs = 10_000;
const hostKilledCloseTimeoutMs = 2_000;
const uuidTeardownTimeoutMs = postgresTeardownTimeoutMs + 10_000;

function uuidFixture(profile: string) {
  const controller = new AbortController();
  const { signal } = controller;
  const pools: Pool[] = [];
  let container: PostgresContainer | undefined;
  let state: string | undefined;
  let child: { process: ChildProcess; closed: Promise<void>; closing?: Promise<void> } | undefined;
  let teardown: Promise<void> | undefined;
  let phase = 'initial';
  let setupFailed = false;
  let setupWork: Promise<void> | undefined;

  async function stopHost() {
    if (!child) return;
    const active = child;
    return active.closing ??= (async () => {
      const kill = setTimeout(() => active.process.kill('SIGKILL'), hostTerminateTimeoutMs);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        active.process.kill('SIGTERM');
        await Promise.race([
          active.closed,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('uuid_host_close_deadline')),
              hostTerminateTimeoutMs + hostKilledCloseTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(kill);
        clearTimeout(deadline);
      }
    })();
  }

  function report(label: string, outcome: string, started: number) {
    console.info(`uuid-host profile=${profile} phase=${label} outcome=${outcome} ms=${Math.round(performance.now() - started)}`);
  }

  async function cleanDatabaseAndScratch(started: number) {
    const failures: unknown[] = [];
    // Give an in-flight setup a bounded chance to hand back resources. Docker
    // and SQL may still be blocked, so late acquisition retains the removal
    // branch and every subsequent acquisition checks the same abort signal.
    if (setupWork) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          setupWork.catch(() => undefined),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              report(phase, 'teardown_join_deadline', started);
              resolve();
            }, setupJoinTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await closePostgres(container, pools).catch(error => failures.push(error));
    if (state) await rm(state, { recursive: true, force: true }).catch(error => failures.push(error));
    if (failures.length) {
      if (!setupFailed) throw new Error('uuid_fixture_cleanup_failed');
      report('cleanup', 'failed_after_setup_error', started);
    }
  }

  return {
    signal,
    async phase<T>(label: string, action: () => Promise<T>) {
      signal.throwIfAborted();
      phase = label;
      const started = performance.now();
      report(label, 'start', started);
      try {
        const result = await action();
        signal.throwIfAborted();
        report(label, 'ok', started);
        return result;
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        const name = (error as { name?: unknown } | undefined)?.name;
        const outcome = signal.aborted ? 'cancelled' : name === 'AssertionError' ? 'assertion'
          : typeof code === 'string' && /^[A-Z0-9_]{1,30}$/.test(code) ? code : 'failed';
        report(label, outcome, started);
        throw error;
      }
    },
    async setup(action: () => Promise<void>, timeoutMs: number) {
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        setupWork = action();
        await Promise.race([
          setupWork,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              report(phase, 'deadline', started);
              reject(new Error(`uuid_setup_deadline profile=${profile} phase=${phase} limitMs=${timeoutMs}`));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        setupFailed = true;
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async scratch() {
      signal.throwIfAborted();
      const scratch = resolve('.context/scratch');
      await mkdir(scratch, { recursive: true });
      signal.throwIfAborted();
      const directory = await mkdtemp(resolve(scratch, `starter-uuid-${profile}-`));
      if (signal.aborted) {
        await rm(directory, { recursive: true, force: true }).catch(() => report('scratch', 'late_cleanup_failed', performance.now()));
        signal.throwIfAborted();
      }
      state = directory;
      return directory;
    },
    async start(spec: PostgresContainerSpec, start = runPostgresContainer) {
      signal.throwIfAborted();
      const acquired = await start(spec);
      if (signal.aborted) {
        const started = performance.now();
        await acquired.remove().catch(() => report('container', 'late_cleanup_failed', started));
        signal.throwIfAborted();
      }
      container = acquired;
      return acquired;
    },
    pool(options: ConstructorParameters<typeof Pool>[0]) {
      signal.throwIfAborted();
      const pool = new Pool(options);
      pools.push(pool);
      return pool;
    },
    child: () => child?.process,
    ownHost(start: () => ChildProcess) {
      signal.throwIfAborted();
      const process = start();
      const closed = new Promise<void>(resolve => process.once('close', () => {
        if (child?.process === process) child = undefined;
        resolve();
      }));
      // Keep the error observed even between readiness or IPC waits.
      process.on('error', () => {});
      child = { process, closed };
      return process;
    },
    stopHost,
    teardown: () => teardown ??= (async () => {
      const started = performance.now();
      controller.abort();
      try {
        await stopHost();
      } catch (error) {
        // SIGKILL has been sent. If close is still unobserved at the deadline,
        // leave the DB owned until close rather than tearing it down underneath the child.
        void child?.closed.then(() => cleanDatabaseAndScratch(started))
          .catch(() => report('cleanup', 'late_cleanup_failed', started));
        report('host-close', 'deadline', started);
        if (!setupFailed) throw error;
        return;
      }
      await cleanDatabaseAndScratch(started);
    })(),
  };
}

function waitForHost<T>(
  host: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
  subscribe: (finish: (error: Error | undefined, value?: T) => void) => () => void,
  closeCode: () => string,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal.reason);
    const onError = () => finish(new Error(closeCode()));
    const timer = setTimeout(() => finish(new Error(timeoutCode)), timeoutMs);
    const unsubscribe = subscribe(finish);
    function finish(error: unknown, value?: T) {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      host.off('close', onError).off('error', onError);
      unsubscribe();
      if (error) reject(error);
      else resolve(value as T);
    }
    signal.addEventListener('abort', onAbort, { once: true });
    host.once('close', onError).once('error', onError);
  });
}

function controlledContainer(remove: PostgresContainer['remove']): PostgresContainer {
  const connectionString = 'postgres://127.0.0.1/neutral_store';
  return { port: 5432, connectionString, connectionStringFor: () => connectionString, remove };
}

const controlledSpec = { name: 'uuid-controlled', password: 'synthetic-conformance' };

it('admits delayed UUID provisioning without spending the scenario deadline', async () => {
  vi.useFakeTimers();
  const fixture = uuidFixture('controlled-slow');
  try {
    const provision = (owner: ReturnType<typeof uuidFixture>) => () => owner.phase('container', async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 31_000));
    });
    const legacyFixture = uuidFixture('controlled-legacy-budget');
    const baseline = expect(legacyFixture.setup(provision(legacyFixture), scenarioSetupTimeoutMs))
      .rejects.toThrow('uuid_setup_deadline');
    const split = fixture.setup(provision(fixture), postgresSetupTimeoutMs);
    await vi.advanceTimersByTimeAsync(31_000);
    await baseline;
    await split;
    const scenario = vi.fn(async () => {});
    await fixture.setup(scenario, scenarioSetupTimeoutMs);
    expect(scenario).toHaveBeenCalledOnce();
    await legacyFixture.teardown();
  } finally {
    await fixture.teardown();
    vi.useRealTimers();
  }
});

it.each([false, true])('removes a UUID container returned after cancellation (after teardown join deadline: %s)', async afterDeadline => {
  vi.useFakeTimers();
  const fixture = uuidFixture('controlled-docker');
  const directory = await fixture.scratch();
  let acquire!: (container: PostgresContainer) => void;
  const late = new Promise<PostgresContainer>(resolve => { acquire = resolve; });
  const remove = vi.fn(async () => {});
  const ready = vi.fn(async () => {});
  const setup = fixture.setup(() => fixture.start(controlledSpec, () => late).then(ready), postgresSetupTimeoutMs);
  const aborted = expect(setup).rejects.toMatchObject({ name: 'AbortError' });
  let cleaned = false;
  const cleanup = fixture.teardown().then(() => { cleaned = true; });
  try {
    await vi.advanceTimersByTimeAsync(afterDeadline ? setupJoinTimeoutMs : setupJoinTimeoutMs - 1);
    if (afterDeadline) {
      await cleanup;
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(cleaned).toBe(false);
    }
    acquire(controlledContainer(remove));
    await aborted;
    await cleanup;
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(remove).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  } finally {
    acquire(controlledContainer(remove));
    await cleanup;
    vi.useRealTimers();
  }
});

it('closes acquired UUID pools while a query is stalled and preserves the setup deadline', async () => {
  vi.useFakeTimers();
  const fixture = uuidFixture('controlled-query');
  const directory = await fixture.scratch();
  let release!: () => void;
  const query = new Promise<void>(resolve => { release = resolve; });
  const wouldStartHost = vi.fn(async () => {});
  const pool = fixture.pool({});
  const end = vi.spyOn(pool, 'end');
  const remove = vi.fn(async () => {
    expect(pool.ended).toBe(true);
    throw new Error('synthetic cleanup failure');
  });
  await fixture.start(controlledSpec, async () => controlledContainer(remove));
  const setup = fixture.setup(() => fixture.phase('roles-migrate-status', () => query)
    .then(() => fixture.phase('host-ready', wouldStartHost)), 1_000);
  const failed = expect(setup).rejects.toThrow('uuid_setup_deadline profile=controlled-query phase=roles-migrate-status');
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    const cleanup = fixture.teardown();
    await vi.advanceTimersByTimeAsync(setupJoinTimeoutMs);
    await expect(cleanup).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(wouldStartHost).not.toHaveBeenCalled();
  } finally {
    release();
    await fixture.teardown();
    vi.useRealTimers();
  }
});

it('joins a cancelled UUID host startup before closing its database and scratch', async () => {
  const fixture = uuidFixture('controlled-host');
  const directory = await fixture.scratch();
  let closed = false;
  const pool = fixture.pool({});
  const end = vi.spyOn(pool, 'end');
  const remove = vi.fn(async () => {
    expect(closed).toBe(true);
    expect(pool.ended).toBe(true);
  });
  await fixture.start(controlledSpec, async () => controlledContainer(remove));
  const child = fixture.ownHost(() => spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 1000)']));
  child.once('close', () => { closed = true; });
  const ready = waitForHost(child, fixture.signal, 10_000, 'uuid_host_start_timeout', () => () => {}, () => 'uuid_host_start_failed');
  const aborted = expect(ready).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await fixture.teardown();
    await aborted;
    expect(end).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fixture.teardown();
  }
});

it('force-closes a UUID host that ignores graceful shutdown', async () => {
  const fixture = uuidFixture('controlled-kill');
  const child = fixture.ownHost(() => spawn(process.execPath, ['--eval',
    'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000); process.send("ready");',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  const ready = waitForHost(child, fixture.signal, 5_000, 'uuid_child_controlled_timeout', finish => {
    const onMessage = () => finish(undefined);
    child.once('message', onMessage);
    return () => child.off('message', onMessage);
  }, () => 'uuid_host_start_failed');
  try {
    await ready;
    vi.useFakeTimers();
    const cleanup = fixture.teardown();
    await vi.advanceTimersByTimeAsync(hostTerminateTimeoutMs);
    await cleanup;
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    vi.useRealTimers();
    await fixture.teardown();
  }
});

describe.each(Object.values(configurations))('$id host UUID identity', config => {
  const fixture = uuidFixture(config.id);
  let owner: Pool;
  let base: string;
  let state: string;
  let cookie: string | undefined;
  let runtimeConnection: string;
  let pending: { orderRef: string; token: string };
  const paid = new Map<string, Record<string, unknown>>();
  const email = `uuid-${config.id}@example.test`;

  async function exchange(operation: Operation, payload: Record<string, unknown>, signedIn = false, key: string = randomUUID()) {
    const started = performance.now();
    const response = await fetch(`${base}/api/actions/${operation}`, {
      method: 'POST', headers: {
        Origin: base, 'Content-Type': 'application/json', 'X-Starter-Request': '1',
        'Idempotency-Key': key, ...(signedIn && cookie ? { Cookie: cookie } : {}),
      }, body: JSON.stringify(payload), signal: fixture.signal,
    });
    const issuedCookie = response.headers.get('set-cookie');
    if (issuedCookie) cookie = issuedCookie.split(';')[0];
    return { body: await response.json() as ActionResult, status: response.status, elapsed: performance.now() - started };
  }

  async function call(operation: Operation, payload: Record<string, unknown>, signedIn = false, key: string = randomUUID()) {
    return (await exchange(operation, payload, signedIn, key)).body;
  }

  async function review(payload: Record<string, unknown>, signedIn = false) {
    const quoted = await call('offer.validate', payload, signedIn);
    expect(quoted.ok).toBe(true);
    if (!quoted.ok || !isRecord(quoted.value)) throw new Error('host_server_quote_required');
    return quoted.value;
  }

  async function quotedSubscription(payload: Record<string, unknown>) {
    const capable = { ...payload, acquisitionCapability: 'subscription-acquisition.v1' };
    const quote = await review(capable);
    return { ...capable, quoteAcceptance: quote.quoteAcceptance, expectedTotal: quote.expectedTotal };
  }

  async function control(permissive: boolean | null, emailLimit?: number, subscriptionOffers?: SubscriptionOffers,
    attemptLimits?: Partial<typeof config.purchase.attemptLimits>) {
    const host = fixture.child()!;
    return waitForHost<{ registrations: number }>(host, fixture.signal, 5_000, 'host_control_timeout', finish => {
      const onMessage = (message: unknown) => finish(undefined, message as { registrations: number });
      host.once('message', onMessage);
      host.send({ permissive, emailLimit, subscriptionOffers, attemptLimits }, error => {
        if (error) finish(new Error('host_control_failed'));
      });
      return () => host.off('message', onMessage);
    }, () => 'host_control_failed');
  }

  const checkout = (address: string) => ({
    locale: 'en', email: address, configuration: config.id, country: config.market.country,
    termsAccepted: true, termsRevision: config.legal.revision,
    firstName: 'Example', lastName: 'Buyer', phone: '000000000',
    line1: '1 Example Lane', city: 'Example City', postalCode: '00000',
    cart: { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null,
      lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] },
  });

  async function reviewedCheckout(address: string, signedIn = false) {
    const input = checkout(address);
    const quote = await review(input, signedIn);
    return { ...input, expectedTotal: quote.expectedTotal };
  }

  async function createOrder(signedIn = false) {
    const result = await call('checkout.create', await reviewedCheckout(email, signedIn), signedIn);
    if (!result.ok || !isRecord(result.value)
      || typeof result.value.orderRef !== 'string' || typeof result.value.token !== 'string') {
      throw new Error('uuid_host_checkout_required');
    }
    return { orderRef: result.value.orderRef, token: result.value.token };
  }

  async function startHost(stopAtContact = false) {
    // Keep the real HTTP host and its strict compiler profile in the child.
    const entry = resolve('examples/neutral-store/host/server.ts');
    // Child-only composition uses the real HTTP host and restricted native ports.
    // IPC configures the existing callback and registrar seams.
    const bootstrap = String.raw`
      import { pathToFileURL } from 'node:url';
      import { Pool } from 'pg';
      import { createPostgresContactClientRegistrar } from '@openlup/platform/identity';
      import { createPostgresRoleFreeTransactionLane } from '@openlup/platform/data';
      import { createPostgresCheckoutRecoveryTokenPort } from '@openlup/platform/commerce/server';
      import { bindScenarioServer } from ${JSON.stringify(pathToFileURL(resolve('tests/helpers/neutralStoreScenario.mjs')).href)};
      const entry = ${JSON.stringify(entry)};
      const load = relative => import(new URL(relative, pathToFileURL(entry)).href);
      const { server, port, base } = await bindScenarioServer();
      const { createApplication } = await load('./server.ts');
      const { composeNativeBindings } = await load('./native-composition.ts');
      const { composePurchaseCapabilities } = await load('./purchase-composition.ts');
      const { createCheckoutRecoveryDelivery } = await load('./checkout-recovery.ts');
      const { createOriginPolicy } = await load('./origin-policy.ts');
      const { selectConfiguration } = await load('../owned/store.config.ts');
      const config = selectConfiguration(${JSON.stringify(config.id)});
      const connectionString = ${JSON.stringify(runtimeConnection)};
      process.chdir(${JSON.stringify(state)});
      const keyring = { current: 'fixture-only-acceptance-key-00000000000000' };
      // The requester key seam: every quota consumer must receive this replacement.
      const { createHash } = await import('node:crypto');
      const requesterKey = request => createHash('sha256').update('fixture-requester:' + request.socket.remoteAddress).digest('hex');
      const bindings = await composeNativeBindings(connectionString, createOriginPolicy(config, port), config, keyring, undefined, { requesterKey });
      const stopAtContact = ${stopAtContact};
      const pool = new Pool({ connectionString, ...(stopAtContact ? { max: 1, connectionTimeoutMillis: 1000 } : {}) });
      const registrar = createPostgresContactClientRegistrar({ connectionString });
      const lane = createPostgresRoleFreeTransactionLane({ connectionString });
      const recovery = { tokens: createPostgresCheckoutRecoveryTokenPort(lane), deliver: createCheckoutRecoveryDelivery(base) };
      let registrations = 0;
      const contacts = { ensureContactClient: input => {
        registrations++;
        return stopAtContact ? { ok: false } : registrar.ensureContactClient(input);
      }, close: async () => {} };
      function configureCheckout(permissive) {
        config.purchase.attemptLimits = { ...config.purchase.attemptLimits,
          ...(stopAtContact ? { maxPerEmail: 1 } : { maxPerEmail: 2, maxPerRequester: 3, maxEntries: 8 }) };
        registrations = 0;
        bindings.actions['checkout.create'] = composePurchaseCapabilities(pool, contacts,
          permissive ? async () => ({ allowed: true }) : undefined, recovery,
          { keyring, ...(stopAtContact ? { bindContact: () => contacts } : {}) })['checkout.create'];
      }
      if (stopAtContact) configureCheckout(false);
      process.on('message', message => {
        if (message.subscriptionOffers !== undefined) config.subscriptionOffers = message.subscriptionOffers;
        if (message.emailLimit !== undefined) config.purchase.inputLimits.email = message.emailLimit;
        if (message.permissive !== null) configureCheckout(message.permissive);
        if (message.attemptLimits !== undefined) config.purchase.attemptLimits = { ...config.purchase.attemptLimits, ...message.attemptLimits };
        process.send({ registrations });
      });
      server.on('request', createApplication(bindings).listeners('request')[0]);
      process.stdout.write('Neutral store local candidate: ' + base + '\n');
      process.once('SIGTERM', () => server.close(async () => {
        await Promise.all([bindings.close(), pool.end(), registrar.close(), lane.close()]);
        process.disconnect();
      }));
    `;
    const host = fixture.ownHost(() => spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', bootstrap,
      'starter-host-proof', '--configuration', config.id, '--database-url', runtimeConnection],
    { cwd: resolve('.'), env: { ...processEnvironment, PGPASSWORD: 'synthetic-conformance' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    let startupRefusal: string | undefined;
    try {
      base = await waitForHost<string>(host, fixture.signal, 10_000, 'uuid_host_start_timeout', finish => {
        const onError = (chunk: string) => {
          startupRefusal ??= /Error: (starter_checkout_attempt_ledger_(?:missing|execute_required|check_failed))\b/.exec(chunk)?.[1];
        };
        let output = '';
        const onOutput = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-2048);
          const origin = /Neutral store local candidate: (http:\/\/127\.0\.0\.1:\d+)\n/.exec(output)?.[1];
          if (origin) finish(undefined, origin);
        };
        host.stderr?.setEncoding('utf8').on('data', onError);
        host.stdout?.on('data', onOutput);
        return () => {
          host.stderr?.off('data', onError).resume();
          host.stdout?.off('data', onOutput).resume();
        };
      }, () => startupRefusal ?? 'uuid_host_start_failed');
    } catch (error) {
      await fixture.stopHost().catch(() => console.info(`uuid-host profile=${config.id} phase=host-ready outcome=cleanup_failed`));
      throw error;
    }
  }

  const { stopHost } = fixture;

  beforeAll(() => fixture.setup(async () => {
    state = await fixture.phase('scratch', () => fixture.scratch());
    const container = await fixture.phase('container', async () => {
      if (!await dockerAvailable()) throw new Error('UUID host proof requires Docker PostgreSQL');
      return fixture.start({
        name: `starter-uuid-${config.id}-${process.pid}`, database: 'neutral_store', password: 'synthetic-conformance',
      });
    });
    await fixture.phase('tcp-ready', async () => {
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('UUID PostgreSQL unavailable');
    });
    await fixture.phase('roles-migrate-status', async () => {
      owner = fixture.pool({ connectionString: container.connectionString });
      for (const role of ['starter_runtime', 'starter_restore']) {
        fixture.signal.throwIfAborted();
        await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
      }
      const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres',
        migrationLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
      const migration = fixture.pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
      const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, {
        installation: selection, poolFactory: () => {
          fixture.signal.throwIfAborted();
          return migration;
        },
      });
      await runner.apply();
      fixture.signal.throwIfAborted();
      expect((await runner.status()).pending).toEqual([]);
    });
    await fixture.phase('seed', async () => {
      await owner.query(`COMMENT ON DATABASE neutral_store IS '${demonstrationMarker}'`);
      fixture.signal.throwIfAborted();
      await applyDemoSeed(config, { connection: owner, installRole: 'postgres', runtimeRole: 'starter_runtime',
        stock: createPostgresFulfillmentStockSyncPort(owner, { sourceKey: `starter-demo:${config.id}`, readLocalInventoryStock: async () => [] }),
        close: async () => {} });
    });
    const runtimeUrl = new URL(container.connectionString);
    runtimeUrl.username = 'starter_runtime';
    runtimeUrl.protocol = 'postgresql:';
    runtimeUrl.password = '';
    runtimeConnection = runtimeUrl.toString();
  }, postgresSetupTimeoutMs), postgresSetupTimeoutMs + 1_000);

  beforeAll(() => fixture.setup(() => fixture.phase('host-ready', () => startHost()), 10_000), 11_000);

  beforeAll(() => fixture.setup(() => fixture.phase('checkout-auth-payment', async () => {
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
  }), scenarioSetupTimeoutMs), scenarioSetupTimeoutMs + 1_000);

  afterAll(fixture.teardown, uuidTeardownTimeoutMs);

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
  it('owned cadence maximum accepts 89 with readback and refuses 90 before contact resolution', async () => {
    const before = Number((await owner!.query('SELECT count(*) AS count FROM public.clients')).rows[0].count);
    const registrations = (await control(null)).registrations;
    try {
      // Both days fit the native 90-day limit. Only the owned offer admits 89;
      // exercise HTTP admission independently of startup validation and the UI projection.
      const offers = structuredClone(config.subscriptionOffers), plan = offers.classic;
      plan.days = set(...choices(plan.days), 89);
      plan.checkoutDays = plan.days;
      plan.bySku = Object.fromEntries(Object.entries(plan.bySku).map(([sku, rules]) =>
        [sku, rules.map(rule => ({ ...rule, days: set(...choices(rule.days), 89) }))]));
      await control(null, undefined, offers);
      const input = checkout(`cadence-${config.id}@example.test`);
      const reviewed = await quotedSubscription({ ...input, cart: { ...input.cart, mode: 'subscription', cadenceDays: 89 } });
      const refused = await call('checkout.create', { ...reviewed, cart: { ...input.cart, mode: 'subscription', cadenceDays: 90 } });
      expect(refused).toEqual({ ok: false, code: 'cadence_unavailable' });
      expect(Number((await owner!.query('SELECT count(*) AS count FROM public.clients')).rows[0].count)).toBe(before);
      expect((await control(null)).registrations).toBe(registrations);
      const accepted = await call('checkout.create', reviewed);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok || !isRecord(accepted.value)) throw new Error('cadence_purchase_required');
      const read = await call('checkout.read', { orderRef: accepted.value.orderRef, token: accepted.value.token });
      expect(read.ok && isRecord(read.value) && read.value.cadenceDays).toBe(89);
    } finally { await control(null, undefined, config.subscriptionOffers); }
  }, 30_000);

  it('padded customer challenge email preserves the normalized address, public shape and floor', async () => {
    const address = `padded-${email}`;
    expect((await call('checkout.create', await reviewedCheckout(address))).ok).toBe(true);
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
    const created = await call('checkout.create', await reviewedCheckout(address));
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
      const result = await exchange('checkout.create', await reviewedCheckout(address));
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

  const ledger = async () => (await owner!.query(
    'SELECT * FROM public.commerce_checkout_attempt_ledger ORDER BY attempt_digest')).rows;
  const purchaseCounts = async () => (await owner!.query(`SELECT
    (SELECT count(*) FROM public.clients) AS clients, (SELECT count(*) FROM public.commerce_orders) AS orders`)).rows[0];

  it('native checkout records its attempt and fails closed when runtime EXECUTE is revoked', async () => {
    await stopHost();
    await startHost();
    const previous = new Set((await ledger()).map(row => row.attempt_digest));
    const key = randomUUID();
    expect((await call('checkout.create', await reviewedCheckout(`native-ledger-${config.id}@example.test`), false, key)).ok).toBe(true);
    const recorded = await ledger();
    expect(recorded.filter(row => !previous.has(row.attempt_digest)).map(row => row.attempt_digest))
      // The limiter receives the derived key, never the header value.
      .toEqual([createHash('sha256').update(`${derivedKey(key)}\0${0}`).digest('hex')]);

    const before = await purchaseCounts();
    // The restricted runtime inherits this grant through service_role.
    await owner!.query(`REVOKE EXECUTE ON FUNCTION ${ledgerSignature} FROM service_role`);
    try {
      expect(await call('checkout.create', await reviewedCheckout(`native-ledger-refused-${config.id}@example.test`)))
        .toEqual({ ok: false, code: 'starter_attempt_limited' });
      expect(await purchaseCounts()).toEqual(before);
      expect(await ledger()).toEqual(recorded);
    } finally {
      await owner!.query(`GRANT EXECUTE ON FUNCTION ${ledgerSignature} TO service_role`);
    }
  }, 30_000);

  it('limiter_survives_restart on the held session with a one-client pool', async () => {
    await stopHost();
    await startHost(true);
    const before = await purchaseCounts();
    const input = await reviewedCheckout(`restart-${config.id}@example.test`);
    const key = randomUUID();
    const digest = createHash('sha256').update(`${derivedKey(key)}\0${0}`).digest('hex');
    const stopped = { ok: false, code: 'starter_purchase_unavailable' };
    expect(await call('checkout.create', input, false, key)).toEqual(stopped);
    expect((await control(null)).registrations).toBe(1);
    const original = await ledger();
    expect(original).toContainEqual(expect.objectContaining({ attempt_digest: digest }));
    expect(await purchaseCounts()).toEqual(before);

    await stopHost();
    await startHost(true);
    expect((await exchange('checkout.create', input)).body).toEqual({ ok: false, code: 'starter_attempt_limited' });
    expect((await control(null)).registrations).toBe(0);
    expect(await purchaseCounts()).toEqual(before);
    expect(await call('checkout.create', input, false, key)).toEqual(stopped);
    expect((await control(null)).registrations).toBe(1);
    expect(await ledger()).toEqual(original);
    expect(await purchaseCounts()).toEqual(before);
  }, 45_000);

  it('native startup requires the ledger and runtime EXECUTE', async () => {
    await stopHost();
    const before = await ledger();
    await owner!.query(`ALTER FUNCTION ${ledgerSignature} RENAME TO checkout_attempt_ledger_fixture`);
    try { await expect(startHost()).rejects.toThrow('starter_checkout_attempt_ledger_missing'); }
    finally {
      await owner!.query(`ALTER FUNCTION ${ledgerSignature.replace('commerce_record_checkout_attempt', 'checkout_attempt_ledger_fixture')}
        RENAME TO commerce_record_checkout_attempt`);
    }
    await owner!.query(`REVOKE EXECUTE ON FUNCTION ${ledgerSignature} FROM service_role`);
    try { await expect(startHost()).rejects.toThrow('starter_checkout_attempt_ledger_execute_required'); }
    finally { await owner!.query(`GRANT EXECUTE ON FUNCTION ${ledgerSignature} TO service_role`); }
    await startHost();
    expect(await ledger()).toEqual(before);
  }, 45_000);

  for (const permissive of [false, true]) it(`retained key binds identity before contact writes with ${permissive ? 'permissive' : 'default'} quota`, async () => {
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    await control(permissive);
    const ledgerBefore = await ledger();
    const count = async () => Number((await owner!.query('SELECT count(*) AS n FROM public.clients')).rows[0].n);
    const before = await count();
    const key = randomUUID();
    const address = `bound-${permissive}-${config.id}@example.test`;
    const input = await reviewedCheckout(address);
    const first = await call('checkout.create', input, false, key);
    expect(first.ok).toBe(true);
    if (!first.ok || !isRecord(first.value)) throw new Error('bound_checkout_required');
    expect(await count()).toBe(before + 1);
    const original = { ...first.value }; delete original.token;
    const afterFirst = await ledger();
    expect(afterFirst).toHaveLength(permissive ? 0 : 1);
    const changedResults: Array<Awaited<ReturnType<typeof exchange>>> = [];
    for (let index = 0; index < 5; index++) {
      const changed = await exchange('checkout.create', { ...input, email: `changed-${permissive}-${index}-${config.id}@example.test` }, false, key);
      changedResults.push(changed);
    }
    expect(await count()).toBe(before + 1);
    // A key bound to another e-mail is a changed payload: metered per key, and named until the key's quota is spent.
    expect(changedResults.map(changed => changed.body)).toEqual(Array.from({ length: 5 }, (_, index) =>
      ({ ok: false, code: permissive || index < 2 ? 'starter_checkout_changed' : 'starter_attempt_limited' })));
    for (const changed of changedResults) {
      expect(changed.status).toBe(409);
      expect(changed.elapsed).toBeGreaterThanOrEqual(config.purchase.responseFloorMs - 5);
    }
    expect((await control(null)).registrations).toBe(1);
    const repeated = await call('checkout.create', { ...input, email: address.toUpperCase() }, false, key);
    if (permissive) {
      // The exact repeat is admitted and returns a new way to pay.
      expect(repeated.ok && isRecord(repeated.value) && typeof repeated.value.token).toBe('string');
      if (!repeated.ok || !isRecord(repeated.value)) throw new Error('bound_repeat_required');
      const { token: _token, ...value } = repeated.value;
      expect({ ...repeated, value }).toEqual({ ok: true, value: original, replayed: true });
    } else {
      // The key's quota is spent: the order is returned without a token.
      expect(repeated).toEqual({ ok: true, value: original, replayed: true });
    }
    expect(await ledger()).toHaveLength(permissive ? 0 : 3);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    // A fresh second key still fits the native requester quota after all refusals.
    expect((await call('checkout.create', await reviewedCheckout(`second-${permissive}-${config.id}@example.test`))).ok).toBe(true);
    await control(permissive);
    const concurrentBefore = await count();
    const concurrentKey = randomUUID();
    const results = await Promise.all([0, 1].map(index => call('checkout.create',
      { ...input, email: `race-${permissive}-${index}-${config.id}@example.test` }, false, concurrentKey)));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'starter_checkout_changed' }]);
    expect(await count()).toBe(concurrentBefore + 1);
    expect((await control(null)).registrations).toBe(1);
    const afterRace = await ledger();
    if (permissive) expect(afterRace).toEqual(ledgerBefore);
    else expect(afterRace).toHaveLength(3);
  }, 30_000);

  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const derivedKey = (header: string) => `checkout:${digest(JSON.stringify([null, header]))}`;
  const fixtureRequester = digest('fixture-requester:127.0.0.1');
  const tokenCount = async (orderRef: string) => Number((await owner!.query(
    'SELECT count(*) AS n FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1', [orderRef])).rows[0].n);
  const capturedRecoveries = async () => (await readdir(resolve(state, '.context/captured-messages')).catch(() => [] as string[]))
    .filter(name => name.endsWith('.json')).length;
  const repeatLimits = { maxPerEmail: 4, maxPerRequester: 12, maxEntries: 50 };
  // Host restarts in earlier cases drop in-memory sessions, so each case signs in again.
  const mailbox = async () => (await readFile(resolve(state, '.context/captured-messages/identity.jsonl'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { email: string; token: string });
  /** Requests a challenge and waits for its delivery: acceptance can precede the private mailbox write. */
  async function freshChallenge(operation: 'auth.request' | 'auth.operator', address: string) {
    const prior = new Set((await mailbox()).filter(row => row.email === address).map(row => row.token));
    expect((await call(operation, { email: address })).ok).toBe(true);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const message = (await mailbox()).filter(row => row.email === address && !prior.has(row.token)).at(-1);
      if (message) return message.token;
      if (Date.now() > deadline) throw new Error(`${operation}_challenge_missing`);
      await new Promise(done => setTimeout(done, 25));
    }
  }
  async function signIn(address: string) {
    const token = await freshChallenge('auth.request', address);
    expect((await call('auth.verify', { token })).ok).toBe(true);
  }
  async function guestOrder(label: string, key = randomUUID()) {
    const input = await reviewedCheckout(`${label}-${config.id}@example.test`);
    const created = await call('checkout.create', input, false, key);
    if (!created.ok || !isRecord(created.value) || typeof created.value.token !== 'string') throw new Error(`${label}_checkout_required`);
    return { key, input, orderRef: String(created.value.orderRef), token: created.value.token, value: created.value };
  }

  it('a repeat of a completed guest checkout is counted and returns a new token', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const first = await guestOrder('repeat');
    const [fresh] = await ledger();
    // The replaced requester function is the value the limiter receives.
    expect(fresh.requester_digest).toBe(fixtureRequester);
    expect(fresh.email_digest).toBe(digest(`repeat-${config.id}@example.test`));
    const captured = await capturedRecoveries();
    expect(captured).toBeGreaterThan(0);
    const tokens = new Set([first.token]);
    for (let index = 1; index <= 2; index++) {
      const repeated = await call('checkout.create', first.input, false, first.key);
      if (!repeated.ok || !isRecord(repeated.value) || typeof repeated.value.token !== 'string') throw new Error('repeat_token_required');
      expect(repeated.replayed).toBe(true);
      expect(repeated.value.orderRef).toBe(first.orderRef);
      tokens.add(repeated.value.token);
      const rows = await ledger();
      expect(rows).toHaveLength(1 + index);
      for (const row of rows.filter(row => row.attempt_digest !== fresh.attempt_digest)) {
        expect(row.email_digest).toBe(digest(`replay:${derivedKey(first.key)}`));
        expect(row.email_digest).not.toBe(fresh.email_digest);
        expect(row.requester_digest).toBe(digest(`replay:${fixtureRequester}`));
      }
      const read = await call('checkout.read', { orderRef: first.orderRef, token: repeated.value.token });
      expect(read.ok && isRecord(read.value) && read.value.orderRef).toBe(first.orderRef);
    }
    expect(tokens.size).toBe(3);
    expect(await tokenCount(first.orderRef)).toBe(3);
    // Earlier links stay valid, and no repeat sends mail.
    expect((await call('checkout.read', { orderRef: first.orderRef, token: first.token })).ok).toBe(true);
    expect(await capturedRecoveries()).toBe(captured);
  }, 30_000);

  it('repeats beyond the per-key quota are refused and issue nothing', async () => {
    await control(false, undefined, undefined, { maxPerEmail: 2, maxPerRequester: 12, maxEntries: 50 });
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const first = await guestOrder('quota');
    for (let index = 0; index < 2; index++) {
      const repeated = await call('checkout.create', first.input, false, first.key);
      expect(repeated.ok && isRecord(repeated.value) && typeof repeated.value.token).toBe('string');
    }
    const issued = await tokenCount(first.orderRef);
    const rows = await ledger();
    const limited = await call('checkout.create', first.input, false, first.key);
    const { token: _token, ...value } = first.value;
    expect(limited).toEqual({ ok: true, value, replayed: true });
    expect(await tokenCount(first.orderRef)).toBe(issued);
    expect(await ledger()).toEqual(rows);
    // The buyer's e-mail quota was not consumed by the repeats.
    expect((await call('checkout.create', await reviewedCheckout(`quota-${config.id}@example.test`))).ok).toBe(true);
  }, 30_000);

  it('checkout.continuation resumes by key', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const pendingOrder = await guestOrder('resume');
    const resumed = await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, pendingOrder.key);
    if (!resumed.ok || !isRecord(resumed.value) || typeof resumed.value.token !== 'string') throw new Error('resume_token_required');
    const { token: _token, ...value } = pendingOrder.value;
    expect({ ...resumed, value: { ...resumed.value, token: '<token>' } }).toEqual({ ok: true, value: { ...value, token: '<token>' }, replayed: true });
    const read = await call('checkout.read', { orderRef: pendingOrder.orderRef, token: resumed.value.token });
    expect(read.ok && isRecord(read.value) && read.value.status).toBe('pending_payment');
    const paidOrder = await guestOrder('resume-paid');
    expect((await call('payment.simulate', { orderRef: paidOrder.orderRef, token: paidOrder.token, outcome: 'captured' })).ok).toBe(true);
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, paidOrder.key))
      .toEqual({ ok: true, value: { ...value, orderRef: paidOrder.orderRef, status: 'paid' }, replayed: true });
    const closedOrder = await guestOrder('resume-closed');
    await owner!.query('SELECT public.commerce_cancel_abandoned_purchase_checkout($1,$2::uuid,$3,now())',
      [`fixture-close:${closedOrder.orderRef}`, closedOrder.orderRef, 'fixture_closed']);
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, closedOrder.key))
      .toEqual({ ok: false, code: 'starter_checkout_not_payable' });
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }))
      .toEqual({ ok: false, code: 'starter_checkout_not_found' });
  }, 30_000);

  it('a guest key works without the contact e-mail and is useless to another principal', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const order = await guestOrder('bearer');
    const resumed = await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, order.key);
    expect(resumed.ok && isRecord(resumed.value) && typeof resumed.value.token).toBe('string');
    // The buyer's own principal does not address the guest key either.
    await signIn(`bearer-${config.id}@example.test`);
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, true, order.key))
      .toEqual({ ok: false, code: 'starter_checkout_not_found' });
  }, 30_000);

  it('the stored journey key is the derived key', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const order = await guestOrder('journey');
    const { rows: [client] } = await owner!.query(`SELECT c.metadata->'checkout'->>'lastIntentIdempotencyKey' AS key, row_to_json(c)::text AS bytes
      FROM public.clients c JOIN public.commerce_orders o ON o.client_id=c.id WHERE o.id=$1`, [order.orderRef]);
    expect(client.key).toBe(derivedKey(order.key));
    expect(client.bytes).not.toContain(order.key);
  }, 30_000);

  it('continuation is metered for known keys only and requires a version 4 key', async () => {
    await control(false, undefined, undefined, { maxPerEmail: 2, maxPerRequester: 12, maxEntries: 50 });
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    for (let index = 0; index < 4; index++) {
      expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }))
        .toEqual({ ok: false, code: 'starter_checkout_not_found' });
    }
    expect(await ledger()).toEqual([]);
    for (const header of ['fictional-command-0001', randomUUID().replace(/^(.{14})4/, '$11')]) {
      expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, header))
        .toEqual({ ok: false, code: 'starter_input_invalid' });
    }
    expect(await ledger()).toEqual([]);
    const order = await guestOrder('probe');
    for (let index = 0; index < 2; index++) {
      const resumed = await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, order.key);
      expect(resumed.ok && isRecord(resumed.value) && typeof resumed.value.token).toBe('string');
    }
    expect(await ledger()).toHaveLength(3);
    const limited = await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, order.key);
    const { token: _token, ...value } = order.value;
    expect(limited).toEqual({ ok: true, value, replayed: true });
    expect(await ledger()).toHaveLength(3);
  }, 30_000);

  /** Polls until `minimum` backends wait on a lock held by `holder`, or the bound passes; returns how many did. */
  async function blockedBy(holder: number, minimum: number, boundMs = 5_000) {
    const deadline = performance.now() + boundMs;
    for (;;) {
      const count = Number((await owner!.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND $1::integer = ANY(pg_blocking_pids(pid))`, [holder])).rows[0].n);
      if (count >= minimum || performance.now() > deadline) return count;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  it('checkout.continuation waits for the key lock and many calls complete on the small pool', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const order = await guestOrder('locked');
    const holder = await owner!.connect();
    try {
      const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [derivedKey(order.key)]);
      let settled = false;
      const waiting = call('checkout.continuation', { action: 'resume', locale: 'en' }, false, order.key)
        .finally(() => { settled = true; });
      // The continuation's session waits on the advisory key lock held here.
      expect(await blockedBy(pid, 1)).toBe(1);
      expect(settled).toBe(false);
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [derivedKey(order.key)]);
      const resumed = await waiting;
      expect(resumed.ok && isRecord(resumed.value) && resumed.value.orderRef).toBe(order.orderRef);
    } finally { holder.release(); }
    // More calls than pooled connections all complete, each issuing a token while it holds a session and its key lock.
    const orders: Awaited<ReturnType<typeof guestOrder>>[] = [];
    // Five callers against four pooled connections.
    for (let index = 0; index < 5; index++) orders.push(await guestOrder(`pool-${index}`));
    const answers = await Promise.all(orders.map(known => call('checkout.continuation', { action: 'resume', locale: 'en' }, false, known.key)));
    for (const [index, answer] of answers.entries()) {
      expect(answer.ok && isRecord(answer.value) && answer.value.orderRef).toBe(orders[index]!.orderRef);
      expect(answer.ok && isRecord(answer.value) && typeof answer.value.token).toBe('string');
    }
  }, 60_000);


  const held = async (orderRef: string) => Number((await owner!.query(`SELECT count(*) AS n FROM public.fulfillment_inventory_reservations
    WHERE purchase_order_id=$1 AND status='held'`, [orderRef])).rows[0].n);
  const orderStatus = async (orderRef: string) => (await owner!.query('SELECT status FROM public.commerce_orders WHERE id=$1', [orderRef])).rows[0].status;
  const abandon = (key: string, signedIn = false) => call('checkout.continuation', { action: 'abandon', locale: 'en' }, signedIn, key);

  it('checkout.continuation abandons by key', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const order = await guestOrder('abandon');
    expect(await held(order.orderRef)).toBeGreaterThan(0);
    expect(await abandon(order.key)).toEqual({ ok: true, value: { abandoned: true, orderRef: order.orderRef } });
    expect(await orderStatus(order.orderRef)).toBe('cancelled');
    expect(await held(order.orderRef)).toBe(0);
    expect((await owner!.query('SELECT failure_reason FROM public.commerce_settlement_intents WHERE order_id=$1', [order.orderRef])).rows)
      .toEqual([{ failure_reason: 'checkout_started_over' }]);
    expect(await abandon(order.key)).toEqual({ ok: true, value: { abandoned: false, orderRef: order.orderRef, status: 'cancelled' } });
    expect(await call('checkout.create', order.input, false, order.key))
      .toEqual({ ok: false, code: 'starter_checkout_not_payable' });
    expect(await abandon(randomUUID())).toEqual({ ok: true, value: { abandoned: false } });
    const paidOrder = await guestOrder('abandon-paid');
    expect((await call('payment.simulate', { orderRef: paidOrder.orderRef, token: paidOrder.token, outcome: 'captured' })).ok).toBe(true);
    expect(await abandon(paidOrder.key)).toEqual({ ok: false, code: 'starter_checkout_paid' });
    // A provider attempt that ever happened keeps the order out of the start-over path.
    const attempted = await guestOrder('abandon-attempted');
    expect((await call('payment.simulate', { orderRef: attempted.orderRef, token: attempted.token, outcome: 'refused' })).ok).toBe(true);
    expect(await abandon(attempted.key)).toEqual({ ok: false, code: 'starter_checkout_not_abandonable' });
    expect(await orderStatus(attempted.orderRef)).toBe('pending_payment');
    // The signed-in principal cannot address a guest key.
    const guestKey = (await guestOrder('abandon-bearer')).key;
    await signIn(`abandon-bearer-${config.id}@example.test`);
    expect(await abandon(guestKey, true)).toEqual({ ok: true, value: { abandoned: false } });
    expect((await abandon(guestKey)).ok).toBe(true);
  }, 45_000);

  it('abandon racing a capture ends in exactly one of paid or cancelled', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const order = await guestOrder('race');
    const holder = await owner!.connect();
    let outcomes: [ActionResult, ActionResult];
    try {
      const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [order.orderRef]);
      const racing = Promise.all([abandon(order.key),
        call('payment.simulate', { orderRef: order.orderRef, token: order.token, outcome: 'captured' })]);
      // Contention is proved, not assumed: at least one racer waits on the held order row.
      expect(await blockedBy(pid, 2)).toBeGreaterThanOrEqual(1);
      await holder.query('ROLLBACK');
      outcomes = await racing;
    } finally { holder.release(); }
    const [abandoned, captured] = outcomes;
    const status = await orderStatus(order.orderRef);
    expect(['paid', 'cancelled']).toContain(status);
    if (status === 'cancelled') {
      expect(abandoned).toEqual({ ok: true, value: { abandoned: true, orderRef: order.orderRef } });
      expect(captured.ok).toBe(false);
      expect(await held(order.orderRef)).toBe(0);
      expect(await call('checkout.create', order.input, false, order.key))
        .toEqual({ ok: false, code: 'starter_checkout_not_payable' });
    } else {
      expect(captured.ok).toBe(true);
      // A capture recorded before abandon decides answers paid. A capture still in flight when the
      // compensation port runs leaves the order unpaid at that moment, so abandon names it not abandonable.
      expect(['starter_checkout_paid', 'starter_checkout_not_abandonable']).toContain(!abandoned.ok && abandoned.code);
    }
    expect((await owner!.query(`SELECT count(*) AS n FROM public.outbox_events WHERE event_type='commerce.checkout.expired'
      AND idempotency_key=$1`, [`checkout_expired:${order.orderRef}`])).rows[0].n).toBe('0');
  }, 45_000);

  // The store's operator path: a provisioned human administrator with a Commerce operator row.
  let operatorCookie: string | undefined;
  let operatorId: string | undefined;
  async function operatorCall(operation: Operation, payload: Record<string, unknown>) {
    const address = `operator-${config.id}@example.test`;
    if (!operatorId) {
      // Bootstrapping happens once per installation; a later sign-in failure must not try it again.
      const connection = new URL(runtimeConnection); connection.password = 'synthetic-conformance';
      const operators = createPostgresOperatorIdentityStore({ connectionString: connection.toString() });
      try { operatorId = (await operators.bootstrapFirstAdministrator({ email: address })).principalId; }
      finally { await operators.close(); }
      await owner!.query('INSERT INTO public.commerce_operators(id,label) VALUES($1,$2) ON CONFLICT DO NOTHING', [operatorId, 'Synthetic operator']);
    }
    if (!operatorCookie) {
      const token = await freshChallenge('auth.operator', address);
      const verified = await fetch(`${base}/api/actions/auth.operator`, { method: 'POST', headers: { Origin: base,
        'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ token }), signal: fixture.signal });
      expect(((await verified.json()) as ActionResult).ok).toBe(true);
      operatorCookie = verified.headers.get('set-cookie')!.split(';')[0];
    }
    const response = await fetch(`${base}/api/actions/${operation}`, { method: 'POST', headers: { Origin: base,
      'Content-Type': 'application/json', 'X-Starter-Request': '1', 'Idempotency-Key': randomUUID(), Cookie: operatorCookie! },
      body: JSON.stringify(payload), signal: fixture.signal });
    return await response.json() as ActionResult;
  }
  async function agedSubscription(label: string, outcome: 'refused' | 'indeterminate') {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const key = randomUUID();
    const payload = checkout(`${label}-${config.id}@example.test`);
    const subscription = async () => quotedSubscription({ ...payload,
      cart: { ...payload.cart, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays } });
    const created = await call('checkout.create', await subscription(), false, key);
    if (!created.ok || !isRecord(created.value) || typeof created.value.token !== 'string') throw new Error(`${label}_subscription_required`);
    const orderRef = String(created.value.orderRef);
    expect((await call('payment.simulate', { orderRef, token: created.value.token, outcome })).ok).toBe(true);
    await owner!.query("UPDATE public.commerce_orders SET created_at=created_at - interval '25 hours' WHERE id=$1", [orderRef]);
    // Past the link lifetime the buyer gets no token and cannot abandon an attempted order.
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, key))
      .toEqual({ ok: false, code: 'starter_checkout_expired' });
    expect(await abandon(key)).toEqual({ ok: false, code: 'starter_checkout_not_abandonable' });
    expect(await orderStatus(orderRef)).toBe('pending_payment');
    return { key, orderRef, subscription };
  }

  it('an aged order with a refused attempt is settled by the store, then the key and a new key resolve', async () => {
    const { key, orderRef, subscription } = await agedSubscription('aged-refused', 'refused');
    // While the unpaid draft exists, the same contact's first subscription is held.
    expect(await call('checkout.create', await subscription(), false, randomUUID()))
      .toEqual({ ok: false, code: 'starter_command_conflict' });
    const cancelled = await operatorCall('operator.cancelUnpaid', { orderRef, reason: 'buyer_requested_start_over', confirmed: true });
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    expect(await orderStatus(orderRef)).toBe('cancelled');
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, key))
      .toEqual({ ok: false, code: 'starter_checkout_not_payable' });
    const fresh = await call('checkout.create', await subscription(), false, randomUUID());
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(fresh.ok && isRecord(fresh.value) && fresh.value.orderRef).not.toBe(orderRef);
  }, 60_000);

  it('an aged order with an indeterminate attempt cannot be cancelled by the store', async () => {
    const { orderRef } = await agedSubscription('aged-indeterminate', 'indeterminate');
    expect(await operatorCall('operator.cancelUnpaid', { orderRef, reason: 'buyer_requested_start_over', confirmed: true }))
      .toEqual({ ok: false, code: 'starter_order_transition_conflict' });
    expect(await orderStatus(orderRef)).toBe('pending_payment');
  }, 60_000);

  it('abandon with no order, then the first create, then a changed create leave one order', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const key = randomUUID();
    expect(await abandon(key)).toEqual({ ok: true, value: { abandoned: false } });
    const first = await guestOrder('late', key);
    expect(await call('checkout.create', { ...first.input, line1: '2 Example Lane' }, false, key))
      .toEqual({ ok: false, code: 'starter_checkout_changed' });
    expect((await owner!.query('SELECT order_id FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1', [derivedKey(key)])).rows)
      .toEqual([{ order_id: first.orderRef }]);
  }, 30_000);

  it('an incomplete order is abandoned and its creation tail holds nothing', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const reserve = 'public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz)';
    const cancel = 'public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz)';
    const key = randomUUID();
    const input = await reviewedCheckout(`incomplete-${config.id}@example.test`);
    // A host that stops after the draft commit: the hold fails and so does its compensation.
    await owner!.query(`REVOKE EXECUTE ON FUNCTION ${reserve}, ${cancel} FROM service_role`);
    try { expect((await call('checkout.create', input, false, key)).ok).toBe(false); }
    finally { await owner!.query(`GRANT EXECUTE ON FUNCTION ${reserve}, ${cancel} TO service_role`); }
    const { rows: [draft] } = await owner!.query(`SELECT o.id, o.status FROM public.commerce_order_draft_receipts r
      JOIN public.commerce_orders o ON o.id=r.order_id WHERE r.idempotency_key=$1`, [derivedKey(key)]);
    expect(draft.status).toBe('pending_payment');
    expect(await call('checkout.continuation', { action: 'resume', locale: 'en' }, false, key))
      .toEqual({ ok: false, code: 'starter_checkout_in_progress' });
    // A young incomplete order may still be creating; abandon waits until creation has stalled.
    expect(await abandon(key)).toEqual({ ok: false, code: 'starter_checkout_in_progress' });
    expect(await orderStatus(draft.id)).toBe('pending_payment');
    await owner!.query("UPDATE public.commerce_orders SET created_at=created_at - interval '61 seconds' WHERE id=$1", [draft.id]);
    expect(await abandon(key)).toEqual({ ok: true, value: { abandoned: true, orderRef: draft.id } });
    expect(await call('checkout.create', input, false, key)).toEqual({ ok: false, code: 'starter_checkout_not_payable' });
    expect(await held(draft.id)).toBe(0);
    expect((await owner!.query('SELECT count(*) AS n FROM public.commerce_settlement_intents WHERE order_id=$1', [draft.id])).rows[0].n).toBe('0');
  }, 30_000);

  it('more parallel abandons than pooled connections all complete', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const orders: Awaited<ReturnType<typeof guestOrder>>[] = [];
    for (let index = 0; index < 6; index++) orders.push(await guestOrder(`parallel-${index}`));
    const answers = await Promise.all(orders.map(order => abandon(order.key)));
    // Releases share the inventory admission gate; a busy release refuses and can be repeated.
    const abandoned = { ok: true, value: { abandoned: true } };
    for (const [index, answer] of answers.entries()) {
      if (!answer.ok) {
        expect(answer).toEqual({ ok: false, code: 'starter_purchase_unavailable' });
        expect(await orderStatus(orders[index]!.orderRef)).toBe('pending_payment');
        expect(await abandon(orders[index]!.key)).toMatchObject(abandoned);
      } else expect(answer).toMatchObject(abandoned);
      expect(await orderStatus(orders[index]!.orderRef)).toBe('cancelled');
    }
  }, 45_000);

  it('the package storefront observer reports each subject ledger read-only', async () => {
    await control(false, undefined, undefined, repeatLimits);
    await owner!.query('TRUNCATE public.commerce_checkout_attempt_ledger');
    const subjectA = `observer-a-${config.id}@example.test`;
    const subjectB = `observer-b-${config.id}@example.test`;
    const ledgerOf = (orders: number, payableOrders: number, holds: number, attempts: number, captures: number) =>
      ({ orders, payableOrders, holds, attempts, captures });
    const reader = await owner!.connect();
    try {
      const observer = createPostgresStorefrontObserver(asPostgresSqlExecutor(reader), { exclusive: true });
      // Every observation reads inside one READ ONLY transaction: a write or row lock would fail there.
      const observe = async () => {
        await reader.query('BEGIN READ ONLY');
        try {
          expect((await reader.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
          const seen = { a: await observer.ledger(subjectA), upperA: await observer.ledger(subjectA.toUpperCase()),
            b: await observer.ledger(subjectB), database: await observer.payableOrdersInDatabase!() };
          expect(seen.upperA).toEqual(seen.a);
          return seen;
        } finally { await reader.query('COMMIT'); }
      };
      const start = await observe();
      expect([start.a, start.b]).toEqual([ledgerOf(0, 0, 0, 0, 0), ledgerOf(0, 0, 0, 0, 0)]);
      // The exclusive-database rule: payable orders added in the database are exactly the subjects'.
      const expectObserved = async (a: ReturnType<typeof ledgerOf>, b: ReturnType<typeof ledgerOf>) => {
        const seen = await observe();
        expect({ a: seen.a, b: seen.b }).toEqual({ a, b });
        expect(seen.database - start.database).toBe(a.payableOrders + b.payableOrders);
        return seen;
      };
      // (1) A one-line order abandoned by key: cancelled, its reservation released.
      const abandoned = await guestOrder('observer-a');
      expect(await abandon(abandoned.key)).toEqual({ ok: true, value: { abandoned: true, orderRef: abandoned.orderRef } });
      await expectObserved(ledgerOf(1, 0, 0, 0, 0), ledgerOf(0, 0, 0, 0, 0));
      // (2) A two-line order: one order holding stock, whatever its reservation lines.
      const twoLines = checkout(subjectA);
      twoLines.cart = { ...twoLines.cart, lines: config.offer.products.slice(0, 2).map(product => ({ sku: product.sku, quantity: 1 })) };
      const quote = await review(twoLines);
      const created = await call('checkout.create', { ...twoLines, expectedTotal: quote.expectedTotal });
      if (!created.ok || !isRecord(created.value) || typeof created.value.token !== 'string') throw new Error('observer_two_line_order_required');
      const order = { orderRef: String(created.value.orderRef), token: created.value.token };
      expect(Number((await owner!.query(`SELECT count(*) AS n FROM public.fulfillment_inventory_reservation_lines l
        JOIN public.fulfillment_inventory_reservations r ON r.id=l.reservation_id WHERE r.purchase_order_id=$1 AND r.status='held'`,
      [order.orderRef])).rows[0].n)).toBe(2);
      await expectObserved(ledgerOf(2, 1, 1, 0, 0), ledgerOf(0, 0, 0, 0, 0));
      // (3) A refused attempt.
      expect((await call('payment.simulate', { ...order, outcome: 'refused' })).ok).toBe(true);
      await expectObserved(ledgerOf(2, 1, 1, 1, 0), ledgerOf(0, 0, 0, 0, 0));
      // (4) A captured attempt; held reservations after capture are read independently.
      expect((await call('payment.simulate', { ...order, outcome: 'captured' })).ok).toBe(true);
      const holdsA = (await held(abandoned.orderRef) > 0 ? 1 : 0) + (await held(order.orderRef) > 0 ? 1 : 0);
      await expectObserved(ledgerOf(2, 0, holdsA, 2, 1), ledgerOf(0, 0, 0, 0, 0));
      // (5) B's one-line order with a provider attempt planted as a fixture bypass of the provider rail.
      const orderB = await guestOrder('observer-b');
      const { rows: [intent] } = await owner!.query(
        'SELECT id, amount_minor, currency_code FROM public.commerce_settlement_intents WHERE order_id=$1', [orderB.orderRef]);
      const { rows: [providerState] } = await owner!.query(
        "INSERT INTO public.payment_provider_states(id, target_kind) VALUES ($1, 'one_time_order') RETURNING payment_id", [intent.id]);
      await owner!.query(`INSERT INTO public.payment_provider_attempts(settlement_intent_id, payment_id, provider, idempotency_key,
        status, amount_minor, currency) VALUES ($1, $2, 'fixture', 'fixture-observer-attempt', 'succeeded', $3, $4)`,
      [intent.id, providerState.payment_id, intent.amount_minor, intent.currency_code]);
      await expectObserved(ledgerOf(2, 0, holdsA, 2, 1), ledgerOf(1, 1, 1, 1, 1));
    } finally {
      reader.release();
    }
  }, 45_000);

});
