import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPaymentProviderReconciliationPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderPaymentControlPort, createVerifiedPaymentIngress, runPaymentProviderReconciliationWorker } from "@openlup/platform/payments";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { call } from "./subscriptionNativeFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const at = "2026-11-13T12:00:00Z", old = "2026-11-13T10:00:00Z";
const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
let env: LifecycleInstallation, db: PoolClient;
type Fixture = { intent: string; attempt: string; order: string; cycle: string | null; provider: string };
type RefundInput = Parameters<ReturnType<typeof createPostgresPaymentWebhookControlPort>["ingestPaymentEvent"]>[0];
let installed: { capture: Fixture; delta: Fixture; prepared: Fixture; refunds: RefundInput[] };
beforeAll(async () => {
  env = await lifecycleInstallation("qualified-v2"); db = await env.owner.connect();
  for (const path of ["paymentProvider/setup.sql", "paymentReconciliation/setup.sql"]) {
    await db.query(readFileSync(`tests/postgres/fixtures/${path}`, "utf8"));
  }
  const fixtures = Object.fromEntries((await db.query("SELECT name,f FROM proof_fixture")).rows.map(row => [row.name, row.f]));
  installed = { capture: fixtures.capture, delta: fixtures.delta, prepared: fixtures.prepared, refunds: [] };
  for (const [n, amount] of [3000, 12999, 3000, 12999].entries()) {
    installed.refunds.push((await db.query("SELECT pg_temp.refund_input($1::jsonb,$2,$3::integer) value",
      [installed.capture, `installed-refund:${n}`, amount])).rows[0].value);
  }
  await age(installed.prepared);
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await env?.close(); }, postgresTeardownTimeoutMs);
async function fixture(name = "capture", subscription = false, finalized = true): Promise<Fixture> {
  return (await db.query("SELECT pg_temp.reconciliation_fixture((SELECT f->>'provider' FROM proof_fixture WHERE name=$1),$2,$3) f",
    [name, subscription, finalized])).rows[0].f;
}
const port = () => createPostgresPaymentProviderReconciliationPort(env.runtime, options);
async function age(f: Fixture, time = old) {
  await db.query("UPDATE public.payment_provider_attempts SET created_at=$2,updated_at=$2 WHERE id=$1", [f.attempt, time]);
  await db.query("UPDATE public.payment_provider_states SET created_at=$2,updated_at=$2 WHERE id=$1", [f.intent, time]);
}
function reopen(f: Fixture, key = `absence:${f.intent}`) {
  return { idempotencyKey: key, paymentAttemptId: f.attempt, expectedPaymentIntentId: f.intent,
    expectedSubscriptionCycleId: f.cycle!, operatorRef: "operator.fixture", absenceCheckedAt: at,
    nextRetryAt: "2026-11-13T12:10:00Z", absenceEvidence: { providerAbsenceConfirmed: true } };
}
async function census(f: Fixture) {
  return (await db.query(`SELECT jsonb_build_array(
    (SELECT to_jsonb(s) FROM public.payment_provider_states s WHERE id=$1),
    (SELECT to_jsonb(a) FROM public.payment_provider_attempts a WHERE id=$2),
    (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE id=$3),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.payment_refund_evidence r WHERE payment_intent_id=$1),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$3),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.outbox_events e WHERE aggregate_id=$3),
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM public.payment_provider_receipts r WHERE metadata->>'paymentIntentId'=$1::text)
  ) state`, [f.intent, f.attempt, f.order])).rows[0].state;
}

it("proves cumulative refunds and default-off absence reopen using only the installed runtime role", async () => {
  const runtime = await env.runtime.connect();
  try {
    expect((await runtime.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=session_user`)).rows[0]).toEqual({ current_user: "service_role", session_user: "lifecycle_r",
      rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    await expect(runtime.query("SELECT * FROM public.payment_refund_evidence")).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query("SELECT * FROM public.payment_prepared_absence_reopens")).rejects.toMatchObject({ code: "42501" });
    const control = createPostgresPaymentWebhookControlPort(runtime, options);
    for (const [n, input] of installed.refunds.entries()) {
      const ingested = await control.ingestPaymentEvent(input);
      expect(ingested.replayed).toBe(false);
      expect(await control.ingestPaymentEvent(input)).toMatchObject({ paymentEventId: ingested.paymentEventId, replayed: true });
      const result = { idempotencyKey: `installed-apply:${n}`, paymentIntentId: installed.capture.intent,
        paymentEventId: ingested.paymentEventId, resultStatus: n === 0 || n === 2 ? "partially_refunded" as const : "refunded" as const,
        occurredAt: input.occurredAt, failureReason: null };
      expect(await control.applyPaymentResult!(result)).toEqual({ replayed: false });
      expect(await control.applyPaymentResult!(result)).toEqual({ replayed: true });
      expect((await runtime.query("SELECT public.payment_refund_readback($1::uuid) value", [installed.capture.intent])).rows[0].value)
        .toMatchObject({ refundCents: n === 0 ? 3000 : 12999, currency: "XXX", refundEvidenceVersion: "provider-refund.v2" });
    }
    expect((await runtime.query("SELECT amount_minor::text FROM public.commerce_settlement_intents WHERE id=$1",
      [installed.capture.intent])).rows[0].amount_minor).toBe("12999");
    expect(Number((await runtime.query("SELECT count(*) n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.refund_processed'",
      [installed.capture.order])).rows[0].n)).toBe(1);
    const reconciliation = createPostgresPaymentProviderReconciliationPort(runtime, options);
    let probes = 0;
    await runPaymentProviderReconciliationWorker({ port: reconciliation, providers: { [installed.prepared.provider]: {
      readPayment: async () => { throw Error("unexpected_provider_read"); },
      findPaymentByLocalIntent: async () => { probes++; return "absent"; },
    } }, now: at, claimKey: "installed-default-off" });
    expect(probes).toBe(0);
    expect((await runtime.query("SELECT public.payment_provider_attempt_read($1::uuid,$2::uuid) value",
      [installed.prepared.intent, installed.prepared.attempt])).rows[0].value).toMatchObject({ paymentAttempt: { status: "created" } });
    const request = reopen(installed.prepared, "installed-absence-reopen");
    expect(await reconciliation.reopenPreparedAttemptAfterAbsence(request)).toEqual({ replayed: false });
    expect(await reconciliation.reopenPreparedAttemptAfterAbsence(request)).toEqual({ replayed: true });
    const due = async (time: string, key: string) => (await runtime.query(
      "SELECT public.payment_prepared_absence_reopen_due($1::uuid,$2::timestamptz,$3) value", [installed.prepared.intent, time, key])).rows[0].value;
    expect(await due(at, "installed-consumer")).toBeNull();
    const consumed = await due(request.nextRetryAt, "installed-consumer");
    expect(consumed).toMatchObject({ provider_attempt_sequence: 1, consumed_key: "installed-consumer" });
    expect(await due(request.nextRetryAt, "installed-consumer")).toEqual(consumed);
    expect(await due(request.nextRetryAt, "installed-other-consumer")).toBeNull();
  } finally { runtime.release(); }
});

it("reads a verified 3000 event-delta refund on a 12999 payment through the runtime role", async () => {
  const f = installed.delta, money = { amountMinor: 12999, currency: "XXX" };
  const ingress = createVerifiedPaymentIngress({ provider: f.provider,
    paymentControlPort: createPostgresPaymentWebhookControlPort(env.runtime, options),
    verifyPort: { verifyAndNormalize: async () => ({ kind: "money", provider: f.provider,
      providerEventId: "installed-delta-refund", fingerprint: "d".repeat(64), providerOccurredAt: at,
      providerPaymentRef: `charge_${f.attempt}`, intentRef: f.intent, attemptRef: f.attempt,
      outcome: "refunded", money, refund: { kind: "event-delta", operationId: "installed-delta-refund",
        originalPaymentMoney: money, refundedMoney: { amountMinor: 3000, currency: "XXX" } } }) } });
  const input = { rawBody: new Uint8Array(), headers: {}, receivedAt: at };
  expect(await ingress.receive(input)).toMatchObject({ status: 200 });
  expect(await ingress.receive(input)).toMatchObject({ status: 200 });
  expect((await env.runtime.query("SELECT public.payment_refund_readback($1::uuid) value", [f.intent])).rows[0].value)
    .toMatchObject({ refundCents: 3000, currency: "XXX" });
  expect((await db.query(`SELECT e.amount_minor,e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}' AS delta,
    r.amount_minor AS refunded FROM public.payment_provider_attempt_evidence e
    JOIN public.payment_refund_evidence r ON r.source_evidence_id=e.id WHERE e.settlement_intent_id=$1`, [f.intent])).rows)
    .toEqual([{ amount_minor: "12999", delta: "3000", refunded: "3000" }]);
  expect((await env.runtime.query("SELECT amount_minor::text FROM public.commerce_settlement_intents WHERE id=$1", [f.intent]))
    .rows[0].amount_minor).toBe("12999");
});

it("denies runtime calls to the sealed interactive reopen body", async () => {
  await expect(env.runtime.query(`SELECT public.commerce_payment_reopen_interactive_sealed_v1(
    'sealed-denied',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`))
    .rejects.toMatchObject({ code: "42501", message: "permission denied for function commerce_payment_reopen_interactive_sealed_v1" });
});

it("bounds claims, retains latest-check fairness and skips a locked active attempt", async () => {
  const first = await fixture(), second = await fixture(), recent = await fixture();
  await age(first, "2026-11-13T08:00:00Z"); await age(second, "2026-11-13T09:00:00Z"); await age(recent, at);
  const claim = (claimKey: string) => port().claimStaleAttempts({ now: at, staleAfterSeconds: 900, limit: 1, claimKey });
  expect((await claim("fairness-first")).map(x => x.paymentAttemptId)).toEqual([first.attempt]);
  const locked = await env.owner.connect();
  try {
    await locked.query("BEGIN"); await locked.query("SELECT 1 FROM public.payment_provider_attempts WHERE id=$1 FOR UPDATE", [second.attempt]);
    expect((await claim("fairness-locked")).map(x => x.paymentAttemptId)).toEqual([first.attempt]);
    await locked.query("ROLLBACK");
    expect((await claim("fairness-next")).map(x => x.paymentAttemptId)).toEqual([second.attempt]);
    await db.query("UPDATE public.payment_provider_reconciliation_runs SET correction_status='corrected',provider_status='succeeded' WHERE payment_attempt_id=$1", [first.attempt]);
    expect(await claim("fairness-next")).toEqual([]);
  } finally { await locked.query("ROLLBACK"); locked.release(); }
  await expect(port().claimStaleAttempts({ now: at, staleAfterSeconds: 59, limit: 1, claimKey: "invalid-bounds" }))
    .rejects.toThrow("payment_reconciliation_claim_invalid_input");
  await db.query("UPDATE public.payment_provider_states SET status='expired' WHERE id=ANY($1::uuid[])", [[first.intent, second.intent, recent.intent]]);
});

it("keeps the worker default off and requires watchdog, age and exact absence proof", async () => {
  const f = await fixture("prepared", true, false); await age(f);
  await expect(port().reopenPreparedAttemptAfterAbsence(reopen(f))).rejects.toThrow("prepared_attempt_absence_reopen_watchdog_evidence_missing");
  let probes = 0;
  await runPaymentProviderReconciliationWorker({ port: port(), providers: { [f.provider]: {
    readPayment: async () => { throw Error("unexpected_provider_read"); },
    findPaymentByLocalIntent: async () => { probes++; return "absent"; },
  } }, now: at, claimKey: `watchdog:${f.intent}` });
  expect(probes).toBe(0);
  expect((await db.query("SELECT status FROM public.payment_provider_attempts WHERE id=$1", [f.attempt])).rows[0].status).toBe("created");
  await expect(port().reopenPreparedAttemptAfterAbsence({ ...reopen(f), absenceEvidence: {} })).rejects.toThrow("prepared_attempt_absence_reopen_requires_provider_absence_proof");
  await age(f, "2026-11-13T11:45:00Z");
  await expect(port().reopenPreparedAttemptAfterAbsence(reopen(f))).rejects.toThrow("prepared_attempt_absence_reopen_too_fresh");
  await age(f);
  const request = reopen(f);
  const readState = async () => (await db.query(`SELECT s.provider_attempt_sequence,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.payment_provider_receipts r
      WHERE r.scope='commerce.payment_attempt.prepared_absence_reopen' AND r.idempotency_key=$3) AS receipts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM public.payment_prepared_absence_reopens r
      WHERE r.payment_attempt_id=$2 OR r.idempotency_key=$3) AS reopens,
    jsonb_build_object(
      'retry', (SELECT to_jsonb(r) FROM public.subscription_retry_obligations r WHERE r.cycle_id=s.subscription_cycle_id),
      'cycle', (SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE c.id=s.subscription_cycle_id),
      'order', (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE o.id=$4),
      'providerState', to_jsonb(s)-'provider_attempt_sequence'-'updated_at',
      'dispatch', (SELECT jsonb_agg(jsonb_build_object('id', a.id, 'provider_attempt_id', a.provider_attempt_id,
        'provider_session_id', a.provider_session_id, 'next_action_kind', a.next_action_kind,
        'request_payload', a.request_payload) ORDER BY a.id)
        FROM public.payment_provider_attempts a WHERE a.settlement_intent_id=$1)
    ) AS retry_dispatch,
    to_jsonb(s) AS provider_state,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.payment_provider_attempts a WHERE a.settlement_intent_id=$1) AS attempts
    FROM public.payment_provider_states s WHERE s.id=$1`, [f.intent, f.attempt, request.idempotencyKey, f.order])).rows[0];
  const before = await readState();
  const observed = await Promise.allSettled([port().reopenPreparedAttemptAfterAbsence(reopen(f)), port().reopenPreparedAttemptAfterAbsence(reopen(f))]);
  const applied = observed.filter(x => x.status === "fulfilled" && x.value.replayed === false);
  expect(applied).toHaveLength(1);
  const other = observed.find(x => x !== applied[0]);
  expect(other).toBeDefined();
  if (other?.status === "fulfilled") {
    expect(other.value).toEqual({ replayed: true });
  } else {
    expect(other?.reason).toMatchObject({ message: "prepared_attempt_absence_reopen_attempt_not_prepared", code: "22023" });
  }
  const settled = await readState();
  expect(settled.receipts).toHaveLength(1);
  expect(settled.receipts[0]).toMatchObject({ status: "completed", metadata: { paymentAttemptId: f.attempt } });
  expect(settled.reopens).toHaveLength(1);
  expect(settled.reopens[0]).toMatchObject({ payment_attempt_id: f.attempt, idempotency_key: request.idempotencyKey });
  expect(settled.provider_attempt_sequence).toBe(before.provider_attempt_sequence + 1);
  expect(settled.retry_dispatch).toEqual(before.retry_dispatch);
  expect(await port().reopenPreparedAttemptAfterAbsence(reopen(f))).toEqual({ replayed: true });
  expect((await db.query("SELECT provider_attempt_sequence FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].provider_attempt_sequence).toBe(1);
  const stored = settled.receipts[0].response_payload;
  expect(stored.preparedAttemptReopen.replayed).toBe(false);
  const replay = (await env.runtime.query(
    "SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence($1,$2::uuid,$3::uuid,$4::uuid,$5,$6::timestamptz,$7::timestamptz,$8::jsonb) AS response",
    [request.idempotencyKey, request.paymentAttemptId, request.expectedPaymentIntentId, request.expectedSubscriptionCycleId,
      request.operatorRef, request.absenceCheckedAt, request.nextRetryAt, JSON.stringify(request.absenceEvidence)],
  )).rows[0].response;
  expect(replay).toEqual({ ...stored, preparedAttemptReopen: { ...stored.preparedAttemptReopen, replayed: true } });
  expect(await readState()).toEqual(settled);
});

it("retains the interactive exact predecessor, sensitive-evidence refusal and canonical replay", async () => {
  const f = await fixture("interactive", false, false); await age(f);
  await db.query("UPDATE public.payment_provider_attempts SET request_payload=request_payload||$2::jsonb WHERE id=$1", [f.attempt, { source: "commerce.runtime.provider-attempt.prepare.v0" }]);
  await db.query("UPDATE public.payment_provider_states SET metadata=metadata||$2::jsonb WHERE id=$1", [f.intent, { checkoutKind: "one_time" }]);
  await db.query("UPDATE public.commerce_orders SET metadata=metadata||$2::jsonb WHERE id=$1", [f.order, { runtimeFinalize: { checkoutKind: "one_time", source: "commerce.runtime.hidden.v0" } }]);
  await port().claimPreparedAttempts({ now: at, staleAfterSeconds: 900, limit: 50, claimKey: `interactive:${f.intent}` });
  const request = { idempotencyKey: `interactive-reopen:${f.intent}`, paymentAttemptId: f.attempt, expectedPaymentIntentId: f.intent,
    expectedOrderId: f.order, expectedSubscriptionId: null, expectedSubscriptionCycleId: null,
    operatorRef: "operator.fixture", absenceCheckedAt: at,
    absenceEvidence: { providerAbsenceConfirmed: true as const, watchdogEvidence: true as const, evidenceCode: "operator_verified_absence" as const } };
  await expect(port().reopenInteractivePreparedAttemptAfterAbsence({ ...request, expectedOrderId: randomUUID() })).rejects.toBeInstanceOf(Error);
  const sensitiveEvidence = { ...request.absenceEvidence, clientSecret: "synthetic-refused" };
  await expect(port().reopenInteractivePreparedAttemptAfterAbsence({ ...request, absenceEvidence: sensitiveEvidence })).rejects.toBeInstanceOf(Error);
  const result = await Promise.all([port().reopenInteractivePreparedAttemptAfterAbsence(request), port().reopenInteractivePreparedAttemptAfterAbsence(request)]);
  expect(result.map(x => x.replayed).sort()).toEqual([false, true]);
  expect(await port().reopenInteractivePreparedAttemptAfterAbsence(request)).toMatchObject({ paymentAttemptId: f.attempt, replayed: true });
});

it("refuses legacy and superseded attribution without reconstructing payment or refund authority", async () => {
  const f = await fixture();
  const hook = createPostgresPaymentWebhookControlPort(env.runtime, options);
  const event = await hook.ingestPaymentEvent({ provider: f.provider, providerEventId: `unresolved:${f.intent}`, eventType: "payment.refunded",
    paymentIntentId: f.intent, providerPaymentId: "unresolved-provider-reference", amountMinor: 12999, currency: "XXX", occurredAt: at, rawPayload: {} });
  const before = await census(f);
  await expect(hook.applyPaymentResult!({ idempotencyKey: `unresolved-apply:${f.intent}`, paymentIntentId: f.intent,
    paymentEventId: event.paymentEventId, resultStatus: "refunded", occurredAt: at, failureReason: null })).rejects.toThrow("payment_control_result_attempt_unresolved");
  expect(await census(f)).toEqual(before);
  await db.query("UPDATE public.payment_provider_states SET active_attempt_id=NULL WHERE id=$1", [f.intent]);
  await expect(createPostgresProviderPaymentControlPort(env.runtime, options).applyPaymentResult({ idempotencyKey: `legacy:${f.intent}`,
    paymentIntentId: f.intent, paymentEventId: null, resultStatus: "refunded", occurredAt: at, failureReason: null }))
    .rejects.toThrow("payment_control_result_active_attempt_not_found");
  expect((await env.runtime.query("SELECT public.payment_refund_readback($1) value", [f.intent])).rows[0].value).toBeNull();
});

it("rolls back refund, stock, notices and receipts together when reservation release refuses", async () => {
  const f = await fixture();
  await db.query("SELECT pg_temp.provider_apply($1,$2,NULL,'succeeded',$3,NULL)", [`capture:${f.intent}`, f.intent, at]);
  await db.query(`INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
    VALUES($1,$2,'fixture','held',$3,'2032-01-01T12:00Z')`, [f.order, "a".repeat(64), at]);
  const before = await census(f);
  try {
    await db.query("BEGIN");
    await db.query(`CREATE FUNCTION pg_temp.refuse_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_release_refusal'; END; $$;
      CREATE TRIGGER r3_release_refusal BEFORE UPDATE ON public.fulfillment_inventory_reservations FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_release()`);
    await expect(db.query("SELECT pg_temp.refund_observe($1,$2,12999)", [f, `refund:${f.intent}`])).rejects.toThrow("synthetic_release_refusal");
  } finally { await db.query("ROLLBACK"); }
  expect(await census(f)).toEqual(before);
  await db.query("SELECT pg_temp.refund_observe($1,$2,12999)", [f, `refund:${f.intent}`]);
  const settled = await census(f);
  await db.query("SELECT pg_temp.refund_observe($1,$2,12999)", [f, `refund:${f.intent}`]);
  expect(await census(f)).toEqual(settled);
});

it("serializes full refund with stock consumption while preserving consumed and unrelated reservations", async () => {
  const f = await fixture();
  await db.query("SELECT pg_temp.provider_apply($1,$2,NULL,'succeeded',$3,NULL)", [`capture:${f.intent}`, f.intent, at]);
  const hold = (await db.query(`INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
    VALUES($1,$2,'fixture','held',$3,'2032-01-01T12:00Z') RETURNING id`, [f.order, "b".repeat(64), at])).rows[0].id;
  const consume = await env.owner.connect();
  try {
    await consume.query("BEGIN");
    await consume.query("UPDATE public.fulfillment_inventory_reservations SET status='consumed' WHERE id=$1", [hold]);
    const refund = db.query("SELECT pg_temp.refund_observe($1,$2,12999)", [f, `race-refund:${f.intent}`]);
    await consume.query("COMMIT"); await refund;
    expect((await db.query("SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1", [hold])).rows[0].status).toBe("consumed");
    expect((await db.query("SELECT amount_minor,status FROM public.commerce_settlement_intents WHERE id=$1", [f.intent])).rows[0]).toEqual({ amount_minor: "12999", status: "settled" });
  } finally { await consume.query("ROLLBACK"); consume.release(); }
});

it("rejects invalid admitted table boundaries", async () => {
  const f = await fixture("prepared", true, false);
  await expect(db.query(`INSERT INTO public.payment_prepared_absence_reopens(payment_intent_id,payment_attempt_id,subscription_cycle_id,
    provider_attempt_sequence,next_retry_at,idempotency_key,evidence) VALUES($1,$2,$3,0,$4,$5,'{}')`,
  [f.intent, f.attempt, f.cycle, at, `invalid-sequence:${f.intent}`])).rejects.toMatchObject({ code: "23514" });
  await expect(call(env.runtime, "payment_refund_evidence_record", [randomUUID(), "unproven", 1, "XXX"]))
    .rejects.toBeInstanceOf(Error);
});
