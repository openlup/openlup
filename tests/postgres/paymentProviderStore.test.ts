import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderExpiredCheckoutSafety, createPostgresProviderPaymentRecoveryGuidancePort,
  createPostgresSandboxPaymentSimulator, executePreparedAttemptMechanism } from "@openlup/platform/payments";
import type { PreparedAttemptFailurePolicy } from "@openlup/platform/payments/contracts";
import { lifecycleInstallation, call, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const AT = "2026-11-13T12:00:00.000Z";
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
let env: LifecycleInstallation;
beforeAll(async () => { env = await lifecycleInstallation("qualified-v2"); }, postgresSetupTimeoutMs);
afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
const control = () => createPostgresProviderPaymentControlPort(env.runtime, options);
const webhook = () => createPostgresPaymentWebhookControlPort(env.runtime, options);

async function fixture(channelKey = "stripe", admitted = true, cycleStatus?: "planned" | "cancelled" | "skipped") {
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
  const prepare = { idempotencyKey: `prepare:${order}`, paymentIntentId: intent, provider: "stripe", providerIdempotencyKey: `provider:${order}`,
    providerRequestFingerprint: "f".repeat(64), providerFlow: "one_time_payment", paymentMethodRef: "method-primary", requestPayload: { source: "fixture" } };
  return { client, order, sku, subscription, cycle, intent, input, prepare };
}
async function prepared(f: Awaited<ReturnType<typeof fixture>>, finalized = true) {
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
  return webhook().ingestPaymentEvent({ provider: "stripe", providerEventId: `event:${randomUUID()}`, providerPaymentId: a ? `pi_${a}` : "unmatched",
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
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.outbox_events e WHERE aggregate_id=ANY(ARRAY[$1::uuid,$2::uuid,$3::uuid]))) AS value`,
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
  const input = { paymentPort: control(), provider: "stripe", paymentIntentId: f.intent,
    executionPort: { validateInput() { trace.push("validate"); }, async execute() {
      calls++; trace.push("provider");
      // An independent session sees the prepared row while the provider call is running.
      expect((await env.owner.query("SELECT status,provider_attempt_id FROM public.payment_provider_attempts WHERE settlement_intent_id=$1", [f.intent])).rows)
        .toEqual([{ status: "created", provider_attempt_id: null }]);
      expect((await env.owner.query("SELECT count(*)::int AS n FROM public.outbox_events WHERE event_type='commerce.payment_attempt.requested' AND aggregate_id=$1", [f.intent])).rows[0].n).toBe(0);
      if (loseReply) throw new Error("reply_lost_after_acceptance");
      return { provider: "stripe", providerAttemptId: `pi_${f.intent}`, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
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
      return { provider: "stripe", providerAttemptId: `pi_${next.intent}`, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
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
  const f = await fixture("stripe", true, "planned"), a = await prepared(f);
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
  const f = await fixture("stripe", false), before = await business(f);
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
});

it("fences compensation, reminders, abandonment and recovery on in-flight or durably successful provider evidence", async () => {
  const f = await fixture(), a = await prepared(f);
  const safe = createPostgresProviderExpiredCheckoutSafety(env.runtime);
  const check = async () => {
    expect(await call(env.owner, "commerce_checkout_recovery_payment_blocked", [f.order, 300, AT])).toBe(true);
    expect(await call(env.owner, "commerce_initial_checkout_abandonment_safe", [f.order])).toBe(false);
    expect(await call(env.owner, "commerce_cancel_abandoned_purchase_checkout", [`cancel:${randomUUID()}`, f.order, "abandoned", AT]))
      .toMatchObject({ cancelled: false, reason: "provider_attempt_in_flight" });
    await expect(call(env.owner, "oms_cancel_unpaid_order_owned", [`ops-cancel:${randomUUID()}`, f.order, "abandoned", null, {}, AT]))
      .rejects.toThrow("oms_cancel_unpaid_order_payment_in_flight");
  };
  await check();
  await result(f, `decline:${f.intent}`); await event(f, a.paymentAttemptId, "payment.succeeded", 100);
  const before = await business(f);
  await check(); expect(await business(f)).toEqual(before);
  expect(await safe.verifyPriorPayment({ orderId: f.order, totalMinor: 100, currency: "XXX" })).toBe("paid");
  expect(await control().prepareProviderAttempt({ ...f.prepare, idempotencyKey: `another:${f.order}` }))
    .toMatchObject({ paymentAttemptId: a.paymentAttemptId, replayed: true });
});

it.each(["prepare", "finalize", "apply", "settlement", "reconciliation"] as const)("takes the subscription root before native payment children for %s", async operation => {
  const f = await fixture("stripe", true, "planned"), a = operation === "prepare" ? null : await prepared(f, operation !== "finalize");
  let truth: string | null = null;
  if (operation === "reconciliation") {
    const e = await webhook().ingestPaymentEvent({ provider: "stripe", providerEventId: `pending:${f.intent}`, providerPaymentId: `pi_${a!.paymentAttemptId}`,
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
      : operation === "settlement" ? call(writer, "commerce_record_settlement", [`locked-settlement:${f.intent}`, f.intent, "failed", null, {}, AT])
      : call(writer, "payment_truth_record_reconciliation", [truth, `locked-reconcile:${f.intent}`, "b".repeat(64), "failed", "indeterminate", AT, null, null, {}, "dunning", "/recover", "recovered"]))
      .catch(error => error);
    let blocked = false;
    for (let n = 0; n < 300 && !blocked; n++) blocked = (await blocker.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0].blocked;
    expect(blocked).toBe(true);
    // NOWAIT is a lock assertion, without a timer or another wait budget.
    await env.owner.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE NOWAIT", [f.order]);
    await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE id=$1 FOR UPDATE NOWAIT", [f.intent]);
    if (a) await env.owner.query("SELECT id FROM public.payment_provider_attempts WHERE id=$1 FOR UPDATE NOWAIT", [a.paymentAttemptId]);
    if (truth) await env.owner.query("SELECT id FROM public.payment_truth_events WHERE id=$1 FOR UPDATE NOWAIT", [truth]);
    await blocker.query("COMMIT"); expect(await pending).not.toBeInstanceOf(Error);
  } finally { await blocker.query("ROLLBACK"); await pending; blocker.release(); writer.release(); }
});
