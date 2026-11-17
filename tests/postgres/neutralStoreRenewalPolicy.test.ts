import { createHash, randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { isDunningLadderExhausted } from '@openlup/core/subscription';
import type { SubscriptionCommand } from '@openlup/platform/subscriptions/contracts';
import type { RenewalPolicy } from '../../examples/neutral-store/owned/renewal-policy.ts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { createRenewalJob } from '../../examples/neutral-store/host/renewal-job.ts';
import { composeRenewalSandbox } from '../../examples/neutral-store/host/renewal-sandbox.ts';
import { active, admin, api, executor, facts, inventory, now, retire, runtime, stock, transaction } from './subscriptionPublicRenewalFixture.js';

const cadence = { backoffHours: [24, 72, 168] }; // Each offset is after the previous failure.
const futureTerms = async () => ({ outcome: 'refused' as const, reason: 'subscription_command_unsupported_action' as const });
type Subject = Awaited<ReturnType<typeof active>>;
type Pause = Extract<SubscriptionCommand, { action: 'pause' }>;

function scheduled(clock: () => string, afterRun?: RenewalPolicy) {
  const config = structuredClone(configurations.supplements!.renewal);
  config.enabled = true; config.retryBackoffHours = [...cadence.backoffHours]; config.sandbox.retry = 'declined';
  const codec = api.createNativeRenewalCodec();
  const sandbox = composeRenewalSandbox({ executor, withTransaction: transaction, codec, config,
    now: clock, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
  return createRenewalJob({ config, ...(afterRun ? { afterRun } : {}), beforeRun: sandbox.refresh,
    async withSession(work) {
      const db = await runtime.connect(); try { return await work(db); } finally { db.release(); }
    },
    native: { executor, withTransaction: transaction, codec, settlement: db => api.createPostgresRenewalSettlementPort(db, codec),
      inventory: inventory.createPostgresRenewalReservationPort(executor), paymentRails: sandbox.paymentRails,
      policy: sandbox.policy, retry: sandbox.retry, failureTemplate: 'failed', recoveryPath: '/recover', workerId: 'owned-policy-proof',
      now: clock, catalogue: { version: 'complete-test-catalogue', migration: 'native-test-catalogue' },
      readiness: async () => ({ state: 'ready', candidate: { artifact: 'fixture', configuration: 'supplements',
        environment: 'disposable', database: 'fixture', schema: 'complete' }, loadedPackages: [], issues: [] }) },
  });
}

// Example application policy, deliberately confined to a trusted fixture subject.
// A real adopter owns candidate selection and authorization before these commands.
function pauseAfterExhaustion(subject: Subject, clock: () => string, preset = 'indefinite') {
  let command: Pause | undefined;
  const policy: RenewalPolicy = async input => {
    const candidate = (await input.db.query('SELECT renewal_operation_id FROM public.subscription_retry_obligations WHERE subscription_id=$1', [subject.subscriptionId])).rows[0];
    if (!candidate) return;
    const operationId = String(candidate.renewal_operation_id), key = `exhaustion-pause:${operationId}`;
    await input.withTransaction(async db => {
      // Match command actor/key -> subscription, then retry's operation -> obligation
      // -> cycle -> settlement -> case order. Recovery takes the subscription first.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [subject.clientId, key]);
      await db.query('SELECT id FROM public.subscriptions WHERE id=$1 AND client_id=$2 FOR UPDATE', [subject.subscriptionId, subject.clientId]);
      await db.query('SELECT id FROM public.subscription_renewal_operations WHERE id=$1 AND subscription_id=$2 FOR UPDATE', [operationId, subject.subscriptionId]);
      await db.query('SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1 FOR UPDATE', [operationId]);
      await db.query('SELECT id FROM public.subscription_cycles WHERE renewal_operation_id=$1 FOR UPDATE', [operationId]);
      await db.query('SELECT id FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1 FOR UPDATE', [operationId]);
      await db.query('SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=(SELECT cycle_id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) FOR UPDATE', [operationId]);
      const retry = await api.createPostgresRetryStore(db, cadence).read(operationId);
      const current = (await db.query(`SELECT s.status,s.next_cycle_at=op.scheduled_at AS current_cycle,
        c.status AS cycle_status,i.status AS settlement_status,d.status AS case_status
        FROM public.subscriptions s JOIN public.subscription_renewal_operations op ON op.subscription_id=s.id
        JOIN public.subscription_cycles c ON c.renewal_operation_id=op.id
        JOIN public.commerce_settlement_intents i ON i.renewal_operation_id=op.id
        JOIN public.subscription_retry_obligations o ON o.renewal_operation_id=op.id
        JOIN public.subscription_dunning_cases d ON d.id=o.case_id WHERE op.id=$1`, [operationId])).rows[0];
      if (!retry || retry.state !== 'waiting' || current?.status !== 'active' || !current.current_cycle
        || current.cycle_status !== 'payment_pending' || current.settlement_status === 'settled' || current.case_status !== 'open'
        || !isDunningLadderExhausted({ status: retry.disposition, retryAttempt: retry.retryAttempt, nextRetryAt: retry.nextRetryAt }, cadence)) return;
      // Policy bookkeeping belongs to the same transaction as the public command.
      await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
        VALUES($1,'fixture.exhaustion_policy',$2,'{}')`, [subject.subscriptionId, key]);
      command = { actor: { kind: 'customer', actorId: subject.clientId, clientId: subject.clientId },
        subscriptionId: subject.subscriptionId, idempotencyKey: key, now: clock(), action: 'pause',
        pausePreset: preset, reason: 'exhausted_retries', survey: null, saveOffer: null };
      const receipt = await input.createCommands({ withTransaction: work => work(db), futureTerms }).apply(command);
      if ('supported' in receipt || receipt.outcome === 'refused') throw new Error('pause_policy_command_refused');
      expect(receipt.outcome).toBe('applied');
    });
  };
  return { policy, command: () => command };
}

async function subject() { await retire(); await stock(1000); return active(); }
async function obligation(id: string) {
  return (await runtime.query('SELECT * FROM public.subscription_retry_obligations WHERE subscription_id=$1', [id])).rows[0];
}
async function status(id: string) { return (await runtime.query('SELECT status FROM public.subscriptions WHERE id=$1', [id])).rows[0].status; }
async function exhausted(subject: Subject) {
  let clock = now;
  const job = scheduled(() => clock);
  await job.services.run();
  for (let rung = 1; rung <= 3; rung++) {
    const row = await obligation(subject.subscriptionId); clock = row.next_retry_at.toISOString();
    expect(await job.services.run()).toMatchObject({ retries: [{ status: 'refused' }] });
  }
  expect(await obligation(subject.subscriptionId)).toMatchObject({ retry_attempt: 4, next_retry_at: null });
  return clock;
}

it('composes 1/3/7 day retries and pauses only after exhaustion, with one effect for a repeated command key', async () => {
  const s = await subject(); let clock = now;
  const custom = pauseAfterExhaustion(s, () => clock), job = scheduled(() => clock, custom.policy);
  expect(await job.services.run()).toMatchObject({ renewals: [{ status: 'refused' }] });
  for (const days of [1, 3, 7]) {
    expect(await status(s.subscriptionId)).toBe('active');
    expect((await runtime.query('SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1', [s.subscriptionId])).rows).toEqual([]);
    const row = await obligation(s.subscriptionId), next = row.next_retry_at.toISOString();
    expect(Date.parse(next) - Date.parse(clock)).toBe(days * 86_400_000); clock = next;
    await job.services.run();
  }
  expect(await status(s.subscriptionId)).toBe('paused');
  const command = custom.command()!; expect(command).toBeDefined();
  const before = (await runtime.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1', [s.subscriptionId])).rows;
  expect(before).toHaveLength(1);
  const commands = api.createPostgresSubscriptionCommands({ withTransaction: transaction, futureTerms });
  expect(await commands.apply(command)).toMatchObject({ outcome: 'replayed' });
  expect(await commands.apply(command)).toMatchObject({ outcome: 'replayed' });
  expect((await runtime.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1', [s.subscriptionId])).rows).toEqual(before);
  expect((await runtime.query('SELECT id FROM public.subscription_command_receipts WHERE idempotency_key=$1', [command.idempotencyKey])).rows).toHaveLength(1);
  expect((await runtime.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND event_type='fixture.exhaustion_policy'", [s.subscriptionId])).rows).toHaveLength(1);
  expect((await runtime.query('SELECT status FROM public.platform_job_runs WHERE job_name=$1 ORDER BY started_at DESC LIMIT 1', ['subscription-renewal:demo:supplements'])).rows[0].status).toBe('success');
});

it('waits for concurrent native recovery and rechecks instead of pausing the repaired subscription', async () => {
  const s = await subject(), clock = await exhausted(s), row = await obligation(s.subscriptionId);
  const recovery = await runtime.connect(); let pending: Promise<unknown> | undefined;
  let policyPid = 0;
  try {
    await recovery.query('BEGIN');
    await recovery.query('SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE', [s.subscriptionId]);
    const custom = pauseAfterExhaustion(s, () => clock);
    pending = scheduled(() => clock, async input => {
      policyPid = Number((await input.db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await custom.policy(input);
    }).services.run();
    await vi.waitFor(async () => {
      expect(policyPid).toBeGreaterThan(0);
      expect((await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [policyPid])).rows[0]?.wait_event_type).toBe('Lock');
    });
    const at = new Date().toISOString(), raw = randomBytes(32).toString('base64url');
    await recovery.query('SELECT public.dunning_lifecycle_issue_recovery_token($1::uuid,$2,$3::timestamptz)',
      [row.case_id, createHash('sha256').update(raw).digest('hex'), new Date(Date.parse(at) + 3600_000).toISOString()]);
    const token = (await recovery.query('SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1', [createHash('sha256').update(raw).digest('hex')])).rows[0];
    const store = api.createPostgresRetryStore(recovery, cadence);
    const authorization = await store.authorizeRecovery(row.renewal_operation_id, token.id, facts.methodRef, facts.methodEvidenceRef, at);
    await store.scheduleRecovery(row.renewal_operation_id, `repair:${row.renewal_operation_id}`, String(authorization.id), at);
    const config = structuredClone(configurations.supplements!.renewal); config.retryBackoffHours = [...cadence.backoffHours];
    const codec = api.createNativeRenewalCodec(), withTransaction: typeof transaction = work => work(recovery);
    const sandbox = composeRenewalSandbox({ executor: recovery, withTransaction, codec, config,
      now: () => at, failureTemplate: 'failed', recoveredTemplate: 'recovered', recoveryPath: '/recover' });
    await sandbox.refresh();
    const driver = api.createNativeRetryDriver({ executor: recovery, withTransaction, decode: codec.decode, ...sandbox.retry,
      validateInput: sandbox.policy.validateInput, classifyFailure: sandbox.policy.classifyFailure, failureTemplate: 'failed', recoveryPath: '/recover' });
    expect(await driver.run(at, 10)).toEqual([{ operationId: row.renewal_operation_id, status: 'succeeded' }]);
    await recovery.query('COMMIT');
    await pending;
    expect(custom.command()).toBeUndefined();
    expect(await status(s.subscriptionId)).toBe('active');
    expect(await obligation(s.subscriptionId)).toMatchObject({ state: 'recovered' });
    expect((await runtime.query('SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1', [s.subscriptionId])).rows).toEqual([]);
  } finally { await recovery.query('ROLLBACK'); recovery.release(); await pending; }
});

it('rolls back policy bookkeeping and command receipts when the native pause refuses', async () => {
  const s = await subject(), clock = await exhausted(s), custom = pauseAfterExhaustion(s, () => clock, 'invalid-preset');
  const before = await obligation(s.subscriptionId);
  await expect(scheduled(() => clock, custom.policy).services.run()).rejects.toThrow('pause_policy_command_refused');
  expect(await status(s.subscriptionId)).toBe('active');
  expect(await obligation(s.subscriptionId)).toEqual(before);
  expect((await runtime.query('SELECT id FROM public.subscription_command_receipts WHERE idempotency_key=$1', [custom.command()!.idempotencyKey])).rows).toEqual([]);
  expect((await runtime.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND event_type='fixture.exhaustion_policy'", [s.subscriptionId])).rows).toEqual([]);
  expect((await runtime.query('SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1', [s.subscriptionId])).rows).toEqual([]);
  expect((await runtime.query('SELECT status FROM public.subscription_dunning_cases WHERE id=$1', [before.case_id])).rows[0].status).toBe('open');
});

it('runs the hook after native work under both leases and records a hook error as failed', async () => {
  const s = await subject();
  const job = scheduled(() => now, async input => {
    expect(input.result).toMatchObject({ renewals: [{ status: 'refused' }] });
    expect(await obligation(s.subscriptionId)).toMatchObject({ retry_attempt: 1 });
    expect((await input.db.query('SELECT status FROM public.platform_job_runs WHERE job_name=$1 ORDER BY started_at DESC LIMIT 1', ['subscription-renewal:demo:supplements'])).rows[0].status).toBe('running');
    expect(await scheduled(() => now).services.run()).toBeNull();
    await input.withTransaction(async db => {
      await db.query('SELECT 1'); throw new Error('synthetic_policy_failure');
    });
  });
  await expect(job.services.run()).rejects.toThrow('synthetic_policy_failure');
  const runs = (await runtime.query('SELECT status,metadata FROM public.platform_job_runs WHERE job_name=$1 ORDER BY started_at DESC LIMIT 1', ['subscription-renewal:demo:supplements'])).rows;
  expect(runs[0]).toMatchObject({ status: 'failed', metadata: { reason: 'renewal_run_unavailable', countsAvailable: false } });
  expect(await status(s.subscriptionId)).toBe('active');
  expect(await scheduled(() => now).services.run()).toEqual({ retries: [], renewals: [] });
});
