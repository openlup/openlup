import { randomUUID } from "node:crypto";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentMethodStore, createPostgresPaymentMethodSetup, createPostgresPaymentWebhookControlPort,
  createPostgresPaymentWebhookMethodRefPort, createVerifiedPaymentIngress, consumePostgresPaymentMethodDelivery,
  applyPostgresPaymentMethodLifecycleEvent, schedulePostgresRetryOnDurableMethodUpdate, createPostgresRecordedSubscriptionMethodReader } from "@openlup/platform/payments";
import type { VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";
import type { RenewalFrozenSnapshot } from "@openlup/platform/subscriptions/contracts";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
import { createNativeRetryDriver, createPostgresRetryStore, NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import type { PaymentMethodLifecycleEvent, PaymentMethodReplacementFacts } from "@openlup/core/payment";
import { call, failure, prepareOriginal, renewal, request } from "./subscriptionNativeFixture.js";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
let originalHeaders: Record<string, unknown>[];
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `method-native-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  db = await pool.connect();
  await db.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file.endsWith("20261114110000_payment_method_refs.sql")) originalHeaders = await headers();
    await db.query(readFileSync(unit.file, "utf8"));
  }
  await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
async function headers() {
  const registry = JSON.parse(readFileSync("config/reviewed-platform-forwards.json", "utf8"));
  const slot = registry.nativeStoreForwardClass.slots.find((row: { row: string }) => row.row === "n6-method-refs");
  return (await db.query(`SELECT oid::regprocedure::text AS signature,prosecdef,proacl,proconfig,provolatile,proparallel,proisstrict,
    pg_get_function_arguments(oid) AS arguments,pg_get_function_result(oid) AS result
    FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid::regprocedure::text`,
  [slot.replacedFunctions.map((fn: { signature: string }) => fn.signature)])).rows;
}
it("preserves every replaced function's signature, security, configuration and ACL", async () => {
  expect(originalHeaders).toHaveLength(16);
  expect(await headers()).toEqual(originalHeaders);
});
it.each([["replayed", 7], ["subscription_switch", 4], ["consent_snapshot_merge", 8], ["scope_repair", 24], ["health", 16]] as const)("retains %s assertions on native PostgreSQL", async (file, count) => {
  try {
    const response = await db.query(readFileSync(`tests/postgres/fixtures/paymentMethods/${file}.sql`, "utf8"));
    const results = Array.isArray(response) ? response : [response];
    const lines = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((value): value is string => typeof value === "string")));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^(?:ok|not ok) \d+/u.test(line))).toHaveLength(count);
  } finally { await db.query("ROLLBACK"); }
});

const AT = "2026-11-13T12:00:00.000Z";
const store = () => createPostgresPaymentMethodStore(db);
async function subject() {
  const client = randomUUID(), subscription = randomUUID(), principal = randomUUID();
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
  await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, AT]);
  return { client, subscription, principal };
}
async function method(f: { client: string; subscription: string }, reference: string = randomUUID(), consent: Record<string, unknown> = {}, scoped = true) {
  const result = await store().upsert({ key: randomUUID(), clientId: f.client, subscriptionId: scoped ? f.subscription : null, provider: "card_rail",
    methodKind: "card", customer: `customer:${f.client}`, reference, mandate: null, status: "active", active: true, expiresAt: null, consent, payload: {} });
  return { ...result, reference };
}
const lifecycle = (reference: string, kind: "method_updated" | "method_revoked" = "method_updated", replacement: PaymentMethodReplacementFacts = { lastDigits: "1234", schemeLabel: null, expiresAt: null }): PaymentMethodLifecycleEvent => ({
  providerKind: "card_rail", providerMethodRef: reference, providerEventId: randomUUID(), occurredAt: AT, kind, replacement,
});

it("authorizes setup before provider I/O, reuses the customer and preserves both stable keys", async () => {
  const f = await subject(), trace: string[] = [];
  const lane = createPostgresPaymentMethodSetup(db, { enabled: () => true,
    ensureCustomer: async input => { trace.push(input.idempotencyKey); return "customer-created"; },
    methodPort: { async setupMethod(input) { trace.push(input.idempotencyKey); return { kind: "ready", setupRef: "setup-1", handoff: { kind: "client-confirmed", payload: "transient" as never }, replayed: false }; } } });
  expect(await lane.execute(randomUUID(), { subscriptionId: f.subscription, idempotencyKey: "setup" })).toMatchObject({ kind: "forbidden" });
  expect(trace).toEqual([]);
  expect(await lane.execute(f.principal, { subscriptionId: f.subscription, idempotencyKey: "setup" })).toMatchObject({ kind: "ready" });
  expect(trace).toEqual([`account-card-customer:${f.subscription}:setup`, `account-card-setup:${f.subscription}:setup`]);
  await method(f); trace.length = 0;
  expect(await lane.execute(f.principal, { subscriptionId: f.subscription.toUpperCase(), idempotencyKey: "again" })).toMatchObject({ kind: "ready" });
  expect(trace).toEqual([`account-card-setup:${f.subscription}:again`]);
  const unavailable = { supported: false, refusalCode: "host_binding_required" } as const;
  const facade = createSelfServiceCommandFacade({ context: { principalId: f.principal, clientId: f.client, graph: "native" },
    capabilities: { graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
      paymentMethodSetup: { supported: true }, commerceRecovery: unavailable, configuredPurchase: unavailable,
      operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
      operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
      subscriptions: { ...NATIVE_SUBSCRIPTION_CAPABILITIES, genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" },
        commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" } },
      communicationGifts: { supported: false, refusalCode: "unsupported_preference" } }, paymentMethod: lane });
  await expect(facade.paymentMethod.execute(randomUUID(), { subscriptionId: f.subscription, idempotencyKey: "foreign" })).rejects.toThrow("customer_principal_mismatch");
  expect(await facade.paymentMethod.execute(f.principal, { subscriptionId: f.subscription, idempotencyKey: "account" })).toMatchObject({ kind: "ready" });
  const disabled = createPostgresPaymentMethodSetup(db, { enabled: () => false, ensureCustomer: async () => { throw new Error("unreachable"); }, methodPort: { async setupMethod() { throw new Error("unreachable"); } } });
  expect(await disabled.execute(f.principal, { subscriptionId: f.subscription, idempotencyKey: "disabled" })).toEqual({ kind: "disabled" });
  expect(await lane.execute(f.principal, { subscriptionId: "invalid", idempotencyKey: "" })).toEqual({ kind: "invalid" });
  const unsupported = createPostgresPaymentMethodSetup(db, { enabled: () => true, ensureCustomer: async () => "unused", methodPort: { async setupMethod() { return { kind: "unsupported" }; } } });
  expect(await unsupported.execute(f.principal, { subscriptionId: f.subscription, idempotencyKey: "unsupported" })).toEqual({ kind: "unsupported" });
});

it("falls back to the client's most active recent customer, preserving the resolver selection", async () => {
  const f = await subject(); await method(f, "account-method", {}, false);
  expect(await call(db, "payment_method_setup_resolve_owner", [f.principal, f.subscription])).toMatchObject({ providerCustomerRef: `customer:${f.client}` });
  expect(await call(db, "payment_method_setup_resolve_owner", [randomUUID(), f.subscription])).toBeNull();
});

it("merges lifecycle facts, skips absent/inactive deaths, retains first deactivation and expires stale arrivals", async () => {
  const f = await subject(), m = await method(f, "lifecycle-primary", { recurringModel: "O", source: "registration" });
  const refresh = lifecycle(m.reference);
  expect(await applyPostgresPaymentMethodLifecycleEvent(db, refresh)).toEqual({ outcome: "metadata_refreshed", reason: null });
  expect((await store().read("card_rail", m.reference))?.consent_snapshot).toMatchObject({ recurringModel: "O", source: "registration", methodLastDigits: "1234" });
  await applyPostgresPaymentMethodLifecycleEvent(db, refresh);
  expect((await db.query("SELECT count(*)::int AS n FROM public.payment_method_ref_receipts WHERE idempotency_key=$1", [`provider-webhook:card_rail:${refresh.providerEventId}:method-lifecycle`])).rows[0].n).toBe(1);
  expect(await applyPostgresPaymentMethodLifecycleEvent(db, lifecycle("unknown"))).toEqual({ outcome: "skipped", reason: "method_ref_absent" });
  const death = lifecycle(m.reference, "method_revoked");
  expect(await applyPostgresPaymentMethodLifecycleEvent(db, death)).toEqual({ outcome: "deactivated", reason: null });
  const first = (await db.query("SELECT deactivated_at FROM public.payment_method_refs WHERE id=$1", [m.id])).rows[0];
  expect(await applyPostgresPaymentMethodLifecycleEvent(db, death)).toEqual({ outcome: "skipped", reason: "method_ref_already_inactive" });
  expect((await db.query("SELECT deactivated_at FROM public.payment_method_refs WHERE id=$1", [m.id])).rows[0]).toEqual(first);
  const next = await method(f, "expired-arrival");
  expect(await applyPostgresPaymentMethodLifecycleEvent(db, { ...lifecycle(next.reference), replacement: { schemeLabel: null, lastDigits: null, expiresAt: "2020-01-01T00:00:00Z" } })).toEqual({ outcome: "deactivated", reason: null });
});

it("keeps setup ingress retryable after a concrete method write failure and closes only after redelivery succeeds", async () => {
  const f = await subject(), evidence: VerifiedMethodEvidence = { provider: "card_rail", providerEventId: randomUUID(), fingerprint: "a".repeat(64), providerOccurredAt: AT,
    kind: "method", outcome: "registered", methodRef: "pipeline-method", setupRef: "setup-pipeline", intentRef: null,
    reusableMethod: { providerCustomerRef: "customer", providerMethodRef: "pipeline-method", methodKind: "card", status: "active", consentSnapshot: { source: "setup" } } };
  const control = createPostgresPaymentWebhookControlPort(db, { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  let fail = true;
  const ingress = createVerifiedPaymentIngress({ provider: "card_rail", verifyPort: { async verifyAndNormalize() { return evidence; } }, paymentControlPort: control,
    resolveMethodOwner: async () => ({ clientId: f.client, subscriptionId: f.subscription }),
    methodRefPort: { async upsertFromWebhook(event) {
      if (fail) {
        // Storage's active/expiry invariant refuses this write; no mock persistence result.
        await store().upsert({ key: "invalid-pipeline", clientId: f.client, subscriptionId: f.subscription, provider: event.provider,
          methodKind: "card", customer: null, reference: "invalid", mandate: null, status: "active", active: true, expiresAt: "2020-01-01T00:00:00Z", consent: {}, payload: {} });
      }
      return createPostgresPaymentWebhookMethodRefPort(db).upsertFromWebhook(event);
    } }, afterProcessed: async ({ event }) => consumePostgresPaymentMethodDelivery(db, event) });
  const input = { rawBody: new Uint8Array(), headers: {}, receivedAt: AT };
  expect((await ingress.receive(input)).status).toBe(503);
  const row = () => db.query("SELECT processing_status,processed_at FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1", [evidence.providerEventId]);
  expect((await row()).rows[0]).toEqual({ processing_status: "received", processed_at: null });
  fail = false;
  expect((await ingress.receive(input)).status).toBe(200);
  expect((await row()).rows[0].processing_status).toBe("processed");
  expect((await ingress.receive(input)).status).toBe(200);
  expect((await store().read("card_rail", "pipeline-method"))?.subscription_id).toBe(f.subscription);
  expect((await db.query("SELECT count(*)::int AS n FROM public.payment_truth_events")).rows[0].n).toBe(0);
  expect(await control.markSetupEventProcessed!({ paymentEventId: randomUUID() })).toEqual({ updated: false });
  await expect(call(db, "payment_control_mark_setup_event_processed", [null])).rejects.toThrow("payment_control_mark_setup_event_invalid_input");
});

it("retains safe historical refusals, dry-run bounds, fingerprint exclusions and direct switch semantics", async () => {
  const f = await subject(), reference = "historical-mirror";
  await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,method_kind) VALUES($1,'healthy',$2,'card')", [f.subscription, reference]);
  expect((await db.query("SELECT count(*)::int AS n FROM public.payment_method_refs WHERE provider_method_ref=$1", [reference])).rows[0].n).toBe(0);
  const missingBefore = await methodRows();
  expect(await createPostgresRecordedSubscriptionMethodReader(db).read(f.subscription)).toEqual({ kind: "unavailable", reason: "method_ref_not_recorded" });
  expect(await call(db, "payment_method_ref_repair_subscription_scope", ["missing-historical", f.subscription, AT, "native-test"]))
    .toMatchObject({ paymentMethodRefScopeRepair: { status: "skipped", reason: "no_matching_method_ref" } });
  // Scope-repair refusal records its receipt, but never manufactures a reusable method.
  expect((await methodRows()).payment_method_refs).toEqual(missingBefore.payment_method_refs);
  const m = await method(f, reference, { recurringModel: "O", source: "first" }, false);
  const before = (await db.query("SELECT to_jsonb(m) AS row FROM public.payment_method_refs m WHERE id=$1", [m.id])).rows;
  expect(await call(db, "payment_method_ref_repair_subscription_scope_batch", [100, false, "native-test"])).toMatchObject({ paymentMethodRefScopeRepairBatch: { apply: false, repairableCount: 1, repairedCount: 0 } });
  expect((await db.query("SELECT to_jsonb(m) AS row FROM public.payment_method_refs m WHERE id=$1", [m.id])).rows).toEqual(before);
  for (const limit of [0, 501, null]) await expect(call(db, "payment_method_ref_repair_subscription_scope_batch", [limit, false, "native-test"])).rejects.toThrow("payment_method_ref_scope_repair_batch_invalid_limit");
  expect(await call(db, "payment_method_ref_repair_subscription_scope_batch", [1, true, "native-test"])).toMatchObject({ paymentMethodRefScopeRepairBatch: { repairedCount: 1 } });
  expect(await createPostgresRecordedSubscriptionMethodReader(db).read(f.subscription)).toMatchObject({ kind: "recorded", methodRef: m.reference });
  const second = await method(f, "switch-target", {}, false);
  await call(db, "payment_method_ref_switch_active", ["direct-switch", second.id, f.subscription]);
  expect((await store().read("card_rail", m.reference))?.active).toBe(false);
  const state = (await db.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
  await call(db, "payment_method_ref_link_subscription_mirror", ["direct-link", f.subscription, second.id]);
  expect((await db.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0]).toEqual(state);
  const key = randomUUID(), base = { key, clientId: f.client, subscriptionId: null, provider: "alias_rail", methodKind: "alias", customer: null,
    reference: "fingerprint", mandate: null, status: "active", active: true, expiresAt: null, consent: { source: "first" }, payload: { first: true } };
  await store().upsert(base);
  expect(await store().upsert({ ...base, consent: { source: "changed" }, payload: { changed: true } })).toMatchObject({ replayed: true });
  expect((await store().read("alias_rail", "fingerprint"))?.consent_snapshot).toEqual({ source: "first" });
  await expect(store().upsert({ ...base, reference: "different" })).rejects.toThrow("payment_method_ref_idempotency_conflict");
});

async function declined() {
  const f = await renewal(pool), original = await prepareOriginal(pool, f);
  await call(db, "subscription_retry_apply_failure", [f.operation, `decline:${f.operation}`, failure()]);
  await call(db, "subscription_retry_open_case", [f.operation, "dunning", "/recover"]);
  const o = (await db.query("SELECT * FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0];
  return { ...f, original, obligation: o.id as string, caseId: o.case_id as string };
}
async function authorize(f: Awaited<ReturnType<typeof declined>>, m: { id: string; reference: string }) {
  const hash = randomUUID().replaceAll("-", "").repeat(2);
  await call(db, "dunning_lifecycle_issue_recovery_token", [f.caseId, hash, "2027-11-13T00:00:00Z"]);
  const token = (await db.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [hash])).rows[0].id;
  return call(db, "subscription_retry_authorize_recovery", [f.operation, token, m.reference, m.id, AT]);
}

it("accelerates only a fresh usable automatic slot, never a stopped/exhausted cycle or a bare historical mirror", async () => {
  const f = await declined(), m = await method(f);
  const event = { provider: "card_rail", providerEventId: randomUUID(), providerPaymentId: "setup", eventType: "setup.succeeded" as const, occurredAt: AT, rawPayload: {},
    reusableMethod: { clientId: f.client, subscriptionId: f.subscription, providerMethodRef: m.reference, methodKind: "card", status: "active" as const } };
  await db.query("UPDATE public.payment_method_refs SET updated_at='2020-01-01T00:00:00Z' WHERE id=$1", [m.id]);
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, event)).toEqual({ outcome: "not_scheduled", reason: "recovery_not_ready" });
  await db.query("UPDATE public.payment_method_refs SET updated_at=now() WHERE id=$1", [m.id]);
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, event)).toEqual({ outcome: "scheduled", reason: "ready" });
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, event)).toEqual({ outcome: "not_scheduled", reason: "already_scheduled" });
  await db.query("UPDATE public.subscription_retry_obligations SET retry_attempt=4,next_retry_at=NULL WHERE id=$1", [f.obligation]);
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, event)).toEqual({ outcome: "not_scheduled", reason: "recovery_not_ready" });
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, { ...event, reusableMethod: undefined })).toEqual({ outcome: "skipped", reason: "no_usable_method_signal" });
  expect(await schedulePostgresRetryOnDurableMethodUpdate(db, { ...event, reusableMethod: { ...event.reusableMethod, providerMethodRef: "unrecorded" } })).toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });
  expect(await call(db, "subscription_try_schedule_recovery_retry", [randomUUID(), m.reference, AT, "method_ref_webhook"])).toEqual({ scheduled: false, reason: "case_not_found" });
});

it("rebinds undispatched authority, clears quarantine, preserves rung/counters and freezes the exact binding at dispatch", async () => {
  const f = await declined(), a = await method(f, "repair-a", { recoveryCaseId: f.caseId });
  const first = await authorize(f, a);
  expect(await call(db, "subscription_retry_schedule_recovery", [f.operation, "schedule-a", first.id, AT])).toMatchObject({ scheduled: true });
  await db.query("UPDATE public.subscription_retry_obligations SET renewal_quarantined_until='2027-01-01',renewal_row_error_key='stale',renewal_row_error_count=3 WHERE id=$1", [f.obligation]);
  const b = await method(f, "repair-b", { recoveryCaseId: f.caseId }), second = await authorize(f, b);
  expect(await call(db, "subscription_retry_schedule_recovery", [f.operation, "schedule-b", second.id, AT])).toMatchObject({ scheduled: true });
  expect((await db.query("SELECT retry_attempt,attempt_sequence,method_recovery_authority_id,renewal_quarantined_until,renewal_row_error_key,renewal_row_error_count FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0])
    .toEqual({ retry_attempt: 1, attempt_sequence: 0, method_recovery_authority_id: second.id, renewal_quarantined_until: null, renewal_row_error_key: null, renewal_row_error_count: 0 });
  const input = { ...request(f), paymentMethodRef: b.reference };
  // Expired authority cannot dispatch even when its method remains active.
  await db.query("UPDATE public.commerce_checkout_recovery_tokens SET created_at='2019-01-01T00:00:00Z',expires_at='2020-01-01T00:00:00Z' WHERE id=$1", [second.token_id]);
  await expect(call(db, "subscription_retry_prepare", [f.operation, "expired-prepare", input, "2026-11-14T12:00:00Z"])).rejects.toThrow("subscription_retry_method_mismatch");
  await db.query("UPDATE public.commerce_checkout_recovery_tokens SET expires_at='2027-11-13T00:00:00Z' WHERE id=$1", [second.token_id]);
  expect(await call(db, "subscription_retry_prepare", [f.operation, "prepare-b", input, "2026-11-14T12:00:00Z"])).toMatchObject({ execute: true, attemptSequence: 1 });
  expect((await db.query("SELECT dispatch_key FROM public.payment_method_recovery_authorities WHERE id=$1", [second.id])).rows[0].dispatch_key).toBe("prepare-b");
  expect(await call(db, "subscription_retry_prepare", [f.operation, "prepare-b", input, "2026-11-14T12:00:00Z"])).toMatchObject({ execute: false, replayed: true });
  expect((await db.query("SELECT count(*)::int AS n FROM public.payment_method_recovery_authorities WHERE case_id=$1", [f.caseId])).rows[0].n).toBe(2);
  const c = await method(f, "repair-c", { recoveryCaseId: f.caseId });
  expect(await call(db, "subscription_try_schedule_recovery_retry", [f.caseId, c.reference, AT, "method_ref_webhook"])).toMatchObject({ scheduled: false, reason: "cycle_not_retryable" });
});

it("allows an exhausted rung only through recorded token authority without replenishing its budget", async () => {
  const f = await declined(), m = await method(f, randomUUID(), { recoveryCaseId: f.caseId });
  await db.query("UPDATE public.subscription_retry_obligations SET retry_attempt=4,next_retry_at=NULL WHERE id=$1", [f.obligation]);
  expect(await call(db, "subscription_try_schedule_recovery_retry", [f.caseId, m.reference, AT, "method_ref_webhook"])).toEqual({ scheduled: false, reason: "recovery_not_ready" });
  const authority = await authorize(f, m);
  expect(await call(db, "subscription_retry_schedule_recovery", [f.operation, "exhausted-token", authority.id, AT])).toMatchObject({ scheduled: true });
  expect(await call(db, "subscription_retry_schedule_recovery", [f.operation, "exhausted-replay", authority.id, AT])).toMatchObject({ scheduled: false });
  expect((await db.query("SELECT retry_attempt,attempt_sequence FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0]).toEqual({ retry_attempt: 4, attempt_sequence: 0 });
  expect(await call(db, "subscription_retry_prepare", [f.operation, "exhausted-prepare", { ...request(f), paymentMethodRef: m.reference }, "2026-11-14T12:00:00Z"])).toMatchObject({ execute: true, attemptSequence: 1 });
});


it("consumes the provider owner's canonical failure once and replays its original result without another rung or case", async () => {
  const f = await renewal(pool, 10, 1, randomUUID(), true);
  await call(db, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, "2026-09-01T12:00:00Z"]);
  const original = await call(db, "commerce_prepare_subscription_renewal", [f.operation, f.token, "2026-09-01T12:00:00Z"]);
  const cycle = (await db.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [original.orderId])).rows[0].subscription_cycle_id;
  const control = createPostgresProviderPaymentControlPort(db, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" });
  const intent = original.settlementIntentId as string;
  await control.createIntent({ idempotencyKey: `provider:${intent}`, targetKind: "subscription_cycle", orderId: original.orderId,
    subscriptionId: f.subscription, subscriptionCycleId: cycle, amountMinor: 200, currency: "XXX", metadata: {}, channelKey: "fixture", at: AT });
  const prepared = await control.prepareProviderAttempt({ idempotencyKey: `prepare:${intent}`, paymentIntentId: intent, provider: "card_rail",
    providerIdempotencyKey: `provider:${intent}`, providerRequestFingerprint: "f".repeat(64), providerFlow: "off_session_payment", paymentMethodRef: "method-primary", requestPayload: {} });
  const external = `provider-attempt:${prepared.paymentAttemptId}`;
  await control.finalizeProviderAttempt({ idempotencyKey: `finalize:${intent}`, paymentIntentId: intent, paymentAttemptId: prepared.paymentAttemptId,
    providerIdempotencyKey: `provider:${intent}`, providerRequestFingerprint: "f".repeat(64), providerAttemptId: external,
    providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} });
  await call(db, "commerce_acknowledge_subscription_renewal_attempt", [f.operation, f.fingerprint, external, AT]);
  await control.applyPaymentResult({ idempotencyKey: `result:${intent}`, paymentIntentId: intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: AT, failureReason: "declined", failureClass: "soft_retryable" });
  const receipt = (await db.query("SELECT * FROM public.subscription_retry_receipts WHERE receipt_key=$1", [`result:${intent}:truth`])).rows[0];
  const retry = createPostgresRetryStore(db);
  const expected = await retry.applyFailure(f.operation, receipt.receipt_key, receipt.input);
  const unreachable = () => { throw new Error("unexpected payment I/O"); };
  const driver = createNativeRetryDriver({ executor: db, withTransaction: async work => {
    await db.query("BEGIN");
    try { const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
  }, decode: unreachable, readFrozenMandate: unreachable, retryInput: unreachable, validateInput: unreachable,
  payments: { execute: unreachable, readOutcome: unreachable }, classifyFailure: unreachable,
  failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/recover" });
  const before = (await db.query(`SELECT jsonb_build_array(
    (SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$1),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commerce_settlement_transitions t WHERE intent_id=$2),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_receipts r WHERE obligation_id=$3),
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.subscription_dunning_cases c WHERE cycle_id=$4)) AS value`,
  [f.operation, intent, receipt.obligation_id, cycle])).rows[0].value;
  for (const key of ["retry-handoff:first", "retry-handoff:replay", receipt.receipt_key]) {
    expect(await driver.propagateFailure(f.operation, key, receipt.input)).toEqual({ obligation: expected, replayed: true, caseAdvanced: false });
  }
  await expect(driver.propagateFailure(f.operation, "wrong-attempt", { ...receipt.input, externalRef: "another-attempt" }))
    .rejects.toThrow("subscription_retry_provider_failure_mismatch");
  expect(await call(db, "subscription_retry_apply_failure", [f.operation, receipt.receipt_key, receipt.input])).toEqual(receipt.result);
  expect((await db.query(`SELECT jsonb_build_array(
    (SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$1),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commerce_settlement_transitions t WHERE intent_id=$2),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_receipts r WHERE obligation_id=$3),
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.subscription_dunning_cases c WHERE cycle_id=$4)) AS value`,
  [f.operation, intent, receipt.obligation_id, cycle])).rows[0].value).toEqual(before);
  expect(before[0].retry_attempt).toBe(1);
  expect(before[1].filter((row: { outcome: string }) => row.outcome !== "opened")).toHaveLength(1);
  expect(before[2]).toHaveLength(1); expect(before[3]).toBeNull();
});


async function methodRows() {
  const rows: Record<string, unknown> = {};
  for (const table of ["subscriptions", "subscription_cycles", "subscription_renewal_operations", "subscription_retry_obligations",
    "subscription_retry_receipts", "subscription_retry_recovery_authorizations", "subscription_dunning_cases", "subscription_events",
    "subscription_method_states", "payment_method_refs", "payment_method_ref_receipts", "payment_method_recovery_authorities", "commerce_checkout_recovery_tokens",
    "commerce_orders", "commerce_settlement_intents", "commerce_settlement_transitions", "payment_provider_attempt_evidence", "fulfillment_inventory_reservations"]) {
    rows[table] = (await db.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return rows;
}

it("refuses historical provider work without reusable refs or recorded recovery context with zero state change", async () => {
  const f = await declined();
  // Provider/renewal context remains recorded even when the method mirror predates reusable refs.
  await createPostgresProviderPaymentControlPort(db, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" })
    .createIntent({ idempotencyKey: `historical:${f.operation}`, targetKind: "subscription_cycle", orderId: f.original.orderId,
      subscriptionId: f.subscription, subscriptionCycleId: (await db.query("SELECT cycle_id FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0].cycle_id,
      amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", metadata: {}, channelKey: "fixture", at: AT });
  await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,method_kind) VALUES($1,'healthy','legacy-ref','card')", [f.subscription]);
  const token = randomUUID();
  await db.query("INSERT INTO public.commerce_checkout_recovery_tokens(id,token_hash,order_id,client_id,expires_at) VALUES($1,$2,$3,$4,'2027-11-13')",
    [token, randomUUID().replaceAll("-", "").repeat(2), f.original.orderId, f.client]);
  const before = await methodRows();
  expect(await call(db, "subscription_method_uses_recorded_refs", [f.subscription])).toBe(true);
  expect(await createPostgresRecordedSubscriptionMethodReader(db).read(f.subscription)).toEqual({ kind: "unavailable", reason: "method_ref_not_recorded" });
  await expect(call(db, "subscription_retry_prepare", [f.operation, "historical-no-ref", { ...request(f), paymentMethodRef: "legacy-ref" }, AT]))
    .rejects.toThrow("subscription_missing_payment_method_ref");
  await expect(call(db, "subscription_retry_authorize_recovery", [f.operation, token, "legacy-ref", "legacy-evidence", AT]))
    .rejects.toThrow("subscription_retry_recovery_not_authorized");
  expect(await methodRows()).toEqual(before);
  const m = await method(f, "recorded-after-history", { recoveryCaseId: f.caseId }), recordedBefore = await methodRows();
  await expect(call(db, "subscription_retry_authorize_recovery", [f.operation, token, m.reference, m.id, AT]))
    .rejects.toThrow("subscription_retry_recovery_not_authorized");
  expect(await methodRows()).toEqual(recordedBefore);
});

it("returns recovery_not_ready for an open payment_pending case without reconstructing an obligation", async () => {
  const f = await subject(), cycle = randomUUID(), caseId = randomUUID(), m = await method(f);
  await db.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'payment_pending')", [cycle, f.subscription, AT]);
  await db.query("INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,idempotency_key) VALUES($1::uuid,$2,$3,$4,$1::uuid::text)", [caseId, f.subscription, cycle, f.client]);
  const before = await methodRows();
  for (const entry of ["method_ref_webhook", "recovery_redeem"]) expect(await call(db, "subscription_try_schedule_recovery_retry", [caseId, m.reference, AT, entry]))
    .toEqual({ scheduled: false, reason: "recovery_not_ready" });
  expect(await methodRows()).toEqual(before);
});

it("enqueues a renewal reminder for an active card expiring in ten days", async () => {
  const f = await subject();
  await store().upsert({ key: randomUUID(), clientId: f.client, subscriptionId: f.subscription, provider: "card_rail", methodKind: "card",
    customer: null, reference: randomUUID(), mandate: null, status: "active", active: true,
    expiresAt: (await db.query("SELECT now()+interval '10 days' AS at")).rows[0].at.toISOString(), consent: {}, payload: {} });
  await db.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days',updated_at=now()-interval '6 days' WHERE id=$1", [f.subscription]);
  expect(await call(db, "subscription_method_health_read", [f.subscription])).toMatchObject({ health_state: "method_expiring" });
  await call(db, "dunning_lifecycle_renewal_reminder_enqueue", [100]);
  expect((await db.query("SELECT reminder_kind FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [f.subscription])).rows)
    .toEqual([{ reminder_kind: "renewal_due_soon" }]);
});

it("uses the current recorded method after a repaired attempt soft-fails and the next scheduled rung proceeds", async () => {
  const f = await declined(), repaired = await method(f, randomUUID(), { recoveryCaseId: f.caseId });
  const authority = await authorize(f, repaired);
  await call(db, "subscription_retry_schedule_recovery", [f.operation, "repair:soft-failure", authority.id, AT]);
  const first = { ...request(f), paymentMethodRef: repaired.reference };
  await call(db, "subscription_retry_prepare", [f.operation, "repair:dispatch", first, "2026-11-14T12:00:00Z"]);
  await call(db, "subscription_retry_apply_failure", [f.operation, "repair:declined", failure(1, "2026-11-14T12:00:00Z", "soft_retryable")]);
  await call(db, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
  const current = await method(f);
  const snapshot = { cycle: { status: "correlated", logicalCycleNumber: 3, nativeRenewalCounter: 2 },
    authorizationRef: "frozen-mandate", pricingSnapshot: { totalAmountMinor: f.snapshot.totalAmountMinor, currency: "XXX" } } as RenewalFrozenSnapshot;
  const executed: string[] = [];
  const driver = createNativeRetryDriver({ executor: db, withTransaction: async work => {
    await db.query("BEGIN");
    try { const result = await work(db); await db.query("COMMIT"); return result; } catch (error) { await db.query("ROLLBACK"); throw error; }
  }, decode: () => snapshot, readFrozenMandate: async () => ({ authorized: true, authorizationRef: snapshot.authorizationRef, paymentMethodRef: "original-frozen-method" }),
  retryInput: () => ({ paymentIntentId: f.original.settlementIntentId, orderRef: f.original.orderId,
    amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", paymentMethodRef: current.reference,
    mode: "recurring", orderId: f.original.orderId, flow: "off_session_payment", customerRef: null,
    recurringModel: null, clientId: f.client, payer: null, cycleIdempotencyKey: f.identity,
    executionIdempotencyKey: `later:${f.operation}`, externalIdempotencyKey: `provider:later:${f.operation}`, requestFingerprint: "f".repeat(64) }),
  validateInput: () => {}, payments: { async execute(input) { executed.push(input.paymentMethodRef); return { status: "pending", externalAttemptRef: "later-attempt" }; },
    async readOutcome() { return { operationId: f.operation, requestFingerprint: "f".repeat(64), status: "processing", disposition: "ambiguous" } as never; } },
  classifyFailure: () => "soft_retryable", failureTemplate: "failed", recoveredTemplate: "recovered", recoveryPath: "/recover" });
  const due = (await db.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0].next_retry_at.toISOString();
  await db.query("UPDATE public.subscription_retry_obligations SET renewal_quarantined_until='2099-11-13T00:00:00Z' WHERE id=$1", [f.obligation]);
  const quarantined = await call(db, "subscription_retry_read", [f.operation]);
  expect(await driver.run(due, 500)).not.toContainEqual(expect.objectContaining({ operationId: f.operation }));
  expect(executed).toEqual([]);
  expect(await call(db, "subscription_retry_read", [f.operation])).toEqual(quarantined);
  await expect(call(db, "subscription_retry_prepare", [f.operation, "quarantine:direct", { ...request(f), paymentMethodRef: current.reference }, due]))
    .rejects.toThrow("subscription_retry_not_due_or_ambiguous");
  expect(await call(db, "subscription_retry_read", [f.operation])).toEqual(quarantined);
  await db.query("UPDATE public.subscription_retry_obligations SET renewal_quarantined_until=$2 WHERE id=$1", [f.obligation, due]);
  expect(await driver.run(due, 500)).toContainEqual({ operationId: f.operation, status: "awaiting_provider" });
  expect(executed).toContain(current.reference);
  expect(await call(db, "payment_method_recovery_authority_read", [authority.id])).toMatchObject({ dispatch_key: "repair:dispatch", retry_attempt: 1, method_ref: repaired.reference });
  expect((await db.query("SELECT retry_attempt,attempt_sequence,state FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0])
    .toEqual({ retry_attempt: 2, attempt_sequence: 2, state: "prepared" });
});

it("holds the exact authorized method through admission and re-reads rotation after the method lock", async () => {
  const f = await declined(), m = await method(f, randomUUID(), { recoveryCaseId: f.caseId });
  const authority = await authorize(f, m);
  await call(db, "subscription_retry_schedule_recovery", [f.operation, "lock:schedule", authority.id, AT]);
  const admission = await pool.connect(), rotation = await pool.connect(); let pending: Promise<unknown> | undefined;
  const pids = (await db.query("SELECT $1::int AS admission,$2::int AS rotation", [
    (await admission.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, (await rotation.query("SELECT pg_backend_pid() AS pid")).rows[0].pid])).rows[0];
  const input = { ...request(f), paymentMethodRef: m.reference };
  try {
    await admission.query("BEGIN");
    expect(await call(admission, "subscription_retry_prepare", [f.operation, "lock:dispatch", input, "2026-11-14T12:00:00Z"])).toMatchObject({ execute: true });
    await rotation.query("BEGIN");
    pending = call(rotation, "payment_method_ref_deactivate", ["rotate:blocked", m.id, "revoked", {}]).catch(error => error);
    let blockers: number[] = [];
    for (let n = 0; n < 300 && !blockers.length; n++) blockers = (await db.query("SELECT pg_blocking_pids($1) AS pids", [pids.rotation])).rows[0].pids;
    expect(blockers).toContain(pids.admission);
    await admission.query("ROLLBACK");
    expect(await pending).not.toBeInstanceOf(Error);
    // Rotation now holds the method row; admission must block there and reject its post-rotation state.
    pending = call(admission, "subscription_retry_prepare", [f.operation, "lock:after-rotation", input, "2026-11-14T12:00:00Z"]).catch(error => error);
    blockers = [];
    for (let n = 0; n < 300 && !blockers.length; n++) blockers = (await db.query("SELECT pg_blocking_pids($1) AS pids", [pids.admission])).rows[0].pids;
    expect(blockers).toContain(pids.rotation);
    await rotation.query("COMMIT");
    expect(await pending).toMatchObject({ message: "subscription_missing_payment_method_ref" });
    expect((await db.query("SELECT state,attempt_sequence FROM public.subscription_retry_obligations WHERE id=$1", [f.obligation])).rows[0]).toEqual({ state: "waiting", attempt_sequence: 0 });
    expect(await call(db, "payment_method_recovery_authority_read", [authority.id])).toMatchObject({ dispatch_key: null });
  } finally { await Promise.all([admission.query("ROLLBACK"), rotation.query("ROLLBACK")]); await pending; admission.release(); rotation.release(); }
});


it("refuses a direct non-setup event close and leaves the received event and money rows unchanged", async () => {
  const f = await declined(), id = randomUUID();
  await db.query(`INSERT INTO public.payment_provider_attempt_evidence(id,provider,provider_event_id,event_type,processing_status,payload,settlement_intent_id)
    VALUES($1,'card_rail',$1::uuid::text,'payment.succeeded','received','{}',$2)`, [id, f.original.settlementIntentId]);
  const before = await methodRows();
  expect(await call(db, "payment_control_mark_setup_event_processed", [id])).toMatchObject({ setupEventProcessed: { updated: false } });
  expect((await db.query("SELECT processing_status,processed_at FROM public.payment_provider_attempt_evidence WHERE id=$1", [id])).rows)
    .toEqual([{ processing_status: "received", processed_at: null }]);
  expect(await methodRows()).toEqual(before);
});

it("refuses another provider's same-text method at admission and at the dispatch freeze", async () => {
  const f = await declined(), a = await method(f, randomUUID(), { recoveryCaseId: f.caseId });
  const authority = await authorize(f, a);
  await call(db, "subscription_retry_schedule_recovery", [f.operation, "identity:schedule", authority.id, AT]);
  const b = await store().upsert({ key: randomUUID(), clientId: f.client, subscriptionId: f.subscription, provider: "other_rail",
    methodKind: "card", customer: null, reference: a.reference, mandate: null, status: "active", active: true, expiresAt: null,
    consent: { recoveryCaseId: f.caseId }, payload: {} });
  expect(b.id).not.toBe(a.id);
  expect(await call(db, "payment_method_recovery_authority_read", [authority.id])).toMatchObject({ method_id: a.id, method_ref: a.reference });
  const before = await methodRows();
  await expect(call(db, "subscription_retry_prepare", [f.operation, "identity:prepare", { ...request(f), paymentMethodRef: a.reference }, "2026-11-14T12:00:00Z"]))
    .rejects.toThrow("subscription_retry_method_mismatch");
  expect(await methodRows()).toEqual(before);
  // Exercise the bounded writer separately from the caller's admission check.
  await db.query("UPDATE public.subscription_retry_obligations SET state='prepared' WHERE id=$1", [f.obligation]);
  const freezeBefore = await methodRows();
  await expect(call(db, "payment_method_recovery_authority_freeze", [authority.id, f.operation, "identity:freeze", a.reference, "2026-11-14T12:00:00Z"]))
    .rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
  expect(await methodRows()).toEqual(freezeBefore);
});

it.each(["settlement", "frozen"] as const)("refuses historical %s provider-channel context without reusable evidence and changes no rows", async context => {
  const f = await declined();
  // Isolate each recorded context from method/provider state and from the other channel.
  await db.query("UPDATE public.commerce_settlement_intents SET channel_key=$2 WHERE id=$1", [f.original.settlementIntentId, context === "settlement" ? "card_rail" : "sandbox"]);
  await db.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=jsonb_set(cycle_snapshot,'{settlementChannelKey}',to_jsonb($2::text)) WHERE id=$1", [f.operation, context === "frozen" ? "card_rail" : "sandbox"]);
  await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref) VALUES($1,'healthy','historical-channel-method')", [f.subscription]);
  const token = randomUUID();
  await db.query("INSERT INTO public.commerce_checkout_recovery_tokens(id,token_hash,order_id,client_id,expires_at) VALUES($1,$2,$3,$4,'2099-11-13')",
    [token, randomUUID().replaceAll("-", "").repeat(2), f.original.orderId, f.client]);
  const before = await methodRows();
  expect(await call(db, "subscription_method_uses_recorded_refs", [f.subscription])).toBe(true);
  expect(await createPostgresRecordedSubscriptionMethodReader(db).read(f.subscription)).toEqual({ kind: "unavailable", reason: "method_ref_not_recorded" });
  await expect(call(db, "subscription_retry_prepare", [f.operation, `historical:${context}`, { ...request(f), paymentMethodRef: "historical-channel-method" }, AT]))
    .rejects.toThrow("subscription_missing_payment_method_ref");
  await expect(call(db, "subscription_retry_authorize_recovery", [f.operation, token, "historical-channel-method", "historical-evidence", AT]))
    .rejects.toThrow("subscription_retry_recovery_not_authorized");
  expect(await methodRows()).toEqual(before);
});

it("keeps a hard stop below rung four closed to a bare webhook and repairs it once in webhook-first order", async () => {
  const f = await renewal(pool), original = await prepareOriginal(pool, f);
  await call(db, "subscription_retry_apply_failure", [f.operation, `hard:${f.operation}`, failure(0, AT, "hard_do_not_retry")]);
  await call(db, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
  const row = (await db.query("SELECT * FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0];
  const subject = { ...f, original, obligation: row.id as string, caseId: row.case_id as string };
  const m = await method(subject, randomUUID(), { recoveryCaseId: subject.caseId });
  expect(row).toMatchObject({ state: "waiting", retry_attempt: 1, next_retry_at: null });
  expect((await db.query("SELECT status FROM public.subscription_dunning_cases WHERE id=$1", [subject.caseId])).rows).toEqual([{ status: "open" }]);
  expect((await db.query("SELECT status FROM public.subscriptions WHERE id=$1", [subject.subscription])).rows).toEqual([{ status: "active" }]);
  const before = await methodRows();
  expect(await call(db, "subscription_try_schedule_recovery_retry", [subject.caseId, m.reference, AT, "method_ref_webhook"]))
    .toEqual({ scheduled: false, reason: "recovery_not_ready" });
  expect((await call(db, "subscription_retry_candidates", [500, "2026-11-14T12:00:00Z"])).filter((item: { id: string }) => item.id === subject.obligation)).toHaveLength(0);
  expect(await methodRows()).toEqual(before);
  const authority = await authorize(subject, m);
  expect(await call(db, "subscription_retry_schedule_recovery", [subject.operation, "hard:repair", authority.id, AT])).toMatchObject({ scheduled: true });
  expect(await call(db, "subscription_try_schedule_recovery_retry", [subject.caseId, m.reference, AT, "method_ref_webhook"]))
    .toMatchObject({ scheduled: false });
  expect((await call(db, "subscription_retry_candidates", [500, "2026-11-14T12:00:00Z"])).filter((item: { id: string }) => item.id === subject.obligation)).toHaveLength(1);
  expect((await db.query("SELECT retry_attempt,attempt_sequence FROM public.subscription_retry_obligations WHERE id=$1", [subject.obligation])).rows)
    .toEqual([{ retry_attempt: 1, attempt_sequence: 0 }]);
  expect((await db.query("SELECT count(*)::int AS n FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.retry_scheduled' AND payload->>'source'='subscription.payment_recovery'", [subject.subscription])).rows).toEqual([{ n: 1 }]);
});
