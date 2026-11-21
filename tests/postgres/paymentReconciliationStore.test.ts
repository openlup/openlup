import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPaymentProviderReconciliationPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderPaymentControlPort, createVerifiedPaymentIngress, runPaymentProviderReconciliationWorker } from "@openlup/platform/payments";
import { createTpayPaymentReconciliationProvider } from "@openlup/platform/payments/tpay";
import type { PaymentIngressPort } from "@openlup/platform/payments/contracts";
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
async function completedCaptureReceipt(provider: string, eventId: string, remote: string, fingerprint: string) {
  return (await env.runtime.query(`SELECT public.commerce_payment_control_completed_capture_receipt(
    $1,$2,$3,$4) AS event_id`, [provider, eventId, remote, fingerprint])).rows[0].event_id;
}

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

it("settles two simultaneous verified webhook deliveries once and replays the historical exact receipt", async () => {
  const f = await fixture();
  const providerEventId = `verified-capture:${randomUUID()}`;
  const createIngress = (runtime: PoolClient): PaymentIngressPort => createVerifiedPaymentIngress({
    provider: f.provider,
    paymentControlPort: createPostgresPaymentWebhookControlPort(runtime, options),
    verifyPort: { verifyAndNormalize: async () => ({
      kind: "money", provider: f.provider, providerEventId, fingerprint: "a".repeat(64),
      providerOccurredAt: at, providerPaymentRef: `charge_${f.attempt}`, intentRef: f.intent, attemptRef: f.attempt,
      outcome: "succeeded", money: { amountMinor: 12999, currency: "XXX" }, capturedAmountBasis: "provider_capture_v1",
    }) },
  });
  const request = { rawBody: new Uint8Array(), headers: {}, receivedAt: at };
  const receivers = await Promise.all([env.runtime.connect(), env.runtime.connect()]);
  let pending: Promise<Awaited<ReturnType<PaymentIngressPort["receive"]>>[]> | undefined;
  try {
    // The real order-row lock forces both deliveries to contend in the store.
    await db.query("BEGIN");
    await db.query("SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE", [f.order]);
    const pids = await Promise.all(receivers.map(async receiver => (await receiver.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    pending = Promise.all(receivers.map(receiver => createIngress(receiver).receive(request)));
    let waiting = 0;
    for (let attempt = 0; attempt < 300 && waiting < 2; attempt++) {
      waiting = (await db.query(`SELECT count(*)::int AS waiting FROM unnest($1::int[]) AS worker(pid)
        WHERE cardinality(pg_blocking_pids(pid))>0`, [pids])).rows[0].waiting;
    }
    expect(waiting).toBe(2);
    await db.query("COMMIT");
    const deliveries = await pending;
    expect(deliveries.map(delivery => delivery.status)).toEqual([200, 200]);
    expect(deliveries.map(delivery => delivery.data.replayed).sort()).toEqual([false, true]);
  } finally {
    await db.query("ROLLBACK");
    await pending;
    for (const receiver of receivers) receiver.release();
  }
  const key = `provider-webhook:${f.provider}:${providerEventId}:apply`;
  expect((await db.query(`SELECT
    (SELECT count(*)::int FROM public.payment_provider_attempt_evidence WHERE settlement_intent_id=$1) AS events,
    (SELECT count(*)::int FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=$2) AS receipts,
    (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded') AS settlements,
    (SELECT status FROM public.commerce_orders WHERE id=$3) AS order_status`, [f.intent, key, f.order])).rows[0])
    .toEqual({ events: 1, receipts: 1, settlements: 1, order_status: "paid" });

  // Completed historical event receipts remain exact replays when their
  // evidence has no new capture basis column value.
  const remote = `charge_${f.attempt}`, fingerprint = "a".repeat(64);
  expect(await completedCaptureReceipt(f.provider, providerEventId, remote, fingerprint)).toBeNull();
  const historicalProof = (await db.query(`UPDATE public.payment_provider_attempt_evidence SET captured_amount_basis=NULL
    WHERE provider_event_id=$1 RETURNING id`, [providerEventId])).rows[0].id;
  const lookupBefore = await census(f);
  expect(await completedCaptureReceipt(f.provider, providerEventId, remote, fingerprint)).toBe(historicalProof);
  expect(await completedCaptureReceipt(f.provider, providerEventId, remote, "b".repeat(64))).toBeNull();
  expect(await completedCaptureReceipt(f.provider, providerEventId, "superseded-handle", fingerprint)).toBeNull();
  expect(await census(f)).toEqual(lookupBefore);
  const historicalEvent = await env.runtime.connect();
  try {
    expect(await createIngress(historicalEvent).receive(request)).toMatchObject({ status: 200, data: { replayed: true } });
  } finally { historicalEvent.release(); }
  expect((await db.query("SELECT captured_amount_basis FROM public.payment_provider_attempt_evidence WHERE provider_event_id=$1",
    [providerEventId])).rows[0].captured_amount_basis).toBeNull();

  // Represent the old completed eventless receipt without running the old writer.
  const historicalKey = `historical-receipt:${f.intent}`;
  await db.query(`INSERT INTO public.payment_provider_receipts
    (scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
    SELECT scope,$2,md5($3::uuid::text || '||succeeded|' || $4::timestamptz::text || '|'),status,
      jsonb_set(response_payload,'{paymentResult,idempotencyKey}',to_jsonb($2::text)),metadata
    FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=$1`, [key, historicalKey, f.intent, at]);
  const before = await census(f);
  expect(await createPostgresProviderPaymentControlPort(env.runtime, options).applyPaymentResult({
    idempotencyKey: historicalKey, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "succeeded", occurredAt: at, failureReason: null,
  })).toMatchObject({ status: "succeeded", replayed: true });
  expect(await census(f)).toEqual(before);
});

it.each([
  ["configured amount", { amount: 130.99, payments: { amountPaid: "129.99" } }, 13099],
  ["paid fields", { amount: 129.99, paidAmount: "130.99", payments: { amountPaid: "129.99" } }, 12999],
] as const)("records a provider success with conflicting %s without settling native payment", async (_, fields, configuredAmountMinor) => {
  const f = await fixture("delta");
  await age(f);
  const reconciliation = port();
  const provider = createTpayPaymentReconciliationProvider({ getTransaction: async providerPaymentId => ({
    transactionId: providerPaymentId, status: "correct", currency: "XXX",
    title: null, transactionPaymentUrl: null, requestId: null, ...fields,
  }) });
  const result = await runPaymentProviderReconciliationWorker({
    port: { ...reconciliation, async claimStaleAttempts(input) {
      return (await reconciliation.claimStaleAttempts({ ...input, limit: 100 })).filter(row => row.paymentAttemptId === f.attempt);
    } },
    providers: { [f.provider]: provider },
    now: at, claimKey: `amount-conflict:${f.intent}`,
  });
  expect(result).toMatchObject({ manualReview: 1, corrected: 0 });
  expect((await db.query(`SELECT
    (SELECT status FROM public.commerce_orders WHERE id=$1) AS order_status,
    (SELECT status FROM public.commerce_settlement_intents WHERE id=$2) AS settlement_status,
    (SELECT count(*)::int FROM public.payment_truth_events WHERE settlement_intent_id=$2 AND outcome='captured') AS captures`,
  [f.order, f.intent])).rows).toEqual([{ order_status: "pending_payment", settlement_status: "created", captures: 0 }]);
  expect((await db.query(`SELECT payload FROM public.payment_provider_reconciliation_runs
    WHERE payment_intent_id=$1 AND correction_status='failed'`, [f.intent])).rows)
    .toMatchObject([{ payload: { failureReason: "provider_amount_mismatch",
      providerPayload: { amountEvidence: [
        { field: "amount", amountMinor: configuredAmountMinor },
        { field: "payments.amountPaid", amountMinor: 12999 },
        ...("paidAmount" in fields ? [{ field: "paidAmount", amountMinor: 13099 }] : []),
      ] } } }]);
});

it.each(["worker", "renewal"] as const)("records the exact amount and provenance of a %s readback before settling", async carrier => {
  const f = await fixture();
  const paymentId = (await db.query("SELECT payment_id FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_id;
  const request = {
    idempotencyKey: `reconcile-capture:${randomUUID()}`, expectedOrderId: f.order,
    expectedPaymentIntentId: f.intent, expectedPaymentAttemptId: f.attempt, expectedPaymentId: paymentId,
    provider: f.provider, providerPaymentId: `charge_${f.attempt}`, localStatus: "processing",
    providerStatus: "succeeded", resultStatus: "succeeded" as const, occurredAt: at, failureReason: null, checkedAt: at,
    payload: carrier === "worker" ? { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" }
      : { observedMoney: { amountMinor: 12999, currency: "XXX" }, providerOccurredAt: at, capturedAmountBasis: "provider_capture_v1" },
  };
  const before = await census(f);
  await expect(port().applyTerminalResult({
    ...request, payload: { normalizedStatus: "succeeded", currency: "XXX" },
  })).rejects.toMatchObject({ code: "22023", message: "payment_control_result_success_evidence_required" });
  await expect(port().applyTerminalResult({
    ...request, payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX" },
  })).rejects.toMatchObject({ code: "22023", message: "payment_control_result_success_evidence_required" });
  expect(await census(f)).toEqual(before);
  expect(await port().applyTerminalResult(request)).toMatchObject({ correctionStatus: "corrected", replayed: false });
  expect(await port().applyTerminalResult(request)).toMatchObject({ correctionStatus: "corrected", replayed: true });
  expect((await db.query(`SELECT
    e.received_via, e.signature_verified, e.amount_minor::text, e.currency, e.captured_amount_basis,
    t.source_evidence->>'sourceKind' AS source_kind,
    (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=e.settlement_intent_id AND outcome='succeeded') AS settlements
    FROM public.payment_provider_attempt_evidence e
    JOIN public.payment_truth_events t ON t.settlement_intent_id=e.settlement_intent_id
      AND t.source_evidence->>'sourceReference'=e.id::text
    WHERE e.settlement_intent_id=$1`, [f.intent])).rows)
    .toEqual([{ received_via: "reconciliation_read.v1", signature_verified: null,
      amount_minor: "12999", currency: "XXX", captured_amount_basis: "provider_capture_v1", source_kind: "reconciliation_read", settlements: 1 }]);

  if (carrier === "worker") {
    const historicalKey = `historical-readback:${f.intent}`;
    await db.query(`INSERT INTO public.payment_provider_receipts
      (scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
      SELECT scope,$2,md5($3::uuid::text || '||succeeded|' || $4::timestamptz::text || '|'),status,
        jsonb_set(response_payload,'{paymentResult,idempotencyKey}',to_jsonb($2::text)),metadata-'paymentEventId'
      FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=$1`,
    [request.idempotencyKey, historicalKey, f.intent, at]);
    await db.query(`INSERT INTO public.payment_provider_reconciliation_runs
      (provider,provider_payment_id,payment_intent_id,payment_attempt_id,local_status,provider_status,correction_status,idempotency_key,checked_at,payload)
      SELECT provider,provider_payment_id,payment_intent_id,payment_attempt_id,local_status,provider_status,correction_status,$2,checked_at,payload-'amountMinor'-'capturedAmountBasis'
      FROM public.payment_provider_reconciliation_runs WHERE idempotency_key=$1`,
    [`${request.idempotencyKey}:evidence`, `${historicalKey}:evidence`]);
    const historical = await census(f);
    expect(await port().applyTerminalResult({ ...request, idempotencyKey: historicalKey }))
      .toMatchObject({ correctionStatus: "corrected", replayed: true });
    expect(await census(f)).toEqual(historical);
  }
});

it.each([
  ["cancelled", "webhook"], ["cancelled", "readback"], ["expired", "webhook"], ["expired", "readback"],
] as const)("retains a %s order's late %s capture without paying it", async (closedStatus, carrier) => {
  const f = await fixture(), control = createPostgresProviderPaymentControlPort(env.runtime, options);
  await control.applyPaymentResult({ idempotencyKey: `closed-order-decline:${f.intent}`,
    paymentIntentId: f.intent, paymentEventId: null, resultStatus: "failed", occurredAt: old, failureReason: "declined" });
  const cancel = (suffix = "original") => call(env.runtime, "oms_cancel_unpaid_order_owned",
    [`cancel:${f.order}:${suffix}`, f.order, "buyer_cancelled", null, {}, old]);
  if (closedStatus === "cancelled") {
    expect(await cancel()).toMatchObject({ status: "cancelled", replayed: false });
  } else {
    await db.query(`INSERT INTO public.fulfillment_inventory_reservations
      (purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
      VALUES($1,$2,'fixture','held',$3,$4)`, [f.order, "a".repeat(64), old, at]);
    expect(await call(env.runtime, "commerce_sweep_expired_checkouts", [50, {}, at])).toMatchObject({ expired: 1, released: 1 });
  }

  const readStates = async () => (await db.query(`SELECT i.status AS intent_status,o.status AS order_status,
    s.status AS provider_status,s.payment_status,a.status AS attempt_status,
    to_jsonb(i) AS settlement, to_jsonb(o) AS order_row, to_jsonb(s) AS provider_state, to_jsonb(a) AS attempt,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.fulfillment_inventory_reservations r WHERE r.purchase_order_id=o.id) AS reservations,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.outbox_events e WHERE e.aggregate_id=o.id) AS outbox
    FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id
    JOIN public.payment_provider_states s ON s.id=i.id
    JOIN public.payment_provider_attempts a ON a.id=s.active_attempt_id WHERE i.id=$1`, [f.intent])).rows[0];
  const before = await readStates();
  expect(before).toMatchObject({ order_status: closedStatus, attempt_status: "failed",
    ...(closedStatus === "cancelled" ? { intent_status: "cancelled", provider_status: "cancelled" } : {}) });
  const key = `review-capture:${f.intent}`, remote = `charge_${f.attempt}`;
  const occurredAt = "2026-11-13T13:00:00Z";
  const attemptRead = () => call(env.runtime, "payment_provider_attempt_read", [f.intent, f.attempt]);
  expect(await attemptRead()).toMatchObject({ orderId: f.order, captureReviewRequired: false });
  const checkDelayedNegativeResults = async (phase: string) => {
    for (const resultStatus of ["failed", "expired"] as const) {
      const providerEventId = `late-negative:${phase}:${resultStatus}:${f.intent}`;
      const evidence = await createPostgresPaymentWebhookControlPort(env.runtime, options).ingestPaymentEvent({
        provider: f.provider, providerEventId, providerPaymentId: remote, paymentIntentId: f.intent, paymentAttemptId: f.attempt,
        eventType: "payment.failed", amountMinor: 12999, currency: "XXX", occurredAt, rawPayload: {},
      });
      const input = {
        idempotencyKey: `provider-webhook:${f.provider}:${providerEventId}:apply`, paymentIntentId: f.intent,
        paymentEventId: evidence.paymentEventId, resultStatus, occurredAt, failureReason: "late_decline",
        failureClass: "authorization_refused", failureClassDecidedBy: "fixture",
      };
      expect(await control.applyPaymentResult(input)).toMatchObject({ kind: "ignored_failure_protected_state", replayed: false });
      expect(await control.applyPaymentResult(input)).toMatchObject({ kind: "ignored_failure_protected_state", replayed: true });
      expect(await readStates()).toEqual(before);
      expect((await db.query(`SELECT e.processing_status,
        (SELECT count(*)::int FROM public.payment_provider_transitions
          WHERE settlement_intent_id=$1 AND idempotency_key=$2) AS business_transitions
        FROM public.payment_provider_attempt_evidence e WHERE e.id=$3`,
      [f.intent, `${input.idempotencyKey}:payment_result`, evidence.paymentEventId])).rows)
        .toEqual([{ processing_status: "ignored", business_transitions: 0 }]);
    }
  };
  await checkDelayedNegativeResults("before-review");

  if (carrier === "webhook") {
    const webhook = createPostgresPaymentWebhookControlPort(env.runtime, options);
    const event = await webhook.ingestPaymentEvent({
      provider: f.provider, providerEventId: key, providerPaymentId: remote, paymentIntentId: f.intent, paymentAttemptId: f.attempt,
      eventType: "payment.succeeded", amountMinor: 12999, currency: "XXX", occurredAt,
      rawPayload: {}, capturedAmountBasis: "provider_capture_v1",
    });
    const input = { idempotencyKey: `provider-webhook:${f.provider}:${key}:apply`, paymentIntentId: f.intent,
      paymentEventId: event.paymentEventId, resultStatus: "succeeded" as const, occurredAt, failureReason: null };
    expect(await control.applyPaymentResult(input)).toMatchObject({ kind: "ignored_success_requiring_review", replayed: false });
    expect(await control.applyPaymentResult(input)).toMatchObject({ kind: "ignored_success_requiring_review", replayed: true });
  } else {
    const paymentId = (await db.query("SELECT payment_id FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_id;
    const input = {
      idempotencyKey: key, expectedOrderId: f.order, expectedPaymentIntentId: f.intent, expectedPaymentAttemptId: f.attempt,
      expectedPaymentId: paymentId, provider: f.provider, providerPaymentId: remote, localStatus: before.attempt_status,
      providerStatus: "succeeded", resultStatus: "succeeded" as const, occurredAt, failureReason: null, checkedAt: occurredAt,
      payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" },
    };
    const later = "2026-11-13T13:01:00Z";
    const concurrentInput = {
      ...input, occurredAt: later, checkedAt: later, payload: { ...input.payload, trigger: "buyer_confirm_settled" },
    };
    const results = await Promise.all([port().applyTerminalResult(input), port().applyTerminalResult(concurrentInput)]);
    expect(results).toEqual(results.map(() => expect.objectContaining({
      correctionStatus: "ignored", paymentResult: expect.objectContaining({ kind: "ignored_success_requiring_review" }),
    })));
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(await port().applyTerminalResult(input)).toMatchObject({ correctionStatus: "ignored", replayed: true });
    await expect(port().applyTerminalResult({ ...input, payload: { ...input.payload, amountMinor: 13000 } }))
      .rejects.toThrow(/payment_reconciliation_apply_evidence_conflict/);
    await expect(port().applyTerminalResult({ ...input, providerPaymentId: "other_payment" }))
      .rejects.toThrow(/payment_reconciliation_apply_evidence_conflict/);

    // Historical exact replay remains valid after the active slot is cleared.
    const exact = results[0].replayed ? concurrentInput : input;
    await db.query("UPDATE public.payment_provider_states SET active_attempt_id=NULL WHERE id=$1", [f.intent]);
    try {
      expect(await port().applyTerminalResult(exact)).toMatchObject({ correctionStatus: "ignored", replayed: true });
      await expect(port().applyTerminalResult({ ...exact, occurredAt: "2026-11-13T13:02:00Z" })).rejects.toThrow(/idempotency_conflict/);
    } finally {
      await db.query("UPDATE public.payment_provider_states SET active_attempt_id=$2 WHERE id=$1", [f.intent, f.attempt]);
    }
  }

  expect(await attemptRead()).toMatchObject({ orderId: f.order, captureReviewRequired: true });
  await checkDelayedNegativeResults("after-review");
  if (closedStatus === "cancelled") {
    expect(await cancel()).toMatchObject({ status: "cancelled", replayed: true });
    await expect(cancel("new-command")).rejects.toThrow(/oms_cancel_unpaid_order_payment_already_moved/);
  }
  expect(await readStates()).toEqual(before);
  expect((await db.query(`SELECT t.outcome,t.state,t.review_required_at,t.settlement_transition_id,e.processing_status,
    (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded') AS paid,
    (SELECT count(*)::int FROM public.payment_provider_transitions WHERE settlement_intent_id=$1
      AND transition_kind='business_result' AND to_status='succeeded') AS finalized
    FROM public.payment_truth_events t JOIN public.payment_provider_attempt_evidence e ON e.id::text=t.source_evidence->>'sourceReference'
    WHERE t.settlement_intent_id=$1 AND t.outcome='captured'`, [f.intent])).rows).toEqual([{
    outcome: "captured", state: "open", review_required_at: expect.any(Date), settlement_transition_id: null,
    processing_status: "ignored", paid: 0, finalized: 0,
  }]);
});

it.each(["capture", "cancellation"] as const)("serializes an OMS cancellation and readback with %s first", async first => {
  const f = await fixture();
  await createPostgresProviderPaymentControlPort(env.runtime, options).applyPaymentResult({
    idempotencyKey: `race-decline:${f.intent}`, paymentIntentId: f.intent, paymentEventId: null,
    resultStatus: "failed", occurredAt: old, failureReason: "declined",
  });
  const paymentId = (await db.query("SELECT payment_id FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_id;
  const input = {
    idempotencyKey: `race-capture:${f.intent}`, expectedOrderId: f.order, expectedPaymentIntentId: f.intent,
    expectedPaymentAttemptId: f.attempt, expectedPaymentId: paymentId, provider: f.provider, providerPaymentId: `charge_${f.attempt}`,
    localStatus: "failed", providerStatus: "succeeded", resultStatus: "succeeded" as const, occurredAt: at, failureReason: null,
    checkedAt: at, payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" },
  };
  const capture = (runtime: PoolClient) => createPostgresPaymentProviderReconciliationPort(runtime, options).applyTerminalResult(input);
  const cancel = (runtime: PoolClient) => call(runtime, "oms_cancel_unpaid_order_owned", [`race-cancel:${f.order}`, f.order, "buyer_cancelled", null, {}, at]);
  const winner = await env.runtime.connect(), waiter = await env.runtime.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await winner.query("BEGIN");
    const win = await (first === "capture" ? capture(winner) : cancel(winner));
    const { pid } = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0];
    pending = (first === "capture" ? cancel(waiter) : capture(waiter)).catch(error => error);
    let waiting = false;
    for (let retry = 0; retry < 300 && !waiting; retry++) {
      waiting = (await db.query("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting", [pid])).rows[0].waiting;
    }
    expect(waiting).toBe(true);
    await winner.query("COMMIT");
    if (first === "capture") {
      expect(win).toMatchObject({ correctionStatus: "corrected" });
      expect(await pending).toMatchObject({ message: "oms_cancel_unpaid_order_payment_already_moved" });
    } else {
      expect(win).toMatchObject({ status: "cancelled" });
      expect(await pending).toMatchObject({ correctionStatus: "ignored", paymentResult: { kind: "ignored_success_requiring_review" } });
    }
  } finally {
    await winner.query("ROLLBACK");
    await pending;
    winner.release();
    waiter.release();
  }
  expect((await db.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows)
    .toEqual([{ status: first === "capture" ? "paid" : "cancelled" }]);
  expect(await call(env.runtime, "payment_provider_attempt_read", [f.intent, f.attempt]))
    .toMatchObject({ captureReviewRequired: first === "cancellation" });
});

it("stops reclaiming an otherwise eligible attempt once its capture review is durable", async () => {
  const f = await fixture();
  // An old closed order can still have a stale processing projection. Isolate
  // the claim filter from the lifecycle transitions covered above.
  await db.query("UPDATE public.commerce_orders SET status='expired' WHERE id=$1", [f.order]);
  await age(f);
  const claim = (phase: string) => port().claimStaleAttempts({ now: at, staleAfterSeconds: 900, limit: 100,
    claimKey: `capture-claim:${f.intent}:${phase}` });
  const [pending] = (await claim("before-review")).filter(row => row.paymentAttemptId === f.attempt);
  expect(pending).toMatchObject({ orderId: f.order, attemptStatus: "processing" });
  expect(await port().applyTerminalResult({
    idempotencyKey: `capture-review:${f.intent}`, expectedOrderId: pending.orderId, expectedPaymentIntentId: pending.paymentIntentId,
    expectedPaymentAttemptId: pending.paymentAttemptId, expectedPaymentId: pending.paymentId,
    provider: pending.provider, providerPaymentId: pending.providerPaymentId!, localStatus: pending.attemptStatus,
    providerStatus: "succeeded", resultStatus: "succeeded", occurredAt: at, failureReason: null, checkedAt: at,
    payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" },
  })).toMatchObject({ correctionStatus: "ignored", paymentResult: { kind: "ignored_success_requiring_review" } });
  expect(await call(env.runtime, "payment_provider_attempt_read", [f.intent, f.attempt]))
    .toMatchObject({ paymentAttempt: { status: "processing" }, captureReviewRequired: true });
  expect((await claim("after-review")).some(row => row.paymentAttemptId === f.attempt)).toBe(false);
});

it("keeps historical pending evidence unpaid and refuses readback through a predecessor handle", async () => {
  const f = await fixture();
  const oldEvent = await createPostgresPaymentWebhookControlPort(env.runtime, options).ingestPaymentEvent({
    provider: f.provider, providerPaymentId: `charge_${f.attempt}`, providerEventId: `historic-evidence:${f.intent}`, paymentIntentId: f.intent,
    paymentAttemptId: f.attempt, eventType: "payment.succeeded", amountMinor: 12999, currency: "XXX", occurredAt: at, rawPayload: {},
  });
  const pendingProof = (await db.query("SELECT provider_event_id,event_fingerprint FROM public.payment_provider_attempt_evidence WHERE id=$1",
    [oldEvent.paymentEventId])).rows[0];
  expect(await completedCaptureReceipt(f.provider, pendingProof.provider_event_id, `charge_${f.attempt}`, pendingProof.event_fingerprint)).toBeNull();
  const before = await census(f);
  await expect(createPostgresProviderPaymentControlPort(env.runtime, options).applyPaymentResult({
    idempotencyKey: `historical-unpaid:${f.intent}`, paymentIntentId: f.intent, paymentEventId: oldEvent.paymentEventId,
    resultStatus: "succeeded", occurredAt: at, failureReason: null,
  })).rejects.toMatchObject({ code: "22023", message: "payment_control_result_success_evidence_required" });
  expect(await census(f)).toEqual(before);

  const predecessorRef = `charge_${f.attempt}`;
  const paymentId = (await db.query(`UPDATE public.payment_provider_states SET provider_payment_id=$2
    WHERE id=$1 RETURNING payment_id`, [f.intent, predecessorRef])).rows[0].payment_id;
  await db.query("UPDATE public.payment_provider_attempts SET provider_attempt_id=NULL,provider_session_id=NULL WHERE id=$1", [f.attempt]);
  const after = await census(f);
  await expect(port().applyTerminalResult({
    idempotencyKey: `historical-handle:${f.intent}`, expectedOrderId: f.order, expectedPaymentIntentId: f.intent,
    expectedPaymentAttemptId: f.attempt, expectedPaymentId: paymentId, provider: f.provider, providerPaymentId: predecessorRef,
    localStatus: "processing", providerStatus: "succeeded", resultStatus: "succeeded", occurredAt: at, failureReason: null, checkedAt: at,
    payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" },
  })).rejects.toMatchObject({ code: "22023", message: "payment_reconciliation_apply_claim_mismatch" });
  expect(await census(f)).toEqual(after);

  await age(f, "2026-11-13T08:00:00Z");
  const claim = { now: at, staleAfterSeconds: 60, limit: 100, claimKey: `no-active-handle:${f.intent}` };
  expect((await port().claimStaleAttempts(claim)).some(row => row.paymentAttemptId === f.attempt)).toBe(false);
  expect((await db.query("SELECT count(*)::int AS n FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=$1", [f.attempt]))
    .rows[0].n).toBe(0);
  const session = `active-session:${f.attempt}`;
  await db.query("UPDATE public.payment_provider_attempts SET provider_session_id=$2 WHERE id=$1", [f.attempt, session]);
  try {
    expect((await port().claimStaleAttempts({ ...claim, claimKey: `active-handle:${f.intent}` }))
      .find(row => row.paymentAttemptId === f.attempt)).toMatchObject({ providerPaymentId: session });
  } finally { await db.query("UPDATE public.payment_provider_attempts SET provider_session_id=NULL WHERE id=$1", [f.attempt]); }
});

it("settles a concurrent verified webhook and provider readback through one business result", async () => {
  const f = await fixture();
  const paymentId = (await db.query("SELECT payment_id FROM public.payment_provider_states WHERE id=$1", [f.intent])).rows[0].payment_id;
  const remote = `charge_${f.attempt}`;
  const webhookKey = `webhook-capture:${f.intent}`, readbackKey = `readback-capture:${f.intent}`;
  const [webhookDb, readbackDb] = await Promise.all([env.runtime.connect(), env.runtime.connect()]);
  try {
    const webhook = createPostgresPaymentWebhookControlPort(webhookDb, options);
    const result = createPostgresProviderPaymentControlPort(webhookDb, options);
    const event = await webhook.ingestPaymentEvent({
      provider: f.provider, providerPaymentId: remote, providerEventId: webhookKey, paymentIntentId: f.intent,
      paymentAttemptId: f.attempt, eventType: "payment.succeeded", amountMinor: 12999, currency: "XXX", occurredAt: at,
      rawPayload: {}, capturedAmountBasis: "provider_capture_v1",
    });
    const [a, b] = await Promise.all([
      result.applyPaymentResult({ idempotencyKey: webhookKey, paymentIntentId: f.intent, paymentEventId: event.paymentEventId,
        resultStatus: "succeeded", occurredAt: at, failureReason: null }),
      createPostgresPaymentProviderReconciliationPort(readbackDb, options).applyTerminalResult({
        idempotencyKey: readbackKey, expectedOrderId: f.order, expectedPaymentIntentId: f.intent,
        expectedPaymentAttemptId: f.attempt, expectedPaymentId: paymentId, provider: f.provider, providerPaymentId: remote,
        localStatus: "processing", providerStatus: "succeeded", resultStatus: "succeeded", occurredAt: at, failureReason: null, checkedAt: at,
        payload: { normalizedStatus: "succeeded", amountMinor: 12999, currency: "XXX", capturedAmountBasis: "provider_capture_v1" },
      }),
    ]);
    expect([a.kind, b.paymentResult.kind].sort()).toEqual(["ignored_duplicate_success", "state_changed"]);
  } finally { webhookDb.release(); readbackDb.release(); }
  expect((await db.query(`SELECT
    (SELECT count(*)::int FROM public.payment_provider_attempt_evidence WHERE settlement_intent_id=$1 AND captured_amount_basis='provider_capture_v1') AS proofs,
    (SELECT count(*)::int FROM public.payment_provider_transitions WHERE settlement_intent_id=$1 AND transition_kind='business_result' AND to_status='succeeded') AS results,
    (SELECT count(*)::int FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded') AS settlements`, [f.intent])).rows[0])
    .toEqual({ proofs: 2, results: 1, settlements: 1 });
});

it("restricts the completed capture receipt lookup to the runtime role", async () => {
  expect((await db.query(`SELECT
    has_function_privilege('service_role', 'public.commerce_payment_control_completed_capture_receipt(text,text,text,text)', 'EXECUTE') AS runtime,
    has_function_privilege('anon', 'public.commerce_payment_control_completed_capture_receipt(text,text,text,text)', 'EXECUTE') AS anonymous,
    has_function_privilege('authenticated', 'public.commerce_payment_control_completed_capture_receipt(text,text,text,text)', 'EXECUTE') AS browser`)).rows[0])
    .toEqual({ runtime: true, anonymous: false, browser: false });
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
  await db.query("SELECT pg_temp.provider_capture($1::jsonb,$2,$3)", [f, `capture:${f.intent}`, at]);
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
  await db.query("SELECT pg_temp.provider_capture($1::jsonb,$2,$3)", [f, `capture:${f.intent}`, at]);
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
