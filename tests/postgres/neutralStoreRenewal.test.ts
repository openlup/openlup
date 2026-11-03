import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPostgresTransactionalDeliveryStore } from '@openlup/platform/communications';
import { createPrivateCapture } from '../../examples/neutral-store/host/private-capture.ts';
import { createLifecycleNoticeHost } from '../../examples/neutral-store/host/lifecycle-notices.ts';
import { expect, it } from 'vitest';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { composeRenewalSandbox } from '../../examples/neutral-store/host/renewal-sandbox.ts';
import { createRenewalJob, renewalLedgerReady, summarizeRenewalRun } from '../../examples/neutral-store/host/renewal-job.ts';
import { readAccountRenewal } from '../../examples/neutral-store/host/account-renewal.ts';
import { api, active, admin, deps, payments, executor, facts, inventory, now, retire, runtime, runtimeUrl, stock, transaction } from './subscriptionPublicRenewalFixture.js';

// Native installation/pack takes its fixture's setup allowance. Case bounds are
// measured independently below before the checkpoint; no hosted timing claim.
it.each(Object.values(configurations))('$id: persisted sandbox retry recovers only the same frozen obligation after reconstructing host ports', async config => {
  await retire(); await stock(1000);
  const purchase = await active();
  const d = await deps(purchase.subscriptionId, 'declined');
  const initial = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(initial.status).toBe('refused');
  const retryStore = api.createPostgresRetryStore(executor);
  const before = (await retryStore.read(initial.operationId))!;
  const frozen = (await runtime.query('SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1', [initial.operationId])).rows[0].cycle_snapshot;
  const make = () => composeRenewalSandbox({ executor, withTransaction: transaction, codec: d.codec,
    config: config.renewal, now: () => before.nextRetryAt!, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
  let host = make(); await host.refresh();
  const driver = () => api.createNativeRetryDriver({ executor, withTransaction: transaction,
    decode: d.codec.decode, ...host.retry, payments: host.retry.payments,
    validateInput: host.policy.validateInput, classifyFailure: host.policy.classifyFailure,
    failureTemplate: 'failed', recoveryPath: '/recover' });
  expect(await driver().run(before.nextRetryAt!, 10)).toEqual([{ operationId: initial.operationId, status: 'succeeded' }]);
  const after = await retryStore.read(initial.operationId);
  expect(after).toMatchObject({ orderId: before.orderId, cycleId: before.cycleId, state: 'recovered' });
  expect((await runtime.query('SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1', [initial.operationId])).rows[0].cycle_snapshot).toEqual(frozen);
  const effects = await runtime.query('SELECT id,external_ref,status FROM public.commerce_settlement_intents WHERE id=$1', [before.settlementIntentId]);
  host = make(); await host.refresh();
  expect(await driver().run(before.nextRetryAt!, 10)).toEqual([]);
  expect(await runtime.query('SELECT id,external_ref,status FROM public.commerce_settlement_intents WHERE id=$1', [before.settlementIntentId])).toMatchObject({ rows: effects.rows });
  expect((await admin.query('SELECT count(*)::int AS n FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1', [before.settlementIntentId])).rows[0].n).toBe(1);
  expect((await runtime.query('SELECT status FROM public.subscriptions WHERE id=$1', [purchase.subscriptionId])).rows[0].status).toBe('active');
}, 30000);

it('observes the selected native job-ledger installation without claiming or widening authority', async () => {
  expect(await renewalLedgerReady(executor)).toBe(true);
  expect((await runtime.query("SELECT to_regprocedure('public.platform_claim_job_run_v3(text,text,text,integer,jsonb)') AS claim")).rows[0].claim).toBeTruthy();
});

it('projects uppercase owned account identity from actual frozen and retained facts without a rich account assembler', async () => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  const principalId = (await admin.query('SELECT principal_id FROM public.clients WHERE id=$1', [purchase.clientId])).rows[0].principal_id;
  expect(principalId).toBeTruthy();
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const projection = await readAccountRenewal(executor, { principalId: String(principalId).toUpperCase(), clientId: purchase.clientId.toUpperCase() });
  const subscription = projection.subscriptions.find(row => row.subscriptionId === purchase.subscriptionId)!;
  expect(subscription.nextCharge).toMatchObject({ source: 'frozen_obligation', amountMinor: facts.lines[0]!.quantity * facts.lines[0]!.unitAmountMinor, currency: facts.currency });
  expect(subscription.action).toMatchObject({ blockedReason: 'payment_blocked', orderId: (await api.createPostgresRetryStore(executor).read(result.operationId))!.orderId });
  expect(subscription.promisedArrival).toEqual({ available: false });
  expect(subscription.payment?.healthState).toBe('healthy');
  await expect(readAccountRenewal(executor, { principalId: '00000000-0000-4000-8000-000000000001', clientId: purchase.clientId })).rejects.toThrow('starter_account_owner_required');
}, 30000);

it.each(Object.values(configurations))('$id: scheduled host gates before claim and durably finishes actual renewal and retry counts', async config => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  let clock = now;
  const owned = structuredClone(config.renewal); owned.enabled = true;
  const sandbox = composeRenewalSandbox({ executor, withTransaction: transaction, codec: d.codec, config: owned,
    now: () => clock, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
  const withSession = async <T>(work: (db: typeof executor) => Promise<T>) => {
    const db = await runtime.connect(); try { return await work(db); } finally { db.release(); }
  };
  const native = { executor, withTransaction: transaction, codec: d.codec,
    settlement: (db: typeof executor) => api.createPostgresRenewalSettlementPort(db, d.codec),
    inventory: inventory.createPostgresRenewalReservationPort(executor), paymentRails: sandbox.paymentRails,
    policy: sandbox.policy, retry: sandbox.retry, failureTemplate: 'failed', recoveryPath: '/recover',
    workerId: 'starter-proof', now: () => clock, catalogue: { version: 'complete-test-catalogue', migration: 'native-test-catalogue' },
    readiness: async () => ({ state: 'ready' as const, candidate: { artifact: 'fixture', configuration: config.id,
      environment: 'disposable', database: 'fixture', schema: 'complete' }, loadedPackages: [], issues: [] }),
  };
  const binding = () => createRenewalJob({ config: owned, native, withSession, beforeRun: sandbox.refresh });
  const jobName = `subscription-renewal:${owned.population}`;
  expect(await createRenewalJob({ config: { ...owned, enabled: false }, native, withSession, beforeRun: sandbox.refresh }).services.run())
    .toEqual({ kind: 'refused', code: 'disabled' });
  expect((await runtime.query('SELECT count(*)::int AS n FROM public.platform_job_runs WHERE job_name=$1', [jobName])).rows[0].n).toBe(0);
  expect(await createRenewalJob({ config: owned, native: { ...native,
    readiness: async () => ({ ...await native.readiness(), state: 'unsatisfied' as const }) },
  withSession, beforeRun: sandbox.refresh }).services.run()).toEqual({ kind: 'refused', code: 'schema_unsatisfied' });
  expect((await runtime.query('SELECT count(*)::int AS n FROM public.platform_job_runs WHERE job_name=$1', [jobName])).rows[0].n).toBe(0);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; });
  const held = new Promise<void>(done => { release = done; });
  const first = createRenewalJob({ config: owned, native, withSession, async beforeRun() {
    enter(); await held; await sandbox.refresh();
  } }).services.run();
  await entered;
  try { expect(await binding().services.run()).toBeNull(); } finally { release(); }
  expect(await first).toMatchObject({ renewals: [{ status: 'refused' }] });
  const obligation = (await runtime.query(`SELECT obligation.* FROM public.subscription_retry_obligations obligation
    WHERE subscription_id=$1`, [purchase.subscriptionId])).rows[0];
  expect(obligation).toBeTruthy(); clock = obligation.next_retry_at.toISOString();
  expect(await binding().services.run()).toMatchObject({ retries: [{ operationId: obligation.renewal_operation_id, status: 'succeeded' }] });
  const runs = (await runtime.query('SELECT status,checked,updated,metadata FROM public.platform_job_runs WHERE job_name=$1 ORDER BY started_at,id', [jobName])).rows;
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({ status: 'success', checked: 1, updated: 0, metadata: { failures: 1, deferred: 0 } });
  expect(runs[1]).toMatchObject({ status: 'success', checked: 1, updated: 1, metadata: { failures: 0, deferred: 0 } });
}, 30000);

it.each(Object.values(configurations))('$id: automatic notice freezes one private artifact and native grant, then reconciles accepted delivery after host reconstruction', async config => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const root = resolve('.context/scratch/r2b'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'notice-'));
  const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const owned = structuredClone(config);
  // This fixture's cycle is genuinely old. Vary the configured repair grace to
  // prove the SQL expiry carrier, without rewriting its durable failure instant.
  owned.renewal.recovery.activeGraceSeconds = 20000000;
  owned.renewal.notices.locale = 'en';
  owned.renewal.notices.countryLocales = config.id === 'coffee' ? { ZZ: 'pl' } : {};
  // Ancillary synthetic recipient metadata; money/case/notice facts use their writers.
  await admin.query('UPDATE public.clients SET country=$1 WHERE id=$2', ['ZZ', purchase.clientId]);
  const expectedLocale = config.id === 'coffee' ? 'pl' : 'en';
  const make = () => {
    const host = createLifecycleNoticeHost({ config: owned, publicOrigin: 'http://localhost:4319',
      withTransaction: transaction, capture: createPrivateCapture(directory), receipts });
    return api.createPostgresLifecycleMessages({ ...host,
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
    });
  };
  try {
    const notice = (await runtime.query(`SELECT n.* FROM public.subscription_dunning_notifications n
      WHERE subscription_id=$1 AND notification_kind='payment_failed'`, [purchase.subscriptionId])).rows[0];
    expect(notice).toBeTruthy();
    const key = `subscription-notice:dunning:${notice.id}`;
    await make().run(100);
    expect(await receipts.readReceipt(key)).toMatchObject({ state: 'accepted' });
    const artifact = await createPrivateCapture(directory).read(key);
    expect(artifact && typeof artifact === 'object' && 'locale' in artifact ? artifact.locale : null).toBe(expectedLocale);
    const tokens = (await runtime.query('SELECT id,expires_at,revoked_at,xmin::text FROM public.commerce_checkout_recovery_tokens WHERE order_id=(SELECT order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1)', [purchase.subscriptionId])).rows;
    expect(tokens).toHaveLength(1);
    await make().run(100);
    expect((await runtime.query('SELECT id,expires_at,revoked_at,xmin::text FROM public.commerce_checkout_recovery_tokens WHERE order_id=(SELECT order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1)', [purchase.subscriptionId])).rows).toEqual(tokens);
    expect(JSON.stringify(await createPrivateCapture(directory).read(key)) === JSON.stringify(artifact)).toBe(true);
    expect((await runtime.query('SELECT status FROM public.subscriptions WHERE id=$1', [purchase.subscriptionId])).rows[0].status).toBe('active');
  } finally { await receipts.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);

async function restartedRetry(at: string, configuration: string) {
  const moduleUrl = pathToFileURL(resolve('examples/neutral-store/host/renewal-sandbox.ts')).href;
  const configUrl = pathToFileURL(resolve('examples/neutral-store/owned/store.config.ts')).href;
  const code = `import pg from 'pg';import {readFileSync} from 'node:fs';
    import {createNativeRenewalCodec,createNativeRetryDriver} from '@openlup/platform/subscriptions';
    import {composeRenewalSandbox} from ${JSON.stringify(moduleUrl)};
    import {configurations} from ${JSON.stringify(configUrl)};
    const input=JSON.parse(readFileSync(0,'utf8'));const pool=new pg.Pool({connectionString:input.url});
    const executor={query:(sql,values)=>pool.query(sql,values)};
    const transaction=async work=>{const db=await pool.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
    try{const codec=createNativeRenewalCodec();const host=composeRenewalSandbox({executor,withTransaction:transaction,codec,
      config:configurations[input.configuration].renewal,now:()=>input.at,failureTemplate:'failed',recoveredTemplate:'recovered',recoveryPath:'/recover'});
      await host.refresh();const driver=createNativeRetryDriver({executor,withTransaction:transaction,decode:codec.decode,
        ...host.retry,validateInput:host.policy.validateInput,classifyFailure:host.policy.classifyFailure,failureTemplate:'failed',recoveryPath:'/recover'});
      process.stdout.write(JSON.stringify(await driver.run(input.at,10)));
    }finally{await pool.end();}`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.end(JSON.stringify({ url: runtimeUrl, at, configuration }));
  const [exit] = await once(child, 'exit');
  expect(/https?:\/\/|(?:rcv_)?[A-Za-z0-9_-]{43}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/.test(output + errors)).toBe(false);
  if (exit !== 0 || output.length > 65536) throw new Error('starter_restart_worker_unavailable');
  return JSON.parse(output);
}

it('keeps an ambiguous prepared attempt through an actual process restart and consumes matching late observation once', async () => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  const initial = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const row = (await api.createPostgresRetryStore(executor).read(initial.operationId))!;
  const config = structuredClone(configurations.supplements!.renewal); config.sandbox.retry = 'ambiguous';
  const host = composeRenewalSandbox({ executor, withTransaction: transaction, codec: d.codec, config,
    now: () => row.nextRetryAt!, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
  await host.refresh();
  const driver = api.createNativeRetryDriver({ executor, withTransaction: transaction, decode: d.codec.decode,
    ...host.retry, validateInput: host.policy.validateInput, classifyFailure: host.policy.classifyFailure,
    failureTemplate: 'failed', recoveryPath: '/recover' });
  expect(await driver.run(row.nextRetryAt!, 10)).toEqual([{ operationId: initial.operationId, status: 'awaiting_provider' }]);
  expect(await restartedRetry(row.nextRetryAt!, 'supplements')).toEqual([{ operationId: initial.operationId, status: 'awaiting_provider' }]);
  const simulator = payments.createPostgresSandboxPaymentSimulator(executor, {
    dunningTemplateSlug: 'failed', recoveryTemplateSlug: 'recovered', recoveryUrlPath: '/recover' });
  const attempt = (await simulator.readAttempt({ settlementIntentId: row.settlementIntentId }))!;
  await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: `late:${attempt.id}`, outcome: 'captured', occurredAt: row.nextRetryAt! });
  expect(await restartedRetry(row.nextRetryAt!, 'supplements')).toEqual([{ operationId: initial.operationId, status: 'succeeded' }]);
  expect(await restartedRetry(row.nextRetryAt!, 'supplements')).toEqual([]);
  expect((await admin.query('SELECT count(*)::int AS n FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1', [row.settlementIntentId])).rows[0].n).toBe(1);
}, 30000);

it('reconciles a committed receipt with lost ACK without rebinding or reissuing, and refuses a missing private artifact', async () => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const claimed = (await runtime.query('SELECT * FROM public.subscription_dunning_claim_batch(100,60,6)')).rows
    .find(row => row.subscription_id === purchase.subscriptionId && row.notification_kind === 'payment_failed')!;
  expect(claimed).toBeTruthy();
  const root = resolve('.context/scratch/r2b'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'notice-fault-'));
  const store = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const config = structuredClone(configurations.supplements!); config.renewal.recovery.activeGraceSeconds = 20000000;
  const key = `subscription-notice:dunning:${claimed.id}`;
  const notice = { id: String(claimed.id), messageKey: key, source: 'dunning' as const,
    subscriptionId: purchase.subscriptionId, clientId: purchase.clientId, kind: 'payment_failed',
    templateSlug: 'subscription-payment-failed-1', payload: claimed.payload, recoveryUrlPath: null };
  const recipient = (await runtime.query('SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient', [purchase.clientId])).rows[0].recipient;
  let lost = false;
  const capture = createPrivateCapture(directory);
  const faultHost = createLifecycleNoticeHost({ config, publicOrigin: 'http://localhost:4319', withTransaction: transaction, capture,
    receipts: { ...store, async recordAccepted(value) { const receipt = await store.recordAccepted(value);
      if (!lost) { lost = true; throw new Error('synthetic_lost_ack'); } return receipt; } },
  });
  try {
    const command = { ...await faultHost.bind({ ...notice, id: notice.id.toUpperCase(),
      subscriptionId: notice.subscriptionId.toUpperCase(), clientId: notice.clientId.toUpperCase() }, recipient), idempotencyKey: key };
    expect(/^token:[0-9a-f-]{36}$/.test(command.accessGrantReference ?? '')).toBe(true);
    await expect(faultHost.delivery.send(command)).rejects.toThrow('transactional_delivery_unavailable');
    expect(await store.readReceipt(key)).toMatchObject({ state: 'accepted' });
    const before = (await runtime.query('SELECT id,xmin::text,revoked_at,expires_at FROM public.commerce_checkout_recovery_tokens WHERE order_id=(SELECT order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1)', [purchase.subscriptionId])).rows;
    // Fixture fault: the abandoned native sending lease expires before restart.
    await admin.query("UPDATE public.subscription_dunning_notifications SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [notice.id]);
    const host = createLifecycleNoticeHost({ config, publicOrigin: 'http://localhost:4319', withTransaction: transaction, capture, receipts: store });
    let rebound = false;
    const binding = api.createPostgresLifecycleMessages({ ...host, async bind(value, contact) {
      if (value.id === notice.id) rebound = true;
      return host.bind(value, contact);
    }, async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } } });
    expect((await binding.run(100)).replayed).toBeGreaterThanOrEqual(1);
    expect(rebound).toBe(false);
    expect((await runtime.query('SELECT id,xmin::text,revoked_at,expires_at FROM public.commerce_checkout_recovery_tokens WHERE order_id=(SELECT order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1)', [purchase.subscriptionId])).rows).toEqual(before);
    await rm(directory, { recursive: true, force: true });
    await expect(host.delivery.readReceipt(key)).rejects.toThrow('starter_notice_identity_unavailable');
    await expect(host.delivery.send(command)).rejects.toThrow('starter_notice_identity_unavailable');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);

it('counts returned native outcome classes without conflating a decline with an infrastructure error', () => {
  expect(summarizeRenewalRun({ renewals: [{ status: 'succeeded' }, { status: 'deferred' }, { status: 'lease_active' },
    { status: 'terminal_replay' }, { status: 'refused' }], retries: [{ status: 'awaiting_provider' },
    { status: 'error' }, { status: 'succeeded' }] })).toEqual({ checked: 8, updated: 2, failures: 2, deferred: 3, errors: 1 });
  expect(() => summarizeRenewalRun({ renewals: [{ status: 'invented' }], retries: [] })).toThrow('starter_renewal_result_invalid');
});

it('uses the current server-authorized repair method and evidence on the original frozen obligation', async () => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  const initial = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const retryStore = api.createPostgresRetryStore(executor), row = (await retryStore.read(initial.operationId))!;
  const methodRef = `sandbox:repair:${purchase.subscriptionId}`, evidenceRef = `sandbox:repair-evidence:${purchase.subscriptionId}`;
  await api.createPostgresPurchaseRenewalWriter(executor).transitionMethod({ subscriptionId: purchase.subscriptionId,
    eventKey: randomUUID(), expectedState: 'healthy', healthState: 'healthy', methodRef, evidenceRef });
  const raw = randomBytes(32).toString('base64url'), digest = createHash('sha256').update(raw).digest('hex');
  const liveNow = new Date().toISOString();
  await runtime.query('SELECT public.dunning_lifecycle_issue_recovery_token($1::uuid,$2,$3::timestamptz)',
    [row.caseId, digest, new Date(Date.parse(liveNow) + 3600000).toISOString()]);
  const token = (await runtime.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1', [digest])).rows[0];
  expect(token).toBeTruthy();
  const authorization = await retryStore.authorizeRecovery(initial.operationId, String(token.id), methodRef, evidenceRef, liveNow);
  await retryStore.scheduleRecovery(initial.operationId, `repair:${initial.operationId}`, String(authorization.id), liveNow);
  const host = composeRenewalSandbox({ executor, withTransaction: transaction, codec: d.codec,
    config: configurations.supplements!.renewal, now: () => liveNow,
    failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
  await host.refresh();
  const driver = api.createNativeRetryDriver({ executor, withTransaction: transaction, decode: d.codec.decode,
    ...host.retry, validateInput: host.policy.validateInput, classifyFailure: host.policy.classifyFailure,
    failureTemplate: 'failed', recoveryPath: '/recover' });
  expect(await driver.run(liveNow, 10)).toEqual([{ operationId: initial.operationId, status: 'succeeded' }]);
  const attempt = await payments.createPostgresSandboxPaymentSimulator(executor, {
    dunningTemplateSlug: 'failed', recoveryTemplateSlug: 'recovered', recoveryUrlPath: '/recover' })
    .readAttempt({ settlementIntentId: row.settlementIntentId });
  expect(attempt?.methodFacts).toMatchObject({ methodRef, methodEvidenceRef: evidenceRef, authorizationRef: d.due.authorizationRef });
  expect(await retryStore.read(initial.operationId)).toMatchObject({ orderId: row.orderId, cycleId: row.cycleId, state: 'recovered' });
  expect(await driver.run(liveNow, 10)).toEqual([]);
  expect((await runtime.query('SELECT consumed_at FROM public.subscription_retry_recovery_authorizations WHERE id=$1', [authorization.id])).rows[0].consumed_at).not.toBeNull();
}, 30000);

it('maps a known transactional command conflict to a final disposition without delivering or reissuing', async () => {
  await retire(); await stock(1000);
  const purchase = await active(), d = await deps(purchase.subscriptionId, 'declined');
  await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  const notice = (await runtime.query('SELECT * FROM public.subscription_dunning_claim_batch(100,60,6)')).rows
    .find(row => row.subscription_id === purchase.subscriptionId && row.notification_kind === 'payment_failed')!;
  const key = `subscription-notice:dunning:${notice.id}`;
  const root = resolve('.context/scratch/r2b'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'notice-conflict-'));
  const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
  const config = structuredClone(configurations.supplements!); config.renewal.recovery.activeGraceSeconds = 20000000;
  const host = createLifecycleNoticeHost({ config, publicOrigin: 'http://localhost:4319', withTransaction: transaction,
    capture: createPrivateCapture(directory), receipts });
  try {
    const recipient = (await runtime.query('SELECT public.dunning_lifecycle_recipient($1::uuid) AS recipient', [purchase.clientId])).rows[0].recipient;
    const command = { ...await host.bind({ id: notice.id, messageKey: key, source: 'dunning', subscriptionId: purchase.subscriptionId,
      clientId: purchase.clientId, kind: 'payment_failed', templateSlug: 'subscription-payment-failed-1', payload: notice.payload, recoveryUrlPath: null }, recipient), idempotencyKey: key };
    await receipts.recordFailed({ idempotencyKey: key, commandFingerprint: '0'.repeat(64), errorCode: 'synthetic_conflict' });
    expect(await host.delivery.send(command)).toEqual({ state: 'failed', deliveryReference: null, retryable: false });
    expect(await receipts.readReceipt(key)).toMatchObject({ state: 'failed', attemptCount: 1 });
    expect((await runtime.query('SELECT count(*)::int AS n FROM public.commerce_checkout_recovery_tokens WHERE order_id=(SELECT order_id FROM public.subscription_retry_obligations WHERE subscription_id=$1)', [purchase.subscriptionId])).rows[0].n).toBe(1);
  } finally { await receipts.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
