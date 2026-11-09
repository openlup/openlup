import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresCheckoutRecoveryWaves, createPostgresCheckoutRecoveryTokenPort, hashCheckoutRecoveryToken,
  createOutboxCheckoutRecoveryEmailHandler, createOutboxCheckoutExpiredEmailHandler } from '@openlup/platform/commerce/server';
import { withCheckoutRecoverySendEvidence } from '@openlup/platform/communications';
import { createCheckoutRecoveryWaveJob } from '@openlup/platform/composition';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import type { TransactionalEmailPort } from '@openlup/platform/commerce';
import { lifecycleInstallation, lifecycleProfiles, call, lifecycleDeclined, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

// Explicit UTC fixtures: wave and activity boundaries do not depend on wall-clock age.
const NOW = '2040-01-02T12:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(NOW) + hours * 3600000).toISOString();
const policy = { profile: 'capture' };

const unselectedMail = async (): Promise<never> => { throw new Error('unselected_mail'); };
const unusedMailPort: TransactionalEmailPort = {
  findExistingSend: unselectedMail, sendReturnApprovedNotice: unselectedMail, sendReturnRejectedNotice: unselectedMail,
  sendOrderConfirmation: unselectedMail, sendCheckoutRecovery: unselectedMail, sendOrderPaidConfirmation: unselectedMail,
  sendPaymentFailedNotice: unselectedMail, sendCheckoutExpiredNotice: unselectedMail, sendOrderCanceledNotice: unselectedMail,
  sendOrderRefundedNotice: unselectedMail, sendShipmentDispatchedNotice: unselectedMail,
  sendShipmentDeliveredNotice: unselectedMail, sendShipmentExceptionNotice: unselectedMail,
};

describe.each(lifecycleProfiles)('checkout recovery waves on %s', profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => {
    env = await lifecycleInstallation(profile);
    if (profile === 'legacy') await env.owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');
  }, postgresSetupTimeoutMs);
  afterAll(async () => env?.close(), postgresTeardownTimeoutMs);
  const waves = () => createPostgresCheckoutRecoveryWaves(env.runtime, policy);
  const tokenPort = () => createPostgresCheckoutRecoveryTokenPort({ run: async work => {
    const db = await env.runtime.connect();
    try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  } });
  async function order(age = 2, subscription = false) {
    const id = randomUUID(), client = randomUUID(), db = await env.owner.connect();
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2)', [client, `${client}@example.invalid`]);
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor,metadata)
        VALUES($1,$2,$3,'XXX',100,$4::jsonb)`, [id, client, at(-age), { orderDraftSnapshot: { context: { mode: subscription ? 'subscription' : 'one_time', cadenceDays: subscription ? 28 : null } } }]);
      await db.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)VALUES($1,1,1,100,100)', [id]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
    if (subscription) await call(env.runtime, 'subscription_declare_provisional_activation', [`declare:${id}`, id, 28, at(-age)]);
    return { id, client };
  }
  const events = async (id: string) => (await env.owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery' ORDER BY idempotency_key", [id])).rows;
  const tokens = async (id: string) => (await env.owner.query('SELECT * FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1 ORDER BY id', [id])).rows;
  async function intent(id: string, status = 'created', time = at(-1)) {
    const key = randomUUID();
    await env.owner.query(`INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,updated_at,settled_at)
      VALUES($1::uuid,$2::uuid,'sandbox',$3::text,100,'XXX',$1::text,$4::timestamptz,CASE WHEN $3::text='settled' THEN $4::timestamptz END)`, [key, id, status, time]);
    return key;
  }
  async function hold(id: string, hours: number, status = 'held') {
    const key = randomUUID();
    await env.owner.query(`INSERT INTO public.fulfillment_inventory_reservations(id,purchase_order_id,operation_fingerprint,source_key,status,expires_at,created_at,updated_at,terminal_reason)
      VALUES($1,$2,$3,'fixture',$4,$5,$6,$6,CASE WHEN $4='expired' THEN 'reservation_expired' END)`, [key, id, 'a'.repeat(64), status, at(hours), at(-2)]);
    return key;
  }
  async function expireEvents(id: string) { return (await env.owner.query("SELECT * FROM public.outbox_events WHERE event_type='commerce.checkout.expired' AND aggregate_id=$1", [id])).rows; }

  it('atomically mints both waves, retains both links, and payment consumes both without a second settlement', async () => {
    const o = await order(21);
    await waves().enqueue(1000, NOW);
    const first = (await events(o.id))[0]!;
    expect(first.payload).toMatchObject({ reminderHours: 1, recoveryToken: expect.stringMatching(/^rcv_/) });
    const sends: string[] = [];
    const email = withCheckoutRecoverySendEvidence({ ...unusedMailPort, findExistingSend: async () => false,
      sendCheckoutRecovery: async (input: Parameters<TransactionalEmailPort['sendCheckoutRecovery']>[0]) => { sends.push(input.recoveryToken); return { ok: true, messageId: `capture:${input.outboxEventId}`, httpStatus: 200, providerError: null, aborted: false }; },
    }, waves());
    const handler = createOutboxCheckoutRecoveryEmailHandler({ emailPort: email,
      recipientPort: { resolve: async () => ({ email: `${o.client}@example.invalid`, firstName: null, country: 'EN' }) },
      lifecyclePort: { read: async () => { const row = (await env.runtime.query('SELECT status FROM public.commerce_orders WHERE id=$1', [o.id])).rows[0];
        return { orderStatus: row.status, paymentStatus: null, hasPayment: row.status === 'paid' }; } },
      runtime: { resolveLocale: () => 'en', parseOutboxPayload: (schema, payload) => { const parsed = schema.safeParse(payload);
        return parsed.success ? { ok: true, data: parsed.data } : { ok: false, outcome: { kind: 'discard', reason: 'invalid_payload' } }; },
        mapSendOutcome: outcome => outcome.ok ? { kind: 'processed' } : { kind: 'retry', reason: 'send_failed' } },
    });
    expect(await handler.handle(first, new AbortController().signal)).toMatchObject({ kind: 'processed' });
    await waves().enqueue(1000, NOW);
    const both = await events(o.id), stored = await tokens(o.id);
    const final = both.find(event => event.payload.reminderHours === 20)!;
    expect(await handler.handle(final, new AbortController().signal)).toMatchObject({ kind: 'processed' });
    expect(sends).toEqual([first.payload.recoveryToken, final.payload.recoveryToken]);
    expect(both).toHaveLength(2); expect(stored).toHaveLength(2);
    for (const event of both) {
      const row = stored.find(t => t.token_hash === hashCheckoutRecoveryToken(event.payload.recoveryToken));
      expect(row).toMatchObject({ revoked_at: null });
      expect(JSON.stringify(stored)).not.toContain(event.payload.recoveryToken);
      expect(await tokenPort().validate(event.payload.recoveryToken, new Date(NOW))).toMatchObject({ orderId: o.id });
    }
    await waves().enqueue(1000, NOW);
    expect(await tokens(o.id)).toEqual(stored);
    const settlement = await intent(o.id);
    const result = await call(env.runtime, 'commerce_record_settlement', [`paid:${o.id}`, settlement, 'succeeded', null, {}, NOW]);
    expect(result).toBeTruthy();
    for (const event of both) {
      expect(await tokenPort().inspect(event.payload.recoveryToken, new Date(NOW))).toMatchObject({ status: 'paid', tokenState: 'order_not_recoverable' });
      expect(await tokenPort().validate(event.payload.recoveryToken, new Date(NOW))).toBeNull();
    }
    for (const event of both) expect(await handler.handle(event, new AbortController().signal)).toMatchObject({ kind: 'processed', detail: { skipped: 'order_not_pending_payment' } });
    expect(sends).toHaveLength(2);
    await call(env.runtime, 'commerce_record_settlement', [`paid:${o.id}`, settlement, 'succeeded', null, {}, NOW]);
    expect((await env.owner.query("SELECT count(*)::int n FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [settlement])).rows[0].n).toBe(1);
  });

  it.each(['absent', 'queued', 'processed-only', 'skipped', 'disabled', 'ambiguous', 'failed', 'confirmed', 'before-settlement', 'wrong-profile', 'wrong-template'])(
    'requires event/template/profile-bound first-send evidence: %s', async evidence => {
      const o = await order(21); await waves().enqueue(1000, NOW); const first = (await events(o.id))[0]!;
      if (evidence === 'processed-only') await env.owner.query("UPDATE public.outbox_events SET status='processed' WHERE id=$1", [first.id]);
      if (['confirmed', 'before-settlement'].includes(evidence)) await waves().recordConfirmedSend(first.id, 'capture:confirmed');
      if (['skipped', 'disabled', 'ambiguous', 'failed'].includes(evidence)) {
        const outcome = { ok: evidence === 'skipped' || evidence === 'disabled', messageId: null, httpStatus: 0,
          providerError: null, aborted: evidence === 'ambiguous',
          ...(evidence === 'skipped' ? { skipReason: 'egress_suppressed' as const } : evidence === 'disabled' ? { skipReason: 'admin_disabled' as const } : {}) };
        const email = withCheckoutRecoverySendEvidence({ sendCheckoutRecovery: async () => outcome } as unknown as TransactionalEmailPort, waves());
        await email.sendCheckoutRecovery({ to: 'recipient@example.invalid', firstName: null, orderId: o.id,
          recoveryToken: first.payload.recoveryToken, mode: 'one_time', reminderHours: 1, outboxEventId: first.id, signal: new AbortController().signal });
      }
      if (evidence === 'wrong-profile') await expect(createPostgresCheckoutRecoveryWaves(env.runtime, { profile: 'other' }).recordConfirmedSend(first.id, 'capture:other')).rejects.toThrow('checkout_recovery_delivery_identity_invalid');
      if (evidence === 'wrong-template') await env.owner.query("SELECT public.transactional_delivery_record_accepted($1,$2,'capture:other')", [`checkout-reminder:${first.id}`, 'a'.repeat(64)]);
      await waves().enqueue(1000, NOW);
      expect(await events(o.id)).toHaveLength(['confirmed', 'before-settlement'].includes(evidence) ? 2 : 1);
      if (evidence === 'before-settlement') expect(first.status).toBe('pending');
    });

  it.each(['no-payment', 'fresh', 'stale', 'success', 'initial', 'renewal', 'too-young', 'deadline'])(
    'ports pending checkout/payment/declaration eligibility: %s', async state => {
      const o = await order(state === 'too-young' ? 0.5 : state === 'deadline' ? 24 : 2, state === 'initial');
      if (state === 'fresh' || state === 'stale' || state === 'success') await intent(o.id, state === 'success' ? 'settled' : 'created', state === 'fresh' ? at(-0.1) : at(-1));
      if (state === 'renewal') {
        const f = await lifecycleDeclined(env.owner);
        await env.owner.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1', [o.id, f.original.cycleId]);
      }
      await waves().enqueue(1000, NOW);
      expect(await events(o.id)).toHaveLength(['no-payment', 'stale', 'initial'].includes(state) ? 1 : 0);
      expect(await tokens(o.id)).toHaveLength(['no-payment', 'stale', 'initial'].includes(state) ? 1 : 0);
    });

  it('uses reservation expiry, preserves earlier links, and reconciles one expired notice atomically under replay', async () => {
    const o = await order(), old = randomUUID();
    await env.owner.query('INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)VALUES($1,$2,$3,$4)', [o.id, o.client, hashCheckoutRecoveryToken(old), at(24)]);
    await hold(o.id, -0.5);
    await waves().expire(1000, NOW); await waves().expire(1000, NOW); await waves().reconcile(1000, NOW);
    const emitted = await expireEvents(o.id); expect(emitted).toHaveLength(1);
    const stored = await tokens(o.id); expect(stored).toHaveLength(2); expect(stored.every(t => t.revoked_at === null)).toBe(true);
    expect(stored.map(t => t.token_hash)).toContain(hashCheckoutRecoveryToken(emitted[0]!.payload.recoveryToken));
    expect((await env.owner.query('SELECT status FROM public.commerce_orders WHERE id=$1', [o.id])).rows[0].status).toBe('expired');
    const missing = await order(); await hold(missing.id, -0.5, 'expired');
    await waves().expire(1000, NOW); expect(await expireEvents(missing.id)).toHaveLength(1);
    const untouched = await order(200); await hold(untouched.id, 1);
    await waves().expire(1000, NOW); expect(await expireEvents(untouched.id)).toHaveLength(0);
    const repair = await order(); await env.owner.query("UPDATE public.commerce_orders SET status='expired' WHERE id=$1", [repair.id]);
    await waves().reconcile(1000, NOW); await waves().reconcile(1000, NOW);
    expect(await expireEvents(repair.id)).toHaveLength(1); expect(await tokens(repair.id)).toHaveLength(1);
  });

  it('sweeps only unpaid initial activation, progressing past provider-contact refusals under limit without cancellation mail', async () => {
    const refused = await order(30, true), safe = await order(29, true), second = await order(28, true);
    const i = await intent(refused.id); await env.owner.query(`INSERT INTO public.payment_simulator_attempts(settlement_intent_id,request_key,request_fingerprint,state,dispatched_at,updated_at,authorization_ref,unattended_charge_authorized_at,method_ref,method_evidence_ref)
      VALUES($1,$2,$3,'dispatched',$4,$4,'authorization',$4,'method','evidence')`, [i, `attempt:${i}`, 'a'.repeat(64), at(-27)]);
    const dispatched = (await env.owner.query('SELECT id FROM public.payment_simulator_attempts WHERE settlement_intent_id=$1', [i])).rows[0].id;
    await call(env.runtime, 'payment_simulator_record_observation', [dispatched, `refused:${i}`, 'b'.repeat(64), 'refused', at(-26)]);
    const paid = await order(31, true); await intent(paid.id, 'settled');
    await waves().sweepInitial(1, at(-24), NOW);
    expect(await expireEvents(paid.id)).toHaveLength(0); expect(await expireEvents(refused.id)).toHaveLength(0); expect(await expireEvents(safe.id)).toHaveLength(1);
    expect(await expireEvents(second.id)).toHaveLength(0);
    await waves().sweepInitial(1, at(-24), NOW); await waves().sweepInitial(1, at(-24), NOW);
    expect(await expireEvents(second.id)).toHaveLength(1);
    for (const o of [safe, second]) {
      expect((await env.owner.query('SELECT state FROM public.subscription_activations WHERE order_id=$1', [o.id])).rows[0].state).toBe('compensated');
      expect(await tokens(o.id)).toHaveLength(1);
      expect((await env.owner.query("SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('commerce.order.cancelled','subscription.cancelled')", [o.id])).rows).toEqual([]);
    }
    expect((await env.owner.query('SELECT state FROM public.subscription_activations WHERE order_id=$1', [refused.id])).rows[0].state).toBe('provisional');
  });

  it.each(['past-window', 'at-deadline'])('emits exactly one token-less reservation-expiry notice: %s', async boundary => {
    const o = await order(boundary === 'past-window' ? 24 * 40 : 2);
    await hold(o.id, -0.5);
    const selected = createPostgresCheckoutRecoveryWaves(env.runtime,
      boundary === 'at-deadline' ? { ...policy, recoverySeconds: 7200 } : policy);
    await selected.expire(1000, NOW); await selected.expire(1000, NOW); await selected.reconcile(1000, NOW);
    const notices = await expireEvents(o.id);
    expect(notices).toHaveLength(1); expect(notices[0]!.payload).not.toHaveProperty('recoveryToken');
    expect(notices[0]!.payload).toMatchObject({ orderUuid: o.id, totalCents: 100, currency: 'XXX' });
    expect(await tokens(o.id)).toHaveLength(0);
  });

  it('reconciles an expired-window order together with a fresh one and replays without new capture', async () => {
    const old = await order(24 * 40), fresh = await order(2);
    await env.owner.query("UPDATE public.commerce_orders SET status='expired' WHERE id=ANY($1::uuid[])", [[old.id, fresh.id]]);
    const first = await waves().reconcile(1000, NOW);
    expect(first.inserted).toBe(2);
    const olderNotice = await expireEvents(old.id), freshNotice = await expireEvents(fresh.id);
    expect(olderNotice).toHaveLength(1); expect(olderNotice[0]!.payload).not.toHaveProperty('recoveryToken');
    expect(await tokens(old.id)).toHaveLength(0);
    expect(freshNotice).toHaveLength(1);
    expect(freshNotice[0]!.payload.recoveryToken).toMatch(/^rcv_/); expect(await tokens(fresh.id)).toHaveLength(1);
    expect(await waves().reconcile(1000, NOW)).toEqual({ checked: 0, inserted: 0 });
    expect(await expireEvents(old.id)).toEqual(olderNotice); expect(await expireEvents(fresh.id)).toEqual(freshNotice);
  });

  it('abandons an old safe initial checkout and sends its token-less notice without ordinary cancellation mail', async () => {
    const o = await order(24 * 40, true);
    expect(await waves().sweepInitial(1000, at(-24), NOW)).toMatchObject({ swept: 1 });
    const notices = await expireEvents(o.id); expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).not.toHaveProperty('recoveryToken'); expect(await tokens(o.id)).toHaveLength(0);
    const sent: Array<string | null> = [];
    const handler = createOutboxCheckoutExpiredEmailHandler({
      emailPort: { ...unusedMailPort, findExistingSend: async () => false, sendCheckoutExpiredNotice: async input => {
        sent.push(input.recoveryToken ?? null); return { ok: true, messageId: 'capture:expired', httpStatus: 200, providerError: null, aborted: false };
      } },
      recipientPort: { resolve: async () => ({ email: `${o.client}@example.invalid`, firstName: null }) },
      lifecyclePort: { read: async () => {
        const row = (await env.runtime.query(`SELECT o.status, o.metadata->>'subscriptionActivation'='abandoned' AND a.state='compensated' AS abandoned
          FROM public.commerce_orders o JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=$1`, [o.id])).rows[0];
        return { orderStatus: row.status, subscriptionActivationAbandoned: row.abandoned, paymentStatus: null, hasPayment: false };
      } },
      runtime: { formatMoney: (amount, currency) => `${currency} ${amount}`, resolveLocale: () => 'en',
        parseOutboxPayload: (schema, payload) => { const parsed = schema.safeParse(payload);
          return parsed.success ? { ok: true, data: parsed.data } : { ok: false, outcome: { kind: 'discard', reason: 'invalid_payload' } }; },
        mapSendOutcome: outcome => outcome.ok ? { kind: 'processed' } : { kind: 'retry', reason: 'send_failed' } },
    });
    expect(await handler.handle(notices[0]!, new AbortController().signal)).toMatchObject({ kind: 'processed' });
    expect(sent).toEqual([null]);
    expect(await waves().sweepInitial(1000, at(-24), NOW)).toMatchObject({ swept: 0 });
    await waves().reconcile(1000, NOW); expect(await expireEvents(o.id)).toEqual(notices);
    expect((await env.owner.query("SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('commerce.order.cancelled','subscription.cancelled')", [o.id])).rows).toEqual([]);
  });

  it('two connections enqueueing the same wave commit one event and token by outbox uniqueness', async () => {
    const o = await order(), a = await env.runtime.connect(), b = await env.runtime.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await createPostgresCheckoutRecoveryWaves(a, policy).enqueue(1000, NOW);
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = createPostgresCheckoutRecoveryWaves(b, policy).enqueue(1000, NOW); pending.catch(() => {});
      let blocked = false;
      for (let tries = 0; tries < 100 && !blocked; tries++) {
        blocked = (await env.owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await a.query('COMMIT'); await pending; await b.query('COMMIT');
      expect(await events(o.id)).toHaveLength(1); expect(await tokens(o.id)).toHaveLength(1);
    } finally { await a.query('ROLLBACK'); await pending?.catch(() => {}); await b.query('ROLLBACK'); a.release(); b.release(); }
  });

  it('rolls event capture back when the digest insert fails', async () => {
    const o = await order(), suffix = randomUUID().replaceAll('-', ''), name = `recovery_probe_${suffix}`;
    await env.owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.order_id='${o.id}'::uuid THEN RAISE EXCEPTION 'wave_token_probe' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON public.commerce_checkout_recovery_tokens FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try {
      await expect(waves().enqueue(1000, NOW)).rejects.toThrow('wave_token_probe');
      expect(await events(o.id)).toHaveLength(0); expect(await tokens(o.id)).toHaveLength(0);
    } finally { await env.owner.query(`DROP TRIGGER ${name} ON public.commerce_checkout_recovery_tokens; DROP FUNCTION public.${name}()`); }
  });

  it('competing scheduled invocations use the real job lease and disabled performs no persistence', async () => {
    const ledger = createPostgresPlatformJobRunLedger(env.runtime, { releaseCorrelation: () => ({}), defaultFailureReason: 'enqueue_failed' });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); let calls = 0; const jobName = `recovery:${randomUUID()}`;
    const bind = async () => ({ ledger, enqueue: async () => { calls++; entered(); await held; return { enqueued_1h: 0, enqueued_20h: 0 }; } });
    const options = { jobName, leaseSeconds: 120, batchSize: 200, bind };
    const invoke = { triggerKind: 'scheduler' as const, invocationSource: 'fixture' };
    expect(await createCheckoutRecoveryWaveJob({ ...options, enabled: () => false })(invoke, NOW)).toMatchObject({ skipped: true });
    expect((await env.owner.query('SELECT * FROM public.platform_job_runs WHERE job_name=$1', [jobName])).rows).toEqual([]);
    const job = createCheckoutRecoveryWaveJob({ ...options, enabled: () => true }); const first = job(invoke, NOW);
    try { await started; expect(await job(invoke, NOW)).toMatchObject({ skipped: true }); expect(calls).toBe(1); }
    finally { release(); await first; }
  });
});
