import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPostgresPaymentMethodSetup, createPostgresPaymentWebhookControlPort, createPostgresPaymentWebhookMethodRefPort,
  createVerifiedPaymentIngress, consumePostgresPaymentMethodDelivery, createPostgresRecordedSubscriptionMethodReader,
  createPostgresPaymentMethodStore, paymentSchemaDescriptor } from "@openlup/platform/payments";
import type { VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
import { createPostgresPurchaseRenewalWriter, createPostgresRenewalStore, NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import type { RenewalPaymentRail } from "@openlup/platform/subscriptions/contracts";
import { storeJourneyResources, assertJourneyRuntime } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { call, failure, prepareOriginal, renewal, request, retryDueAt } from "./subscriptionNativeFixture.js";
import { abortAtSecondLock, codec, dueSubject, lifecycleInstallation, lifecycleProfiles,
  scheduledRenewal, truth, witnessTimeout } from "./subscriptionLifecycleClosureFixture.js";

const AT = "2026-11-13T12:00:00.000Z";

const runtimeResources = storeJourneyResources();
let installed: ReturnType<typeof runtimeResources.installation> | undefined;
const installation = () => installed ??= runtimeResources.installation("method-runtime");
// Install the qualified runtime as fixture setup, outside the ingress test budget.
beforeAll(async () => { await installation(); }, postgresSetupTimeoutMs);
afterAll(async () => { await runtimeResources.close(); }, postgresTeardownTimeoutMs);
it("accepts method setup, account support and verified method ingress on the installed qualified-v2 runtime roles", async () => {
  const { runtime } = await installation();
  await assertJourneyRuntime(runtime);
  expect(paymentSchemaDescriptor.methodSetup).toBe("supported");
  const principal = randomUUID(), subscription = randomUUID();
  await runtime.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
  const client = (await runtime.query("INSERT INTO public.clients(email,principal_id,acquisition_source,lifecycle_stage) VALUES($1,$2,'synthetic','customer') RETURNING id", [`${principal}@example.invalid`, principal])).rows[0].id;
  await runtime.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, AT]);
  expect(await call(runtime, "subscription_method_has_recorded_ref", [subscription])).toBe(false);
  const trace: string[] = [];
  const lane = createPostgresPaymentMethodSetup(runtime, { enabled: () => true, ensureCustomer: async input => { trace.push(input.idempotencyKey); return "runtime-customer"; },
    methodPort: { async setupMethod(input) { trace.push(input.idempotencyKey); return { kind: "ready", setupRef: "runtime-setup", handoff: { kind: "client-confirmed", payload: "transient" as never }, replayed: false }; } } });
  expect(await lane.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign-key" })).toMatchObject({ kind: "forbidden" });
  expect(trace).toEqual([]);
  const unavailable = { supported: false, refusalCode: "host_binding_required" } as const;
  const facade = createSelfServiceCommandFacade({ context: { principalId: principal, clientId: client, graph: "native" },
    capabilities: { graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
      paymentMethodSetup: { supported: true }, commerceRecovery: unavailable, configuredPurchase: unavailable,
      operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
      subscriptions: { ...NATIVE_SUBSCRIPTION_CAPABILITIES, genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" }, commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" } },
      communicationGifts: { supported: false, refusalCode: "unsupported_preference" } }, paymentMethod: lane });
  expect(facade.capabilities.paymentMethodSetup).toEqual({ supported: true });
  expect(await facade.paymentMethod.execute(principal, { subscriptionId: subscription, idempotencyKey: "runtime-key" })).toMatchObject({ kind: "ready" });
  expect(trace).toEqual([`account-card-customer:${subscription}:runtime-key`, `account-card-setup:${subscription}:runtime-key`]);
  await expect(facade.paymentMethod.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign-key" })).rejects.toThrow("customer_principal_mismatch");
  const evidence: VerifiedMethodEvidence = { provider: "card_rail", providerEventId: randomUUID(), fingerprint: "b".repeat(64), providerOccurredAt: AT,
    kind: "method", outcome: "registered", methodRef: "runtime-method", setupRef: "runtime-setup", intentRef: null,
    reusableMethod: { providerCustomerRef: "runtime-customer", providerMethodRef: "runtime-method", methodKind: "card", status: "active", consentSnapshot: { source: "setup" } } };
  const webhook = createPostgresPaymentWebhookControlPort(runtime, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const closed: boolean[] = [];
  const ingress = createVerifiedPaymentIngress({ provider: "card_rail", verifyPort: { async verifyAndNormalize() { return evidence; } },
    paymentControlPort: { ...webhook, async markSetupEventProcessed(input) {
      const result = await webhook.markSetupEventProcessed!(input); closed.push(result.updated); return result;
    } },
    resolveMethodOwner: async () => ({ clientId: client, subscriptionId: subscription }), methodRefPort: createPostgresPaymentWebhookMethodRefPort(runtime),
    afterProcessed: async ({ event }) => consumePostgresPaymentMethodDelivery(runtime, event) });
  for (let n = 0; n < 2; n++) expect((await ingress.receive({ rawBody: new Uint8Array(), headers: {}, receivedAt: AT })).status).toBe(200);
  expect(await createPostgresRecordedSubscriptionMethodReader(runtime).read(subscription)).toMatchObject({ kind: "recorded", methodRef: "runtime-method", customerRef: "runtime-customer" });
  const recorded = await createPostgresPaymentMethodStore(runtime).read("card_rail", "runtime-method");
  expect(recorded).toMatchObject({ client_id: client, subscription_id: subscription });
  expect(closed).toEqual([true, false]);
  for (const table of ["payment_method_refs", "payment_method_ref_receipts", "payment_method_recovery_authorities"]) {
    await expect(runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
  }
  await expect(call(runtime, "payment_method_recovery_authority_record", [randomUUID(), randomUUID()])).rejects.toThrow("payment_method_recovery_authority_context_mismatch");
  await expect(call(runtime, "payment_method_recovery_authority_bind", [randomUUID(), randomUUID(), "outside-purpose", "evidence", AT])).rejects.toThrow("subscription_retry_recovery_not_authorized");
  await expect(call(runtime, "payment_method_recovery_authority_freeze", [randomUUID(), randomUUID(), "outside-purpose", "method", AT])).rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
  // Reminder production uses the unchanged invoker routine as the installed runtime login.
  await createPostgresPaymentMethodStore(runtime).upsert({ key: randomUUID(), clientId: client, subscriptionId: subscription,
    provider: "card_rail", methodKind: "card", customer: "runtime-customer", reference: "runtime-method", mandate: null,
    status: "active", active: true, expiresAt: (await runtime.query("SELECT now()+interval '10 days' AS at")).rows[0].at.toISOString(), consent: {}, payload: {} });
  await runtime.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days',updated_at=now()-interval '6 days' WHERE id=$1", [subscription]);
  await expect(runtime.query("SELECT subscription_id,active,status FROM public.payment_method_refs")).rejects.toMatchObject({ code: "42501" });
  expect(await call(runtime, "subscription_method_health_read", [subscription])).toMatchObject({ health_state: "method_expiring" });
  expect(await call(runtime, "dunning_lifecycle_renewal_reminder_enqueue", [100, 259200, 432000, 432000, 86400])).toMatchObject({ enqueued: 1 });
  expect((await runtime.query("SELECT reminder_kind FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [subscription])).rows)
    .toEqual([{ reminder_kind: "renewal_due_soon" }]);
  expect(await call(runtime, "dunning_lifecycle_renewal_reminder_enqueue", [100, 259200, 432000, 432000, 86400])).toMatchObject({ enqueued: 0 });
  await call(runtime, "payment_method_ref_deactivate", [randomUUID(), recorded!.id, "revoked", {}]);
  expect(await call(runtime, "subscription_method_has_recorded_ref", [subscription])).toBe(true);
  expect(await createPostgresPurchaseRenewalWriter(runtime).readMethod(subscription)).toMatchObject({ healthState: "method_missing", methodRef: null });
  expect((await runtime.query("SELECT has_function_privilege('anon','public.subscription_method_has_recorded_ref(uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
  await assertJourneyRuntime(runtime);
});


it.each(["admission", "freeze"] as const)("locks the token against concurrent revocation through %s as the installed runtime", async phase => {
  const { owner, runtime } = await installation();
  const f = await renewal(owner), original = await prepareOriginal(owner, f);
  await call(runtime, "subscription_retry_apply_failure", [f.operation, `token-failure:${f.operation}`, failure()]);
  await call(runtime, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
  const obligation = (await runtime.query("SELECT * FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0];
  const reference = randomUUID(), method = await createPostgresPaymentMethodStore(runtime).upsert({ key: randomUUID(), clientId: f.client,
    subscriptionId: f.subscription, provider: "card_rail", methodKind: "card", customer: null, reference, mandate: null,
    status: "active", active: true, expiresAt: null, consent: { recoveryCaseId: obligation.case_id }, payload: {} });
  const hash = randomUUID().replaceAll("-", "").repeat(2);
  await runtime.query("SELECT public.dunning_lifecycle_issue_recovery_token($1,$2,now()+interval '30 days')", [obligation.case_id, hash]);
  const token = (await runtime.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [hash])).rows[0].id;
  const recoveryAt = (await runtime.query("SELECT now() AS at")).rows[0].at.toISOString();
  const authority = await call(runtime, "subscription_retry_authorize_recovery", [f.operation, token, reference, method.id, recoveryAt]);
  await call(runtime, "subscription_retry_schedule_recovery", [f.operation, `token-schedule:${f.operation}`, authority.id, recoveryAt]);
  const dispatchAt = await retryDueAt(runtime, f.operation);
  if (phase === "freeze") await owner.query("UPDATE public.subscription_retry_obligations SET state='prepared' WHERE id=$1", [obligation.id]);
  const admission = await runtime.connect(), revocation = await runtime.connect(), methodBlocker = await owner.connect();
  let pending: Promise<unknown> | undefined, dispatchPending: Promise<unknown> | undefined;
  const admissionPid = (await admission.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const revocationPid = (await revocation.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  // Observe the expected lock dependency, rather than merely the first blocker.
  // Keep the existing 300-query bound; no elapsed-time delay or dispatch retry.
  const blockedBy = async (pid: number, blocker: number) => {
    let pids: number[] = [];
    for (let n = 0; n < 300 && !pids.includes(blocker); n++) {
      pids = (await owner.query(`SELECT pg_blocking_pids(a.pid) AS pids FROM pg_stat_activity a
        WHERE a.pid=$1 AND a.wait_event_type='Lock'
          AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`, [pid])).rows[0]?.pids ?? [];
    }
    return pids;
  };
  const dispatch = () => phase === "admission"
    ? call(admission, "subscription_retry_prepare", [f.operation, `token-dispatch:${f.operation}`, { ...request({ ...f, original }), paymentMethodRef: reference }, dispatchAt])
    : call(admission, "payment_method_recovery_authority_freeze", [authority.id, f.operation, `token-dispatch:${f.operation}`, reference, dispatchAt]);
  try {
    expect((await admission.query("SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ current_user: "transfer_runtime", rolsuper: false }]);
    await methodBlocker.query("BEGIN");
    await methodBlocker.query("SELECT id FROM public.payment_method_refs WHERE id=$1 FOR UPDATE", [method.id]);
    const methodPid = (await methodBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await admission.query("BEGIN");
    dispatchPending = dispatch().catch(error => error);
    const methodBlockers = await blockedBy(admissionPid, methodPid);
    expect(methodBlockers).toContain(methodPid);
    await revocation.query("BEGIN");
    pending = revocation.query("UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=$2 WHERE id=$1", [token, dispatchAt]).catch(error => error);
    let blockers = await blockedBy(revocationPid, admissionPid);
    expect(blockers).toContain(admissionPid);
    await methodBlocker.query("COMMIT");
    expect(await dispatchPending).not.toBeInstanceOf(Error);
    await admission.query("ROLLBACK");
    expect(await pending).not.toBeInstanceOf(Error);
    // Reverse the order: admission must observe revocation after the lock releases.
    pending = dispatch().catch(error => error);
    blockers = await blockedBy(admissionPid, revocationPid);
    expect(blockers).toContain(revocationPid);
    await revocation.query("COMMIT");
    expect(await pending).toMatchObject({ message: phase === "admission" ? "subscription_retry_method_mismatch" : "payment_method_recovery_authority_dispatch_mismatch" });
    expect(await call(runtime, "payment_method_recovery_authority_read", [authority.id])).toMatchObject({ dispatch_key: null });
    expect((await runtime.query("SELECT state,attempt_sequence FROM public.subscription_retry_obligations WHERE id=$1", [obligation.id])).rows[0])
      .toEqual({ state: phase === "freeze" ? "prepared" : "waiting", attempt_sequence: 0 });
  } finally {
    await methodBlocker.query("ROLLBACK");
    await Promise.all([admission.query("ROLLBACK"), revocation.query("ROLLBACK")]);
    await Promise.all([pending, dispatchPending]); admission.release(); revocation.release(); methodBlocker.release();
  }
});

it.each(lifecycleProfiles)('LOCK-1R S/P on %s recovers setup-success redelivery and scheduled prepare after either abort', async profile => {
  const h = await lifecycleInstallation(profile);
  try {
    const { owner, runtime } = h;
    const provider = 'card_rail', f = await dueSubject(h, provider);
    await call(owner, 'subscription_delivery_alignment_set_mode', ['off']);
    const oldMethod = 'pm_original', replacement = 'pm_replacement', customer = 'cus_fixture';
    const method = await createPostgresPaymentMethodStore(runtime).upsert({
      key: `method:${f.subscription}`, clientId: f.client, subscriptionId: f.subscription,
      provider, methodKind: 'card', customer, reference: oldMethod,
      mandate: null, status: 'active', active: true, expiresAt: null, consent: {}, payload: {},
    });
    const store = createPostgresRenewalStore(runtime, codec);
    const [due] = await store.listDue(1, f.at(0));
    expect(due.subscriptionId).toBe(f.subscription);
    const snapshot = await store.buildCycleSnapshots(due);
    if (snapshot.cycle.status !== 'correlated') throw new Error('Fixture needs correlated paid history');
    const claim = await store.claimDue({ snapshot, workerId: 'seed', now: f.at(0) });
    const operation = claim.operationId;
    await call(runtime, 'fulfillment_reserve_subscription_renewal', [operation, claim.claimToken, 900, f.at(0)]);
    const original = await call(runtime, 'commerce_prepare_subscription_renewal', [operation, claim.claimToken, f.at(0)]);
    await call(runtime, 'commerce_acknowledge_subscription_renewal_attempt', [operation, claim.operationFingerprint, 'declined-attempt', f.at(0)]);
    await call(runtime, 'subscription_retry_apply_failure', [operation, `failure:${operation}`,
      { ...failure(0, f.at(0)), logicalCycleNumber: snapshot.cycle.logicalCycleNumber }]);
    await call(runtime, 'subscription_retry_open_case', [operation, truth.dunningTemplateSlug, truth.recoveryUrlPath]);

    const eventId = randomUUID(), receiptKey = `provider-webhook:${provider}:${eventId}:method-ref`, at = f.at(25);
    const evidence: VerifiedMethodEvidence = {
      provider, providerEventId: eventId, fingerprint: 'b'.repeat(64), providerOccurredAt: at,
      kind: 'method', outcome: 'registered', methodRef: replacement, setupRef: 'setup-replacement', intentRef: null,
      reusableMethod: { providerCustomerRef: customer, providerMethodRef: replacement, methodKind: 'card', status: 'active' },
    };
    const delivery = { rawBody: Buffer.from(JSON.stringify({ eventId })), headers: {}, receivedAt: at };
    const receive = (executor: typeof setupAbort.executor) => createVerifiedPaymentIngress({
      provider, verifyPort: { verifyAndNormalize: async () => evidence },
      paymentControlPort: createPostgresPaymentWebhookControlPort(executor, truth),
      resolveMethodOwner: async () => ({ clientId: f.client, subscriptionId: f.subscription }),
      methodRefPort: createPostgresPaymentWebhookMethodRefPort(executor),
      afterProcessed: async ({ event }) => consumePostgresPaymentMethodDelivery(executor, event),
    }).receive(delivery);
    const subscription = ['SELECT id FROM public.subscriptions WHERE id=$1', f.subscription] as const;
    const paymentMethod = ['SELECT id FROM public.payment_method_refs WHERE id=$1', method.id] as const;
    const setupAbort = abortAtSecondLock(h, 'payment_method_ref_upsert', paymentMethod, subscription);
    const prepareAbort = abortAtSecondLock(h, 'subscription_retry_prepare', subscription, paymentMethod);
    const dispatch = vi.fn<RenewalPaymentRail['execute']>(async () => ({ status: 'pending', externalAttemptRef: 'retry-attempt' }));
    const population = `lock1r:${f.subscription}`;
    const tick = (executor: typeof prepareAbort.executor) => scheduledRenewal(h, executor, () => at, oldMethod, dispatch, population)();
    const effects = async () => (await owner.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.provider_method_ref) FROM public.payment_method_refs m WHERE subscription_id=$1) AS methods,
      (SELECT count(*)::int FROM public.payment_method_ref_receipts WHERE idempotency_key=$4) AS method_receipts,
      (SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$2) AS obligation,
      (SELECT count(*)::int FROM public.subscription_retry_receipts r JOIN public.subscription_retry_obligations o
        ON o.id=r.obligation_id WHERE o.renewal_operation_id=$2 AND r.kind='prepare') AS prepares,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.outbox_events e WHERE aggregate_id IN ($1,$3)) AS outbox,
      (SELECT count(*)::int FROM public.commerce_order_holds WHERE order_id=$3) AS holds`,
    [f.subscription, operation, original.orderId, receiptKey])).rows[0];
    const storedEvidence = async () => (await owner.query(`SELECT id,processing_status,processed_at
      FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1`, [eventId])).rows;

    const before = await effects();
    expect(before).toMatchObject({ method_receipts: 0, prepares: 0, holds: 0, obligation: { state: 'waiting' } });
    expect(await receive(setupAbort.executor)).toMatchObject({ status: 503 });
    expect(setupAbort.cancelled).toEqual(['payment_method_ref_upsert']);
    expect(await storedEvidence()).toEqual([{ id: expect.any(String), processing_status: 'received', processed_at: null }]);
    expect(await effects()).toEqual(before);

    expect(await tick(prepareAbort.executor)).toMatchObject({ retries: [{ operationId: operation, status: 'error' }] });
    expect(prepareAbort.cancelled).toEqual(['subscription_retry_prepare']);
    expect(await effects()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
    expect((await owner.query('SELECT status FROM public.platform_job_runs WHERE job_name=$1', [`subscription-renewal:demo:${population}`])).rows)
      .toEqual([{ status: 'failed' }]);

    expect(await tick(runtime)).toMatchObject({ retries: [{ operationId: operation, status: 'awaiting_provider' }] });
    expect(await effects()).toMatchObject({ prepares: 1, method_receipts: 0, holds: 0, outbox: before.outbox, obligation: { state: 'prepared' } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paymentMethodRef: oldMethod }));

    expect(await receive(runtime)).toMatchObject({ status: 200 });
    const committed = await effects(), processed = await storedEvidence();
    expect(committed).toMatchObject({ prepares: 1, method_receipts: 1, holds: 0, outbox: before.outbox,
      methods: [{ provider_method_ref: oldMethod, active: false }, { provider_method_ref: replacement, active: true }] });
    expect(processed).toEqual([{ id: expect.any(String), processing_status: 'processed', processed_at: expect.any(Date) }]);
    expect(await receive(runtime)).toMatchObject({ status: 200 });
    await tick(runtime);
    expect(await storedEvidence()).toEqual(processed);
    expect(await effects()).toEqual(committed);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
}, witnessTimeout);
