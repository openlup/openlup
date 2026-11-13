import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresPaymentMethodSetup, createPostgresPaymentWebhookControlPort, createPostgresPaymentWebhookMethodRefPort,
  createVerifiedPaymentIngress, consumePostgresPaymentMethodDelivery, createPostgresRecordedSubscriptionMethodReader,
  createPostgresPaymentMethodStore, paymentSchemaDescriptor } from "@openlup/platform/payments";
import type { VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { storeJourneyResources, assertJourneyRuntime } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { call, failure, prepareOriginal, renewal, request } from "./subscriptionNativeFixture.js";

const AT = "2026-11-13T12:00:00.000Z";

const runtimeResources = storeJourneyResources();
let installed: ReturnType<typeof runtimeResources.installation> | undefined;
const installation = () => installed ??= runtimeResources.installation("method-runtime");
afterAll(async () => { await runtimeResources.close(); }, postgresTeardownTimeoutMs);
it("accepts method setup, account support and verified method ingress on the installed qualified-v2 runtime roles", async () => {
  const { runtime } = await installation();
  await assertJourneyRuntime(runtime);
  expect(paymentSchemaDescriptor.methodSetup).toBe("supported");
  const principal = randomUUID(), subscription = randomUUID();
  await runtime.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
  const client = (await runtime.query("INSERT INTO public.clients(email,principal_id,acquisition_source,lifecycle_stage) VALUES($1,$2,'synthetic','customer') RETURNING id", [`${principal}@example.invalid`, principal])).rows[0].id;
  await runtime.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, AT]);
  const trace: string[] = [];
  const lane = createPostgresPaymentMethodSetup(runtime, { enabled: () => true, ensureCustomer: async input => { trace.push(input.idempotencyKey); return "runtime-customer"; },
    methodPort: { async setupMethod(input) { trace.push(input.idempotencyKey); return { kind: "ready", setupRef: "runtime-setup", handoff: { kind: "client-confirmed", payload: "transient" as never }, replayed: false }; } } });
  expect(await lane.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign" })).toMatchObject({ kind: "forbidden" });
  expect(trace).toEqual([]);
  const unavailable = { supported: false, refusalCode: "host_binding_required" } as const;
  const facade = createSelfServiceCommandFacade({ context: { principalId: principal, clientId: client, graph: "native" },
    capabilities: { graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
      paymentMethodSetup: { supported: true }, commerceRecovery: unavailable, configuredPurchase: unavailable,
      operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" }, operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
      subscriptions: { ...NATIVE_SUBSCRIPTION_CAPABILITIES, genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" }, commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" } },
      communicationGifts: { supported: false, refusalCode: "unsupported_preference" } }, paymentMethod: lane });
  expect(facade.capabilities.paymentMethodSetup).toEqual({ supported: true });
  expect(await facade.paymentMethod.execute(principal, { subscriptionId: subscription, idempotencyKey: "runtime" })).toMatchObject({ kind: "ready" });
  expect(trace).toEqual([`account-card-customer:${subscription}:runtime`, `account-card-setup:${subscription}:runtime`]);
  await expect(facade.paymentMethod.execute(randomUUID(), { subscriptionId: subscription, idempotencyKey: "foreign" })).rejects.toThrow("customer_principal_mismatch");
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
  await call(runtime, "dunning_lifecycle_issue_recovery_token", [obligation.case_id, hash, "2099-11-13T00:00:00Z"]);
  const token = (await runtime.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [hash])).rows[0].id;
  const authority = await call(runtime, "subscription_retry_authorize_recovery", [f.operation, token, reference, method.id, AT]);
  await call(runtime, "subscription_retry_schedule_recovery", [f.operation, `token-schedule:${f.operation}`, authority.id, AT]);
  if (phase === "freeze") await owner.query("UPDATE public.subscription_retry_obligations SET state='prepared' WHERE id=$1", [obligation.id]);
  const admission = await runtime.connect(), revocation = await runtime.connect(), methodBlocker = await owner.connect();
  let pending: Promise<unknown> | undefined, dispatchPending: Promise<unknown> | undefined;
  const admissionPid = (await admission.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const revocationPid = (await revocation.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const dispatch = () => phase === "admission"
    ? call(admission, "subscription_retry_prepare", [f.operation, `token-dispatch:${f.operation}`, { ...request({ ...f, original }), paymentMethodRef: reference }, "2026-11-14T12:00:00Z"])
    : call(admission, "payment_method_recovery_authority_freeze", [authority.id, f.operation, `token-dispatch:${f.operation}`, reference, "2026-11-14T12:00:00Z"]);
  try {
    expect((await admission.query("SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ current_user: "transfer_runtime", rolsuper: false }]);
    await methodBlocker.query("BEGIN");
    await methodBlocker.query("SELECT id FROM public.payment_method_refs WHERE id=$1 FOR UPDATE", [method.id]);
    const methodPid = (await methodBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await admission.query("BEGIN");
    dispatchPending = dispatch().catch(error => error);
    let methodBlockers: number[] = [];
    for (let n = 0; n < 300 && !methodBlockers.length; n++) methodBlockers = (await owner.query("SELECT pg_blocking_pids($1) AS pids", [admissionPid])).rows[0].pids;
    expect(methodBlockers).toContain(methodPid);
    await revocation.query("BEGIN");
    pending = revocation.query("UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=$2 WHERE id=$1", [token, AT]).catch(error => error);
    let blockers: number[] = [];
    for (let n = 0; n < 300 && !blockers.length; n++) blockers = (await owner.query("SELECT pg_blocking_pids($1) AS pids", [revocationPid])).rows[0].pids;
    expect(blockers).toContain(admissionPid);
    await methodBlocker.query("COMMIT");
    expect(await dispatchPending).not.toBeInstanceOf(Error);
    await admission.query("ROLLBACK");
    expect(await pending).not.toBeInstanceOf(Error);
    // Reverse the order: admission must observe revocation after the lock releases.
    pending = dispatch().catch(error => error);
    blockers = [];
    for (let n = 0; n < 300 && !blockers.length; n++) blockers = (await owner.query("SELECT pg_blocking_pids($1) AS pids", [admissionPid])).rows[0].pids;
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
