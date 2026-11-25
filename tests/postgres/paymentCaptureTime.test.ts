import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  createPostgresPaymentProviderReconciliationPort, createPostgresPaymentWebhookControlPort,
  createPostgresProviderPaymentControlPort, createPostgresProviderPaymentRail,
  createPostgresSandboxPaymentSimulator, createVerifiedPaymentIngress,
  runPaymentProviderReconciliationWorker, verifyPaymentAttemptNow,
} from "@openlup/platform/payments";
import { createStripePaymentAdapter, createStripePaymentReconciliationProvider } from "@openlup/platform/payments/stripe";
import {
  createNativeRenewalCodec, createPostgresProviderRenewalBinding, createPostgresRenewalSettlementPort,
  type SubscriptionQueryExecutor,
} from "@openlup/platform/subscriptions";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeySelection, storeJourneyResources } from "../helpers/storeJourney.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { AT, call, renewal } from "./subscriptionNativeFixture.js";

const options = { dunningTemplateSlug: "dunning", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" };
const secret = "synthetic-payment-signature";
const amount = 200;
const currency = "XXX";
const scope = "public.payment_capture_time_test_qualification";
const forward = "_payment_capture_time_read.sql";
type Db = Pool | PoolClient;
type Clock = { created: number; observed: string; occurred: string; precise: string };
type Subject = {
  order: string; client: string; intent: string; attempt: string;
  remote: string; paymentId: string; provider: string; time: Clock;
};
const heldFields = {
  order_id: null, intent_id: null, evidence_id: null, truth_id: null, settlement_transition_id: null,
  captured_at: null, fallback_at: null, truth_occurred_at: null, observed_at: null,
  db_acknowledged_at: null, provider_occurred_at: null,
};
const hold = (kind: "invalid" | "pending" | "unqualified" | "ambiguous") => ({
  ...heldFields, kind, code: {
    invalid: "capture_time_selector_invalid", pending: "capture_time_pending_application",
    unqualified: "capture_time_route_unqualified", ambiguous: "capture_time_integrity",
  }[kind],
});
let env: LifecycleInstallation;

async function clock(db: Db): Promise<Clock> {
  const { rows: [row] } = await db.query(`SELECT
    extract(epoch FROM t)::int AS created, to_char(t,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred,
    to_char(t + interval '3 seconds','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed,
    to_char(t + interval '0.123456 seconds','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise
    FROM (SELECT date_trunc('second', now() AT TIME ZONE 'UTC') - interval '1 hour' AS t) clock`);
  return row;
}

async function draft(db: Db, status = "pending_payment") {
  const client = randomUUID(), order = randomUUID(), sku = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [sku, sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Example')", [sku, sku]);
  await db.query(`WITH created AS (
    INSERT INTO public.commerce_orders(id,client_id,status,total_amount_minor,currency_code)
    VALUES($1,$2,$3,$4,$5) RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT id,$6,1,1,$4,$4 FROM created`, [order, client, status, amount, currency, sku]);
  return { order, client };
}

async function prepared(owner: Db, runtime: Db, provider = "stripe"): Promise<Subject> {
  const { order, client } = await draft(owner);
  const time = await clock(owner);
  const control = createPostgresProviderPaymentControlPort(runtime, options);
  const { id: intent, paymentId } = await control.createIntent({
    idempotencyKey: `intent:${order}`, targetKind: "one_time_order", orderId: order,
    amountMinor: amount, currency, channelKey: provider, metadata: {}, at: time.occurred,
  });
  const request = {
    paymentIntentId: intent, providerIdempotencyKey: `provider:${order}`, providerRequestFingerprint: "a".repeat(64),
  };
  const { paymentAttemptId: attempt } = await control.prepareProviderAttempt({
    ...request, idempotencyKey: `prepare:${order}`, provider,
    providerFlow: provider === "tpay" ? "blik_one_time" : "one_time_payment", paymentMethodRef: null, requestPayload: {},
  });
  const remote = `pi_${attempt}`;
  await control.finalizeProviderAttempt({
    ...request, idempotencyKey: `finalize:${order}`, paymentAttemptId: attempt,
    providerAttemptId: remote, providerSessionId: null, attemptStatus: "processing", nextActionKind: null,
    requestPayload: {}, responsePayload: { providerCall: true },
  });
  return { order, client, intent, attempt, remote, paymentId, provider, time };
}

function stripe(db: Db, f: Subject, mode: "test" | "live" = "test") {
  const unused = async (): Promise<never> => { throw new Error("unexpected provider call"); };
  const adapter = createStripePaymentAdapter({
    mode, supportedCurrencies: [currency], webhookSigningSecrets: [secret], clock: () => f.time.created + 3,
    client: {
      createPaymentIntent: unused, createSetupIntent: unused, ensureCustomer: unused,
      async retrievePaymentIntent() {
        return { id: f.remote, status: "succeeded", amount, amount_received: amount, currency: currency.toLowerCase() };
      },
    },
  });
  return createPostgresProviderPaymentRail({ executor: db, adapter, mode, truth: options,
    resolveSavedMethodOwner: async () => null, resolveMethodOwner: async () => null });
}

function signed(f: Subject, livemode: boolean | string | null = false, created: number | null = f.time.created,
  type = "payment_intent.succeeded", object: Record<string, unknown> = {}, eventId = `evt_${f.attempt}`) {
  const payload = { id: eventId, type, ...(livemode === null ? {} : { livemode }), ...(created === null ? {} : { created }),
    data: { object: { id: f.remote, status: "succeeded", amount, amount_received: amount, currency: currency.toLowerCase(),
      metadata: { paymentIntentId: f.intent }, ...object } } };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const stamp = f.time.created + 3;
  const digest = createHmac("sha256", secret).update(`${stamp}.`).update(rawBody).digest("hex");
  return { rawBody, headers: { "stripe-signature": `t=${stamp},v1=${digest}` }, receivedAt: f.time.observed };
}

async function read(db: Db, order: string | null, intent: string | null = null) {
  const { rows } = await db.query(`SELECT to_jsonb(p) capture FROM public.payment_read_capture_time($1::uuid,$2::uuid) p`, [order, intent]);
  expect(rows).toHaveLength(1);
  return rows[0].capture;
}

const qualify = (db: Db) => db.query(`INSERT INTO ${scope} (singleton,qualified_at) VALUES (true,now())`);
const timeEq = (db: Db, actual: string, expected: string) =>
  db.query("SELECT $1::timestamptz = $2::timestamptz AS equal", [actual, expected]).then(r => expect(r.rows[0].equal).toBe(true));
const prepare = (provider?: string) => prepared(env.owner, env.runtime, provider);
const recovery = () => createPostgresPaymentProviderReconciliationPort(env.runtime, options);

beforeAll(async () => { env = await lifecycleInstallation("qualified-v2"); }, postgresSetupTimeoutMs);
afterAll(async () => { await env?.close(); }, postgresTeardownTimeoutMs);
afterEach(async () => {
  // The failing-first database has no qualification relation.
  if ((await env.owner.query("SELECT to_regclass($1) AS relation", [scope])).rows[0].relation) {
    await env.owner.query(`DELETE FROM ${scope}`);
  }
});

it("reads the signed success instant by either selector in the apply transaction and after commit", async () => {
  const f = await prepare();
  expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
  await qualify(env.migration);
  const db = await env.owner.connect();
  let applied: Awaited<ReturnType<typeof read>>;
  try {
    await db.query("BEGIN");
    const delivery = await stripe(db, f).ingress.receive(signed(f));
    expect(delivery.status).toBe(200);
    applied = await read(db, f.order);
    expect(applied).toMatchObject({
      kind: "authoritative", code: null, order_id: f.order, intent_id: f.intent, evidence_id: delivery.data.paymentEventId,
      provider: "stripe", payment_mode: "test", route: "signed_webhook", fallback_at: null,
    });
    expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await read(env.owner, null, f.intent)).toEqual(applied);
  expect(await read(env.owner, f.order)).toEqual(applied);
  const bound = (await env.owner.query(`SELECT e.created_at::text db_time,e.payload,t.id AS truth_id,
    t.settlement_transition_id,t.occurred_at::text AS truth_time
    FROM public.payment_provider_attempt_evidence e
    JOIN public.payment_truth_events t ON t.source_evidence->>'sourceReference'=e.id::text WHERE e.id=$1`,
  [applied.evidence_id])).rows[0];
  expect(applied).toMatchObject({ truth_id: bound.truth_id, settlement_transition_id: bound.settlement_transition_id });
  expect(bound.payload).toMatchObject({ livemode: false, eventType: "payment_intent.succeeded" });
  await timeEq(env.owner, applied.captured_at, f.time.occurred);
  await timeEq(env.owner, applied.provider_occurred_at, f.time.occurred);
  await timeEq(env.owner, applied.truth_occurred_at, bound.truth_time);
  await timeEq(env.owner, applied.observed_at, f.time.observed);
  await timeEq(env.owner, applied.db_acknowledged_at, bound.db_time);
  expect(new Set([applied.provider_occurred_at, applied.observed_at, applied.db_acknowledged_at]).size).toBe(3);
  expect((await env.owner.query(`SELECT ARRAY(SELECT $1::timestamptz >=
    date_trunc('second',$1::timestamptz + offset_seconds * interval '1 second' + interval '0.25 seconds','UTC')
    FROM unnest(ARRAY[1,0,-1]) AS offset_seconds) AS expired`, [applied.captured_at])).rows[0].expired)
    .toEqual([false, true, true]);
  expect(await stripe(env.runtime, f).ingress.receive(signed(f))).toMatchObject({ status: 200, data: { replayed: true } });
  expect(await read(env.owner, f.order)).toEqual(applied);
  const refund = signed(f, false, f.time.created + 1, "charge.refunded", {
    id: `ch_${f.attempt}`, payment_intent: f.remote, amount_refunded: amount, refunded: true,
  }, `refund_${f.attempt}`);
  expect(await stripe(env.runtime, f).ingress.receive(refund)).toMatchObject({ status: 200 });
  expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows[0].status).toBe("refunded");
  expect(await read(env.owner, f.order)).toEqual(applied);
});

it.each([
  [false, false, "test"], [null, true, "unknown"], ["false", true, "unknown"], [true, true, "live"],
] as const)("holds an applied Stripe mode %s with qualification present=%s", async (mode, qualified, expected) => {
  const f = await prepare();
  const db = await env.owner.connect();
  try {
    await db.query("BEGIN");
    if (qualified) await qualify(db);
    expect(await stripe(db, f, mode === true ? "live" : "test").ingress.receive(signed(f, mode))).toMatchObject({ status: 200 });
    expect(await read(db, f.order)).toMatchObject({
      ...hold("unqualified"), provider: "stripe", route: "signed_webhook", payment_mode: expected,
    });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("keeps a mixed installed population unqualified and holds a bound fractional signed clock", async () => {
  const test = await prepare(), live = await prepare();
  const db = await env.owner.connect();
  try {
    await db.query("BEGIN");
    expect(await stripe(db, test).ingress.receive(signed(test))).toMatchObject({ status: 200 });
    expect(await stripe(db, live, "live").ingress.receive(signed(live, true))).toMatchObject({ status: 200 });
    expect((await db.query(`SELECT count(*)::int AS qualification FROM ${scope}`)).rows).toEqual([{ qualification: 0 }]);
    expect(await read(db, test.order)).toMatchObject({ ...hold("unqualified"), payment_mode: "test" });
    expect(await read(db, live.order)).toMatchObject({ ...hold("unqualified"), payment_mode: "live" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  const fractional = await prepare();
  await qualify(env.migration);
  expect(await stripe(env.runtime, fractional).ingress.receive(signed(fractional, false, fractional.time.created + 0.125)))
    .toMatchObject({ status: 200 });
  expect((await env.owner.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [fractional.intent])).rows)
    .toEqual([{ status: "settled" }]);
  expect(await read(env.owner, fractional.order)).toMatchObject(hold("ambiguous"));
});

it("keeps missing selectors, absent orders, unpaid attempts and recorded-only deliveries on their typed paths", async () => {
  expect(await read(env.owner, null)).toMatchObject(hold("invalid"));
  expect(await read(env.owner, randomUUID(), randomUUID())).toMatchObject(hold("invalid"));
  expect(await read(env.owner, randomUUID())).toMatchObject(hold("pending"));
  expect(await read(env.owner, null, randomUUID())).toMatchObject(hold("pending"));
  expect(await read(env.owner, (await draft(env.owner)).order)).toMatchObject(hold("pending"));
  const f = await prepare();
  expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
  expect(await stripe(env.runtime, f).ingress.receive(signed(f, false, null))).toMatchObject({ status: 200 });
  expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
  expect((await env.owner.query("SELECT processing_status FROM public.payment_provider_attempt_evidence WHERE settlement_intent_id=$1", [f.intent])).rows)
    .toEqual([{ processing_status: "received" }]);
  const review = await prepare();
  await env.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [review.order]);
  expect(await stripe(env.runtime, review).ingress.receive(signed(review))).toMatchObject({
    status: 200, data: { skipped: "result_manual_review" },
  });
  expect(await read(env.owner, review.order)).toMatchObject(hold("pending"));
});

it("does not expose a capture rolled back by its applying transaction", async () => {
  const f = await prepare();
  await qualify(env.migration);
  const db = await env.owner.connect();
  try {
    await db.query("BEGIN");
    expect(await stripe(db, f).ingress.receive(signed(f))).toMatchObject({ status: 200 });
    expect(await read(db, f.order)).toMatchObject({ kind: "authoritative" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
});

function readbackRequest(f: Subject, precise = false) {
  return {
    idempotencyKey: `capture-readback:${f.intent}`, expectedOrderId: f.order, expectedPaymentIntentId: f.intent,
    expectedPaymentAttemptId: f.attempt, expectedPaymentId: f.paymentId, provider: f.provider,
    providerPaymentId: f.remote, localStatus: "processing", providerStatus: "succeeded",
    resultStatus: "succeeded" as const, occurredAt: precise ? f.time.precise : f.time.observed,
    checkedAt: f.time.observed, failureReason: null,
    payload: precise
      ? { observedMoney: { amountMinor: amount, currency }, providerOccurredAt: f.time.precise, capturedAmountBasis: "provider_capture_v1" }
      : { normalizedStatus: "succeeded", amountMinor: amount, currency, capturedAmountBasis: "provider_capture_v1" },
  };
}

const fallback = {
  kind: "fallback", code: "capture_time_provider_time_unproven", provider: "stripe",
  route: "reconciliation_read", payment_mode: "unknown", captured_at: null,
};
const readbackProvider = (f: Subject) => createStripePaymentReconciliationProvider({
  async retrievePaymentIntent() {
    return { id: f.remote, status: "succeeded", amount, amount_received: amount, currency: currency.toLowerCase() };
  },
});

it.each(["worker", "verify-now"] as const)("retains the %s observer clock as a diagnostic fallback", async path => {
  const f = await prepare();
  const providers = { stripe: readbackProvider(f) };
  await qualify(env.migration);
  if (path === "worker") {
    await env.owner.query(`UPDATE public.payment_provider_attempts
      SET updated_at=$2::timestamptz-interval '1 hour',created_at=$2::timestamptz-interval '1 hour' WHERE id=$1`,
    [f.attempt, f.time.observed]);
    await env.owner.query("UPDATE public.payment_provider_states SET updated_at=$2::timestamptz-interval '1 hour' WHERE id=$1",
      [f.intent, f.time.observed]);
    expect(await runPaymentProviderReconciliationWorker({
      port: recovery(), providers, now: f.time.observed, claimKey: `capture-clock:${f.intent}`,
    })).toMatchObject({ ok: true, corrected: 1 });
  } else {
    const stored = await stripe(env.runtime, f).readAttempt(f.intent);
    expect(stored).not.toBeNull();
    const snapshot = {
      orderId: f.order, orderClientId: f.client, orderMode: "one_time", paymentIntentId: f.intent,
      intentStatus: stored!.intentStatus, paymentAttemptId: f.attempt, paymentId: f.paymentId,
      attemptStatus: stored!.paymentAttempt.status, provider: f.provider, providerAttemptId: f.remote,
      providerSessionId: null, intentProviderPaymentId: null, amountMinor: amount, currency,
      localUpdatedAt: f.time.occurred, captureReviewRequired: stored!.captureReviewRequired,
    };
    expect(await verifyPaymentAttemptNow({ snapshot, applyPort: recovery(), providers,
      now: () => new Date(f.time.observed) })).toMatchObject({ status: "succeeded", applied: true });
  }
  const before = await read(env.owner, f.order);
  expect(before).toMatchObject({ ...fallback, order_id: f.order, intent_id: f.intent, provider_occurred_at: null });
  for (const key of ["fallback_at", "observed_at", "truth_occurred_at"]) await timeEq(env.owner, before[key], f.time.observed);
  expect(await stripe(env.runtime, f).ingress.receive(signed(f))).toMatchObject({ status: 200 });
  expect(await read(env.owner, f.order)).toEqual(before);
});

it.each([false, true])("binds the typed renewal carrier with provider time present=%s", async timed => {
  const time = await clock(env.owner);
  const source = await renewal(env.owner, 10, 1, undefined, false, "stripe");
  const codec = createNativeRenewalCodec();
  const frozen = codec.freeze({
    subscription_id: source.subscription, client_id: source.client, cadence_days: 28, template_version: 1,
    currency_code: currency, stock_source_key: source.source, settlement_channel_key: "stripe", authorization_ref: "frozen-mandate",
    payer_account_ref: null, unattended_charge_authorized_at: AT, next_cycle_number: 2, paid_cycle_count: 2,
    activation_cycle_id: randomUUID(), activation_cycle_paid: true, delivery_admission: "allowed",
    purchase_facts: { templateId: "fixture", shippingAmountMinor: 0, acquisitionRef: null }, lines: source.snapshot.lines,
  }, { subscriptionId: source.subscription, scheduledAt: AT, scheduledInstant: Date.parse(AT) });
  await env.owner.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [source.operation]);
  const claim = await call(env.owner, "subscription_claim_due_renewal", [
    source.identity, frozen.frozenFingerprint, codec.encode(frozen), "fixture", 300, time.occurred,
  ]);
  await call(env.owner, "fulfillment_reserve_subscription_renewal", [claim.operationId, claim.claimToken, 900, time.occurred]);
  const order = await call(env.owner, "commerce_prepare_subscription_renewal", [claim.operationId, claim.claimToken, time.occurred]);
  const intent = order.settlementIntentId as string;
  const control = createPostgresProviderPaymentControlPort(env.runtime, options);
  const cycle = (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [order.orderId])).rows[0];
  expect(await control.createIntent({
    idempotencyKey: `renewal-intent:${intent}`, targetKind: "subscription_cycle", orderId: order.orderId,
    subscriptionId: source.subscription, subscriptionCycleId: cycle.subscription_cycle_id,
    amountMinor: amount, currency, channelKey: "stripe", metadata: {}, at: AT,
  })).toMatchObject({ id: intent });
  const request = { paymentIntentId: intent, providerIdempotencyKey: `provider:${intent}`, providerRequestFingerprint: "a".repeat(64) };
  const { paymentAttemptId: attempt } = await control.prepareProviderAttempt({
    ...request, idempotencyKey: `prepare:${intent}`, provider: "stripe", providerFlow: "off_session_payment", paymentMethodRef: null, requestPayload: {},
  });
  const remote = `pi_${attempt}`;
  const finalized = await control.finalizeProviderAttempt({
    ...request, idempotencyKey: `finalize:${intent}`, paymentAttemptId: attempt, providerAttemptId: remote,
    providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: { providerCall: true },
  });
  const readAttempt = (await env.owner.query("SELECT payment_id FROM public.payment_provider_attempts WHERE id=$1", [attempt])).rows[0];
  const f = { order: order.orderId as string, client: source.client, intent, attempt, remote,
    paymentId: readAttempt.payment_id as string, provider: "stripe", time };
  expect(finalized.paymentAttemptId).toBe(attempt);

  const rail = stripe(env.runtime, f);
  const base = rail.adapter.readbackPort;
  if (timed) rail.adapter.readbackPort = {
    async readPayment(input) {
      const result = await base.readPayment(input);
      expect(result.kind).toBe("succeeded");
      return { ...result, providerOccurredAt: time.precise };
    },
  };
  const withTransaction = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => {
    const db = await env.runtime.connect();
    try { await db.query("BEGIN"); const value = await work(db); await db.query("COMMIT"); return value; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  };
  const binding = createPostgresProviderRenewalBinding({
    enabled: true, channelKey: "stripe", executor: env.runtime, withTransaction, codec, paymentRail: rail, truth: options,
    now: () => time.observed, settlement: db => createPostgresRenewalSettlementPort(db, codec, withTransaction), search: async () => [],
  });
  await binding.lifecycle.settlement.acknowledgeExternalAttempt({
    operationId: claim.operationId, operationFingerprint: frozen.frozenFingerprint, externalAttemptRef: remote,
    acknowledgedAt: time.occurred,
  });
  expect(await binding.rail.readOutcome({
    settlementIntentId: intent, orderId: f.order, subscriptionId: source.subscription, amountMinor: amount, currency, externalAttemptRef: remote,
  })).toMatchObject({ status: "succeeded" });
  const value = await read(env.owner, f.order);
  if (!timed) {
    expect(value).toMatchObject(hold("pending"));
    expect((await env.owner.query("SELECT correction_status FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=$1", [attempt])).rows)
      .toEqual([{ correction_status: "observed" }]);
    return;
  }
  const bound = (await env.owner.query(`SELECT (t.source_evidence->>'sourceReference')::uuid AS evidence_id,
    t.settlement_transition_id, to_char(date_trunc('milliseconds',t.occurred_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS projected
    FROM public.payment_truth_events t WHERE t.settlement_intent_id=$1 AND t.state='settled' AND t.outcome='captured'`, [intent])).rows[0];
  expect(value).toMatchObject({ ...fallback, evidence_id: bound.evidence_id, settlement_transition_id: bound.settlement_transition_id });
  await timeEq(env.owner, value.provider_occurred_at, time.precise);
  await timeEq(env.owner, value.truth_occurred_at, time.precise);
  await timeEq(env.owner, value.fallback_at, time.observed);
  expect(bound.projected).toBe(time.precise.replace(/456Z$/u, "Z"));
});

const corruptions = [
  ["reciprocal link", `UPDATE public.payment_truth_events SET settlement_transition_id=(
    SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='opened'
  ) WHERE settlement_intent_id=$1`],
  ["primary link", "UPDATE public.commerce_settlement_transitions SET payload=payload-'paymentTruthEventId' WHERE intent_id=$1 AND to_status='settled'"],
  ["truth amount", "UPDATE public.payment_truth_events SET amount_minor=amount_minor+1 WHERE settlement_intent_id=$1"],
  ["truth occurrence", "UPDATE public.payment_truth_events SET occurred_at=occurred_at+interval '1 second' WHERE settlement_intent_id=$1"],
  ["wrong evidence intent", "UPDATE public.payment_provider_attempt_evidence SET settlement_intent_id=NULL WHERE settlement_intent_id=$1"],
  ["wrong evidence attempt", "UPDATE public.payment_provider_attempt_evidence SET payment_attempt_id=NULL WHERE settlement_intent_id=$1"],
  ["wrong evidence provider", "UPDATE public.payment_provider_attempt_evidence SET provider='tpay' WHERE settlement_intent_id=$1"],
  ["wrong evidence remote reference", "UPDATE public.payment_provider_attempt_evidence SET provider_payment_id='foreign' WHERE settlement_intent_id=$1"],
  ["wrong evidence fingerprint", "UPDATE public.payment_provider_attempt_evidence SET event_fingerprint=repeat('b',64) WHERE settlement_intent_id=$1"],
  ["missing clock", "UPDATE public.payment_provider_attempt_evidence SET payload=payload-'openlupReceipt' WHERE settlement_intent_id=$1"],
  ["nonfinite clock", "UPDATE public.payment_provider_attempt_evidence SET payload=jsonb_set(payload,'{openlupReceipt,receivedAt}',to_jsonb('infinity'::text)) WHERE settlement_intent_id=$1"],
  ["malformed clock", "UPDATE public.payment_provider_attempt_evidence SET payload=jsonb_set(payload,'{openlupReceipt,receivedAt}',to_jsonb('2026-02-30T00:00:00Z'::text)) WHERE settlement_intent_id=$1"],
  ["fractional signed clock", "UPDATE public.payment_provider_attempt_evidence SET payload=jsonb_set(payload,'{openlupEvidence,providerOccurredAt}',to_jsonb($2::text)) WHERE settlement_intent_id=$1"],
  ["duplicate transition", `INSERT INTO public.commerce_settlement_transitions(intent_id,from_status,to_status,outcome,idempotency_key,payload,occurred_at)
    SELECT intent_id,from_status,to_status,outcome,idempotency_key||':copy',payload,occurred_at FROM public.commerce_settlement_transitions
    WHERE intent_id=$1 AND to_status='settled' AND outcome='succeeded'`],
  ["duplicate native truth", `INSERT INTO public.payment_truth_events(settlement_intent_id,source_event_id,ingest_idempotency_key,event_fingerprint,
    state,outcome,amount_minor,currency_code,source_evidence,occurred_at,settled_at,settlement_transition_id)
    SELECT settlement_intent_id,source_event_id||':copy',ingest_idempotency_key||':copy',event_fingerprint,
    state,outcome,amount_minor,currency_code,source_evidence,occurred_at,settled_at,settlement_transition_id
    FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND outcome='captured'`],
] as const;

it.each(corruptions)("holds a settled capture with a %s", async (label, mutation) => {
  const f = await prepare();
  await qualify(env.migration);
  expect(await stripe(env.runtime, f).ingress.receive(signed(f))).toMatchObject({ status: 200 });
  expect(await read(env.owner, f.order)).toMatchObject({ kind: "authoritative" });
  await env.owner.query(mutation, mutation.includes("$2") ? [f.intent, f.time.precise] : [f.intent]);
  expect(await read(env.owner, f.order)).toMatchObject(hold("ambiguous"));
  const replayStatus = ["wrong evidence provider", "wrong evidence fingerprint"].includes(label) ? 503 : 200;
  expect(await stripe(env.runtime, f).ingress.receive(signed(f))).toMatchObject({ status: replayStatus });
  expect(await read(env.owner, f.order)).toMatchObject(hold("ambiguous"));
});

it.each(["missing", "foreign"] as const)("holds a readback whose winning run is %s", async change => {
  const f = await prepare();
  const request = readbackRequest(f, true);
  expect(await recovery().applyTerminalResult(request)).toMatchObject({ correctionStatus: "corrected" });
  expect(await read(env.owner, f.order)).toMatchObject(fallback);
  await env.owner.query(change === "missing"
    ? "DELETE FROM public.payment_provider_reconciliation_runs WHERE idempotency_key=$1"
    : "UPDATE public.payment_provider_reconciliation_runs SET payment_attempt_id=NULL WHERE idempotency_key=$1",
  [`${request.idempotencyKey}:evidence`]);
  await recovery().recordEvidence({ idempotencyKey: `later:${f.intent}`, provider: "stripe", providerPaymentId: f.remote,
    paymentIntentId: f.intent, paymentAttemptId: f.attempt, localStatus: "succeeded", providerStatus: "succeeded",
    checkedAt: f.time.observed, correctionStatus: "observed", payload: request.payload });
  expect(await read(env.owner, f.order)).toMatchObject(hold("ambiguous"));
});

it.each(["signed_webhook", "reconciliation_read"] as const)("keeps %s as the winning concurrent route", async winner => {
  const f = await prepare();
  await qualify(env.migration);
  const race = await env.owner.connect();
  let other: Promise<unknown> | undefined;
  try {
    await race.query("BEGIN");
    if (winner === "signed_webhook") {
      expect(await stripe(race, f).ingress.receive(signed(f))).toMatchObject({ status: 200 });
      other = recovery().applyTerminalResult(readbackRequest(f));
    } else {
      const port = createPostgresPaymentProviderReconciliationPort(race, options);
      expect(await port.applyTerminalResult(readbackRequest(f))).toMatchObject({ correctionStatus: "corrected" });
      other = stripe(env.runtime, f).ingress.receive(signed(f)).then(result => expect(result.status).toBe(200));
    }
    // The committed view cannot see the route while the aggregate lock is held.
    expect(await read(env.owner, f.order)).toMatchObject(hold("pending"));
    expect(await read(race, f.order)).toMatchObject({ route: winner });
    await race.query("COMMIT");
    await other;
  } finally { await race.query("ROLLBACK"); race.release(); await other?.catch(() => {}); }
  expect(await read(env.owner, f.order)).toMatchObject({
    route: winner, kind: winner === "signed_webhook" ? "authoritative" : "fallback",
  });
  expect((await env.owner.query(`SELECT count(*)::int AS settled FROM public.payment_truth_events
    WHERE settlement_intent_id=$1 AND state='settled' AND outcome='captured'`, [f.intent])).rows).toEqual([{ settled: 1 }]);
});

function tpay(db: Db, f: Subject) {
  const providerEventId = `${f.remote}:succeeded`;
  const delivery = { rawBody: Buffer.from("recorded tpay test delivery"), headers: {}, receivedAt: f.time.observed };
  return {
    providerEventId,
    deliver: () => createVerifiedPaymentIngress({
      provider: "tpay", paymentControlPort: createPostgresPaymentWebhookControlPort(db, options),
      verifyPort: { async verifyAndNormalize(input) {
        expect(input).toEqual(delivery);
        return {
          kind: "money", provider: "tpay", providerEventId, providerPaymentRef: f.remote,
          intentRef: f.intent, attemptRef: null, providerOccurredAt: f.time.occurred,
          outcome: "succeeded", money: { amountMinor: amount, currency }, capturedAmountBasis: "provider_capture_v1",
          fingerprint: "b".repeat(64),
        };
      } },
    }).receive(delivery),
  };
}

it("classifies a current bound Tpay capture as unsupported", async () => {
  const f = await prepare("tpay");
  expect(await tpay(env.runtime, f).deliver()).toMatchObject({ status: 200 });
  expect((await env.owner.query("SELECT captured_amount_basis FROM public.payment_provider_attempt_evidence WHERE settlement_intent_id=$1", [f.intent])).rows)
    .toEqual([{ captured_amount_basis: "provider_capture_v1" }]);
  expect(await read(env.owner, f.order)).toMatchObject({
    ...hold("unqualified"), provider: "tpay", route: "signed_webhook", payment_mode: "unknown",
  });
});

it("retains predecessor captures and classifies Tpay identically after verified fingerprint enrichment", async () => {
  const container = await runPostgresContainer({ name: `capture-predecessor-${process.pid}`, password: "synthetic-conformance" });
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: container.connectionString, options: "-c timezone=UTC" });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
    const beforeEvidence = manifest.forward.findIndex(unit => unit.file.endsWith("_native_durable_capture_evidence.sql"));
    expect(beforeEvidence).toBeGreaterThan(0);
    for (const unit of [manifest.baseline, ...manifest.forward.slice(0, beforeEvidence)]) await db.query(readFileSync(unit.file, "utf8"));
    const staged: { f: Subject; id: string }[] = [];
    for (const provider of ["tpay", "stripe"]) {
      const f = await prepared(db, db, provider);
      const event = provider === "tpay" ? tpay(db, f).providerEventId : `evt_${f.attempt}`;
      const { paymentEvent: { id } } = await call(db, "payment_provider_event_ingest", [
        provider, event, "payment.succeeded", f.remote, f.intent, f.attempt, null, null, true, { eventType: "recorded_success" },
      ]);
      await createPostgresProviderPaymentControlPort(db, options).applyPaymentResult({
        idempotencyKey: `provider-webhook:${provider}:${event}:apply`,
        paymentIntentId: f.intent, paymentEventId: id, resultStatus: "succeeded", occurredAt: f.time.occurred, failureReason: null,
      });
      staged.push({ f, id });
    }
    for (const unit of manifest.forward.slice(beforeEvidence)) await db.query(readFileSync(unit.file, "utf8"));
    expect(manifest.forward.at(-1)?.file).toEqual(expect.stringMatching(forward + "$"));
    const evidence = async (id: string) => (await db.query(`SELECT e.event_fingerprint,e.payload,e.captured_amount_basis,
      to_jsonb(t) AS truth,to_jsonb(x) AS transition FROM public.payment_provider_attempt_evidence e
      JOIN public.payment_truth_events t ON t.source_evidence->>'sourceReference'=e.id::text
      JOIN public.commerce_settlement_transitions x ON x.id=t.settlement_transition_id WHERE e.id=$1`, [id])).rows[0];
    for (const { f, id } of staged) {
      expect(await read(db, f.order)).toMatchObject({ ...hold("unqualified"), provider: f.provider, route: "signed_webhook" });
      expect(await evidence(id)).toMatchObject({ event_fingerprint: null, captured_amount_basis: null });
    }
    const { f, id } = staged[0]!;
    const before = await evidence(id);
    expect(await tpay(db, f).deliver()).toMatchObject({ status: 200, data: { paymentEventId: id, replayed: true } });
    expect(await evidence(id)).toEqual({ ...before, event_fingerprint: "b".repeat(64) });
    expect(await read(db, f.order)).toMatchObject({ ...hold("unqualified"), provider: "tpay", route: "signed_webhook" });
    await db.query("UPDATE public.payment_provider_attempt_evidence SET provider_payment_id='foreign' WHERE id=$1", [id]);
    expect(await read(db, f.order)).toMatchObject(hold("ambiguous"));
  } finally { await closePostgres(container, db); }
}, postgresSetupTimeoutMs);

it("classifies sandbox co-settlement using the primary observation", async () => {
  const { order } = await draft(env.owner);
  const time = await clock(env.owner);
  const opened = await call(env.runtime, "commerce_open_settlement_intent", [`sandbox:${order}`, order, "sandbox", amount, currency, {}, time.occurred]);
  const intent = opened.settlement.id as string;
  const sandbox = createPostgresSandboxPaymentSimulator(env.runtime, options);
  const attempt = await sandbox.beginAttempt({ settlementIntentId: intent, idempotencyKey: `sandbox-attempt:${order}`,
    requestFingerprint: "c".repeat(64), at: time.occurred });
  for (const outcome of ["indeterminate", "captured"] as const) {
    const observation = await sandbox.recordObservation({ attemptId: attempt.id, idempotencyKey: `sandbox:${outcome}:${order}`,
      outcome, occurredAt: time.occurred });
    expect(await sandbox.ingress.receive({ rawBody: Buffer.from(JSON.stringify({
      settlementIntentId: intent, attemptId: attempt.id, observationId: observation.id,
    })), headers: {}, receivedAt: time.observed })).toMatchObject({ status: 200 });
  }
  expect((await env.owner.query("SELECT count(*)::int AS co_settled FROM public.payment_truth_events WHERE settlement_intent_id=$1 AND state='settled'", [intent])).rows[0].co_settled).toBeGreaterThan(1);
  expect(await read(env.owner, order)).toMatchObject({ ...hold("unqualified"), provider: "sandbox", route: null, payment_mode: "unknown" });
});

it("carries signed evidence through same-profile restore and requires target-local qualification", async () => {
  const resources = storeJourneyResources();
  try {
    const source = await resources.installation("capture-clock-source");
    const target = await resources.installation("capture-clock-target");
    const f = await prepared(source.owner, source.runtime);
    expect(await stripe(source.runtime, f).ingress.receive(signed(f))).toMatchObject({ status: 200 });
    await qualify(source.owner);
    const captured = await read(source.owner, f.order);
    expect(captured).toMatchObject({ kind: "authoritative" });
    const packet = await captureStoreJourney(source.owner, "capture-clock-source");
    expect(packet.outsideProfileCensus).toContainEqual({
      relation: scope, owner: journeySelection.migrationLogin, rows: "1", disposition: "intentionally-not-carried",
    });
    const freshTarget = await captureStoreJourney(target.owner, "capture-clock-target");
    const restore = () => restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget });
    await qualify(target.owner);
    await expect(restore()).rejects.toThrow(/unsupported_table/u);
    await target.owner.query(`DELETE FROM ${scope}`);
    expect(await restore()).toMatchObject({ replayed: false, captureSha256: packet.sha256 });
    expect(await read(target.owner, f.order)).toMatchObject({
      ...hold("unqualified"), provider: "stripe", payment_mode: "test", route: "signed_webhook",
    });
    expect((await target.owner.query(`SELECT * FROM ${scope}`)).rows).toEqual([]);
    await qualify(target.owner);
    expect(await read(target.owner, f.order)).toEqual(captured);
  } finally { await resources.close(); }
}, postgresSetupTimeoutMs);
