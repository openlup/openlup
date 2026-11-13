import { randomUUID } from "node:crypto";
import { createPostgresPaymentMethodStore, createPostgresPaymentMethodSetup, createPostgresPaymentWebhookControlPort,
  createPostgresPaymentWebhookMethodRefPort, createVerifiedPaymentIngress, consumePostgresPaymentMethodDelivery,
  applyPostgresPaymentMethodLifecycleEvent, schedulePostgresRetryOnDurableMethodUpdate, createPostgresRecordedSubscriptionMethodReader } from "@openlup/platform/payments";
import type { VerifiedMethodEvidence } from "@openlup/platform/payments/contracts";
import { createSelfServiceCommandFacade } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
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
it.each([["replayed", 7], ["subscription_switch", 4], ["consent_snapshot_merge", 8], ["scope_repair", 24], ["health", 15]] as const)("retains %s assertions on native PostgreSQL", async (file, count) => {
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
  const f = await subject(), m = await method(f, "historical-mirror", { recurringModel: "O", source: "first" }, false);
  await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,method_kind) VALUES($1,'healthy',$2,'card')", [f.subscription, m.reference]);
  expect(await createPostgresRecordedSubscriptionMethodReader(db).read(f.subscription)).toEqual({ kind: "unavailable", reason: "method_ref_not_recorded" });
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

it("keeps authority writes behind bounded service helpers and preserves the raw-table fence", async () => {
  const f = await declined(), m = await method(f, randomUUID(), { recoveryCaseId: f.caseId });
  const hash = randomUUID().replaceAll("-", "").repeat(2);
  // The host supplies its existing invoker grants. No new private table is among them.
  await db.query(`GRANT SELECT,INSERT,UPDATE ON public.subscriptions,public.subscription_renewal_operations,
    public.subscription_retry_obligations,public.commerce_checkout_recovery_tokens,public.subscription_dunning_cases,
    public.subscription_retry_recovery_authorizations,public.subscription_method_states,public.subscription_retry_receipts,
    public.subscription_cycles,public.commerce_settlement_intents,public.fulfillment_inventory_reservations,
    public.fulfillment_stock_current,public.fulfillment_inventory_reservation_lines,public.commerce_orders TO service_role;
    GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_issue_recovery_token(uuid,text,timestamptz),
    public.subscription_retry_authorize_recovery(uuid,uuid,text,text,timestamptz),public.subscription_retry_schedule_recovery(uuid,text,uuid,timestamptz),
    public.subscription_retry_prepare(uuid,text,jsonb,timestamptz) TO service_role`);
  await db.query("SET ROLE service_role");
  try {
    for (const table of ["payment_method_refs", "payment_method_ref_receipts", "payment_method_recovery_authorities"]) {
      await expect(db.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(call(db, "payment_method_recovery_authority_record", [randomUUID(), f.caseId])).rejects.toThrow("payment_method_recovery_authority_context_mismatch");
    await expect(call(db, "payment_method_recovery_authority_bind", [f.operation, randomUUID(), m.reference, m.id, AT])).rejects.toThrow("subscription_retry_recovery_not_authorized");
    await expect(call(db, "payment_method_recovery_authority_freeze", [randomUUID(), f.operation, "unauthorized", m.reference, AT])).rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
    expect(await call(db, "dunning_lifecycle_issue_recovery_token", [f.caseId, hash, "2027-11-13T00:00:00Z"])).toMatchObject({ issued: true });
    const token = (await db.query("SELECT id FROM public.commerce_checkout_recovery_tokens WHERE token_hash=$1", [hash])).rows[0].id;
    const authority = await call(db, "subscription_retry_authorize_recovery", [f.operation, token, m.reference, m.id, AT]);
    expect(await call(db, "subscription_retry_schedule_recovery", [f.operation, "runtime-schedule", authority.id, AT])).toMatchObject({ scheduled: true });
    await expect(call(db, "payment_method_recovery_authority_freeze", [authority.id, f.operation, "too-early", m.reference, AT])).rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
    expect(await call(db, "subscription_retry_prepare", [f.operation, "runtime-dispatch", { ...request(f), paymentMethodRef: m.reference }, "2026-11-14T12:00:00Z"])).toMatchObject({ execute: true });
    expect(await call(db, "payment_method_recovery_authority_read", [authority.id])).toMatchObject({ dispatch_key: "runtime-dispatch" });
    await expect(call(db, "payment_method_recovery_authority_freeze", [authority.id, f.operation, "another-key", m.reference, AT])).rejects.toThrow("payment_method_recovery_authority_dispatch_mismatch");
  } finally { await db.query("RESET ROLE"); }
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
