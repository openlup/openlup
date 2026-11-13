import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderExpiredCheckoutSafety, createPostgresProviderPaymentRecoveryGuidancePort,
  createPostgresSandboxPaymentSimulator, createPostgresPaymentMethodStore, executePreparedAttemptMechanism } from "@openlup/platform/payments";
import type { PreparedAttemptFailurePolicy } from "@openlup/platform/payments/contracts";
import { lifecycleInstallation, call, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { renewal, prepareOriginal } from "./subscriptionNativeFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const AT = "2026-11-13T12:00:00.000Z";
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
let env: LifecycleInstallation;
beforeAll(async () => { env = await lifecycleInstallation("qualified-v2"); }, postgresSetupTimeoutMs);
afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
const control = () => createPostgresProviderPaymentControlPort(env.runtime, options);
const webhook = () => createPostgresPaymentWebhookControlPort(env.runtime, options);

async function fixture(channelKey = "card_rail", admitted = true, cycleStatus?: "planned" | "cancelled" | "skipped") {
  const client = randomUUID(), order = randomUUID(), sku = randomUUID(), subscription = cycleStatus ? randomUUID() : null, cycle = cycleStatus ? randomUUID() : null;
  await env.owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await env.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [sku, sku]);
  await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Example')", [sku, sku]);
  if (subscription) {
    await env.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,started_at) VALUES($1,$2,28,$3,'2026-01-01T00:00:00Z')", [subscription, client, AT]);
    await env.owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,$4)", [cycle, subscription, AT, cycleStatus]);
  }
  await env.owner.query(`WITH created AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,subscription_cycle_id)
    VALUES($1,$2,'pending_payment','XXX',100,$3) RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,1,100,100 FROM created`, [order, client, cycle, sku]);
  const input = { idempotencyKey: `intent:${order}`, targetKind: subscription ? "subscription_cycle" as const : "one_time_order" as const,
    orderId: order, subscriptionId: subscription, subscriptionCycleId: cycle, amountMinor: 100, currency: "XXX", metadata: {}, channelKey, at: AT };
  const intent = admitted ? (await control().createIntent(input)).id
    : String((await call(env.runtime, "commerce_open_settlement_intent", [input.idempotencyKey, order, channelKey, 100, "XXX", {}, AT])).settlement.id);
  const prepare = { idempotencyKey: `prepare:${order}`, paymentIntentId: intent, provider: "card_rail", providerIdempotencyKey: `provider:${order}`,
    providerRequestFingerprint: "f".repeat(64), providerFlow: "one_time_payment", paymentMethodRef: "method-primary", requestPayload: { source: "fixture" } };
  return { client, order, sku, subscription, cycle, intent, input, prepare };
}
async function prepared(f: Pick<Awaited<ReturnType<typeof fixture>>, "intent" | "prepare">, finalized = true) {
  const a = await control().prepareProviderAttempt(f.prepare);
  if (finalized) await control().finalizeProviderAttempt({ idempotencyKey: `finalize:${a.paymentAttemptId}`, paymentIntentId: f.intent,
    paymentAttemptId: a.paymentAttemptId, providerIdempotencyKey: f.prepare.providerIdempotencyKey,
    providerRequestFingerprint: f.prepare.providerRequestFingerprint, providerAttemptId: `pi_${a.paymentAttemptId}`,
    providerSessionId: `session_${a.paymentAttemptId}`, attemptStatus: "processing", nextActionKind: null,
    requestPayload: {}, responsePayload: { providerCall: true } });
  return a;
}
const result = (f: { intent: string }, key: string, status: "failed" | "expired" | "succeeded" = "failed", event: string | null = null) => control().applyPaymentResult({
  idempotencyKey: key, paymentIntentId: f.intent, paymentEventId: event, resultStatus: status, occurredAt: AT, failureReason: status === "succeeded" ? null : "declined" });
async function event(f: { intent: string }, a: string | null, type: "payment.failed" | "payment.succeeded" = "payment.failed", amount: number | null = 0) {
  return webhook().ingestPaymentEvent({ provider: "card_rail", providerEventId: `event:${randomUUID()}`, providerPaymentId: a ? `pi_${a}` : "unmatched",
    eventType: type, paymentIntentId: f.intent, amountMinor: amount, currency: "XXX", occurredAt: AT, rawPayload: { kind: type } });
}
async function business(f: { order: string; intent: string; subscription: string | null; cycle: string | null }) {
  return (await env.owner.query(`SELECT jsonb_build_array(
    (SELECT to_jsonb(i) FROM public.commerce_settlement_intents i WHERE id=$1),
    (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE id=$2),
    (SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=$3),
    (SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id=$4),
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.subscription_dunning_cases d WHERE cycle_id=$4),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$2),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.outbox_events e WHERE aggregate_id=ANY(ARRAY[$1::uuid,$2::uuid,$3::uuid])),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_obligations r WHERE cycle_id=$4),
    (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.subscription_dunning_notifications n WHERE case_id IN
      (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=$4)),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_receipts r WHERE obligation_id IN
      (SELECT id FROM public.subscription_retry_obligations WHERE cycle_id=$4)),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commerce_checkout_recovery_tokens t WHERE order_id=$2),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commerce_settlement_transitions t WHERE intent_id=$1),
    (SELECT to_jsonb(op) FROM public.subscription_renewal_operations op WHERE id=
      (SELECT renewal_operation_id FROM public.commerce_settlement_intents WHERE id=$1)),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.subscription_events e WHERE subscription_id=$3)) AS value`,
  [f.intent, f.order, f.subscription, f.cycle])).rows[0].value;
}

it("binds intent replay to target, money and metadata and allocates a separate durable payment identity", async () => {
  const f = await fixture(), first = await control().createIntent(f.input);
  expect(first).toMatchObject({ id: f.intent, replayed: true }); expect(first.paymentId).not.toBe(f.intent);
  for (const changed of [{ amountMinor: 101 }, { currency: "XTS" }, { metadata: { changed: true } }, { orderId: randomUUID() }]) {
    await expect(control().createIntent({ ...f.input, ...changed })).rejects.toThrow("payment_control_intent_idempotency_conflict");
  }
  const a = await prepared(f), row = (await env.owner.query("SELECT payment_id FROM public.payment_provider_attempts WHERE id=$1", [a.paymentAttemptId])).rows[0];
  expect(row.payment_id).toBe(first.paymentId); expect(row.payment_id).not.toBe(a.paymentAttemptId);
});

it("preserves nullable handles, enriched payload and one unresolved attempt across browser keys", async () => {
  const f = await fixture(), a = await prepared(f, false);
  expect(a).toMatchObject({ status: "created", replayed: false, providerAttemptId: null, providerSessionId: null });
  const replay = await control().prepareProviderAttempt({ ...f.prepare, idempotencyKey: `other:${f.order}`, providerIdempotencyKey: "other-provider", paymentMethodRef: "other-method" });
  expect(replay).toMatchObject({ paymentAttemptId: a.paymentAttemptId, replayed: true });
  await expect(control().prepareProviderAttempt({ ...f.prepare, paymentMethodRef: "changed" })).rejects.toThrow("payment_control_provider_attempt_prepare_idempotency_conflict");
  expect((await env.owner.query("SELECT request_payload,response_payload FROM public.payment_provider_attempts WHERE id=$1", [a.paymentAttemptId])).rows[0])
    .toMatchObject({ request_payload: { paymentMethodRef: "method-primary", providerFlow: "one_time_payment", source: "fixture" }, response_payload: { providerCallPlanned: true, providerCall: false } });
  expect(await createPostgresProviderExpiredCheckoutSafety(env.runtime).verifyPriorPayment({ orderId: f.order, totalMinor: 100, currency: "XXX" })).toBe("unavailable");
});

it("executes validate, committed prepare, provider, then same-row finalize and retains uncertainty on lost replies", async () => {
  const f = await fixture(), trace: string[] = [];
  const policy: PreparedAttemptFailurePolicy<Error, string> = {
    replayError: () => new Error("provider_attempt_in_flight"), isTrustedNoCharge: (e): e is Error => e instanceof Error && e.message === "exact-no-charge",
    logRetry: () => {}, exhaustedError: e => e, executionError: () => new Error("provider_execution_failed"), finalizationError: e => e instanceof Error ? e : new Error("finalization"),
  };
  let calls = 0, loseReply = true;
  const input = { paymentPort: control(), provider: "card_rail", paymentIntentId: f.intent,
    executionPort: { validateInput() { trace.push("validate"); }, async execute() {
      calls++; trace.push("provider");
      // An independent session sees the prepared row while the provider call is running.
      expect((await env.owner.query("SELECT status,provider_attempt_id FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [f.intent])).rows)
        .toEqual([{ status: "created", provider_attempt_id: null }]);
      expect((await env.owner.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE event_type='commerce.payment_attempt.requested' AND aggregate_id=$1", [f.intent])).rows[0].n).toBe(0);
      if (loseReply) throw new Error("reply_lost_after_acceptance");
      return { provider: "card_rail", providerAttemptId: `pi_${f.intent}`, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
    } },
    executionInput: { idempotencyKey: `execute:${f.intent}`, providerIdempotencyKey: f.prepare.providerIdempotencyKey,
      providerRequestFingerprint: f.prepare.providerRequestFingerprint, paymentIntentId: f.intent, amountMinor: 100, currency: "XXX", mode: "one_time" as const, orderRef: f.order },
    prepareIdempotencyKey: f.prepare.idempotencyKey, finalizeIdempotencyKey: `finalize:${f.intent}`,
    providerIdempotencyKey: f.prepare.providerIdempotencyKey, providerRequestFingerprint: f.prepare.providerRequestFingerprint,
    providerFlow: f.prepare.providerFlow, paymentMethodRef: f.prepare.paymentMethodRef, prepareRequestPayload: f.prepare.requestPayload };
  await expect(executePreparedAttemptMechanism(input, policy)).rejects.toThrow("provider_execution_failed");
  loseReply = false;
  await expect(executePreparedAttemptMechanism(input, policy)).rejects.toThrow("provider_attempt_in_flight");
  expect(calls).toBe(1); expect(trace).toEqual(["validate", "provider", "validate"]);
  const next = await fixture();
  const clean = { ...input, paymentIntentId: next.intent, prepareIdempotencyKey: next.prepare.idempotencyKey,
    finalizeIdempotencyKey: `finalize:${next.intent}`, executionPort: { async execute() {
      return { provider: "card_rail", providerAttemptId: `pi_${next.intent}`, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
    } } };
  expect(await executePreparedAttemptMechanism(clean, policy)).toMatchObject({ attempt: { status: "processing" } });
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [next.intent])).rows[0].n).toBe(1);
});

it.each([0, null])("applies an unasserted %s provider amount without replacing the payment amount", async amount => {
  const f = await fixture(), a = await prepared(f), e = await event(f, a.paymentAttemptId, "payment.failed", amount);
  await result(f, `apply:${e.paymentEventId}`, "failed", e.paymentEventId);
  expect((await env.owner.query("SELECT amount_minor,status FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows[0]).toEqual({ amount_minor: "100", status: "failed" });
});

it("commits unlinked ingress then refuses unresolved and superseded attribution with zero business effects", async () => {
  const f = await fixture(), a = await prepared(f), e = await event(f, null), before = await business(f);
  await expect(result(f, `unresolved:${e.paymentEventId}`, "failed", e.paymentEventId)).rejects.toThrow("payment_control_result_attempt_unresolved");
  expect(await business(f)).toEqual(before);
  expect((await env.owner.query("SELECT processing_status,payment_attempt_id FROM public.payment_provider_attempt_evidence WHERE id=$1", [e.paymentEventId])).rows[0]).toEqual({ processing_status: "received", payment_attempt_id: null });
  await result(f, `first:${f.intent}`); await control().prepareProviderAttempt({ ...f.prepare, idempotencyKey: `retry:${f.order}` });
  const stale = await event(f, a.paymentAttemptId), after = await business(f);
  await expect(result(f, `stale:${stale.paymentEventId}`, "failed", stale.paymentEventId)).rejects.toThrow("payment_control_result_attempt_mismatch");
  expect(await business(f)).toEqual(after);
});

it("absorbs duplicate failure under a new key without a second settlement, retry, reservation or notice effect", async () => {
  const f = await fixture(), a = await prepared(f); await result(f, `first:${a.paymentAttemptId}`);
  const before = await business(f);
  expect(await result(f, `duplicate:${a.paymentAttemptId}`)).toMatchObject({ kind: "ignored_duplicate_terminal_failure" });
  expect(await business(f)).toEqual(before);
});

it.each(["cancelled", "skipped"] as const)("retains %s cycle finality for late success, failure and replay", async terminal => {
  const f = await fixture("card_rail", true, "planned"), a = await prepared(f);
  await result(f, `original:${f.intent}`);
  await env.owner.query("UPDATE public.subscription_cycles SET status=$2 WHERE id=$1", [f.cycle, terminal]);
  await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [f.order]);
  await env.owner.query("UPDATE public.commerce_settlement_intents SET status='cancelled' WHERE id=$1", [f.intent]);
  const before = await business(f), success = await event(f, a.paymentAttemptId, "payment.succeeded", 100);
  await expect(result(f, `late-success:${f.intent}`, "succeeded", success.paymentEventId)).rejects.toThrow("payment_control_result_terminal_intent");
  expect(await business(f)).toEqual(before);
  for (const status of ["failed", "expired"] as const) {
    const key = `late:${status}:${f.intent}`, e = await event(f, a.paymentAttemptId);
    expect(await result(f, key, status, e.paymentEventId)).toMatchObject({ kind: "ignored_failure_terminalized_cycle", replayed: false });
    expect((await env.owner.query("SELECT status FROM public.payment_provider_attempts WHERE id=$1", [a.paymentAttemptId])).rows[0].status).toBe(status);
    expect((await env.owner.query("SELECT payment_status FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_status).toBe(status);
    expect(await business(f)).toEqual(before);
    expect(await result(f, key, status, e.paymentEventId)).toMatchObject({ kind: "ignored_failure_terminalized_cycle", replayed: true });
    expect(await business(f)).toEqual(before);
  }
});

it("keeps legacy intents and settled history without fabricating provider attempts or payment identities", async () => {
  const f = await fixture("card_rail", false), before = await business(f);
  await expect(result(f, `legacy:${f.intent}`)).rejects.toThrow("payment_control_result_active_attempt_not_found");
  await expect(control().prepareProviderAttempt(f.prepare)).rejects.toThrow("payment_control_provider_attempt_prepare_intent_not_found");
  expect(await business(f)).toEqual(before);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].n).toBe(0);
  await env.owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1", [f.intent, AT]);
  await expect(control().createIntent(f.input)).rejects.toThrow("payment_control_intent_existing_payment_mismatch");
  expect(await createPostgresProviderExpiredCheckoutSafety(env.runtime).verifyPriorPayment({ orderId: f.order, totalMinor: 100, currency: "XXX" })).toBe("paid");
});

it("keeps sandbox replay separate from provider evidence", async () => {
  const f = await fixture("sandbox", false), simulator = createPostgresSandboxPaymentSimulator(env.runtime, options);
  const input = { settlementIntentId: f.intent, idempotencyKey: `sandbox:${f.order}`, requestFingerprint: "a".repeat(64), at: AT };
  const a = await simulator.beginAttempt(input); expect(await simulator.beginAttempt(input)).toMatchObject({ id: a.id, replayed: true });
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [f.intent])).rows[0].n).toBe(0);
});

it("enforces each lexically rewritten CHECK at its edge with the original generated constraint name", async () => {
  const f = await fixture(), a = await prepared(f), e = await event(f, a.paymentAttemptId);
  const checks = [
    ["payment_provider_states", "provider_attempt_sequence", f.intent, -1, 0],
    ["payment_provider_attempts", "amount_minor", a.paymentAttemptId, 0, 1],
    ["payment_provider_attempt_evidence", "amount_minor", e.paymentEventId, -1, 0],
    ["payment_provider_attempt_evidence", "event_fingerprint", e.paymentEventId, "g".repeat(64), "a".repeat(64)],
    ["payment_provider_attempt_evidence", "event_fingerprint", e.paymentEventId, "a".repeat(63), "f".repeat(64)],
  ] as const;
  for (const [table, column, id, invalid, edge] of checks) {
    await expect(env.owner.query(`UPDATE public.${table} SET ${column}=$2 WHERE id=$1`, [id, invalid])).rejects.toMatchObject({ code: "23514", constraint: `${table}_${column}_check` });
    await env.owner.query(`UPDATE public.${table} SET ${column}=$2 WHERE id=$1`, [id, edge]);
  }
});

it("keeps provider tables private and exposes bounded readback through the service functions", async () => {
  const f = await fixture(), a = await prepared(f);
  await expect(env.runtime.query("SELECT * FROM public.payment_provider_attempts")).rejects.toMatchObject({ code: "42501" });
  const read = await call(env.runtime, "payment_provider_attempt_read", [f.intent, a.paymentAttemptId]);
  expect(read).toMatchObject({ orderId: f.order, amountMinor: 100, currency: "XXX" });
  expect(await createPostgresProviderPaymentRecoveryGuidancePort(env.runtime, () => null).getGuidanceSnapshot({ orderId: f.order, paymentIntentId: f.intent }))
    .toMatchObject({ paymentAttemptId: a.paymentAttemptId, intentStatus: "processing", observedSuccess: false });
  for (const table of ["payment_provider_states", "payment_provider_attempts", "payment_provider_attempt_evidence", "payment_provider_receipts", "payment_provider_transitions"]) {
    expect((await env.owner.query("SELECT relrowsecurity AS rls FROM pg_class WHERE oid=$1::regclass", [`public.${table}`])).rows[0].rls).toBe(true);
  }
  const signature = "public.payment_provider_retry_failure_recorded(uuid,text,text)";
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await env.owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0].allowed).toBe(role === "service_role");
  }
  expect(await call(env.runtime, "payment_provider_retry_failure_recorded", [f.intent, "unrecorded", a.paymentAttemptId])).toBe(false);
});

it("fences compensation, reminders, abandonment and recovery on in-flight or durably successful provider evidence", async () => {
  const f = await fixture(), a = await prepared(f);
  const safe = createPostgresProviderExpiredCheckoutSafety(env.runtime);
  const check = async (moneyMoved = false) => {
    expect(await call(env.owner, "commerce_checkout_recovery_payment_blocked", [f.order, 300, AT])).toBe(true);
    expect(await call(env.owner, "commerce_initial_checkout_abandonment_safe", [f.order])).toBe(false);
    expect(await call(env.owner, "commerce_cancel_abandoned_purchase_checkout", [`cancel:${randomUUID()}`, f.order, "abandoned", AT]))
      .toMatchObject({ cancelled: false, reason: moneyMoved ? "payment_already_moved" : "provider_attempt_in_flight" });
    await expect(call(env.owner, "oms_cancel_unpaid_order_owned", [`ops-cancel:${randomUUID()}`, f.order, "abandoned", null, {}, AT]))
      .rejects.toThrow(moneyMoved ? "oms_cancel_unpaid_order_payment_already_moved" : "oms_cancel_unpaid_order_payment_in_flight");
  };
  await check();
  await result(f, `decline:${f.intent}`); await event(f, a.paymentAttemptId, "payment.succeeded", 100);
  const before = await business(f);
  await check(true); expect(await business(f)).toEqual(before);
  expect(await safe.verifyPriorPayment({ orderId: f.order, totalMinor: 100, currency: "XXX" })).toBe("paid");
  expect(await control().prepareProviderAttempt({ ...f.prepare, idempotencyKey: `another:${f.order}` }))
    .toMatchObject({ paymentAttemptId: a.paymentAttemptId, replayed: true });
});

it.each(["prepare", "finalize", "apply", "settlement", "reconciliation"] as const)("takes the subscription root before native payment children for %s", async operation => {
  const f = await fixture("card_rail", true, "planned"), a = operation === "prepare" ? null : await prepared(f, operation !== "finalize");
  let truth: string | null = null;
  if (operation === "reconciliation") {
    const e = await webhook().ingestPaymentEvent({ provider: "card_rail", providerEventId: `pending:${f.intent}`, providerPaymentId: `pi_${a!.paymentAttemptId}`,
      eventType: "payment.requires_action", paymentIntentId: f.intent, amountMinor: 100, currency: "XXX", occurredAt: AT, rawPayload: {} });
    const fingerprint = (await env.owner.query("SELECT event_fingerprint FROM public.payment_provider_attempt_evidence WHERE id=$1", [e.paymentEventId])).rows[0].event_fingerprint;
    const read = await call(env.owner, "payment_truth_ingest_event", [`unknown:${f.intent}`, "a".repeat(64), `unknown-key:${f.intent}`,
      f.intent, "indeterminate", 100, "XXX", AT, null, null, { sourceKind: "accepted_event", sourceReference: e.paymentEventId,
        attemptRef: a!.paymentAttemptId, observedAt: AT, payloadFingerprint: fingerprint }, "dunning", "/recover", "recovered"]);
    truth = read.event.id;
  }
  const blocker = await env.owner.connect(), writer = await env.runtime.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const port = createPostgresProviderPaymentControlPort(writer, options);
    pending = (operation === "prepare" ? port.prepareProviderAttempt(f.prepare)
      : operation === "finalize" ? port.finalizeProviderAttempt({ idempotencyKey: `locked-finalize:${f.intent}`, paymentIntentId: f.intent,
        paymentAttemptId: a!.paymentAttemptId, providerIdempotencyKey: f.prepare.providerIdempotencyKey,
        providerRequestFingerprint: f.prepare.providerRequestFingerprint, providerAttemptId: `pi_${a!.paymentAttemptId}`,
        providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} })
      : operation === "apply" ? port.applyPaymentResult({ idempotencyKey: `locked-apply:${f.intent}`, paymentIntentId: f.intent,
        paymentEventId: null, resultStatus: "failed", occurredAt: AT, failureReason: "declined" })
      : operation === "settlement" ? call(writer, "commerce_record_settlement", [`locked-settlement:${f.intent}`, f.intent, "succeeded", null, {}, AT])
      : call(writer, "payment_truth_record_reconciliation", [truth, `locked-reconcile:${f.intent}`, "b".repeat(64), "failed", "indeterminate", AT, null, null, {}, "dunning", "/recover", "recovered"]))
      .catch(error => error);
    await blockedBy(pid);
    // NOWAIT is a lock assertion, without a timer or another wait budget.
    await env.owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [f.order]);
    await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE id=$1 FOR UPDATE NOWAIT", [f.intent]);
    if (a) await env.owner.query("SELECT id FROM public.payment_provider_attempts WHERE id=$1 FOR UPDATE NOWAIT", [a.paymentAttemptId]);
    if (truth) await env.owner.query("SELECT id FROM public.payment_truth_events WHERE id=$1 FOR UPDATE NOWAIT", [truth]);
    await blocker.query("COMMIT"); expect(await pending).not.toBeInstanceOf(Error);
  } finally { await blocker.query("ROLLBACK"); await pending; blocker.release(); writer.release(); }
});

async function blockedBy(pid: number, blockerPid?: number) {
  let pids: number[] = [];
  for (let n = 0; n < 300 && !pids.length; n++) pids = (await env.owner.query("SELECT pg_blocking_pids($1) AS pids", [pid])).rows[0].pids;
  expect(pids.length).toBeGreaterThan(0);
  if (blockerPid !== undefined) expect(pids).toContain(blockerPid);
}
async function hold(f: { order: string }) {
  const id = randomUUID();
  await env.owner.query(`INSERT INTO public.fulfillment_inventory_reservations(id,purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
    VALUES($1,$2,$3,'fixture','held',$4,$5)`, [id, f.order, "a".repeat(64), AT, "2026-11-13T13:00:00Z"]);
  return id;
}

it.each(["blocked_preflight", "processing"] as const)("decodes the compact %s record acknowledgement and replay through the public wrapper", async attemptStatus => {
  const f = await fixture();
  const input = { idempotencyKey: `record:${f.intent}`, paymentIntentId: f.intent, provider: "card_rail",
    providerAttemptId: attemptStatus === "blocked_preflight" ? null : `pi_${f.intent}`, providerSessionId: null,
    attemptStatus, nextActionKind: null, requestPayload: {}, responsePayload: { providerCall: attemptStatus !== "blocked_preflight" } };
  const a = await control().recordAttempt(input);
  expect(a).toEqual({ id: expect.any(String), paymentIntentId: f.intent, status: attemptStatus, provider: "card_rail", idempotencyKey: input.idempotencyKey, replayed: false });
  expect(await control().recordAttempt(input)).toEqual({ ...a, replayed: true });
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [f.intent])).rows[0].n).toBe(1);
});

it.each(["failed", "expired"] as const)("preserves the distinct %s one-time order and reservation effects", async status => {
  const f = await fixture(), reservation = await hold(f); await prepared(f);
  expect(await result(f, `terminal:${f.intent}`, status)).toMatchObject({ kind: status === "failed" ? "recoverable_decline" : "state_changed" });
  const o = (await env.owner.query("SELECT status,metadata FROM public.commerce_orders WHERE id=$1", [f.order])).rows[0];
  expect(o).toMatchObject({ status: status === "failed" ? "pending_payment" : "expired",
    metadata: { paymentStatus: status === "failed" ? "declined" : "expired", failureReason: "declined", source: "payment.control.v0" } });
  if (status === "failed") expect(o.metadata).toMatchObject({ recoverable: true, lastDeclineAt: "2026-11-13T12:00:00+00:00" });
  expect((await env.owner.query("SELECT status,terminal_reason FROM public.fulfillment_inventory_reservations WHERE id=$1", [reservation])).rows[0])
    .toEqual({ status: status === "failed" ? "held" : "released", terminal_reason: status === "failed" ? null : "payment_expired" });
  expect((await env.owner.query("SELECT payload FROM public.outbox_events WHERE event_type='commerce.payment.failed' AND aggregate_id=$1", [f.order])).rows)
    .toEqual(status === "failed" ? [{ payload: { orderId: `order_${f.order}`, orderUuid: f.order, totalCents: 100, currency: "XXX", occurredAt: "2026-11-13T12:00:00+00:00" } }] : []);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.fulfillment_purchase_reservation_receipts WHERE command->>'reservationId'=$1", [reservation])).rows[0].n)
    .toBe(status === "expired" ? 1 : 0);
});

it("withdraws an already-sending decline notice on recovery while retaining the dunning owner", async () => {
  const f = await fixture("card_rail", true, "planned"), a = await prepared(f); await result(f, `decline:${f.intent}`);
  const notices = await env.owner.query(`UPDATE public.subscription_dunning_notifications SET status='sending',claim_token=gen_random_uuid(),
    lease_expires_at='2026-11-13T13:00:00Z' WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=$1) AND notification_kind='payment_failed' RETURNING id`, [f.cycle]);
  expect(notices.rowCount).toBeGreaterThan(0);
  const e = await event(f, a.paymentAttemptId, "payment.succeeded", 100);
  await result(f, `recovered:${f.intent}`, "succeeded", e.paymentEventId);
  expect((await env.owner.query("SELECT status,claim_token,lease_expires_at FROM public.subscription_dunning_notifications WHERE id=ANY($1::uuid[])", [notices.rows.map(n => n.id)])).rows)
    .toEqual(notices.rows.map(() => ({ status: "skipped", claim_token: null, lease_expires_at: null })));
  expect((await env.owner.query("SELECT status FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows).toEqual([{ status: "recovered" }]);
});

it("rolls back all application effects for an invalid failure class and admits the seven persisted classes", async () => {
  const f = await fixture(); await prepared(f); const before = await business(f);
  const input = { idempotencyKey: `classified:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null, resultStatus: "failed" as const,
    occurredAt: AT, failureReason: "declined", failureClass: "invalid" };
  await expect(control().applyPaymentResult(input)).rejects.toMatchObject({ code: "23514", constraint: "payment_provider_attempts_failure_class_check" });
  expect(await business(f)).toEqual(before);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.intent])).rows[0].n).toBe(0);
  expect((await env.owner.query("SELECT status,failure_class FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [f.intent])).rows).toEqual([{ status: "processing", failure_class: null }]);
  for (const failureClass of ["hard_do_not_retry", "mandate_dead", "sca_required", "fix_and_retry_customer_action", "soft_retry_delayed", "soft_retryable", "indeterminate"]) {
    await env.owner.query("UPDATE public.payment_provider_attempts SET failure_class=$2 WHERE settlement_intent_id=$1", [f.intent, failureClass]);
  }
  expect(await control().applyPaymentResult({ ...input, failureClass: "soft_retryable" })).toMatchObject({ replayed: false, kind: "recoverable_decline" });
});

it.each([[101, "XXX"], [100, "XTS"], [0, "XXX"], [null, null]] as const)("validates failure money %s/%s before read-side or SQL recreation admission", async (amount, currency) => {
  const f = await fixture(), a = await prepared(f); await result(f, `decline:${f.intent}`);
  const e = await webhook().ingestPaymentEvent({ provider: "card_rail", providerEventId: `money:${f.intent}`, providerPaymentId: `pi_${a.paymentAttemptId}`,
    eventType: "payment.failed", paymentIntentId: f.intent, amountMinor: amount, currency, occurredAt: AT, rawPayload: {} });
  const valid = (amount === null || amount === 0 || amount === 100) && (currency === null || currency === "XXX");
  expect(await call(env.runtime, "payment_provider_attempt_read", [f.intent, null])).toMatchObject({ observedFailure: valid });
  expect(await createPostgresProviderExpiredCheckoutSafety(env.runtime).verifyPriorPayment({ orderId: f.order, totalMinor: 100, currency: "XXX" }))
    .toBe(valid ? "safe" : "unavailable");
  const replacement = randomUUID(), key = `recreate:${f.order}`, quote = { quote: { lines: [], context: { mode: "one_time" } } };
  await call(env.runtime, "commerce_register_order_destination", [`destination:${f.order}`, f.order,
    { recipientName: "Example", line1: "Example 1", city: "Example", postalCode: "00000", country: "ZZ" }, AT]);
  await env.owner.query(`UPDATE public.commerce_orders SET status='expired',metadata=$2::jsonb WHERE id=$1`,
    [f.order, { paymentStatus: "expired", source: "checkout_reservation_expiry", quoteSnapshot: quote }]);
  await env.owner.query(`WITH created AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata)
    VALUES($1,$2,'pending_payment','XXX',100,$3) RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT created.id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor FROM created,public.commerce_order_items WHERE order_id=$4`,
    [replacement, f.client, { quoteSnapshot: quote, orderDraftSnapshot: {} }, f.order]);
  await env.owner.query("INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload) VALUES($1,$2,$3,'{}')", [key, "a".repeat(32), replacement]);
  const recreate = () => call(env.runtime, "commerce_prepare_expired_checkout_recovery", [key, f.order, replacement, 30 * 86400000, AT]);
  if (valid) expect(await recreate()).toMatchObject({ replacementOrderId: replacement, replayed: false });
  else {
    const before = await business(f);
    await expect(recreate()).rejects.toThrow("commerce_expired_recovery_payment_unavailable");
    expect(await business(f)).toEqual(before);
    expect((await env.owner.query("SELECT recreated_from_order_id FROM public.commerce_orders WHERE id=$1", [replacement])).rows[0].recreated_from_order_id).toBeNull();
  }
  expect((await env.owner.query("SELECT processing_status FROM public.payment_provider_attempt_evidence WHERE id=$1", [e.paymentEventId])).rows[0].processing_status).toBe("received");
});

it.each(["apply", "abandoned", "oms"] as const)("retains the %s order/root barrier without holding payment children", async operation => {
  const f = await fixture("card_rail", true, operation === "abandoned" ? "planned" : undefined), a = await prepared(f, false);
  const blocker = await env.owner.connect(), writer = await env.runtime.connect(); let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(operation === "abandoned" ? "SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE" : "SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [operation === "abandoned" ? f.subscription : f.order]);
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = (operation === "apply" ? createPostgresProviderPaymentControlPort(writer, options).applyPaymentResult({
      idempotencyKey: `barrier:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null, resultStatus: "failed", occurredAt: AT, failureReason: "declined" })
      : operation === "abandoned" ? call(writer, "commerce_cancel_abandoned_purchase_checkout", [`barrier:${f.intent}`, f.order, "abandoned", AT])
      : call(writer, "oms_cancel_unpaid_order_owned", [`barrier:${f.intent}`, f.order, "abandoned", null, {}, AT])).catch(error => error);
    await blockedBy(pid);
    if (operation === "abandoned") await env.owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [f.order]);
    await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE id=$1 FOR UPDATE NOWAIT", [f.intent]);
    await env.owner.query("SELECT id FROM public.payment_provider_attempts WHERE id=$1 FOR UPDATE NOWAIT", [a.paymentAttemptId]);
    await blocker.query("COMMIT"); const response = await pending;
    if (operation === "oms") expect(response).toMatchObject({ message: "oms_cancel_unpaid_order_payment_in_flight" });
    else expect(response).toMatchObject(operation === "apply" ? { status: "failed" } : { reason: "provider_attempt_in_flight" });
    expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows[0].status).toBe("pending_payment");
  } finally { await blocker.query("ROLLBACK"); await pending; blocker.release(); writer.release(); }
});

it("completes a refused renewal outcome while due-renewal claim holds the root and waits for its operation", async () => {
  const f = await renewal(env.owner); await prepareOriginal(env.owner, f);
  const writer = await env.owner.connect(), claimant = await env.owner.connect(); let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [f.operation]);
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const claimPid = (await claimant.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = call(claimant, "subscription_claim_due_renewal", [f.identity, f.fingerprint, f.snapshot, "concurrent-claim", 300, "2026-09-01T12:00:00Z"]).catch(error => error);
    await blockedBy(claimPid, writerPid);
    await expect(env.owner.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT", [f.subscription])).rejects.toMatchObject({ code: "55P03" });
    expect(await call(writer, "commerce_record_subscription_renewal_outcome", [f.operation, `refused:${f.operation}`, f.fingerprint, "refused", null, "declined", "2026-09-01T12:00:00Z"]))
      .toMatchObject({ state: "refused" });
    await writer.query("COMMIT"); expect(await pending).toMatchObject({ state: "refused", replayed: true });
  } finally { await writer.query("ROLLBACK"); await pending; writer.release(); claimant.release(); }
});

async function providerRenewal() {
  const r = await renewal(env.owner, 10, 1, randomUUID(), true);
  await call(env.owner, "fulfillment_reserve_subscription_renewal", [r.operation, r.token, 900, "2026-09-01T12:00:00Z"]);
  const original = await call(env.owner, "commerce_prepare_subscription_renewal", [r.operation, r.token, "2026-09-01T12:00:00Z"]);
  const cycle = (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [original.orderId])).rows[0].subscription_cycle_id;
  const f = { intent: original.settlementIntentId as string, order: original.orderId as string, subscription: r.subscription, cycle };
  await control().createIntent({ idempotencyKey: `provider:${f.intent}`, targetKind: "subscription_cycle", orderId: f.order,
    subscriptionId: f.subscription, subscriptionCycleId: cycle, amountMinor: r.snapshot.totalAmountMinor, currency: "XXX", metadata: {}, channelKey: "fixture", at: AT });
  const prepare = { idempotencyKey: `prepare:${f.intent}`, paymentIntentId: f.intent, provider: "card_rail", providerIdempotencyKey: `provider:${f.intent}`,
    providerRequestFingerprint: "f".repeat(64), providerFlow: "off_session_payment", paymentMethodRef: "method-primary", requestPayload: { source: "fixture" } };
  const a = await prepared({ ...f, prepare });
  await call(env.owner, "commerce_acknowledge_subscription_renewal_attempt", [r.operation, r.fingerprint, `pi_${a.paymentAttemptId}`, AT]);
  return { ...f, r, prepare, a };
}

it("records one attributed renewal failure before truth reuses its settlement and creates no generic case", async () => {
  const f = await providerRenewal(), key = `decline:${f.a.paymentAttemptId}`, e = await event(f, f.a.paymentAttemptId);
  await control().applyPaymentResult({ idempotencyKey: key, paymentIntentId: f.intent, paymentEventId: e.paymentEventId,
    resultStatus: "failed", occurredAt: AT, failureReason: "declined", failureClass: "soft_retryable" });
  const receipt = (await env.owner.query(`SELECT r.* FROM public.subscription_retry_receipts r JOIN public.subscription_retry_obligations o
    ON o.id=r.obligation_id WHERE o.cycle_id=$1 AND r.kind='failure'`, [f.cycle])).rows;
  expect(receipt).toHaveLength(1);
  expect(receipt[0]).toMatchObject({ receipt_key: `${key}:truth`, attempt_sequence: 0,
    input: { attemptSequence: 0, logicalCycleNumber: 3, paymentIntentId: f.intent, paymentAttemptId: f.a.paymentAttemptId,
      provider: "card_rail", providerAttemptId: `pi_${f.a.paymentAttemptId}`, subscriptionCycleId: f.cycle,
      renewalOperationId: f.r.operation, failureClass: "soft_retryable", reason: "declined", evidenceKey: e.paymentEventId },
    result: { retry_attempt: 1, next_retry_at: "2026-11-14T12:00:00+00:00", case_id: null } });
  expect(Date.parse(receipt[0].input.occurredAt)).toBe(Date.parse(AT));
  expect(receipt[0].input.firstRecordedAt).toBeTruthy();
  expect(await call(env.runtime, "payment_provider_retry_failure_recorded", [f.intent, `${key}:truth`, f.a.paymentAttemptId])).toBe(true);
  for (const [intent, receiptKey, attempt] of [[randomUUID(), `${key}:truth`, f.a.paymentAttemptId],
    [f.intent, "other-key", f.a.paymentAttemptId], [f.intent, `${key}:truth`, randomUUID()]]) {
    expect(await call(env.runtime, "payment_provider_retry_failure_recorded", [intent, receiptKey, attempt])).toBe(false);
  }
  const transitions = (await env.owner.query("SELECT id,idempotency_key,payload FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome<>'opened'", [f.intent])).rows;
  expect(transitions).toHaveLength(1);
  expect(transitions[0]).toMatchObject({ idempotency_key: `${key}:truth:settlement`, payload: { renewalOperationId: f.r.operation } });
  expect((await env.owner.query("SELECT settlement_transition_id,dunning_case_id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.intent])).rows)
    .toEqual([{ settlement_transition_id: transitions[0].id, dunning_case_id: null }]);
  expect((await env.owner.query("SELECT payload FROM public.payment_provider_transitions WHERE idempotency_key=$1", [`${key}:payment_result`])).rows[0].payload)
    .toMatchObject({ retryObligationId: receipt[0].obligation_id, retryAttempt: 1, nextRetryAt: receipt[0].result.next_retry_at });
  expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [f.cycle])).rows[0].status).toBe("payment_pending");
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows[0].n).toBe(0);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1", [f.order])).rows[0].n).toBe(0);
  const before = await business(f);
  expect(await control().applyPaymentResult({ idempotencyKey: key, paymentIntentId: f.intent, paymentEventId: e.paymentEventId,
    resultStatus: "failed", occurredAt: AT, failureReason: "declined", failureClass: "soft_retryable" })).toMatchObject({ replayed: true });
  expect(await control().applyPaymentResult({ idempotencyKey: `duplicate:${f.a.paymentAttemptId}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: "2026-11-14T12:00:00Z", failureReason: "another_writer" })).toMatchObject({ kind: "ignored_duplicate_terminal_failure" });
  expect(await business(f)).toEqual(before);
  expect(await call(env.owner, "subscription_retry_apply_failure", [f.r.operation, receipt[0].receipt_key, receipt[0].input])).toEqual(receipt[0].result);
  expect(await business(f)).toEqual(before);
});

it("retains the 24/72/168/exhausted failure ladder and cross-writer duplicate absorption on immutable attempt receipts", async () => {
  const f = await providerRenewal(); let a = f.a;
  await createPostgresPaymentMethodStore(env.runtime).upsert({ key: `ladder-method:${f.intent}`, clientId: f.r.client,
    subscriptionId: f.subscription, provider: f.prepare.provider, methodKind: "card", customer: null,
    reference: f.prepare.paymentMethodRef, mandate: null, status: "active", active: true, expiresAt: null, consent: {}, payload: {} });
  const times = [AT, "2026-11-14T12:00:00Z", "2026-11-17T12:00:00Z", "2026-11-24T12:00:00Z"];
  const next = ["2026-11-14T12:00:00Z", "2026-11-17T12:00:00Z", "2026-11-24T12:00:00Z", null];
  for (let sequence = 0; sequence < 4; sequence++) {
    if (sequence > 0) {
      const prepare = { ...f.prepare, idempotencyKey: `prepare:${f.intent}:${sequence}`, providerIdempotencyKey: `provider:${f.intent}:${sequence}` };
      await call(env.owner, "subscription_retry_prepare", [f.r.operation, `retry:${f.intent}:${sequence}`,
        { ...prepare, orderRef: f.order, amountMinor: f.r.snapshot.totalAmountMinor, currency: "XXX" }, times[sequence]]);
      a = await prepared({ ...f, prepare });
    }
    const key = `failure:${a.paymentAttemptId}`;
    expect(await control().applyPaymentResult({ idempotencyKey: key, paymentIntentId: f.intent, paymentEventId: null,
      resultStatus: "failed", occurredAt: times[sequence], failureReason: "declined" })).toMatchObject({ kind: "state_changed" });
    const receipt = (await env.owner.query("SELECT input,result FROM public.subscription_retry_receipts WHERE receipt_key=$1", [`${key}:truth`])).rows[0];
    expect(receipt.input).toMatchObject({ paymentAttemptId: a.paymentAttemptId, attemptSequence: sequence, logicalCycleNumber: 3 });
    expect(receipt.result.retry_attempt).toBe(sequence + 1);
    expect(receipt.result.next_retry_at == null ? null : Date.parse(receipt.result.next_retry_at)).toBe(next[sequence] == null ? null : Date.parse(next[sequence]!));
    expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [f.cycle])).rows[0].status).toBe("payment_pending");
  }
  const before = await business(f);
  for (const reason of ["declined", "provider_failed"]) {
    const key = `duplicate:${reason}:${f.intent}`;
    expect(await control().applyPaymentResult({ idempotencyKey: key, paymentIntentId: f.intent, paymentEventId: null,
      resultStatus: "failed", occurredAt: "2026-11-25T12:00:00Z", failureReason: reason })).toMatchObject({ kind: "ignored_duplicate_terminal_failure" });
    expect((await env.owner.query("SELECT reason FROM public.payment_provider_transitions WHERE idempotency_key=$1", [`${key}:payment_result`])).rows[0].reason)
      .toBe("ignored_duplicate_terminal_failure");
    expect(await business(f)).toEqual(before);
  }
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.subscription_retry_receipts WHERE kind='failure' AND obligation_id IN (SELECT id FROM public.subscription_retry_obligations WHERE cycle_id=$1)", [f.cycle])).rows[0].n).toBe(4);
  const first = (await env.owner.query("SELECT input,result FROM public.subscription_retry_receipts WHERE receipt_key=$1", [`failure:${f.a.paymentAttemptId}:truth`])).rows[0];
  expect(first.result).toMatchObject({ retry_attempt: 1, next_retry_at: "2026-11-14T12:00:00+00:00" });
  expect(await call(env.owner, "subscription_retry_apply_failure", [f.r.operation, `failure:${f.a.paymentAttemptId}:truth`, first.input])).toEqual(first.result);
  expect(await business(f)).toEqual(before);
});

it("stops a terminating provider failure without creating dunning authority", async () => {
  const f = await providerRenewal();
  await control().applyPaymentResult({ idempotencyKey: `hard:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: AT, failureReason: "declined", failureClass: "hard_do_not_retry" });
  expect((await env.owner.query("SELECT result FROM public.subscription_retry_receipts WHERE receipt_key=$1", [`hard:${f.intent}:truth`])).rows[0].result)
    .toMatchObject({ retry_attempt: 1, next_retry_at: null, case_id: null });
});

it("keeps generic truth dunning for a subscription failure without recorded renewal context", async () => {
  const f = await fixture("card_rail", true, "planned"); await prepared(f);
  await result(f, `generic:${f.intent}`);
  expect((await env.owner.query("SELECT idempotency_key,retry_attempt FROM public.subscription_dunning_cases WHERE cycle_id=$1", [f.cycle])).rows)
    .toEqual([{ idempotency_key: `payment-truth:dunning:${f.cycle}`, retry_attempt: 1 }]);
  expect((await env.owner.query("SELECT count(*)::int AS n FROM public.subscription_retry_obligations WHERE cycle_id=$1", [f.cycle])).rows[0].n).toBe(0);
});

it.each(["logical cycle", "attempt"] as const)("refuses missing recorded renewal %s correlation without financial or retry effects", async missing => {
  const f = await providerRenewal();
  if (missing === "logical cycle") await env.owner.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=cycle_snapshot-'cycle' WHERE id=$1", [f.r.operation]);
  else await env.owner.query("UPDATE public.subscription_renewal_operations SET external_attempt_ref='unrelated-attempt' WHERE id=$1", [f.r.operation]);
  const before = await business(f);
  await expect(result(f, `uncorrelated:${f.intent}`)).rejects.toThrow(missing === "logical cycle" ? "subscription_renewal_cycle_correlation_required" : "subscription_retry_not_prepared");
  expect(await business(f)).toEqual(before);
});

it.each(["cancelled", "skipped"] as const)("preserves the recorded renewal rung after %s cycle finality and replay", async terminal => {
  const f = await providerRenewal(); await result(f, `original:${f.intent}`);
  await env.owner.query("UPDATE public.subscription_cycles SET status=$2 WHERE id=$1", [f.cycle, terminal]);
  await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [f.order]);
  await env.owner.query("UPDATE public.commerce_settlement_intents SET status='cancelled' WHERE id=$1", [f.intent]);
  await env.owner.query("UPDATE public.payment_provider_states SET status='cancelled' WHERE id=$1", [f.intent]);
  const before = await business(f);
  for (const status of ["failed", "expired"] as const) {
    const key = `terminal:${status}:${f.intent}`, e = await event(f, f.a.paymentAttemptId);
    expect(await result(f, key, status, e.paymentEventId)).toMatchObject({ kind: "ignored_failure_terminalized_cycle", replayed: false });
    expect(await result(f, key, status, e.paymentEventId)).toMatchObject({ kind: "ignored_failure_terminalized_cycle", replayed: true });
    expect(await business(f)).toEqual(before);
  }
});

it("locks the recorded renewal operation before payment children when applying a provider failure", async () => {
  const f = await providerRenewal(), blocker = await env.owner.connect(), writer = await env.runtime.connect(); let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [f.r.operation]);
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = createPostgresProviderPaymentControlPort(writer, options).applyPaymentResult({ idempotencyKey: `locked:${f.intent}`,
      paymentIntentId: f.intent, paymentEventId: null, resultStatus: "failed", occurredAt: AT, failureReason: "declined" }).catch(error => error);
    await blockedBy(pid);
    await env.owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [f.order]);
    await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE id=$1 FOR UPDATE NOWAIT", [f.intent]);
    await env.owner.query("SELECT id FROM public.payment_provider_attempts WHERE id=$1 FOR UPDATE NOWAIT", [f.a.paymentAttemptId]);
    await blocker.query("COMMIT"); expect(await pending).toMatchObject({ kind: "state_changed" });
  } finally { await blocker.query("ROLLBACK"); await pending; blocker.release(); writer.release(); }
});
